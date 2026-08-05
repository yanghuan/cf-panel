// E2E 文件管理测试客户端（node >= 22，内置 WebSocket）：
// 连接 /ws/file/{sid} → 鉴权 → 分块上传（write，按 write_result 确认推进）→
// 分块下载（read）→ 校验内容写回。供 test/e2e.sh 调用，绕开 websocat 管道分帧不确定性。
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
const BLK = 512 * 1024; // 512KB 块：base64 后 ~683KB < workerd 入站限制

const src = readFileSync(srcPath);
const chunks = Math.max(1, Math.ceil(src.length / BLK));

const ws = new WebSocket(wsUrl);
const listeners = new Map();
const wait = (type) => new Promise((resolve) => {
  const q = listeners.get(type);
  if (q) q.push(resolve);
  else listeners.set(type, [resolve]);
});
ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  const q = listeners.get(m.type);
  if (q && q.length) q.shift()(m);
});
const send = (o) => ws.send(JSON.stringify(o));

const run = async () => {
  await once(ws, 'open');
  send({ type: 'auth', token });
  // 上传：分块 write（与前端一致按 write_result 确认推进），最后一块 commit
  for (let i = 0; i < chunks; i++) {
    const start = i * BLK;
    send({
      type: 'write', path: dstPath, offset: start,
      data: Buffer.from(src.subarray(start, start + BLK)).toString('base64'),
      commit: i === chunks - 1, upload_id: 'e2e-up',
    });
    const r = await wait('write_result');
    if (!r.ok) { console.error('write failed:', JSON.stringify(r)); process.exit(1); }
  }
  // 下载：分块 read，拼接解码后写回
  const parts = [];
  for (let i = 0; i < chunks; i++) {
    send({ type: 'read', path: dstPath, offset: i * BLK, limit: BLK });
    const r = await wait('read_result');
    if (!r.ok) { console.error('read failed:', JSON.stringify(r)); process.exit(1); }
    if (r.got > 0) parts.push(Buffer.from(r.data, 'base64'));
  }
  const out = Buffer.concat(parts);
  writeFileSync(srcPath + '.down', out);
  console.log(JSON.stringify({ upload_ok: true, download_bytes: out.length }));
  process.exit(0);
};
run().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
