#!/usr/bin/env node
// ============================================================
// Agent 自更新本地演练（零依赖，Node >= 22）
// 不依赖 GitHub/Worker：内置最小 WebSocket 服务端模拟面板控制通道，
// 直接向 agent 下发 agent_update 分片，验证完整链路：
//   校验 → staging → SHA-256/候选 --version → .bak → self-replace
//   → 旧进程退出 → AGENT_SELF_RESTART 自启新版本 → 重连上报新 build id
//
// 用法：
//   1. 准备两个不同 build id 的二进制（旧=安装运行，新=更新候选）
//   2. node scripts/dev/agent-update-drill.mjs \
//        --new  /tmp/new-agent \
//        --install /tmp/cfpanel-drill/cf-panel-agent
// 脚本会自行启动 --install 指定的旧 agent（注入 ALLOW_SELF_UPDATE=1 等），
// 完成更新后自动验证磁盘版本/.bak/自启重连，并清理进程。
// ============================================================
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const NEW_BIN = arg('new');
const INSTALL = arg('install');
const PORT = Number(arg('port', '8790'));
if (!NEW_BIN || !INSTALL) {
  console.error('用法: node scripts/dev/agent-update-drill.mjs --new <新二进制> --install <安装路径>');
  process.exit(2);
}
const PLATFORM = { linux_x64: 'linux-x86_64', linux_arm64: 'linux-aarch64', darwin_arm64: 'macos-aarch64' }[`${process.platform}_${process.arch}`];
if (!PLATFORM) { console.error(`不支持的平台: ${process.platform}/${process.arch}`); process.exit(2); }

const versionOf = (bin) => String(spawnSync(bin, ['--version']).stdout).trim().split(/\s+/)[1] || '';
const oldBuild = versionOf(INSTALL);
const bin = readFileSync(NEW_BIN);
const newBuild = versionOf(NEW_BIN);
if (!oldBuild || !newBuild) { console.error('无法读取二进制 --version（旧/新至少一个缺失）'); process.exit(2); }
if (oldBuild === newBuild) { console.error(`新旧 build id 相同（${oldBuild}），需要两个不同版本的二进制`); process.exit(2); }
const sha256 = crypto.createHash('sha256').update(bin).digest('hex');
const UPDATE_ID = `drill-${crypto.randomBytes(4).toString('hex')}`;
console.log(`[drill] 平台=${PLATFORM} 旧=${oldBuild} → 新=${newBuild}（${bin.length}B, sha=${sha256.slice(0, 12)}…）`);

// ---- 最小 RFC6455 服务端（握手 + 帧 codec，足够本演练）----
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = null;
    socket.on('data', (d) => this.onData(d));
    socket.on('error', () => {});
  }
  sendFrame(op, payload) {
    const len = payload.length;
    let h;
    if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
    else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    h[0] = 0x80 | op;
    this.socket.write(Buffer.concat([h, payload]));
  }
  sendText(s) { this.sendFrame(1, Buffer.from(s)); }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0] & 0x80) !== 0;
      const op = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const maskOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (masked) {
        const m = this.buf.subarray(maskOff, maskOff + 4);
        const u = Buffer.from(payload);
        for (let i = 0; i < u.length; i++) u[i] ^= m[i & 3];
        payload = u;
      }
      this.buf = this.buf.subarray(off + len);
      if (op === 8) { try { this.socket.end(); } catch {} return; }
      if (op === 9) { this.sendFrame(0xA, payload); continue; } // ping → pong
      if (op === 0xA) continue; // pong
      // 文本/二进制（含分片拼装）
      if (op === 1 || op === 2) this.fragments = fin ? null : { op, data: payload };
      else if (op === 0 && this.fragments) {
        this.fragments.data = Buffer.concat([this.fragments.data, payload]);
        if (fin) { const f = this.fragments; this.fragments = null; this.onMessage?.(f.op, f.data); continue; }
      }
      if (fin && this.onMessage) this.onMessage(op, payload);
    }
  }
}

