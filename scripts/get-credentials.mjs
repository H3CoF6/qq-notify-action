/**
 * 扫码获取 AppID / AppSecret，并等待群消息打印群 OpenID
 *
 * 运行：
 *   npm install          # 首次运行先安装依赖
 *   npm run get-credentials
 */
import { writeFileSync } from 'node:fs';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { qrConnect } from '@tencent-connect/qqbot-connector';

console.log('请用手机 QQ 扫描下方二维码...\n');

const credentials = await qrConnect({ source: 'qq-notif-action' });
writeFileSync('credentials.json', JSON.stringify(credentials, null, 2));

console.log('\n========== 登录成功 ==========');
for (const c of credentials) {
  console.log(`  AppID    : ${c.appId}`);
  console.log(`  AppSecret: ${c.appSecret}`);
  if (c.userOpenid) console.log(`  UserOpenID: ${c.userOpenid}`);
  console.log('');
}
console.log('以上信息已写入 credentials.json（请勿提交到 Git）');

// ── 启动 WebSocket，等待群消息打印群 OpenID ──
const cred = credentials[0];
console.log('\n等待群消息以获取群 OpenID...');
console.log('（在机器人所在的群里随便发一条消息）\n');

const bot = new QQBot({
  appId: cred.appId,
  appSecret: cred.appSecret,
  transport: 'websocket',
});

bot.on('error', (err) => console.error('Bot 错误:', err.message));

const seenGroups = new Set();

bot.on('message', (_ctx, msg) => {
  const groupOpenId =
    msg.groupOpenId ?? msg.group_open_id ?? msg.group?.id ?? msg.groupId;
  const senderOpenId =
    msg.author?.memberOpenid ?? msg.author?.member_openid ?? msg.author?.openid;

  if (groupOpenId && !seenGroups.has(groupOpenId)) {
    seenGroups.add(groupOpenId);
    console.log('========== 收到群消息 ==========');
    console.log(`  群 OpenID    : ${groupOpenId}`);
    if (senderOpenId) console.log(`  发送者 OpenID: ${senderOpenId}`);
    console.log('================================');
    console.log('已获取所需信息，可 Ctrl+C 退出');
  }

  if (!groupOpenId) {
    console.log('未识别到 group openid，原始消息:');
    console.log(JSON.stringify(msg, null, 2));
  }
});

await bot.start();
