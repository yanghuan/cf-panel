// ============================================================
// Durable Object 行为测试：MetricsDO（热区/归档/保留期/离线告警）、
// PanelDO（viewers/推送过滤）、TerminalDO（wakeup/create 确认重发/report）
// 运行：node --test test/do.test.js
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsDO, PanelDO, TerminalDO, __internals as I } from '../src/index.js';
import { makeEnv, makePanelStub, captureFetch } from './helpers.js';

function mockState(store = {}) {
  const map = new Map(Object.entries(store));
  const storage = {
    map,
    async get(k) {
      return map.has(k) ? map.get(k) : undefined;
    },
    async put(k, v) {
      map.set(k, v);
    },
    async delete(k) {
      map.delete(k);
    },
    async list(opts = {}) {
      const prefix = opts.prefix || '';
      const keys = [];
      for (const [k, v] of map) {
        if (k.startsWith(prefix)) keys.push({ name: k, value: v });
      }
      return { keys };
    },
    setAlarm(ts) {
      this.alarmTs = ts;
    },
    async getAlarm() {
      return this.alarmTs == null ? null : this.alarmTs;
    },
  };
  return { storage };
}

function mkMetrics(env, state) {
  const inst = new MetricsDO(state, env);
  const call = (path, init) => inst.fetch(new Request(`https://do.internal${path}`, init));
  return { inst, call };
}

function insertServer(env, keyId, name, extra = {}) {
  return env.DB.prepare(
    'INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash, last_seen) VALUES (?,?,?,?,?)'
  ).bind(keyId, name, 1, 'h', extra.last_seen ?? null).run();
}

test.beforeEach(() => I.__reset());

// ---------------- MetricsDO：热区读写 ----------------
test('MetricsDO: report / query / latest 基本读写', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const { call } = mkMetrics(env, mockState());
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin - 1, cpu: 10, mem_used: 1, net_in: 2, net_out: 3 }) });
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 20, mem_used: 4 }) });

  const q = await (await call('/query?server_id=1&limit=10')).json();
  assert.equal(q.length, 2);
  assert.equal(q[0].ts, nowMin - 1);
  assert.equal(q[0].cpu, 10);
  assert.equal(q[0].net_out, 3);
  assert.equal(q[1].cpu, 20);

  const latest = await (await call('/latest')).json();
  assert.equal(latest[1].cpu, 20);
  assert.equal(latest[1].mem_used, 4);

  assert.deepEqual(await (await call('/query?server_id=999')).json(), []);
  assert.equal((await call('/nope')).status, 404);
});

test('MetricsDO: storage.put 按分钟去重，put 失败下帧重试（降额）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const st = mockState();
  const { call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const mKeys = () => [...st.storage.map.keys()].filter((k) => k.startsWith('m:1:')).length;
  // 同分钟多帧 → 只写 1 次 storage（快采 ~20 帧/分钟 → 1 次）
  for (let i = 0; i < 5; i++) {
    await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: i }) });
  }
  assert.equal(mKeys(), 1, '同分钟多帧只 put 一次');
  // 跨分钟 → 追加 put
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin + 1, cpu: 9 }) });
  assert.equal(mKeys(), 2, '跨分钟追加 put');
  // put 失败 → 不更新 putMin → 下帧重试写入
  const origPut = st.storage.put.bind(st.storage);
  let failNext = true;
  st.storage.put = async (k, v) => { if (failNext) { failNext = false; throw new Error('put failed'); } return origPut(k, v); };
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin + 2, cpu: 1 }) });
  assert.equal(st.storage.map.has(`m:1:${nowMin + 2}`), false, 'put 失败未写入');
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin + 2, cpu: 2 }) });
  assert.equal(st.storage.map.has(`m:1:${nowMin + 2}`), true, 'put 失败下帧重试写入');
});

test('MetricsDO: 兜底 listStorage 仅本实例首帧执行（降额）', async () => {
  const env = makeEnv();
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const st = mockState({
    [`m:1:${nowMin - 200}`]: JSON.stringify({ cpu: 11 }),
    'arc:1': String(nowMin - 300),
  });
  const { call } = mkMetrics(env, st);
  let listCount = 0;
  const origList = st.storage.list.bind(st.storage);
  st.storage.list = async (opts = {}) => {
    if (String(opts.prefix || '').startsWith('m:1:')) listCount += 1;
    return origList(opts);
  };
  // 首帧即跨线（fresh=true，推进水位）→ 兜底一次（补归档滞后 Storage 行）
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin - 61, cpu: 22 }) });
  assert.equal(listCount, 1, '首帧跨线兜底一次');
  assert.equal(Number(await st.storage.get('arc:1')), nowMin - 61, '水位推进到跨线行');
  // 之后所有帧（含推进/跨线）不再触发兜底 listStorage（消除每 60 秒一次的全量读）
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin - 62, cpu: 23 }) });
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 24 }) });
  assert.equal(listCount, 1, '非首帧不再触发兜底 list');
});

test('MetricsDO: 家政状态持久化跨 evict（fullSweep/prune 不因重置停摆）', async () => {
  const env = makeEnv();
  const st = mockState();
  const { inst, call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin - 5, cpu: 1 }) });
  await inst.alarm();
  const h = JSON.parse(await st.storage.get('housekeep'));
  assert.ok(h.lastSweepAt > 0, 'fullSweep 时间已持久化');
  assert.ok(h.lastPruneAt > 0, 'prune 时间已持久化');
  // 模拟 evict：新实例共享 storage → alarm 时惰性恢复时间戳，不再重复执行
  const { inst: instB } = mkMetrics(env, st);
  const hBefore = JSON.parse(await st.storage.get('housekeep'));
  await instB.alarm(); // ensureHousekeepLoaded 恢复 lastSweepAt/lastPruneAt + 时间差判定
  assert.equal(instB.lastSweepAt, hBefore.lastSweepAt, '新实例恢复 lastSweepAt');
  assert.equal(instB.lastPruneAt, hBefore.lastPruneAt, '新实例恢复 lastPruneAt');
  const hAfter = JSON.parse(await st.storage.get('housekeep'));
  assert.equal(hAfter.lastSweepAt, hBefore.lastSweepAt, '未到期不重复 fullSweep');
  assert.equal(hAfter.lastPruneAt, hBefore.lastPruneAt, '未到期不重复 prune');
});

test('MetricsDO 上报驱动聚合推送（set_push 开启 + 5s 节流）', async () => {
  // 自定义 Panel stub：记录 init（makePanelStub 不记录请求体）
  const pushCalls = [];
  const env = makeEnv({
    PANEL: {
      calls: pushCalls,
      idFromName: () => 'panel-main',
      get: () => ({ fetch: async (url, init) => { pushCalls.push({ url: String(url), init }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); } }),
    },
  });
  const st = mockState();
  const { inst, call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const pushCount = () => pushCalls.filter((c) => c.url.includes('/rpc/latest_push')).length;
  // 未开启 → 不推送
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 1 }) });
  assert.equal(pushCount(), 0, '未开启推送不调用 PanelDO');
  // 开启推送（PanelDO 0→1 时通知）
  await call('/rpc/set_push', { method: 'POST', body: JSON.stringify({ on: true }) });
  assert.equal(inst.pushOn, true, 'pushOn 已开启');
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 2 }) });
  assert.equal(pushCount(), 1, '开启后 /report 触发 latest_push');
  const body = JSON.parse(pushCalls.find((c) => c.url.includes('/rpc/latest_push')).init.body);
  assert.equal(body.latest[1].cpu, 2, '推送包含最新指标');
  // 5s 内再上报 → 节流不推送
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 3 }) });
  assert.equal(pushCount(), 1, '5s 内不重复推送');
  // 超过 5s → 重新推送
  inst.lastPushAt = Date.now() - 5100;
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 4 }) });
  assert.equal(pushCount(), 2, '超过 5s 重新推送');
});

test('latest_push 对已撤销观看者关闭连接（修复验证问题2）', async () => {
  const env = makeEnv();
  const ws = { closed: false, attachment: 'cfp_revoked_token', deserializeAttachment() { return this.attachment; }, send() {}, close() { this.closed = true; } };
  const inst = new PanelDO({ getWebSockets: () => [ws] }, env);
  const res = await inst.fetch(new Request('https://do.internal/rpc/latest_push', { method: 'POST', body: JSON.stringify({ latest: {} }) }));
  assert.equal(res.status, 200);
  assert.equal(ws.closed, true, '已撤销观看者连接被关闭（不再残留计数维持快采）');
});

test('pushOn evict 丢失后反查 /viewers 自愈（修复验证问题3）', async () => {
  const env = makeEnv({ PANEL: makePanelStub({ viewers: 1 }) }); // 实际有人观看
  const st = mockState();
  const { inst, call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  assert.equal(inst.pushOn, false, '初始未开启（模拟 evict 后丢失）');
  // pushOn=false + 有上报 → 低频反查 /viewers（count=1）→ 恢复推送
  inst.lastPushProbeAt = 0;
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 1 }) });
  assert.equal(inst.pushOn, true, '反查发现有人观看恢复推送');
});

test('MetricsDO: 首帧兜底失败置 pendingArcRetry，后续帧重试成功（修复验证问题4）', async () => {
  const env = makeEnv();
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const xTs = nowMin - 200;
  const minTs = nowMin - 61;
  const state = mockState({
    [`m:1:${xTs}`]: JSON.stringify({ cpu: 11 }),
    'arc:1': String(nowMin - 300),
  });
  const { inst, call } = mkMetrics(env, state);
  // 首帧兜底失败：不推进 + 置 pending 标记
  const origList = state.storage.list.bind(state.storage);
  state.storage.list = async () => { throw new Error('storage unavailable'); };
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs, cpu: 22 }) });
  assert.equal(Number(await state.storage.get('arc:1')), nowMin - 300, '首帧兜底失败不推进');
  assert.ok(inst.pendingArcRetry.has(1), '失败置 pending 重试标记');
  // 恢复后第 2 帧（fresh=false）仍重试兜底 → 滞后行归档 + 推进 + 清除标记
  state.storage.list = origList;
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs, cpu: 22 }) });
  assert.equal(inst.pendingArcRetry.has(1), false, '兜底成功清除标记');
  assert.equal(Number(await state.storage.get('arc:1')), minTs, '推进水位');
  const rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows.results.length, 2, '滞后行与跨线行均归档');
});

