#!/usr/bin/env node
// QQ Bot proactive message sender for GitHub Actions
// Node 18+ required (uses native fetch). Zero npm dependencies.

import { readFileSync, statSync, createReadStream, promises as fsPromises } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import * as https from 'node:https';

const TOKEN_URL    = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE     = 'https://api.sgroup.qq.com';
const MAX_B64_SIZE   = 20 * 1024 * 1024;   // 20MB — base64 single-upload limit
const MAX_FILE_SIZE  = 200 * 1024 * 1024;  // 200MB — QQ API hard limit for chunked upload
const MD5_10M_SIZE = 10_002_432;         // QQ spec: MD5 of first ~10MB

async function getAccessToken(appId, clientSecret) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token fetch failed (${res.status}): ${text}`);
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error(`No access_token: ${text}`);
  return data.access_token;
}

async function sendText(token, groupOpenid, content, useMarkdown, keyboard) {
  const payload = useMarkdown
    ? { msg_type: 2, markdown: { content } }
    : { msg_type: 0, content };
  if (keyboard) payload.keyboard = keyboard;
  const res = await fetch(`${API_BASE}/v2/groups/${groupOpenid}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Send text failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

// ── 内联键盘 ──
// 平台限制（2026-11 实测）：最多 5 行，超了报
//   {"code":40034029,"message":"请求错误，内联键盘行/列超限"}
// 按钮 action.type：0 = 跳转链接（data 填 URL），2 = 代发指令文本。
const KEYBOARD_MAX_ROWS = 5;

// 输入是二维数组，每项一行；元素可以是
//   - 字符串：当成「标签=URL」，标签直接用 URL 当显示文本
//   - "标签|URL"
//   - JSON 对象：原样透传（高级用法，比如 type 2 的指令按钮）
function buildKeyboard(spec) {
  if (spec instanceof Map) return spec; // 已经是平台结构
  if (Array.isArray(spec)) {
    const rows = spec.flatMap((row) => {
      const r = Array.isArray(row) ? row : [row];
      return [{ buttons: r.map((b) => buildButton(b)) }];
    });
    if (rows.length > KEYBOARD_MAX_ROWS) {
      throw new Error(
        `内联键盘最多 ${KEYBOARD_MAX_ROWS} 行，当前 ${rows.length} 行。` +
        `请合并行或减少按钮（QQ 平台硬限制 40034029）。`,
      );
    }
    return { content: { rows } };
  }
  throw new Error('keyboard 必须是二维数组或平台 keyboard 对象');
}

function buildButton(b) {
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    // 已经是完整按钮结构
    if (b.render_data && b.action) return b;
    throw new Error(`无法识别的按钮定义: ${JSON.stringify(b)}`);
  }
  const s = String(b);
  const sep = s.includes('|') ? '|' : '=';
  const i = s.indexOf(sep);
  if (i < 0) throw new Error(`按钮定义缺少分隔符: ${s}`);
  const label = s.slice(0, i).trim();
  const url = s.slice(i + 1).trim();
  if (!label || !url) throw new Error(`按钮定义的标签或 URL 为空: ${s}`);
  return {
    // id 只用于回调匹配，链接按钮用不到；用序号保证唯一即可。
    id: `btn_${label}`.slice(0, 64),
    render_data: { label, visited_label: label, style: 1 },
    action: { type: 0, permission: { type: 2 }, data: url },
  };
}

const FILE_TYPE_MAP = { image: 1, video: 2, audio: 3, file: 4 };

async function apiFetch(token, method, path, payload) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

// ── URL upload (QQ server fetches the file) ──
async function sendFileByUrl(token, groupOpenid, fileUrl, fileType, fileName, keyboard) {
  const payload = { file_type: FILE_TYPE_MAP[fileType] ?? 4, url: fileUrl, srv_send_msg: true };
  if (fileName) payload.file_name = fileName;
  if (keyboard) payload.keyboard = keyboard;
  return apiFetch(token, 'POST', `/v2/groups/${groupOpenid}/files`, payload);
}

