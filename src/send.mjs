#!/usr/bin/env node
// QQ Bot proactive message sender for GitHub Actions
// Node 18+ required (uses native fetch). Zero npm dependencies.

import { readFileSync, statSync, createReadStream, promises as fsPromises } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import * as https from 'node:https';

const TOKEN_URL    = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE     = 'https://api.sgroup.qq.com';
const MAX_B64_SIZE = 20 * 1024 * 1024;  // 20MB — base64 single-upload limit
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

async function sendText(token, groupOpenid, content, useMarkdown) {
  const payload = useMarkdown
    ? { msg_type: 2, markdown: { content } }
    : { msg_type: 0, content };
  const res = await fetch(`${API_BASE}/v2/groups/${groupOpenid}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Send text failed (${res.status}): ${text}`);
  return JSON.parse(text);
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
async function sendFileByUrl(token, groupOpenid, fileUrl, fileType, fileName) {
  const payload = { file_type: FILE_TYPE_MAP[fileType] ?? 4, url: fileUrl, srv_send_msg: true };
  if (fileName) payload.file_name = fileName;
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
async function sendMediaMessage(token, groupOpenid, fileInfo) {
  return apiFetch(token, 'POST', `/v2/groups/${groupOpenid}/messages`,
    { msg_type: 7, media: { file_info: fileInfo } });
}

// ── Small file (≤20MB): base64 direct upload ──
async function sendFileSmall(token, groupOpenid, filePath, numericType, displayName) {
  const fileData = readFileSync(filePath).toString('base64');
  const r = await apiFetch(token, 'POST', `/v2/groups/${groupOpenid}/files`,
    { file_type: numericType, file_data: fileData, file_name: displayName, srv_send_msg: false });
  if (!r.file_info) throw new Error(`No file_info: ${JSON.stringify(r)}`);
  return sendMediaMessage(token, groupOpenid, r.file_info);
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
async function sendFileChunked(token, groupOpenid, filePath, numericType, displayName, fileSize) {
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
  return sendMediaMessage(token, groupOpenid, done.file_info);
}

// ── Local file router: picks strategy by size ──
async function sendFileByPath(token, groupOpenid, filePath, fileType, fileName) {
  const { size } = statSync(filePath);
  const numericType = FILE_TYPE_MAP[fileType] ?? 4;
  const displayName = fileName || basename(filePath);
  console.log(`  ${displayName}  ${(size / 1024 / 1024).toFixed(1)}MB`);
  if (size <= MAX_B64_SIZE) {
    console.log('  Strategy: base64 direct');
    return sendFileSmall(token, groupOpenid, filePath, numericType, displayName);
  }
  console.log('  Strategy: chunked upload via COS');
  return sendFileChunked(token, groupOpenid, filePath, numericType, displayName, size);
}

// ── Main ──
async function main() {
  const appId       = process.env.QQ_APP_ID;
  const secret      = process.env.QQ_CLIENT_SECRET;
  const groupOpenid = process.env.QQ_GROUP_OPENID;
  const message     = process.env.QQ_MESSAGE   || '';
  const useMarkdown = process.env.QQ_MARKDOWN  !== 'false';
  const fileUrl     = process.env.QQ_FILE_URL  || '';
  const filePath    = process.env.QQ_FILE_PATH || '';
  const fileType    = process.env.QQ_FILE_TYPE || 'file';
  const fileName    = process.env.QQ_FILE_NAME || '';

  if (!appId || !secret || !groupOpenid) {
    console.error('::error::Missing required inputs: appid, secret, group_openid');
    process.exit(1);
  }
  if (!message && !fileUrl && !filePath) {
    console.error('::error::Must provide at least one of: message, file_url, file_path');
    process.exit(1);
  }

  console.log('Fetching QQ Bot access token...');
  const token = await getAccessToken(appId, secret);
  console.log('Token acquired.');

  if (message) {
    console.log(`Sending ${useMarkdown ? 'markdown' : 'text'} message...`);
    const r = await sendText(token, groupOpenid, message, useMarkdown);
    console.log(`Message sent. id=${r.id ?? JSON.stringify(r)}`);
  }
  if (fileUrl) {
    console.log(`Sending file via URL (${fileType})...`);
    const r = await sendFileByUrl(token, groupOpenid, fileUrl, fileType, fileName || undefined);
    console.log(`File sent. id=${r.id ?? JSON.stringify(r)}`);
  }
  if (filePath) {
    console.log(`Sending local file (${fileType}): ${filePath}`);
    const r = await sendFileByPath(token, groupOpenid, filePath, fileType, fileName || undefined);
    console.log(`File sent. id=${r.id ?? JSON.stringify(r)}`);
  }
}

main().catch(err => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});