test('PanelDO latest_push 按观看者权限广播（不查 /latest）', async () => {
  const env = makeEnv();
  const token = await I.signJwt({ uid: 1, username: 'admin', role: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, env);
  await insertServer(env, 'k1', 'srv-a', { last_seen: Math.floor(Date.now() / 1000) - 5 });
  const ws = { attachment: token, sent: [], deserializeAttachment() { return this.attachment; }, send(m) { this.sent.push(m); } };
  const inst = new PanelDO({ getWebSockets: () => [ws] }, env);
  const res = await inst.fetch(new Request('https://do.internal/rpc/latest_push', {
    method: 'POST',
    body: JSON.stringify({ latest: { 1: { cpu: 42, last_seen_s: Math.floor(Date.now() / 1000) } } }),
  }));
  assert.equal(res.status, 200);
  assert.equal(ws.sent.length, 1, '广播给观看者');
  const list = JSON.parse(ws.sent[0]);
  assert.equal(list[0].metric.cpu, 42, '推送含最新指标');
  assert.equal(list[0].online, true, '最近上报在线');
});

test('MetricsDO: /report 批量接口（frames 数组）多机聚合处理', async () => {
  const env = makeEnv();
  const st = mockState();
  const { call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  await call('/report', { method: 'POST', body: JSON.stringify({ frames: [
    { serverId: 1, minTs: nowMin, cpu: 10 },
    { serverId: 2, minTs: nowMin, cpu: 20 },
    { serverId: 3, minTs: nowMin, cpu: 30 },
  ] }) });
  // 三台热写 + latest 全部就绪
  const latest = await (await call('/latest')).json();
  assert.equal(latest[1].cpu, 10);
  assert.equal(latest[2].cpu, 20);
  assert.equal(latest[3].cpu, 30);
  assert.ok(st.storage.map.has(`m:1:${nowMin}`), 'server1 storage 行');
  assert.ok(st.storage.map.has(`m:2:${nowMin}`), 'server2 storage 行');
  assert.ok(st.storage.map.has(`m:3:${nowMin}`), 'server3 storage 行');
  // 单帧兼容（非 frames 数组）
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 4, minTs: nowMin, cpu: 40 }) });
  const latest2 = await (await call('/latest')).json();
  assert.equal(latest2[4].cpu, 40, '单帧格式兼容');
});

test('MetricsDO: /usage 用量计数，alarm 汇总到 storage 跨 evict 保留', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const state = mockState();
  const { inst, call } = mkMetrics(env, state);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 1 }) });
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 2 }) });
  await call('/latest');
  await call('/query?server_id=1');
  const usage = await (await call('/usage')).json();
  assert.equal(usage.counters.report, 2);
  assert.equal(usage.counters.latest, 1);
  assert.equal(usage.counters.query, 1);
  // alarm 将本周期计数累计到 storage 并清零内存
  await inst.alarm();
  const after = await (await call('/usage')).json();
  assert.equal(after.counters.report, 0, 'alarm 后内存清零');
  assert.equal(after.persisted.report, 2, '累计到 storage');
  assert.equal(after.persisted.latest, 1);
  assert.equal(after.persisted.query, 1);
  assert.equal(after.persisted.alarm, undefined, 'alarm 次数不持久化（全零跳过 put）');
  // 新实例（共享 storage）能读到累计总量
  const { inst: instB } = mkMetrics(env, state);
  await instB.alarm();
  const usageB = await (await instB.fetch(new Request('https://do.internal/usage'))).json();
  assert.equal(usageB.persisted.report, 2, '跨实例累计保留');
});

test('MetricsDO: /latest 增量 Map evict 后从 storage 恢复并回填（降额优化）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const state = mockState();
  const { call: callA } = mkMetrics(env, state);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  await callA('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 42 }) });
  // 模拟实例 evict：新建实例共享同一 storage，增量 Map 为空 → /latest 全量扫 storage 恢复
  const { inst: instB, call: callB } = mkMetrics(env, state);
  assert.equal(instB.latestByServer.size, 0, '新实例增量 Map 为空');
  const latest = await (await callB('/latest')).json();
  assert.equal(latest[1].cpu, 42, 'evict 后从 storage 恢复最新指标');
  assert.ok(instB.latestByServer.has(1), '恢复结果回填增量 Map');
  // 再次 /latest 直接走增量 Map，结果一致
  const latest2 = await (await callB('/latest')).json();
  assert.equal(latest2[1].cpu, 42);
  assert.equal(Object.keys(latest2).length, 1);
});

test('MetricsDO: query limit 截断只返回最近 N 条', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const { call } = mkMetrics(env, mockState());
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  for (let i = 0; i < 5; i++) {
    await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin - 4 + i, cpu: i }) });
  }
  const q = await (await call('/query?server_id=1&limit=2')).json();
  assert.deepEqual(q.map((x) => x.ts), [nowMin - 1, nowMin]);
});

test('MetricsDO: trim 只保留最近 720 分钟', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const { inst } = mkMetrics(env, mockState());
  const m = new Map();
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  m.set(nowMin - 800, { cpu: 1 });
  m.set(nowMin - 10, { cpu: 2 });
  inst.trim(m);
  assert.equal(m.size, 1);
  assert.equal([...m.keys()][0], nowMin - 10);
});

test('MetricsDO: scheduleArchive 无条件注册 alarm（清理/保留期不依赖归档开关）', async () => {
  const env1 = makeEnv();
  const st1 = mockState();
  const { inst: inst1 } = mkMetrics(env1, st1);
  await inst1.scheduleArchive();
  assert.ok(st1.storage.alarmTs > 0, '默认归档开启 → 注册 alarm');

  const env2 = makeEnv({ ARCHIVE_TO_D1: '0' });
  const st2 = mockState();
  const { inst: inst2 } = mkMetrics(env2, st2);
  await inst2.scheduleArchive();
  assert.ok(st2.storage.alarmTs > 0, '归档关闭也注册 alarm（防 storage 热区 / audit_logs 无限增长）');
});

// ---------------- MetricsDO：归档 / 保留期 ----------------
test('MetricsDO: alarm 归档超 1 小时数据到 D1；热区保留 12h，不重复归档', async () => {
  const env = makeEnv();
  const st = mockState();
  const { inst, call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const oldTs = nowMin - 90;
  const recentTs = nowMin - 5;
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: oldTs, cpu: 5, mem_used: 1000, mem_total: 8000 }) });
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: recentTs, cpu: 6 }) });

  await inst.alarm();

  const rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows.results.length, 1, '归档：仅 >60min 的行写入 D1');
  assert.equal(rows.results[0].ts, oldTs);
  assert.equal(rows.results[0].cpu, 5);
  assert.equal(rows.results[0].mem_total, 8000, '归档保留 mem_total');

  // 热区保留 12h（60min 前的行仍在热区，≤12h 查询完整）
  const q = await (await call('/query?server_id=1&limit=100')).json();
  assert.deepEqual(q.map((x) => x.ts).sort((a, b) => a - b), [oldTs, recentTs], '热区保留归档前数据');

  await inst.alarm();
  const rows2 = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows2.results.length, 1, '二次归档不重复写 D1（OR IGNORE）');
});

test('MetricsDO: 增量归档按水位推进，跨线行直接归档、重复不重复写（降额优化）', async () => {
  const env = makeEnv();
  const st = mockState();
  const { call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  // 跨过归档线的行（now-61）→ /report 时直接归档
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin - 61, cpu: 1 }) });
  let rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows.results.length, 1, '跨线行直接归档');
  // 当前分钟行 → 未跨线不立即归档
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 2 }) });
  rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows.results.length, 1, '未跨线行不归档');
  // 重复上报跨线行 → OR IGNORE 不重复写
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin - 61, cpu: 3 }) });
  rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows.results.length, 1, '重复跨线行不重复写');
  // 水位已持久化
  assert.ok(st.storage.map.has('arc:1'), '水位已持久化');
});

test('MetricsDO: evict 后空 Map 上报水位不误推进，fullSweep 兜底归档（回归修复）', async () => {
  const env = makeEnv();
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const oldTs = nowMin - 180; // 3h 前（<= 归档线，应归档）
  // 模拟实例 A 已写入 storage：历史行 + 水位落后（实例 A 最后一次推进位置）
  const state = mockState({
    [`m:1:${oldTs}`]: JSON.stringify({ cpu: 30, mem_used: 100, net_in: 1, net_out: 2 }),
    'arc:1': String(oldTs - 30),
  });
  // 实例 B（evict 后）：内存空 Map，慢采首帧上报当前分钟
  const { inst, call } = mkMetrics(env, state);
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 50 }) });
  // 修复后：空 Map 不推进水位（storage 历史行仍待归档，不会被 fullSweep 永久跳过）
  assert.equal(await state.storage.get('arc:1'), String(oldTs - 30), '空 Map 时水位不误推进');
  let rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows.results.length, 0, '空 Map 未误归档历史行');
  // fullSweep 兜底：归档水位之后的 storage 行并推进水位
  await inst.fullSweep(true);
  rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows.results.length, 1, 'fullSweep 兜底归档历史行');
  assert.equal(rows.results[0].cpu, 30);
  assert.equal(Number(await state.storage.get('arc:1')), oldTs, 'fullSweep 推进水位到实际归档行');
});