// ---- 演练状态机 ----
let phase = 'wait-old';
let connCount = 0;
let resolveResult, resolveReconnect;
const resultPromise = new Promise((r) => { resolveResult = r; });
const reconnectPromise = new Promise((r) => { resolveReconnect = r; });
const sendUpdate = (conn) => {
  const header = (offset, commit) => Buffer.from(JSON.stringify({
    type: 'agent_update', update_id: UPDATE_ID, build_id: newBuild, sha256,
    platform: PLATFORM, size: bin.length, offset, commit,
  }) + '\n');
  const CHUNK = 48 * 1024;
  for (let off = 0; off < bin.length; off += CHUNK) {
    conn.sendFrame(2, Buffer.concat([header(off, false), bin.subarray(off, Math.min(off + CHUNK, bin.length))]));
  }
  conn.sendFrame(2, header(bin.length, true)); // commit 帧（无数据）
  console.log(`[drill] 已下发 ${Math.ceil(bin.length / (48 * 1024))} 个分片 + commit 帧`);
};
const onText = (s) => {
  let j; try { j = JSON.parse(s); } catch { return; }
  if (j.type === 'agent_update_result') resolveResult(j);
  if (phase === 'wait-new-version' && j?.info?.agent_version) {
    if (j.info.agent_version === newBuild) resolveReconnect(j.info.agent_version);
    else console.log(`[drill] 重连上报版本 ${j.info.agent_version}（等待 ${newBuild}）`);
  }
};

const server = http.createServer();
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${crypto.createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`);
  const conn = new WsConn(socket);
  conn.onMessage = (op, payload) => { if (op === 1) onText(payload.toString()); };
  conn.sendText(JSON.stringify({ type: 'set_report_interval', interval: 2 }));
  connCount += 1;
  console.log(`[drill] agent 第 ${connCount} 次连接（阶段: ${phase}）`);
  // 按连接序号判定：第 1 次=待升级旧进程（立即下发更新）；第 2 次起=自启的新版本。
  // 不依赖 result/phase 的时序竞态——新进程可能在回执处理完成前就完成重连。
  if (connCount === 1) sendUpdate(conn);
  else phase = 'wait-new-version';
});
server.listen(PORT, '127.0.0.1', async () => {
  // 全局看门狗：任何环节卡死都在 90s 时输出阶段诊断并失败退出
  setTimeout(() => {
    console.error(`[drill] FAIL: 看门狗超时（phase=${phase}, conn=${connCount}）`);
    try { spawnSync('pkill', ['-f', INSTALL]); } catch {}
    process.exit(1);
  }, 90000).unref?.();
  console.log(`[drill] 模拟面板就绪 ws://127.0.0.1:${PORT}/ws/agent，启动旧 agent…`);
  const child = spawn(INSTALL, [], {
    env: {
      ...process.env,
      AGENT_WSS_URL: `ws://127.0.0.1:${PORT}/ws/agent`,
      AGENT_KEY: '0'.repeat(64),
      ALLOW_SELF_UPDATE: '1',
      AGENT_SELF_RESTART: '1',
      AGENT_LOG: `${dirname(INSTALL)}/drill-agent.log`,
    },
    stdio: 'ignore',
    detached: false,
  });
  const fail = (msg) => { console.error(`[drill] FAIL: ${msg}`); try { child.kill(); } catch {} try { spawnSync('pkill', ['-f', `^${INSTALL}`]); } catch {} process.exit(1); };
  const result = await Promise.race([resultPromise, new Promise((r) => setTimeout(() => r(null), 60000))]);
  if (!result || !result.ok) return fail(`更新回执异常: ${JSON.stringify(result)}`);
  console.log(`[drill] ✔ agent_update_result ok（build=${newBuild}）`);
  const reported = await Promise.race([reconnectPromise, new Promise((r) => setTimeout(() => r(null), 30000))]);
  if (!reported) return fail('新版本未在 30s 内自启重连并上报');
  console.log(`[drill] ✔ 新版本已自启重连，上报 agent_version=${reported}`);
  // 磁盘断言：正式文件=新版本；.bak=旧版本
  const now = versionOf(INSTALL);
  const bak = versionOf(`${INSTALL}.bak`);
  if (now !== newBuild) return fail(`安装路径版本=${now}，期望 ${newBuild}`);
  console.log(`[drill] ✔ 磁盘正式文件 --version = ${now}`);
  if (bak !== oldBuild) return fail(`.bak 版本=${bak}，期望 ${oldBuild}`);
  console.log(`[drill] ✔ .bak 保留旧版本 --version = ${bak}`);
  console.log('[drill] PASS: 校验→替换→自启→重连→版本确认 全链路通过');
  try { spawnSync('pkill', ['-f', `^${INSTALL}`]); } catch {} // 锚定行首，避免匹配到脚本自身命令行
  process.exit(0);
});
