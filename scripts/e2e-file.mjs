// E2E 文件管理测试客户端（node >= 22，内置 WebSocket）：
// 连接 /ws/file/{sid} → 鉴权 → 分块上传（write 混合帧，按 write_result 确认推进）→
// 分块下载（read）→ 校验内容写回。供 test/e2e.sh 调用。
// 用法：node e2e-file.mjs <base> <token> <sid> <srcLocal> <dstAgent>
// 上传写 agent 端 <dstAgent>，下载结果写到 <srcLocal>.down，退出码 0 表示成功。
import { readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';

const [base, token, sid, srcPath, dstPath] = process.argv.slice(2);
if (!base || !token || !sid || !srcPath || !dstPath) {
  console.error('usage: e2e-file.mjs <base> <token> <sid> <srcLocal> <dstAgent>');
  process.exit(2);
}
const wsUrl = base.replace(/^http/, 'ws') + '/ws/file/' + sid;
const BLK = 512 * 1024; // 512KB 块：混合帧下帧大小 = JSON 头 + 512KB 原始字节 < workerd 限制

const src = readFileSync(srcPath);
const chunks = Math.max(1, Math.ceil(src.length / BLK));

const ws = new WebSocket(wsUrl);
ws.binaryType = 'arraybuffer';
const listeners = new Map();
const wait = (type) => new Promise((resolve) => {
  const q = listeners.get(type);
  if (q) q.push(resolve);
  else listeners.set(type, [resolve]);
});
ws.addEventListener('message', (ev) => {
  let m;
  if (typeof ev.data === 'string') {
    try { m = JSON.parse(ev.data); } catch { return; }
  } else {
    // Binary 混合帧：'\n' 前 JSON 头，后为原始字节（read_result）
    const buf = new Uint8Array(ev.data);
    const nl = buf.indexOf(10);
    if (nl < 0) return;
    try { m = JSON.parse(new TextDecoder().decode(buf.subarray(0, nl))); } catch { return; }
    m.data = Buffer.from(buf.subarray(nl + 1)); // 原始字节
  }
  const q = listeners.get(m.type);
  if (q && q.length) q.shift()(m);
});
const send = (o) => ws.send(JSON.stringify(o));
// 混合帧 write：JSON 头 + '\n' + 原始字节（Buffer 为 Uint8Array，ws.send 支持）
const sendWrite = (offset, data, commit) => {
  const head = Buffer.from(JSON.stringify({ type: 'write', path: dstPath, offset, commit, upload_id: 'e2e-up' }) + '\n');
  ws.send(Buffer.concat([head, data]));
};

const run = async () => {
  await once(ws, 'open');
  send({ type: 'auth', token });
  // 上传：分块 write（与前端一致按 write_result 确认推进），最后一块 commit
  for (let i = 0; i < chunks; i++) {
    const start = i * BLK;
    sendWrite(start, Buffer.from(src.subarray(start, start + BLK)), i === chunks - 1);
    const r = await wait('write_result');
    if (!r.ok) { console.error('write failed:', JSON.stringify(r)); process.exit(1); }
  }
  // 下载：分块 read，拼接原始字节写回
  const parts = [];
  for (let i = 0; i < chunks; i++) {
    send({ type: 'read', path: dstPath, offset: i * BLK, limit: BLK });
    const r = await wait('read_result');
    if (!r.ok) { console.error('read failed:', JSON.stringify(r)); process.exit(1); }
    if (r.got > 0) parts.push(r.data);
  }
  const out = Buffer.concat(parts);
  writeFileSync(srcPath + '.down', out);
  console.log(JSON.stringify({ upload_ok: true, download_bytes: out.length }));
  process.exit(0);
};
run().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