test('MetricsDO: evict 后热写空 Map 不误判已加载，/query 完整恢复（回归修复）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  // storage 预置历史行（实例 A evict 前写入的最近数据）
  const state = mockState({
    [`m:1:${nowMin - 5}`]: JSON.stringify({ cpu: 10 }),
    [`m:1:${nowMin - 30}`]: JSON.stringify({ cpu: 20 }),
  });
  const { call } = mkMetrics(env, state);
  // 实例 B 热写当前分钟（创建空 Map，不应视为「已完整加载」）
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 30 }) });
  // /query 应完整恢复：storage 历史行 + 本次行（修复前 data.has 误判导致缺最近 ~1h）
  const q = await (await call('/query?server_id=1&limit=100')).json();
  const tsList = q.map((x) => x.ts).sort((a, b) => a - b);
  assert.deepEqual(tsList, [nowMin - 30, nowMin - 5, nowMin], '热写空 Map 后 /query 仍完整恢复 storage 数据');
});

test('MetricsDO: evict 后首帧跨线行推进水位前兜底归档滞后 Storage 行（窄时序）', async () => {
  const env = makeEnv();
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const xTs = nowMin - 200; // 仅存在于 Storage 的滞后历史行（arcTs < xTs < minTs <= cutoff）
  const minTs = nowMin - 61; // 新实例首帧上报的跨线行
  const state = mockState({
    [`m:1:${xTs}`]: JSON.stringify({ cpu: 11 }),
    'arc:1': String(nowMin - 300), // 旧水位（更早）
  });
  const { call } = mkMetrics(env, state);
  // 新实例（空 Map，未完整加载）首帧跨线行：推进水位前必须兜底 (arcTs, minTs] 的 Storage 滞后行
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs, cpu: 22 }) });
  const rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows.results.length, 2, '滞后 Storage 行与跨线行均归档');
  assert.equal(rows.results.find((r) => r.ts === xTs).cpu, 11);
  assert.equal(rows.results.find((r) => r.ts === minTs).cpu, 22);
  assert.equal(Number(await state.storage.get('arc:1')), minTs, '水位推进到跨线行');
});

test('MetricsDO: /query 已加载后跨线补报不跳过 (arcTs,minTs) 内存行（残余边界）', async () => {
  const env = makeEnv();
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const xTs = nowMin - 200; // (arcTs, minTs) 之间的历史行
  const minTs = nowMin - 61; // 跨线补报行
  const state = mockState({
    [`m:1:${xTs}`]: JSON.stringify({ cpu: 11 }),
    'arc:1': String(nowMin - 300),
  });
  const { call } = mkMetrics(env, state);
  // 先 /query 触发 loadHot → hotLoaded 置位（内存已完整，兜底分支不再介入）
  await call('/query?server_id=1&limit=100');
  // 随后跨线补报：区间循环必须覆盖 (arcTs, minTs)（不能从 maxArchived+1 起跳）
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs, cpu: 22 }) });
  const rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows.results.length, 2, '历史行与跨线行均归档');
  assert.equal(rows.results.find((r) => r.ts === xTs).cpu, 11);
  assert.equal(rows.results.find((r) => r.ts === minTs).cpu, 22);
});

test('MetricsDO: 兜底 listStorage 瞬时失败不推进水位，恢复后 fullSweep 归档（残余边界）', async () => {
  const env = makeEnv();
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const xTs = nowMin - 200;
  const minTs = nowMin - 61;
  const state = mockState({
    [`m:1:${xTs}`]: JSON.stringify({ cpu: 11 }),
    'arc:1': String(nowMin - 300),
  });
  const { inst, call } = mkMetrics(env, state);
  // 模拟 Storage list 瞬时不可用（兜底失败 → 不推进水位，正确性优先）
  const origList = state.storage.list.bind(state.storage);
  state.storage.list = async () => { throw new Error('storage unavailable'); };
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs, cpu: 22 }) });
  assert.equal(Number(await state.storage.get('arc:1')), nowMin - 300, '兜底失败时不推进水位');
  // 恢复后由 fullSweep（每 ~1h 可靠执行）兜底归档滞后行并推进水位
  state.storage.list = origList;
  await inst.fullSweep(true);
  assert.ok(Number(await state.storage.get('arc:1')) >= xTs, 'fullSweep 兜底推进水位');
  const rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows.results.length, 2, '滞后行与跨线行均归档');
  assert.equal(rows.results.find((r) => r.ts === xTs).cpu, 11);
});

test('MetricsDO: 新服务器 arcTs=0 水位不误推进，避免大区间空循环（回归修复）', async () => {
  const env = makeEnv();
  const state = mockState(); // 无 arc key → arcTs=0（新服务器）
  const { call } = mkMetrics(env, state);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  // 新服务器首次上报（当前分钟，未跨归档线）：不得把水位推进到 cutoff（否则从分钟 1 空循环约 4000 万次）
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 1 }) });
  assert.equal(await state.storage.get('arc:1'), undefined, '新服务器水位未推进到 cutoff');
  const rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows.results.length, 0, '当前分钟不归档');
  // 跨线补报：直接归档并推进到实际行
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin - 61, cpu: 2 }) });
  assert.equal(Number(await state.storage.get('arc:1')), nowMin - 61, '直接归档后水位推进到实际行');
});

test('MetricsDO: ARCHIVE_TO_D1=0 时 alarm 仍清理超 12h 的 storage 热区（防无限增长）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const st = mockState();
  const { inst, call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin - 730, cpu: 5 }) });
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin - 5, cpu: 6 }) });
  assert.ok(st.storage.map.has(`m:1:${nowMin - 730}`), '超 12h 行已写入 storage');
  assert.ok(st.storage.map.has(`m:1:${nowMin - 5}`), '新行已写入 storage');

  // >12h 行清理在降频 fullSweep（每 6 次 alarm ≈1h）中执行
  await inst.fullSweep(false);

  // 归档关闭：超 12h 行仍从 storage 删除（不落 D1），12h 内行保留（供 ≤12h 查询）
  assert.equal(st.storage.map.has(`m:1:${nowMin - 730}`), false, '超 12h 行被清理');
  assert.ok(st.storage.map.has(`m:1:${nowMin - 5}`), '12h 内行保留');
  const rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows.results.length, 0, '归档关闭不写 D1');
  assert.ok(st.storage.alarmTs > 0, 'alarm 重新注册');
});

test('MetricsDO: 高频 report 不后推已有 alarm（归档按期执行）', async () => {
  const env = makeEnv();
  const st = mockState();
  const { inst, call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 1 }) });
  assert.ok(st.storage.alarmTs > 0, '首次 report 注册 alarm');
  const t1 = st.storage.alarmTs;
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 2 }) });
  assert.equal(st.storage.alarmTs, t1, '再次 report 不后推 alarm');
  await inst.alarm();
  assert.ok(st.storage.alarmTs >= Date.now(), 'alarm 执行后固定重排');
});

test('MetricsDO: ARCHIVE_TO_D1=0 时 alarm 仍执行 D1 保留期清理（audit_logs 90 天）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const st = mockState();
  const { inst } = mkMetrics(env, st);
  await env.DB.prepare("INSERT INTO audit_logs (user_id, action, created_at) VALUES (1, 'old', datetime('now', '-100 days'))").run();
  await env.DB.prepare("INSERT INTO audit_logs (user_id, action, created_at) VALUES (1, 'recent', datetime('now', '-5 days'))").run();

  await inst.alarm();

  const rows = await env.DB.prepare('SELECT action FROM audit_logs').all();
  assert.deepEqual(rows.results.map((r) => r.action), ['recent']);
});

test('MetricsDO: alarm 按 30 天保留期清理过期行', async () => {
  const env = makeEnv();
  const { inst } = mkMetrics(env, mockState());
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  await env.DB.prepare('INSERT OR IGNORE INTO metrics_min (server_id, ts, cpu) VALUES (?,?,?)').bind(1, nowMin - 31 * 1440, 1).run();
  await env.DB.prepare('INSERT OR IGNORE INTO metrics_min (server_id, ts, cpu) VALUES (?,?,?)').bind(1, nowMin - 10, 2).run();

  await inst.alarm();

  const rows = await env.DB.prepare('SELECT ts FROM metrics_min ORDER BY ts').all();
  assert.deepEqual(rows.results.map((r) => r.ts), [nowMin - 10]);
});

test('MetricsDO: alarm 清理超过 90 天的审计日志，保留近期', async () => {
  const env = makeEnv();
  const { inst } = mkMetrics(env, mockState());
  await env.DB.prepare("INSERT INTO audit_logs (user_id, action, created_at) VALUES (1, 'server.create', datetime('now', '-100 days'))").run();
  await env.DB.prepare("INSERT INTO audit_logs (user_id, action, created_at) VALUES (1, 'server.delete', datetime('now', '-5 days'))").run();

  await inst.alarm();

  const rows = await env.DB.prepare('SELECT action FROM audit_logs').all();
  assert.deepEqual(rows.results.map((r) => r.action), ['server.delete']);
});