// ── Compute MD5 / SHA1 / MD5-first-10M hashes via streaming ──
function computeHashes(filePath, fileSize) {
  return new Promise((resolve, reject) => {
    const md5h = createHash('md5'), sha1h = createHash('sha1'), m10h = createHash('md5');
    const needs10m = fileSize > MD5_10M_SIZE;
    let consumed = 0;
    createReadStream(filePath)
      .on('data', (raw) => {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        md5h.update(buf); sha1h.update(buf);
        if (needs10m) {
          const rem = MD5_10M_SIZE - consumed;
          if (rem > 0) m10h.update(rem >= buf.length ? buf : buf.subarray(0, rem));
        }
        consumed += buf.length;
      })
      .on('end', () => {
        const md5 = md5h.digest('hex');
        resolve({ md5, sha1: sha1h.digest('hex'), md5_10m: needs10m ? m10h.digest('hex') : md5 });
      })
      .on('error', reject);
  });
}

// ── PUT binary chunk to COS presigned URL (raw https.request, not fetch) ──
function putToCOS(url, data) {
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(url), {
      method: 'PUT',
      headers: { 'Content-Length': String(data.length) },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`COS PUT ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}

// ── Send msg_type:7 after upload ──
async function sendMediaMessage(token, groupOpenid, fileInfo, keyboard) {
  const payload = { msg_type: 7, media: { file_info: fileInfo } };
  if (keyboard) payload.keyboard = keyboard;
  return apiFetch(token, 'POST', `/v2/groups/${groupOpenid}/messages`, payload);
}

// ── Small file (≤20MB): base64 direct upload ──
async function sendFileSmall(token, groupOpenid, filePath, numericType, displayName, keyboard) {
  const fileData = readFileSync(filePath).toString('base64');
  const r = await apiFetch(token, 'POST', `/v2/groups/${groupOpenid}/files`,
    { file_type: numericType, file_data: fileData, file_name: displayName, srv_send_msg: false });
  if (!r.file_info) throw new Error(`No file_info: ${JSON.stringify(r)}`);
  return sendMediaMessage(token, groupOpenid, r.file_info, keyboard);
}

// ── 带指数退避的重试（专为 upload_part_finish 的瞬时限流设计）──
async function withRetry(fn, { retries = 4, baseDelayMs = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (i < retries) {
        const delay = baseDelayMs * 2 ** i;
        console.log(`  Retry ${i + 1}/${retries} in ${delay}ms... (${err.message.slice(0, 80)})`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Large file: chunked upload via COS presigned URLs ──
async function sendFileChunked(token, groupOpenid, filePath, numericType, displayName, fileSize, keyboard) {
  console.log(`  Computing hashes (${(fileSize / 1024 / 1024).toFixed(1)}MB)...`);
  const hashes = await computeHashes(filePath, fileSize);

  const prep = await apiFetch(token, 'POST', `/v2/groups/${groupOpenid}/upload_prepare`, {
    file_type: numericType, file_name: displayName, file_size: fileSize,
    md5: hashes.md5, sha1: hashes.sha1, md5_10m: hashes.md5_10m,
  });
  const { upload_id, block_size, parts } = prep;
  console.log(`  upload_id=${upload_id}  parts=${parts.length}  block=${(block_size/1024).toFixed(0)}KB`);

  for (const part of parts) {
    const offset = (part.index - 1) * block_size;
    const length = Math.min(block_size, fileSize - offset);
    const handle = await fsPromises.open(filePath, 'r');
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, offset);
    await handle.close();
    await putToCOS(part.presigned_url, buf);
    const partMd5 = createHash('md5').update(buf).digest('hex');
    await withRetry(() =>
      apiFetch(token, 'POST', `/v2/groups/${groupOpenid}/upload_part_finish`,
        { upload_id, part_index: part.index, block_size: length, md5: partMd5 })
    );
    console.log(`  Part ${part.index}/${parts.length} OK`);
  }

  const done = await apiFetch(token, 'POST', `/v2/groups/${groupOpenid}/files`, { upload_id });
  if (!done.file_info) throw new Error(`No file_info after complete: ${JSON.stringify(done)}`);
  return sendMediaMessage(token, groupOpenid, done.file_info, keyboard);
}

// ── Local file router: picks strategy by size ──
async function sendFileByPath(token, groupOpenid, filePath, fileType, fileName, keyboard) {
  const { size } = statSync(filePath);
  const numericType = FILE_TYPE_MAP[fileType] ?? 4;
  const displayName = fileName || basename(filePath);
  console.log(`  ${displayName}  ${(size / 1024 / 1024).toFixed(1)}MB`);
  if (size > MAX_FILE_SIZE) {
    throw new Error(
      `File "${displayName}" is ${(size / 1024 / 1024).toFixed(1)}MB, which exceeds the QQ API 200MB limit. ` +
      `Please reduce the file size or provide a download URL instead of a local path.`
    );
  }
  if (size <= MAX_B64_SIZE) {
    console.log('  Strategy: base64 direct');
    return sendFileSmall(token, groupOpenid, filePath, numericType, displayName, keyboard);
  }
  console.log('  Strategy: chunked upload via COS');
  return sendFileChunked(token, groupOpenid, filePath, numericType, displayName, size, keyboard);
}

function splitLines(s) {
  return s.split('\n').map(l => l.trim()).filter(Boolean);
}

// 解析 QQ_KEYBOARD 输入：优先当 JSON，否则按简写解析。
function parseKeyboardInput(raw) {
  const text = raw.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) {
      throw new Error(`keyboard JSON 解析失败: ${e.message}`);
    }
    // 平台结构原样返回；二维数组交给 buildKeyboard 补 id / action。
    if (parsed && parsed.content) return parsed;
    return buildKeyboard(parsed);
  }
  // 简写：一行一组按钮，行内用逗号分隔。
  const rows = text.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/[,，]/).map((b) => b.trim()).filter(Boolean));
  return buildKeyboard(rows);
}

// ── Main ──
async function main() {
  const appId       = process.env.QQ_APP_ID;
  const secret      = process.env.QQ_CLIENT_SECRET;
  const groupOpenid = process.env.QQ_GROUP_OPENID;
  const message     = process.env.QQ_MESSAGE   || '';
  const useMarkdown = process.env.QQ_MARKDOWN  !== 'false';
  const fileUrl     = process.env.QQ_FILE_URL  || '';
  const filePaths   = splitLines(process.env.QQ_FILE_PATH || '');
  const fileTypes   = splitLines(process.env.QQ_FILE_TYPE || '');
  const fileNames   = splitLines(process.env.QQ_FILE_NAME || '');
  const keyboardRaw = process.env.QQ_KEYBOARD || '';

  if (!appId || !secret || !groupOpenid) {
    console.error('::error::Missing required inputs: appid, secret, group_openid');
    process.exit(1);
  }
  if (!message && !fileUrl && filePaths.length === 0) {
    console.error('::error::Must provide at least one of: message, file_url, file_path');
    process.exit(1);
  }

  // keyboard 两种写法：
  //   1) JSON：直接贴平台结构 {"content":{"rows":[...]}}
  //   2) 简写：每行一组按钮，行内逗号分隔，按钮写「标签=URL」或「标签|URL」
  //      例:
  //        win=https://…/setup.exe, mac-arm=https://…/arm64.dmg
  //        linux-x64=https://…/x86_64.AppImage
  // 只在第一条消息上附带键盘（QQ 每条消息一个键盘）。
  const keyboard = keyboardRaw ? parseKeyboardInput(keyboardRaw) : undefined;

  console.log('Fetching QQ Bot access token...');
  const token = await getAccessToken(appId, secret);
  console.log('Token acquired.');

  if (message) {
    console.log(`Sending ${useMarkdown ? 'markdown' : 'text'} message...`);
    const r = await sendText(token, groupOpenid, message, useMarkdown, keyboard);
    console.log(`Message sent. id=${r.id ?? JSON.stringify(r)}`);
  }
  if (fileUrl) {
    const fType = fileTypes[0] || 'file';
    const fName = fileNames[0] || '';
    console.log(`Sending file via URL (${fType})...`);
    const r = await sendFileByUrl(token, groupOpenid, fileUrl, fType, fName || undefined,
      message ? undefined : keyboard);
    console.log(`File sent. id=${r.id ?? JSON.stringify(r)}`);
  }
  for (let i = 0; i < filePaths.length; i++) {
    const fp    = filePaths[i];
    const fType = fileTypes[i] ?? fileTypes[0] ?? 'file';
    const fName = fileNames[i] ?? fileNames[0] ?? '';
    console.log(`Sending local file (${fType}): ${fp}`);
    // 键盘已经挂在正文消息上了就别重复挂；没有正文时挂到第一个文件上。
    const kb = (message || i > 0) ? undefined : keyboard;
    const r = await sendFileByPath(token, groupOpenid, fp, fType, fName || undefined, kb);
    console.log(`File sent. id=${r.id ?? JSON.stringify(r)}`);
  }
}

main().catch(err => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});