test('MetricsDO: alarm 离线/恢复告警（DO Storage 状态去重）', async () => {
  const env = makeEnv();
  await insertServer(env, 'k1', 'srv1', { last_seen: Math.floor(Date.now() / 1000) - 1000 });
  await env.DB.prepare("INSERT INTO kv_json (key, value) VALUES ('settings', ?)")
    .bind(JSON.stringify({ alerts: { webhook_url: 'https://example.com/hook', offline_after_s: 180 } })).run();
  const st = mockState();
  const { inst } = mkMetrics(env, st);
  const cap = captureFetch();
  try {
    await inst.alarm();
    assert.equal(cap.calls.length, 1);
    const body = JSON.parse(cap.calls[0].init.body);
    assert.equal(body.event, 'offline');
    assert.equal(body.server.name, 'srv1');
    assert.equal(st.storage.map.get('alert:offline:1'), 'off');

    // 仍离线 → 不重复告警
    await inst.alarm();
    assert.equal(cap.calls.length, 1);

    // 恢复在线 → recovered
    await env.DB.prepare('UPDATE servers SET last_seen = ? WHERE id = 1').bind(Math.floor(Date.now() / 1000)).run();
    await inst.alarm();
    assert.equal(cap.calls.length, 2);
    assert.equal(JSON.parse(cap.calls[1].init.body).event, 'recovered');
    assert.equal(st.storage.map.get('alert:offline:1'), 'on');
  } finally {
    cap.restore();
  }
});

// ---------------- MetricsDO：阈值告警 / 探活告警（/report 顺风车，单实例去重） ----------------
test('MetricsDO: /report 顺风车触发 CPU 阈值告警，冷却期内抑制', async () => {
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO kv_json (key, value) VALUES ('settings', ?)")
    .bind(JSON.stringify({
      alerts: { webhook_url: 'https://example.com/{token}?ev={event}&name={server_name}', webhook_token: 'tok', cpu_pct: 90, mem_pct: 90, cooldown_min: 30 },
    })).run();
  const { call } = mkMetrics(env, mockState());
  const cap = captureFetch();
  try {
    const nowMin = Math.floor(Date.now() / 1000 / 60);
    await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, serverName: 'srv1', minTs: nowMin, cpu: 95 }) });
    assert.equal(cap.calls.length, 1);
    assert.match(cap.calls[0].url, /^https:\/\/example\.com\/tok\?ev=alert&name=srv1$/);
    const body = JSON.parse(cap.calls[0].init.body);
    assert.equal(body.event, 'alert');
    assert.equal(body.server.id, 1);
    assert.deepEqual(body.details, ['CPU 95.0% >= 90%']);

    // 冷却期内再次触发 → 抑制（同一 DO 实例状态去重）
    await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, serverName: 'srv1', minTs: nowMin, cpu: 98 }) });
    assert.equal(cap.calls.length, 1);

    // 未达阈值不触发
    await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, serverName: 'srv1', minTs: nowMin, cpu: 50 }) });
    assert.equal(cap.calls.length, 1);
  } finally {
    cap.restore();
  }
});

test('MetricsDO: /report 内存/磁盘/负载阈值告警', async () => {
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO kv_json (key, value) VALUES ('settings', ?)")
    .bind(JSON.stringify({ alerts: { webhook_url: 'https://example.com/hook', cpu_pct: 90, mem_pct: 90, disk_pct: 80, load: 5, cooldown_min: 30 } })).run();
  const { call } = mkMetrics(env, mockState());
  const cap = captureFetch();
  try {
    const nowMin = Math.floor(Date.now() / 1000 / 60);
    await call('/report', {
      method: 'POST',
      body: JSON.stringify({
        serverId: 2, serverName: 'srv2', minTs: nowMin,
        cpu: 10, mem_used: 900, mem_total: 1000, // mem 90%
        extra: { disk: [{ m: '/', u: 95 }], load1: 8 },
      }),
    });
    assert.equal(cap.calls.length, 1);
    const details = JSON.parse(cap.calls[0].init.body).details;
    assert.deepEqual(details, ['内存 90.0% >= 90%', '磁盘 / 95% >= 80%', '负载 8 >= 5']);
  } finally {
    cap.restore();
  }
});

test('MetricsDO: /report 探活 down/recovered/冷却抑制', async () => {
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO kv_json (key, value) VALUES ('settings', ?)")
    .bind(JSON.stringify({ alerts: { webhook_url: 'https://example.com/hook', cooldown_min: 30 } })).run();
  const { call } = mkMetrics(env, mockState());
  const cap = captureFetch();
  try {
    const nowMin = Math.floor(Date.now() / 1000 / 60);
    const report = (probes) => call('/report', {
      method: 'POST',
      body: JSON.stringify({ serverId: 1, serverName: 'srv1', minTs: nowMin, probes }),
    });

    await report([{ name: 'web', ok: false }]);
    assert.equal(cap.calls.length, 1);
    assert.equal(JSON.parse(cap.calls[0].init.body).event, 'probe_down');

    // 冷却内再次失败 → 抑制
    await report([{ name: 'web', ok: false }]);
    assert.equal(cap.calls.length, 1);

    // 恢复 → recovered
    await report([{ name: 'web', ok: true }]);
    assert.equal(cap.calls.length, 2);
    assert.equal(JSON.parse(cap.calls[1].init.body).event, 'probe_recovered');

    // 恢复后再次失败 → 立即触发 down（状态已回 ok，冷却不生效）
    await report([{ name: 'web', ok: false }]);
    assert.equal(cap.calls.length, 3);
    assert.equal(JSON.parse(cap.calls[2].init.body).event, 'probe_down');

    // 持续失败 → 冷却抑制
    await report([{ name: 'web', ok: false }]);
    assert.equal(cap.calls.length, 3);
  } finally {
    cap.restore();
  }
});

test('MetricsDO: 告警冷却状态持久化，新实例恢复不重复告警', async () => {
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO kv_json (key, value) VALUES ('settings', ?)")
    .bind(JSON.stringify({ alerts: { webhook_url: 'https://example.com/hook', cpu_pct: 90, cooldown_min: 30 } })).run();
  const st = mockState();
  const cap = captureFetch();
  try {
    const { call: call1 } = mkMetrics(env, st);
    const nowMin = Math.floor(Date.now() / 1000 / 60);
    await call1('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, serverName: 's1', minTs: nowMin, cpu: 95 }) });
    assert.equal(cap.calls.length, 1, '首次超阈值触发告警');
    assert.ok(st.storage.map.has('alert:1:cpu'), '冷却状态已持久化');

    // 模拟 evict：新实例共享同一 storage → 恢复冷却状态，冷却期内不重复告警
    const { call: call2 } = mkMetrics(env, st);
    await call2('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, serverName: 's1', minTs: nowMin, cpu: 98 }) });
    assert.equal(cap.calls.length, 1, '新实例恢复冷却，不重复告警');
  } finally { cap.restore(); }
});

test('MetricsDO: 探活状态持久化，新实例恢复去重', async () => {
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO kv_json (key, value) VALUES ('settings', ?)")
    .bind(JSON.stringify({ alerts: { webhook_url: 'https://example.com/hook', cooldown_min: 30 } })).run();
  const st = mockState();
  const cap = captureFetch();
  try {
    const { call: call1 } = mkMetrics(env, st);
    const nowMin = Math.floor(Date.now() / 1000 / 60);
    await call1('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, serverName: 's1', minTs: nowMin, probes: [{ name: 'web', ok: false }] }) });
    assert.equal(cap.calls.length, 1, '首次失败触发 probe_down');
    assert.ok(st.storage.map.has('probe:1:web'), '探活状态已持久化');

    // 新实例 → 恢复失败状态，冷却期内再次失败不重复告警
    const { call: call2 } = mkMetrics(env, st);
    await call2('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, serverName: 's1', minTs: nowMin, probes: [{ name: 'web', ok: false }] }) });
    assert.equal(cap.calls.length, 1, '新实例恢复探活状态，冷却内不重复告警');
  } finally { cap.restore(); }
});

test('MetricsDO: /drop 清理 storage 告警/探活状态', async () => {
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO kv_json (key, value) VALUES ('settings', ?)")
    .bind(JSON.stringify({ alerts: { webhook_url: 'https://example.com/hook', cpu_pct: 90, cooldown_min: 30 } })).run();
  const st = mockState();
  const { call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, serverName: 's1', minTs: nowMin, cpu: 95, probes: [{ name: 'web', ok: false }] }) });
  assert.ok(st.storage.map.has('alert:1:cpu'), '告警状态已写入');
  assert.ok(st.storage.map.has('probe:1:web'), '探活状态已写入');
  await call('/drop', { method: 'POST', body: JSON.stringify({ server_id: 1 }) });
  assert.equal(st.storage.map.has('alert:1:cpu'), false, 'drop 清理告警状态');
  assert.equal(st.storage.map.has('probe:1:web'), false, 'drop 清理探活状态');
});

// ---------------- PanelDO ----------------
test('PanelDO: /viewers 只统计已鉴权观看者；其他路径 404', async () => {
  const env = makeEnv();
  const ws1 = { deserializeAttachment: () => 'tok1' };
  const ws2 = { deserializeAttachment: () => 'tok2' };
  const ws3 = { deserializeAttachment: () => null }; // 未鉴权
  const inst = new PanelDO({ getWebSockets: () => [ws1, ws2, ws3] }, env);
  const res = await inst.fetch(new Request('https://do.internal/viewers'));
  assert.deepEqual(await res.json(), { count: 2 });
  assert.equal((await inst.fetch(new Request('https://do.internal/other'))).status, 404);
});

test('PanelDO: 首帧 auth 鉴权通过后推送，非法 token 断开并触发快采唤醒', async () => {
  const env = makeEnv();
  const token = await I.signJwt({ uid: 1, username: 'admin', role: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, env);
  await insertServer(env, 'k1', 'srv-a');

  // 非法 token → 关闭
  const bad = { closed: false, deserializeAttachment: () => null, send() {}, close() { this.closed = true; } };
  const inst = new PanelDO({ getWebSockets: () => [bad] }, env);
  await inst.webSocketMessage(bad, JSON.stringify({ type: 'auth', token: 'bogus' }));
  assert.equal(bad.closed, true);

  // 合法 token → 鉴权通过（attachment 存 token），首位观看者触发各分片快采唤醒，之后 sync 推送列表
  const ws = {
    closed: false, attachment: null, sent: [],
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(t) { this.attachment = t; },
    send(m) { this.sent.push(m); },
    close() { this.closed = true; },
  };
  const inst2 = new PanelDO({ getWebSockets: () => [ws] }, env);
  await inst2.webSocketMessage(ws, JSON.stringify({ type: 'auth', token }));
  assert.equal(ws.closed, false);
  assert.equal(ws.attachment, token);
  assert.ok(env.TERMINAL.calls.some((c) => c.path === '/rpc/set_viewers')); // 快采唤醒

  await inst2.webSocketMessage(ws, 'sync');
  assert.equal(ws.sent.length, 1);
  const list = JSON.parse(ws.sent[0]);
  assert.deepEqual(list.map((s) => s.name), ['srv-a']);
});

test('PanelDO: 服务器列表与鉴权缓存（3s/5s TTL，降 D1 读）', async () => {
  const env = makeEnv();
  const token = await I.signJwt({ uid: 1, username: 'admin', role: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, env);
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)').bind('k1', 'srv-a', 1, 'h').run();
  const inst = new PanelDO({ getWebSockets: () => [] }, env);
  await inst.webSocketMessage({ deserializeAttachment: () => token, send() {} }, 'sync'); // 首次查 D1
  assert.ok(inst.listCache && inst.listCache.rows.length === 1, '列表已缓存');
  assert.ok(inst.authCache.has(token), '鉴权已缓存');
  // 二次 sync 走缓存（不重复查 D1）
  const sent = [];
  await inst.webSocketMessage({ deserializeAttachment: () => token, send: (m) => sent.push(m) }, 'sync');
  assert.equal(JSON.parse(sent[0]).length, 1, '缓存列表返回');
});

test('PanelDO: PAT 撤销后 sync 关闭连接（不再静默忽略）', async () => {
  const env = makeEnv();
  const inst = new PanelDO({ getWebSockets: () => [] }, env);
  // 已撤销 token（D1 中不存在）→ sync 时鉴权失败应关闭连接
  const ws = {
    closed: false, attachment: 'cfp_revoked_token',
    deserializeAttachment() { return this.attachment; },
    send() {}, close() { this.closed = true; },
  };
  await inst.webSocketMessage(ws, 'sync');
  assert.equal(ws.closed, true, '撤销后观看者连接被关闭');
});

test('TerminalDO: PAT 撤销后浏览器消息关闭连接（重校验）', async () => {
  const env = makeEnv();
  const inst = new TerminalDO(mockState(), env);
  const sess = { streamId: '0-sid', serverId: 1, creatorUserId: 1, createdAt: Date.now(), userWs: null, agentWs: null, userBuf: [] };
  inst.sessions.set('0-sid', sess);
  const ws = {
    closed: false,
    deserializeAttachment: () => ({ role: 'user', sid: '0-sid', serverId: 1, creatorUserId: 1, type: 'terminal', createdAt: Date.now(), patToken: 'cfp_revoked_token' }),
    send() {}, close() { this.closed = true; },
  };
  sess.userWs = ws;
  await inst.webSocketMessage(ws, 'echo hi');
  assert.equal(ws.closed, true, 'PAT 撤销后输入即关闭连接');
});

test('PanelDO: /latest 共享缓存 + sync 频率下限（降额）', async () => {
  const env = makeEnv();
  const token = await I.signJwt({ uid: 1, username: 'admin', role: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, env);
  await insertServer(env, 'k1', 'srv-a');
  const ws = { attachment: token, deserializeAttachment: () => token, send() {}, close() {} };
  const inst = new PanelDO({ getWebSockets: () => [ws] }, env);
  const latestCalls = () => env.METRICS.calls.filter((c) => c.path === '/latest').length;
  // 首次 sync → 查 MetricsDO /latest（1 次 DO 事件）
  await inst.webSocketMessage(ws, 'sync');
  assert.equal(latestCalls(), 1, '首次 sync 查 /latest');
  // 2s 内再次 sync → 频率下限拦截（不触发全链路）
  await inst.webSocketMessage(ws, 'sync');
  assert.equal(latestCalls(), 1, '<2s sync 被拦截');
  // 非 sync 消息 → 忽略
  inst.syncAt.delete(ws);
  await inst.webSocketMessage(ws, 'hello');
  assert.equal(latestCalls(), 1, '非 sync 消息忽略');
  // 绕过频率下限后再 sync → 命中 /latest 共享缓存（仍不调 DO）
  inst.syncAt.delete(ws);
  await inst.webSocketMessage(ws, 'sync');
  assert.equal(latestCalls(), 1, '/latest 共享缓存命中');
});

test('PanelDO: webSocketError 兜底执行下线检查（最后观看者残留防护）', async () => {
  const env = makeEnv();
  const inst = new PanelDO({ getWebSockets: () => [] }, env); // 错误后该 ws 已不在连接表
  await inst.webSocketError({ deserializeAttachment: () => 'tok' }, 'boom');
  assert.ok(
    env.TERMINAL.calls.some((c) => c.path === '/rpc/set_viewers' && JSON.parse(c.init.body).count === 0),
    'error 后广播慢采（防观看者残留导致持续快采）'
  );
});

test('PanelDO: 切快采过渡期（30s 内）在线判定用慢宽限（防首次误判离线）', async () => {
  const env = makeEnv();
  const token = await I.signJwt({ uid: 1, username: 'admin', role: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, env);
  await insertServer(env, 'k1', 'srv-a', { last_seen: Math.floor(Date.now() / 1000) - 60 }); // 60s 前上报
  const ws = {
    attachment: null, sent: [],
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(t) { this.attachment = t; },
    send(m) { this.sent.push(m); },
  };
  const inst = new PanelDO({ getWebSockets: () => [ws] }, env);
  await inst.webSocketMessage(ws, JSON.stringify({ type: 'auth', token })); // 0→1 切快采
  assert.ok(inst.fastSince > 0, '切快采时刻已记录');
  // 过渡期内：慢宽限 180s → 60s 前上报仍在线（不误判离线）
  await inst.webSocketMessage(ws, 'sync');
  assert.equal(JSON.parse(ws.sent[0])[0].online, true, '过渡期慢宽限不误判离线');
  // 过渡期结束（fastSince 拨回 31s 前）→ 快宽限 15s → 60s 前上报判离线
  inst.fastSince = Date.now() - 31000;
  inst.syncAt.delete(ws); // 绕过 <2s 频率下限，模拟下一个 sync 周期
  await inst.webSocketMessage(ws, 'sync');
  assert.equal(JSON.parse(ws.sent[1])[0].online, false, '过渡期后快宽限生效');
});

test('PanelDO: webSocketMessage 按 token 推送过滤后的服务器列表', async () => {
  const env = makeEnv();
  const token = await I.signJwt({ uid: 1, username: 'admin', role: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, env);
  await insertServer(env, 'k1', 'srv-a');
  await insertServer(env, 'k2', 'srv-b');

  const sent = [];
  const inst = new PanelDO({ getWebSockets: () => [] }, env);
  await inst.webSocketMessage({ deserializeAttachment: () => token, send: (m) => sent.push(m) }, 'sync');
  assert.equal(sent.length, 1);
  const list = JSON.parse(sent[0]);
  assert.deepEqual(list.map((s) => s.name), ['srv-a', 'srv-b']);

  // 非法 token → 不发送
  await inst.webSocketMessage({ deserializeAttachment: () => 'bogus', send: (m) => sent.push(m) }, 'sync');
  assert.equal(sent.length, 1);
});

test('PanelDO: PAT 只看白名单内的服务器', async () => {
  const env = makeEnv();
  await insertServer(env, 'k1', 'srv-a');
  await insertServer(env, 'k2', 'srv-b');
  const pat = 'cfp_' + 'a'.repeat(64);
  const hash = await I.hashSecret(pat, env);
  await env.DB.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scopes, server_ids) VALUES (?,?,?,?,?)')
    .bind(1, 'pat', hash, JSON.stringify(['server:read']), JSON.stringify([1])).run();

  const sent = [];
  const inst = new PanelDO({ getWebSockets: () => [] }, env);
  await inst.webSocketMessage({ deserializeAttachment: () => pat, send: (m) => sent.push(m) }, 'sync');
  assert.deepEqual(JSON.parse(sent[0]).map((s) => s.name), ['srv-a']);
});

// ---------------- TerminalDO ----------------
test('TerminalDO: /rpc/set_viewers 按观看者数切换快/慢采', async () => {
  const env = makeEnv();
  const sent = [];
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, { send: (m) => sent.push(m), readyState: 1 });
  inst.agents.set(2, { send: (m) => sent.push(m), readyState: 1 });
  // 0→1 观看者 → 快采 3s
  let res = await inst.fetch(new Request('https://do.internal/rpc/set_viewers', { method: 'POST', body: JSON.stringify({ count: 1 }) }));
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [
    JSON.stringify({ type: 'set_report_interval', interval: 5 }),
    JSON.stringify({ type: 'set_report_interval', interval: 5 }),
  ]);
  // 1→0 观看者 → 慢采 120s
  res = await inst.fetch(new Request('https://do.internal/rpc/set_viewers', { method: 'POST', body: JSON.stringify({ count: 0 }) }));
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [
    JSON.stringify({ type: 'set_report_interval', interval: 5 }),
    JSON.stringify({ type: 'set_report_interval', interval: 5 }),
    JSON.stringify({ type: 'set_report_interval', interval: 120 }),
    JSON.stringify({ type: 'set_report_interval', interval: 120 }),
  ]);
});

test('TerminalDO: /rpc create 时 agent 离线 → 502 且不残留会话', async () => {
  const env = makeEnv();
  const st = mockState();
  const inst = new TerminalDO(st, env);
  const res = await inst.fetch(new Request('https://do.internal/rpc', {
    method: 'POST',
    body: JSON.stringify({ op: 'create', streamId: '0-abc', serverId: 1, creatorUserId: 1 }),
  }));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'agent offline');
  // 失败路径不落盘（内存 + storage 均无残留）
  assert.equal(inst.sessions.has('0-abc'), false, '不残留内存会话');
  assert.equal(st.storage.map.has('sess:0-abc'), false, '不残留持久化会话');
});

test('TerminalDO: /rpc create 下发 open_terminal，未确认时 5s 重发最多 3 次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const env = makeEnv();
    const sent = [];
    const agentWs = { send: (m) => sent.push(m), readyState: 1 };
    const inst = new TerminalDO(mockState(), env);
    inst.agents.set(1, agentWs);
    const res = await inst.fetch(new Request('https://do.internal/rpc', {
      method: 'POST',
      body: JSON.stringify({ op: 'create', streamId: '0-sid', serverId: 1, creatorUserId: 1 }),
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(sent, [JSON.stringify({ type: 'open_terminal', stream_id: '0-sid' })]);

    t.mock.timers.tick(5000); // 第 1 次重发
    assert.equal(sent.length, 2);
    t.mock.timers.tick(5000); // 第 2 次重发
    assert.equal(sent.length, 3);
    t.mock.timers.tick(5000); // 第 3 次重发后达上限放弃
    assert.equal(sent.length, 4);
    t.mock.timers.tick(5000); // 不再重发
    assert.equal(sent.length, 4);
  } finally {
    t.mock.timers.reset();
  }
});

test('TerminalDO: 控制通道 report 消息 → 落库 + 按观看者数下发间隔', async () => {
  const env = makeEnv();
  await insertServer(env, 'k1', 'srv1');
  const sent = [];
  const ws = {
    deserializeAttachment: () => ({ role: 'control', serverId: 1 }),
    send: (m) => sent.push(m),
    readyState: 1,
  };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, ws);

  await inst.webSocketMessage(ws, JSON.stringify({ type: 'report', cpu: 33, mem_used: 1, mem_total: 2 }));

  const row = await env.DB.prepare('SELECT * FROM servers WHERE id = 1').first();
  assert.ok(row.last_seen > 0); // 在线判定唯一依据 last_seen
  // 观看者数 0 → 慢采间隔 120
  assert.ok(sent.includes(JSON.stringify({ type: 'set_report_interval', interval: 120 })));
});

test('TerminalDO: terminal_ready 确认后停止重发', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const env = makeEnv();
    const sent = [];
    const agentWs = { send: (m) => sent.push(m), readyState: 1 };
    const inst = new TerminalDO(mockState(), env);
    inst.agents.set(1, agentWs);
    await inst.fetch(new Request('https://do.internal/rpc', {
      method: 'POST',
      body: JSON.stringify({ op: 'create', streamId: '0-sid', serverId: 1, creatorUserId: 1 }),
    }));
    assert.equal(sent.length, 1);

    // agent 回 terminal_ready → 停止重发
    await inst.webSocketMessage(agentWs, JSON.stringify({ type: 'terminal_ready', stream_id: '0-sid' }));
    t.mock.timers.tick(5000);
    assert.equal(sent.length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test('TerminalDO: /rpc open_file 下发确认重发，未确认时 5s 重发最多 3 次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const env = makeEnv();
    const sent = [];
    const agentWs = { send: (m) => sent.push(m), readyState: 1 };
    const inst = new TerminalDO(mockState(), env);
    inst.agents.set(1, agentWs);
    const res = await inst.fetch(new Request('https://do.internal/rpc', {
      method: 'POST',
      body: JSON.stringify({ op: 'open_file', streamId: '0-fid', serverId: 1, creatorUserId: 1 }),
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(sent, [JSON.stringify({ type: 'open_file', stream_id: '0-fid' })]);

    t.mock.timers.tick(5000); // 第 1 次重发（重发的仍是 open_file 类型）
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], JSON.stringify({ type: 'open_file', stream_id: '0-fid' }));
    t.mock.timers.tick(5000); // 第 2 次重发
    assert.equal(sent.length, 3);
    t.mock.timers.tick(5000); // 第 3 次重发后达上限放弃
    assert.equal(sent.length, 4);
    t.mock.timers.tick(5000); // 不再重发
    assert.equal(sent.length, 4);
  } finally {
    t.mock.timers.reset();
  }
});

test('TerminalDO: file_ready 确认后停止 open_file 重发', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const env = makeEnv();
    const sent = [];
    const agentWs = { send: (m) => sent.push(m), readyState: 1 };
    const inst = new TerminalDO(mockState(), env);
    inst.agents.set(1, agentWs);
    await inst.fetch(new Request('https://do.internal/rpc', {
      method: 'POST',
      body: JSON.stringify({ op: 'open_file', streamId: '0-fid', serverId: 1, creatorUserId: 1 }),
    }));
    assert.equal(sent.length, 1);

    // agent 回 file_ready → 停止重发
    await inst.webSocketMessage(agentWs, JSON.stringify({ type: 'file_ready', stream_id: '0-fid' }));
    t.mock.timers.tick(5000);
    assert.equal(sent.length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test('TerminalDO: 文件写操作指令写审计（delete/zip/rename + write 首块）', async () => {
  const env = makeEnv();
  const inst = new TerminalDO(mockState(), env);
  const userWs = { send() {}, close() {} };
  const agentWs = { send() {}, readyState: 1 };
  // 模拟已鉴权文件会话（首帧鉴权会写入 creatorUser）
  inst.sessions.set('0-fid', {
    sid: '0-fid', streamId: '0-fid', serverId: 1, creatorUserId: 7, creatorUser: 'alice',
    type: 'file', createdAt: Date.now(), userWs, agentWs, userBuf: [], agentBuf: [],
  });
  const audits = async (action) => {
    const rows = await env.DB.prepare('SELECT * FROM audit_logs WHERE action = ?').bind(action).all();
    return rows.results;
  };

  // delete / rename / zip 各记一条
  await inst.webSocketMessage(userWs, JSON.stringify({ type: 'delete', path: '/tmp/a.txt' }));
  await inst.webSocketMessage(userWs, JSON.stringify({ type: 'rename', path: '/tmp/a.txt', new_name: 'b.txt' }));
  await inst.webSocketMessage(userWs, JSON.stringify({ type: 'zip', path: '/opt/dir' }));
  // write 仅首块（offset=0）记一条，后续块不重复
  await inst.webSocketMessage(userWs, JSON.stringify({ type: 'write', path: '/tmp/up.bin', offset: 0, commit: false }));
  await inst.webSocketMessage(userWs, JSON.stringify({ type: 'write', path: '/tmp/up.bin', offset: 512, commit: true }));

  const dels = await audits('file.delete');
  assert.equal(dels.length, 1);
  assert.equal(dels[0].username, 'alice');
  assert.equal(dels[0].target_server_id, 1);
  assert.equal(dels[0].detail, '/tmp/a.txt');

  const rens = await audits('file.rename');
  assert.equal(rens.length, 1);
  assert.equal(rens[0].detail, '/tmp/a.txt → b.txt');

  const zips = await audits('file.zip');
  assert.equal(zips.length, 1);
  assert.equal(zips[0].detail, '/opt/dir');

  const wrs = await audits('file.write');
  assert.equal(wrs.length, 1, 'write 仅首块记录一次');
  assert.equal(wrs[0].detail, '/tmp/up.bin');

  // 非文件指令（终端输入等）不产生审计
  const all = await env.DB.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action LIKE 'file.%'").all();
  assert.equal(Number(all.results[0].c), 4, '仅 4 条文件审计（delete/rename/zip/write）');
});

test('TerminalDO: /rpc/exec 下发 exec 指令，收到 exec_result 后返回结果', async () => {
  const env = makeEnv();
  const sent = [];
  const agentWs = { send: (m) => sent.push(m), readyState: 1 };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, agentWs);

  const pending = inst.fetch(new Request('https://do.internal/rpc/exec', {
    method: 'POST',
    body: JSON.stringify({ serverId: 1, command: 'echo hi', timeoutMs: 5000 }),
  }));
  // fetch 内部先 await request.json()，send 发生在下一微任务；等一拍再断言
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, 1, 'exec 指令已下发');
  const cmd = JSON.parse(sent[0]);
  assert.equal(cmd.type, 'exec');
  assert.equal(cmd.command, 'echo hi');
  assert.equal(cmd.timeout_s, 5);
  assert.ok(cmd.exec_id.startsWith('e-'));

  // agent 回 exec_result → resolve
  await inst.webSocketMessage(agentWs, JSON.stringify({
    type: 'exec_result', exec_id: cmd.exec_id,
    stdout: 'hi\n', stderr: '', exit_code: 0, timed_out: false,
  }));
  const res = await pending;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { exit_code: 0, stdout: 'hi\n', stderr: '', timed_out: false, error: null });
  assert.equal(inst.pendingExec.size, 0, '完成后清理 pending');
});

test('TerminalDO: /rpc/exec agent 回执 error（DISABLE_EXEC）透传', async () => {
  const env = makeEnv();
  const sent = [];
  const agentWs = { send: (m) => sent.push(m), readyState: 1 };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, agentWs);
  const pending = inst.fetch(new Request('https://do.internal/rpc/exec', {
    method: 'POST',
    body: JSON.stringify({ serverId: 1, command: 'echo hi', timeoutMs: 5000 }),
  }));
  await new Promise((r) => setTimeout(r, 0));
  const cmd = JSON.parse(sent[0]);
  // agent 回执带 error（exec disabled）
  await inst.webSocketMessage(agentWs, JSON.stringify({
    type: 'exec_result', exec_id: cmd.exec_id,
    stdout: '', stderr: '', exit_code: null, timed_out: false, error: 'exec disabled (DISABLE_EXEC=1)',
  }));
  const res = await pending;
  const body = await res.json();
  assert.equal(body.error, 'exec disabled (DISABLE_EXEC=1)');
  assert.equal(body.exit_code, null);
});

test('TerminalDO: /rpc/exec agent 离线 → 502', async () => {
  const env = makeEnv();
  const inst = new TerminalDO(mockState(), env);
  const res = await inst.fetch(new Request('https://do.internal/rpc/exec', {
    method: 'POST',
    body: JSON.stringify({ serverId: 1, command: 'echo hi' }),
  }));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'agent offline');
});

test('TerminalDO: /rpc/exec 超时未收到结果 → 返回超时错误并清理 pending', async () => {
  const env = makeEnv();
  const agentWs = { send: () => {}, readyState: 1 };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, agentWs);
  const pending = inst.fetch(new Request('https://do.internal/rpc/exec', {
    method: 'POST',
    body: JSON.stringify({ serverId: 1, command: 'sleep 99', timeoutMs: 1000 }),
  }));
  const res = await pending; // 真实 1s 超时 → resolve
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.error, /timed out after 1s/);
  assert.equal(inst.pendingExec.size, 0, '超时后清理 pending');
});

test('TerminalDO: 僵尸会话超 TTL 由 alarm 清理，未到期安排下次 alarm', async () => {
  const env = makeEnv();
  const st = mockState();
  const inst = new TerminalDO(st, env);
  const now = Date.now();
  const TTL = 10 * 60 * 1000; // SESSION_TTL_MS
  // 过期僵尸 → 直接清掉，其 pendingOpen 也清理
  inst.sessions.set('0-old', { streamId: '0-old', serverId: 1, creatorUserId: 1, createdAt: now - TTL - 1000, userWs: null, agentWs: null });
  inst.pendingOpen.set('0-old', { tries: 0, timer: null });
  // 未过期僵尸 → 保留并安排 alarm 到其到期时间
  inst.sessions.set('0-young', { streamId: '0-young', serverId: 1, creatorUserId: 1, createdAt: now - 1000, userWs: null, agentWs: null });
  // 任一端有连接 → 不回收（即使创建很久）
  inst.sessions.set('0-live', { streamId: '0-live', serverId: 1, creatorUserId: 1, createdAt: now - TTL * 2, userWs: {}, agentWs: null });

  await inst.alarm();

  assert.equal(inst.sessions.has('0-old'), false);
  assert.equal(inst.pendingOpen.has('0-old'), false);
  assert.equal(inst.sessions.has('0-young'), true);
  assert.equal(inst.sessions.has('0-live'), true);
  // 安排了 alarm：最早僵尸到期时间 +1s
  assert.equal(st.storage.alarmTs, now - 1000 + TTL + 1000);
});

test('TerminalDO: 每服务器并发会话上限，超限 429（H-04）', async () => {
  const env = makeEnv();
  const inst = new TerminalDO(mockState(), env);
  const agentWs = { send() {}, readyState: 1 };
  inst.agents.set(1, agentWs);
  for (let i = 0; i < 8; i++) {
    const r = await inst.fetch(new Request('https://do.internal/rpc', {
      method: 'POST',
      body: JSON.stringify({ op: 'create', streamId: `0-s${i}`, serverId: 1, creatorUserId: 1 }),
    }));
    assert.equal(r.status, 200, `第 ${i + 1} 个创建成功`);
  }
  const over = await inst.fetch(new Request('https://do.internal/rpc', {
    method: 'POST',
    body: JSON.stringify({ op: 'create', streamId: '0-over', serverId: 1, creatorUserId: 1 }),
  }));
  assert.equal(over.status, 429, '超限返回 429');
  // 其他服务器不受影响
  inst.agents.set(2, { send() {}, readyState: 1 });
  const other = await inst.fetch(new Request('https://do.internal/rpc', {
    method: 'POST',
    body: JSON.stringify({ op: 'create', streamId: '1-other', serverId: 2, creatorUserId: 1 }),
  }));
  assert.equal(other.status, 200, '其他服务器可创建');
});

test('TerminalDO: 活跃会话超绝对 TTL 强制回收（H-04）', async () => {
  const env = makeEnv();
  const st = mockState();
  const inst = new TerminalDO(st, env);
  const now = Date.now();
  const userWs = { closed: false, close() { this.closed = true; } };
  inst.sessions.set('0-old', { streamId: '0-old', serverId: 1, creatorUserId: 1, createdAt: now - 4 * 3600 * 1000 - 1000, userWs, agentWs: null, userBuf: [], agentBuf: [] });
  inst.sessions.set('0-live', { streamId: '0-live', serverId: 1, creatorUserId: 1, createdAt: now - 1000, userWs: { close() {} }, agentWs: null, userBuf: [], agentBuf: [] });
  inst.maybeSweep();
  assert.equal(inst.sessions.has('0-old'), false, '超绝对 TTL 被回收（即使有连接）');
  assert.equal(userWs.closed, true, '连接被关闭');
  assert.equal(inst.sessions.has('0-live'), true, '未超 TTL 保留');
  // 活跃会话也排绝对 TTL alarm（4h 准时回收，不依赖后续 fetch）
  assert.ok(st.storage.alarmTs != null, '活跃会话也排 alarm');
  assert.ok(
    Math.abs(st.storage.alarmTs - (now - 1000 + 4 * 3600 * 1000 + 1000)) < 10000,
    'alarm 设为活跃会话的绝对 TTL（±10s 容忍）'
  );
});

test('TerminalDO: maybeSweep 活跃会话按绝对 TTL 排 alarm，到期准时回收', async () => {
  const env = makeEnv();
  const st = mockState();
  const inst = new TerminalDO(st, env);
  const createdAt = Date.now() - 1000;
  inst.sessions.set('1-a', { streamId: '1-a', serverId: 1, creatorUserId: 1, createdAt, type: 'terminal', userWs: { readyState: 1 }, agentWs: null, userBuf: [] });
  inst.maybeSweep();
  assert.ok(st.storage.alarmTs != null, '活跃会话也排 alarm');
  assert.equal(st.storage.alarmTs, createdAt + 4 * 3600 * 1000 + 1000, 'alarm 对齐绝对 TTL');
  // 模拟 4h 后：maybeSweep 强制回收（即使连接仍活跃）
  const live = { closed: false, close() { this.closed = true; } };
  inst.sessions.get('1-a').createdAt = Date.now() - (4 * 3600 * 1000 + 1000);
  inst.sessions.get('1-a').userWs = live;
  inst.maybeSweep();
  assert.equal(live.closed, true, '超绝对 TTL 强制关闭连接');
  assert.equal(inst.sessions.has('1-a'), false, '会话已回收');
});

test('TerminalDO: user-pending 首帧鉴权后挂接 userWs，非法 token 断开', async () => {
  const env = makeEnv();
  const token = await I.signJwt({ uid: 1, username: 'admin', role: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, env);
  const inst = new TerminalDO(mockState(), env);
  inst.sessions.set('0-sid', { streamId: '0-sid', serverId: 1, creatorUserId: 1, createdAt: Date.now(), type: 'terminal', userWs: null, agentWs: null });

  const makeWs = () => ({
    closed: false,
    attachment: { role: 'user-pending', sid: '0-sid', serverId: 1, creatorUserId: 1, type: 'terminal', createdAt: Date.now() },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(a) { this.attachment = a; },
    send() {},
    close() { this.closed = true; },
    readyState: 1,
  });

  // 非法 token → 关闭，userWs 不挂接
  const bad = makeWs();
  await inst.webSocketMessage(bad, JSON.stringify({ type: 'auth', token: 'bogus' }));
  assert.equal(bad.closed, true);
  assert.equal(inst.sessions.get('0-sid').userWs, null);

  // 合法 token → 挂接 userWs，附件升级为 user 角色
  const good = makeWs();
  await inst.webSocketMessage(good, JSON.stringify({ type: 'auth', token }));
  assert.equal(good.closed, false);
  assert.equal(inst.sessions.get('0-sid').userWs, good);
  assert.equal(good.attachment.role, 'user');
});

test('TerminalDO: user-pending 首帧鉴权接受 PAT（server:exec + 白名单）', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)').bind('k1', 's1', 1, 'h1').run();
  const makeWs = () => ({
    closed: false,
    attachment: { role: 'user-pending', sid: '0-sid', serverId: 1, creatorUserId: 1, type: 'terminal', createdAt: Date.now() },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(a) { this.attachment = a; },
    send() {},
    close() { this.closed = true; },
    readyState: 1,
  });
  const mkInst = () => {
    const inst = new TerminalDO(mockState(), env);
    inst.sessions.set('0-sid', { streamId: '0-sid', serverId: 1, creatorUserId: 1, createdAt: Date.now(), type: 'terminal', userWs: null, agentWs: null });
    return inst;
  };
  const insertPat = async (name, scopes, serverIds) => {
    const token = `cfp_pat-${name}`;
    await env.DB.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scopes, server_ids) VALUES (?,?,?,?,?)')
      .bind(1, name, await I.hashSecret(token, env), JSON.stringify(scopes), JSON.stringify(serverIds)).run();
    return token;
  };

  // 白名单内 + exec scope → 放行
  const okToken = await insertPat('pat-exec', ['server:read', 'server:exec'], [1]);
  const inst = mkInst();
  const ok = makeWs();
  await inst.webSocketMessage(ok, JSON.stringify({ type: 'auth', token: okToken }));
  assert.equal(ok.closed, false, '白名单内 PAT（exec）放行');
  assert.equal(inst.sessions.get('0-sid').userWs, ok);

  // 白名单外（[999]）→ 拒绝
  const noToken = await insertPat('pat-no', ['server:read', 'server:exec'], [999]);
  const inst2 = mkInst();
  const denied = makeWs();
  await inst2.webSocketMessage(denied, JSON.stringify({ type: 'auth', token: noToken }));
  assert.equal(denied.closed, true, '白名单外 PAT 拒绝');

  // 无 exec scope → 拒绝
  const roToken = await insertPat('pat-read', ['server:read'], [1]);
  const inst3 = mkInst();
  const ro = makeWs();
  await inst3.webSocketMessage(ro, JSON.stringify({ type: 'auth', token: roToken }));
  assert.equal(ro.closed, true, '无 exec scope PAT 拒绝');
});

test('TerminalDO: 浏览器鉴权前 agent 输出缓冲，鉴权后补发（初始提示符不丢）', async () => {
  const env = makeEnv();
  const token = await I.signJwt({ uid: 1, username: 'admin', role: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, env);
  const inst = new TerminalDO(mockState(), env);
  const agentWs = { send() {}, readyState: 1 };
  inst.sessions.set('0-sid', {
    streamId: '0-sid', serverId: 1, creatorUserId: 1, createdAt: Date.now(), type: 'terminal',
    userWs: null, agentWs, userBuf: [],
  });

  // agent 初始输出（如 bash 提示符）在浏览器挂接前到达 → 缓冲
  const prompt = new TextEncoder().encode('prompt> ');
  await inst.webSocketMessage(agentWs, prompt);
  const sess0 = inst.sessions.get('0-sid');
  assert.equal(sess0.userWs, null);
  assert.equal(sess0.userBuf.length, 1);

  // 浏览器 user-pending 鉴权 → 挂接并补发缓冲
  const browserSent = [];
  const browserWs = {
    closed: false,
    attachment: { role: 'user-pending', sid: '0-sid', serverId: 1, creatorUserId: 1, type: 'terminal', createdAt: Date.now() },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(a) { this.attachment = a; },
    send(m) { browserSent.push(m); },
    close() { this.closed = true; },
  };
  await inst.webSocketMessage(browserWs, JSON.stringify({ type: 'auth', token }));
  const sess = inst.sessions.get('0-sid');
  assert.equal(sess.userWs, browserWs);
  assert.equal(browserSent.length, 1);
  assert.deepEqual(browserSent[0], prompt);
  assert.equal(sess.userBuf.length, 0);
});

test('TerminalDO: 会话持久化到 DO Storage，休眠后可水合（浏览器 auth 不因会话丢失被拒）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // 屏蔽 scheduleOpenAck 的 5s 定时器
  try {
    const env = makeEnv();
    const st = mockState(); // 共享 storage，模拟 DO 持久化跨实例存活
    const inst1 = new TerminalDO(st, env);
    inst1.agents.set(1, { send() {}, readyState: 1 });

    const resp = await inst1.fetch(new Request('https://do.internal/rpc', {
      method: 'POST',
      body: JSON.stringify({ op: 'create', streamId: '0-sid', serverId: 1, creatorUserId: 1 }),
    }));
    assert.equal(resp.status, 200);
    assert.ok(st.storage.map.has('sess:0-sid'), '会话应持久化到 DO Storage');

    // 模拟 DO 休眠：新实例（内存空）共享同一 storage
    const inst2 = new TerminalDO(st, env);
    assert.equal(inst2.sessions.size, 0);
    const sess = await inst2.hydrateSession('0-sid');
    assert.ok(sess, '应从 Storage 水合出会话');
    assert.equal(sess.serverId, 1);
    assert.equal(sess.userWs, null);
  } finally {
    t.mock.timers.reset();
  }
});

test('TerminalDO: 控制通道上报后回复心跳 ping（30s 限频）', async () => {
  const env = makeEnv();
  await insertServer(env, 'k1', 'srv1');
  const sent = [];
  const ws = {
    deserializeAttachment: () => ({ role: 'control', serverId: 1 }),
    send: (m) => sent.push(m),
    readyState: 1,
  };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, ws);

  const pingCount = () => sent.filter((m) => {
    try { return JSON.parse(m).type === 'ping'; } catch { return false; }
  }).length;

  await inst.webSocketMessage(ws, JSON.stringify({ type: 'report', cpu: 1, mem_used: 1, mem_total: 2 }));
  assert.equal(pingCount(), 1, '上报应触发一次心跳');

  // 30s 内再次上报 → 限频不再发心跳
  await inst.webSocketMessage(ws, JSON.stringify({ type: 'report', cpu: 2 }));
  assert.equal(pingCount(), 1, '30s 内限频只发一次心跳');
});

test('TerminalDO: agent 流挂接前浏览器输入缓冲，挂接后按序补发', async () => {
  const env = makeEnv();
  const inst = new TerminalDO(mockState(), env);
  const browserWs = { send() {}, readyState: 1 };
  inst.sessions.set('0-sid', {
    streamId: '0-sid', serverId: 1, creatorUserId: 1, createdAt: Date.now(), type: 'terminal',
    userWs: browserWs, agentWs: null, userBuf: [], agentBuf: [],
  });
  // agent 数据流尚未挂接：输入被缓冲，不丢弃
  await inst.webSocketMessage(browserWs, 'echo hi');
  await inst.webSocketMessage(browserWs, 'echo bye');
  const sess = inst.sessions.get('0-sid');
  assert.deepEqual(sess.agentBuf, ['echo hi', 'echo bye'], '输入被缓冲');

  // 挂接 agent 数据流 → 按序补发并清空
  const sent = [];
  const agentFlow = { send: (m) => sent.push(m), readyState: 1 };
  inst.attachAgentFlow(sess, agentFlow);
  assert.deepEqual(sent, ['echo hi', 'echo bye'], '挂接后按序补发');
  assert.equal(sess.agentBuf.length, 0, '补发后清空');
});

test('MetricsDO: 归档超过 100 行分批 batch 落 D1', async () => {
  const env = makeEnv();
  const st = mockState();
  const { inst, call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  for (let i = 0; i < 150; i++) {
    // 全部 >60min 归档线（且 <12h 热区上限）：增量归档在 /report 时完成（本次上报行直接归档）
    await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin - 220 + i, cpu: i }) });
  }
  const rows = await env.DB.prepare('SELECT COUNT(*) AS c FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows.results[0].c, 150, '增量归档全部落 D1');
});

test('TerminalDO: 控制通道重连时关闭该服务器旧会话流（dropAgentSessions）', async () => {
  const inst = new TerminalDO(mockState(), makeEnv());
  const oldWs = { closed: false, close() { this.closed = true; } };
  const otherWs = { closed: false, close() { this.closed = true; } };
  inst.sessions.set('1-a', { streamId: '1-a', serverId: 1, creatorUserId: 1, createdAt: Date.now(), type: 'terminal', userWs: null, agentWs: oldWs, userBuf: [] });
  inst.sessions.set('1-b', { streamId: '1-b', serverId: 1, creatorUserId: 1, createdAt: Date.now(), type: 'file', userWs: null, agentWs: null, userBuf: [] }); // 无 agent 流不受影响
  inst.sessions.set('2-c', { streamId: '2-c', serverId: 2, creatorUserId: 1, createdAt: Date.now(), type: 'terminal', userWs: null, agentWs: otherWs, userBuf: [] });

  inst.dropAgentSessions(1);

  assert.equal(oldWs.closed, true, '目标服务器旧终端流应被关闭');
  assert.equal(inst.sessions.get('2-c').agentWs.closed, false, '其他服务器会话不受影响');
});

test('TerminalDO: cleanup 按归属清理 pendingOpen，跨服务器/会话隔离', async () => {
  const env = makeEnv();
  const ctl1 = { send() {}, readyState: 1 }; // server 1 控制通道
  const ctl2 = { send() {}, readyState: 1 }; // server 2 控制通道
  const agentFlow = { send() {}, readyState: 1 }; // 会话 agent 数据流
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, ctl1);
  inst.agents.set(2, ctl2);
  inst.sessions.set('1-a', { streamId: '1-a', serverId: 1, creatorUserId: 1, createdAt: Date.now(), userWs: null, agentWs: agentFlow, userBuf: [] });
  inst.sessions.set('2-b', { streamId: '2-b', serverId: 2, creatorUserId: 1, createdAt: Date.now(), userWs: null, agentWs: null, userBuf: [] });
  inst.pendingOpen.set('1-a', { tries: 0, timer: null, serverId: 1, agentWs: ctl1, type: 'open_terminal' });
  inst.pendingOpen.set('2-b', { tries: 0, timer: null, serverId: 2, agentWs: ctl2, type: 'open_file' });

  // server1 控制通道断开 → 只清 server1 的待确认
  inst.cleanup(ctl1);
  assert.equal(inst.agents.has(1), false);
  assert.equal(inst.pendingOpen.has('1-a'), false, 'server1 待确认被清理');
  assert.equal(inst.pendingOpen.has('2-b'), true, 'server2 待确认不受影响');

  // 会话 1-a 的 agent 数据流断开 → 清该会话待确认并回收会话，不影响 server2
  inst.cleanup(agentFlow);
  assert.equal(inst.sessions.has('1-a'), false, '1-a 两端断开被回收');
  assert.equal(inst.pendingOpen.has('2-b'), true, 'server2 待确认仍保留');

  // server2 控制通道断开 → 全部清空
  inst.cleanup(ctl2);
  assert.equal(inst.agents.size, 0);
  assert.equal(inst.pendingOpen.size, 0, 'server2 断开后 pendingOpen 清空');
});
