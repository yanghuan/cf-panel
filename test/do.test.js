// ============================================================
// Durable Object 行为测试：MetricsDO（热区/归档/保留期/离线告警）、
// PanelDO（viewers/推送过滤）、TerminalDO（wakeup/create 确认重发/report）
// 运行：node --test test/do.test.js
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsDO, PanelDO, TerminalDO, __internals as I } from '../src/index.js';
import { EXEC_CMD_MAX_BYTES } from '../src/config.js';
import { listServersWithState } from '../src/auth.js';
import { makeEnv, makePanelStub, captureFetch } from './helpers.js';

function mockState(store = {}) {
  const map = new Map(Object.entries(store));
  const storage = {
    map,
    async get(k) {
      return map.has(k) ? map.get(k) : undefined;
    },
    async put(k, v) {
      // 生产 API 支持 put(entries) 批量写：按 key 逐个写入（计费按 key，语义一致）
      if (k && typeof k === 'object') {
        for (const [kk, vv] of Object.entries(k)) map.set(kk, vv);
        return;
      }
      map.set(k, v);
    },
    async delete(k) {
      // 生产 API 支持 delete(keys[])：一次最多 128 键
      if (Array.isArray(k)) {
        for (const kk of k) map.delete(kk);
        return;
      }
      map.delete(k);
    },
    async list(opts = {}) {
      const prefix = opts.prefix || '';
      // 与生产一致：按 key 字典序返回，支持 startAfter / limit（分页）
      const keys = [];
      for (const [k, v] of [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
        if (!k.startsWith(prefix)) continue;
        if (opts.startAfter && k <= opts.startAfter) continue;
        keys.push({ name: k, value: v });
        if (opts.limit && keys.length >= opts.limit) break;
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

// 指定 id 插入服务器：天账相关用例的 serverId 是硬编码的（7/11/21…），不能依赖自增
function insertServerWithId(env, id, lastSeen = null) {
  return env.DB.prepare(
    'INSERT INTO servers (id, agent_key_id, name, user_id, agent_key_hash, last_seen) VALUES (?,?,?,?,?,?)'
  ).bind(id, `k${id}`, `s${id}`, 1, 'h', lastSeen).run();
}

// 内存 updating 标记的权威在 D1：TerminalDO.isUpdating 会把「没有未过期 job」的残留标记清掉。
// 用例若只 add 标记会被判过期，这里同时种一条未过期的 agent_update 行（贴近真实链路）。
function seedActiveUpdate(env, serverId = 1) {
  const now = Math.floor(Date.now() / 1000);
  return env.DB.prepare(
    `INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, created_at, deadline_at, expires_at)
     VALUES (?, 'agent_update', 'running', 1, 'admin', ?, ?, ?, ?)`
  ).bind(`job_upd_${serverId}`, serverId, now - 10, now + 200, now + 86400).run();
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

// 列表缓存 TTL 从 4.5s 提到 20s 后，命中率决定了 D1 读的量级；并发 miss 必须合并，
// 否则 N 个观看者同时 sync 仍会各打一条全表查询。
test('PanelDO: 列表缓存 TTL 内命中、并发 miss 合并、清缓存后失效', async () => {
  const env = makeEnv();
  await insertServer(env, 'k1', 'srv-a');
  let queries = 0;
  const origPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (/FROM servers ORDER BY/.test(sql)) queries += 1;
    return origPrepare(sql);
  };
  const admin = { id: 1, username: 'admin', role: 1 };
  const inst = new PanelDO({ getWebSockets: () => [] }, env);

  await inst.filterServersCached(admin);
  await inst.filterServersCached(admin);
  assert.equal(queries, 1, 'TTL 内第二个调用必须命中缓存');

  inst.listCache = null; // 模拟 TTL 过期
  const [a, b, c] = await Promise.all([
    inst.filterServersCached(admin), inst.filterServersCached(admin), inst.filterServersCached(admin),
  ]);
  assert.equal(queries, 2, '并发 miss 只允许一条 SQL');
  assert.equal(a.length, 1);
  assert.equal(b[0].id, 1);
  assert.equal(c[0].name, 'srv-a');

  // 清缓存后在途查询的结果不得回填（否则改名结果会被旧行盖住 20s）
  inst.listCache = null;
  const epoch = inst.listEpoch;
  await inst.fetch(new Request('https://do.internal/rpc/clear_list_cache', { method: 'POST' }));
  assert.equal(inst.listEpoch, epoch + 1, '清缓存递增代际');
  assert.equal(inst.listCache, null);
  await inst.filterServersCached(admin);
  assert.equal(queries, 3, '清缓存后重新查询');
});

// 面向浏览器的 DO 不该把 agent_key_hash（agent 鉴权用的哈希）读进内存；同时 info/probe/
// alert_override 三个 JSON 应在缓存填充时预解析一次，而不是每次推送对每台机器各 parse 三次。
test('PanelDO: 列表查询不带 agent_key_hash，JSON 字段预解析进缓存', async () => {
  const env = makeEnv();
  await insertServer(env, 'k1', 'srv-a');
  await env.DB.prepare('UPDATE servers SET info_json = ?, probe_json = ?, alert_override = ? WHERE id = 1')
    .bind(JSON.stringify({ os: 'linux' }), JSON.stringify([{ name: 'web', ok: true }]), JSON.stringify({ cpu_pct: 80 }))
    .run();
  const admin = { id: 1, username: 'admin', role: 1 };
  const inst = new PanelDO({ getWebSockets: () => [] }, env);
  let sql = '';
  const origPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (s) => { if (/FROM servers ORDER BY/.test(s)) sql = s; return origPrepare(s); };

  const rows = await inst.filterServersCached(admin);
  assert.doesNotMatch(sql, /\*/, '列表查询不得用 SELECT *');
  assert.doesNotMatch(sql, /agent_key_hash/, '不得把 agent_key_hash 读进面向浏览器的 DO');
  assert.equal(rows[0].agent_key_hash, undefined, '行里也不该有该列');
  assert.equal(rows[0].info.os, 'linux', 'info 在缓存填充时已预解析');
  assert.equal(rows[0].probes[0].name, 'web', 'probes 预解析');
  assert.equal(rows[0].alertOverride.cpu_pct, 80, 'alert_override 预解析');

  // 命中缓存：预解析结果被复用（不重复 parse），列表组装仍走同一份数据
  const list = await inst.buildList(admin, {});
  assert.equal(list[0].info.os, 'linux');
  assert.equal(list[0].probes[0].ok, true);
  assert.equal(list[0].alert_override.cpu_pct, 80);
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

test('MetricsDO: trim 归档关闭时保留 720 分钟（ARCHIVE_TO_D1=0 热区是唯一存储）', async () => {
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

test('MetricsDO: keepMin() 默认 240，env 可覆盖，归档关闭回退 720', async () => {
  const km = (env) => mkMetrics(env, mockState()).inst.keepMin();
  // 默认（归档开启）：240 = 归档线(60) 的 4 倍余量；>1h 的查询必然走 D1，热区超出归档线是冗余副本
  assert.equal(km(makeEnv()), 240, '默认 240');
  assert.equal(km(makeEnv({ METRICS_KEEP_MIN: '120' })), 120, 'env 覆盖生效');
  // 非法值与低于归档线的值都回退默认：低于归档线会让增量归档扫不到「已上报未归档」的行
  assert.equal(km(makeEnv({ METRICS_KEEP_MIN: 'abc' })), 240, '非法值回退默认');
  assert.equal(km(makeEnv({ METRICS_KEEP_MIN: '10' })), 240, '低于归档线回退默认');
  // 归档关闭 → 热区是唯一存储，必须 720 才保得住 12h 可查历史（env 也不得缩短）
  assert.equal(km(makeEnv({ ARCHIVE_TO_D1: '0' })), 720, '归档关闭回退 720');
  assert.equal(km(makeEnv({ ARCHIVE_TO_D1: '0', METRICS_KEEP_MIN: '120' })), 720, '归档关闭时忽略 env 缩短');
});

test('MetricsDO: trim 升序早退（常态 O(1)）与乱序累积兜底全扫', async () => {
  const env = makeEnv({ METRICS_KEEP_MIN: '100' });
  const { inst } = mkMetrics(env, mockState());
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  // 升序插入（真实路径：minTs 由服务端按接收时刻计算，单调递增）
  const m = new Map();
  for (let i = 400; i >= 0; i--) m.set(nowMin - i, { cpu: i }); // 最旧 → 最新
  inst.trim(m);
  assert.equal(m.has(nowMin - 400), false, '窗口外旧键已删');
  assert.equal(m.has(nowMin - 150), false, '窗口外旧键已删');
  assert.equal(m.has(nowMin - 10), true, '窗口内键保留');
  assert.equal(m.has(nowMin), true, '当前分钟保留');
  assert.ok(m.size <= 101, `条目数受窗口约束（实际 ${m.size}）`);

  // 兜底：乱序插入把过期键追加到尾部，早退扫不到；累积到超出窗口跨度后由 size 判定触发全扫
  const m2 = new Map();
  for (let i = 100; i >= 0; i--) m2.set(nowMin - i, { cpu: i });
  for (let i = 0; i < 20; i++) m2.set(nowMin - 400 - i, { cpu: -1 }); // 乱序追加 20 条
  assert.equal(m2.size, 121);
  inst.trim(m2);
  assert.equal(m2.has(nowMin - 400), false, '乱序过期键被兜底全扫删除');
  assert.equal(m2.has(nowMin - 10), true, '正常键未被误删');
  assert.ok(m2.size <= 101, `乱序累积已清理（实际 ${m2.size}）`);
});

test('MetricsDO: trim 按分钟门控（快采同分钟多帧只裁一次）', async () => {
  const env = makeEnv();
  const { inst, call } = mkMetrics(env, mockState());
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  let trimCalls = 0;
  const origTrim = inst.trim.bind(inst);
  inst.trim = (m) => { trimCalls++; return origTrim(m); };
  // 同分钟 5 帧（快采 5s 下同机重复上报）
  for (let i = 0; i < 5; i++) {
    await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: i }) });
  }
  assert.equal(trimCalls, 1, '同分钟 5 帧只裁剪 1 次（原实现每帧 O(窗口) 全扫）');
  // 跨分钟 → 窗口边界移动，再裁一次
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin - 1, cpu: 9 }) });
  assert.equal(trimCalls, 2, '跨分钟再次裁剪');
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
test('MetricsDO: alarm 归档超 1 小时数据到 D1；热区保留窗口内数据，不重复归档', async () => {
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

  // 热区保留窗口内数据（90min 前的行仍在 240min 窗口内）
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

test('MetricsDO: fullSweep 某服务器跨批失败时保留其全部源行与旧水位，其他服务器继续完成', async () => {
  const env = makeEnv();
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const oldArc = nowMin - 2000;
  const store = { 'arc:1': String(oldArc), 'arc:2': String(oldArc) };
  const server1Keys = [];
  for (let i = 0; i < 101; i++) {
    const ts = nowMin - 800 - i;
    const key = `m:1:${ts}`;
    server1Keys.push(key);
    store[key] = JSON.stringify({ cpu: i });
  }
  const server2Ts = nowMin - 850;
  store[`m:2:${server2Ts}`] = JSON.stringify({ cpu: 2 });
  const state = mockState(store);
  const { inst } = mkMetrics(env, state);
  const realBatch = env.DB.batch.bind(env.DB);
  let batchNo = 0;
  env.DB.batch = async (stmts) => {
    batchNo += 1;
    if (batchNo === 2) throw new Error('transient D1 failure'); // server 1 的第二批
    return realBatch(stmts);
  };
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal(await inst.fullSweep(true), false, '部分失败必须反馈给 housekeep');
  } finally {
    console.error = origError;
  }
  assert.equal(server1Keys.every((k) => state.storage.map.has(k)), true, '失败服务器全部源行保留');
  assert.equal(Number(await state.storage.get('arc:1')), oldArc, '失败服务器水位不推进');
  assert.equal(state.storage.map.has(`m:2:${server2Ts}`), false, '其他服务器仍可完成清理');
  assert.equal(Number(await state.storage.get('arc:2')), server2Ts, '其他服务器水位正常推进');

  env.DB.batch = realBatch;
  assert.equal(await inst.fullSweep(true), true, '恢复后幂等重放成功');
  assert.equal(server1Keys.some((k) => state.storage.map.has(k)), false, '重试后源行清理');
  assert.equal(Number(await state.storage.get('arc:1')), nowMin - 800, '重试后推进到实际最大时间戳');
  const archived = await env.DB.prepare('SELECT COUNT(*) AS c FROM metrics_min WHERE server_id = 1').first();
  assert.equal(Number(archived.c), 101, '成功批次重放由 INSERT OR IGNORE 去重，无数据空洞');
});

test('MetricsDO: fullSweep 源行删除失败返回未完成并保留数据供重试', async () => {
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const ts = nowMin - 800;
  const state = mockState({ [`m:1:${ts}`]: JSON.stringify({ cpu: 1 }), 'arc:1': String(ts) });
  const { inst } = mkMetrics(makeEnv(), state);
  const realDelete = state.storage.delete.bind(state.storage);
  state.storage.delete = async () => { throw new Error('storage unavailable'); };
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal(await inst.fullSweep(true), false);
  } finally {
    console.error = origError;
  }
  assert.equal(state.storage.map.has(`m:1:${ts}`), true, '删除失败后源行仍存在');
  state.storage.delete = realDelete;
  assert.equal(await inst.fullSweep(true), true);
  assert.equal(state.storage.map.has(`m:1:${ts}`), false, '恢复后重试删除成功');
});

test('MetricsDO: fullSweep/prune 失败不推进家政时间戳', async () => {
  const now = Date.now();
  const state = mockState({ housekeep: JSON.stringify({ lastSweepAt: 0, lastPruneAt: now }) });
  const env = makeEnv();
  const { inst } = mkMetrics(env, state);
  inst.fullSweep = async () => false;
  const origError = console.error;
  console.error = () => {};
  try {
    await inst.alarm();
    assert.equal(inst.lastSweepAt, 0, 'fullSweep 未完成时不推进时间戳');

    inst.lastSweepAt = Date.now();
    inst.lastPruneAt = 0;
    const realBatch = env.DB.batch;
    env.DB.batch = async () => { throw new Error('prune unavailable'); };
    await inst.alarm();
    env.DB.batch = realBatch;
    assert.equal(inst.lastPruneAt, 0, 'prune 失败时不推进时间戳');
  } finally {
    console.error = origError;
  }
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

test('MetricsDO: alarm 按保留期分层——细粒度窗口（7 天）后只留降采样点', async () => {
  const env = makeEnv();
  const { inst } = mkMetrics(env, mockState());
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  // 8 天前（超出 7 天细粒度窗口、在 30 天保留期内）：连续 6 分钟各插一行
  // 桶对齐 unix 纪元，取 base 使 base % 5 === 0，故 base 与 base+5 是采样点
  const raw = nowMin - 8 * 1440;
  const base = raw - (raw % 5);
  for (let i = 0; i <= 5; i++) {
    await env.DB.prepare('INSERT OR IGNORE INTO metrics_min (server_id, ts, cpu) VALUES (?,?,?)').bind(1, base + i, i).run();
  }
  // 细粒度窗口内（3 天前）：不受降采样影响，整行保留
  await env.DB.prepare('INSERT OR IGNORE INTO metrics_min (server_id, ts, cpu) VALUES (?,?,?)').bind(1, nowMin - 3 * 1440, 99).run();

  await inst.alarm();

  const rows = await env.DB.prepare('SELECT ts FROM metrics_min ORDER BY ts').all();
  assert.deepEqual(
    rows.results.map((r) => r.ts),
    [base, base + 5, nowMin - 3 * 1440],
    '窗口外仅保留 ts%5==0 的采样点，窗口内整行保留',
  );
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

test('MetricsDO: 离线告警状态跨 evict 恢复不重复告警（storage 键数字归一）', async () => {
  const env = makeEnv();
  await insertServer(env, 'k1', 'srv1', { last_seen: Math.floor(Date.now() / 1000) - 1000 });
  await env.DB.prepare("INSERT INTO kv_json (key, value) VALUES ('settings', ?)")
    .bind(JSON.stringify({ alerts: { webhook_url: 'https://example.com/hook', offline_after_s: 180 } })).run();
  // 模拟「上个实例已告警离线并持久化」的 storage：alert:offline:1 = 'off'
  // （storage 恢复路径 ensureOfflineLoaded 从键名字符串切片——旧实现不归一为 number，
  //   Map 里挂的是字符串键 "1"，与 checkOfflineAlerts 读写的数字键 s.id 永不匹配）
  const st = mockState({ 'alert:offline:1': 'off' });
  const { inst } = mkMetrics(env, st);
  const cap = captureFetch();
  try {
    await inst.alarm(); // evict 后首个 alarm：机器仍离线但状态已持久化为 off
    assert.equal(cap.calls.length, 0, '已告警过的离线机器恢复状态后不得重复告警');
    // 状态应为数字键（与 s.id 匹配），storage 持久化值不变
    assert.equal(inst.offlineState.get(1), 'off');
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
        extra: { disk: [{ m: '/', used: 95, total: 100 }], load1: 8 }, // 磁盘新格式 used/total 95%
      }),
    });
    assert.equal(cap.calls.length, 1);
    const details = JSON.parse(cap.calls[0].init.body).details;
    assert.deepEqual(details, ['内存 90.0% >= 90%', '磁盘 / 95.0% >= 80%', '负载 8 >= 5']);
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

test('MetricsDO: probes 清空（删 PROBES）后清除探活去重状态（内存 + Storage）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const st = mockState();
  const { inst, call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  // 历史失败状态（内存 + Storage 各一份）：只清内存的话 evict 后会被重新加载
  inst.probeState.set('7:web', { ok: false, lastFail: Date.now() });
  await st.storage.put('probe:7:web', JSON.stringify({ ok: false, lastFail: Date.now() }));

  // agent 删掉 PROBES 后上报空数组：handleReport 在「有 → 无」变更帧挂 probesCleared
  await call('/report', {
    method: 'POST',
    body: JSON.stringify({ serverId: 7, minTs: nowMin, probes: [], probesCleared: true }),
  });

  assert.equal(inst.probeState.has('7:web'), false, '内存去重状态必须清除');
  assert.equal(st.storage.map.has('probe:7:web'), false, 'Storage 去重状态必须清除（evict 后不得复活）');
});

// 单帧的 probesCleared 可能丢（同机 5s 批内被覆盖、flush 前 evict），且「只删掉其中一个探针」
// 没有任何信号。alarm 里以 D1 probe_json 为准做对账，把这两种残留都收口。
test('MetricsDO: alarm 兜底清理已不在配置里的探针状态（丢帧/只删一个也能收口）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const ins = (id, probeJson) => env.DB.prepare(
    'INSERT INTO servers (id, agent_key_id, name, user_id, agent_key_hash, probe_json) VALUES (?,?,?,?,?,?)'
  ).bind(id, `k${id}`, `s${id}`, 1, 'h', probeJson).run();
  await ins(1, JSON.stringify([{ name: 'web', ok: true }])); // 只剩 web：db 是已删除的探针
  await ins(3, 'not-a-json'); // 配置损坏：解析失败时不得误删
  // 服务器 2 没有任何行（已删除）→ 残留状态也要清

  const st = mockState();
  const { inst } = mkMetrics(env, st);
  const fail = { ok: false, lastFail: 1 };
  for (const k of ['1:web', '1:db', '2:web', '3:web']) {
    inst.probeState.set(k, fail);
    await st.storage.put(`probe:${k}`, JSON.stringify(fail));
  }

  await inst.pruneStaleProbeStates();

  assert.equal(inst.probeState.has('1:web'), true, '仍配置的探针状态必须保留');
  assert.equal(st.storage.map.has('probe:1:web'), true);
  assert.equal(inst.probeState.has('1:db'), false, '已删除的探针必须清掉（覆盖「只删掉其中一个」）');
  assert.equal(st.storage.map.has('probe:1:db'), false);
  assert.equal(inst.probeState.has('2:web'), false, '服务器已删除的残留也要清');
  assert.equal(st.storage.map.has('probe:2:web'), false);
  assert.equal(inst.probeState.has('3:web'), true, 'probe_json 解析失败时不得误删');
  assert.equal(st.storage.map.has('probe:3:web'), true);
});

// 快照是「按机」的：只要有任意一台写过 l:，就只为缺快照的机器按前缀补扫，
// 不能让这些机器（升级首轮 / 该机快照写失败）在冷启动首查里缺指标。
test('MetricsDO: /latest 冷启动为缺 l: 快照的机器逐机补扫（不全量扫 m:）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  await env.DB.prepare('INSERT INTO servers (id, agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?,?)')
    .bind(1, 'k1', 's1', 1, 'h').run();
  await env.DB.prepare('INSERT INTO servers (id, agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?,?)')
    .bind(2, 'k2', 's2', 1, 'h').run();
  const st = mockState();
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  st.storage.map.set('l:1', JSON.stringify({ ts: nowMin - 1, cpu: 42 })); // 机器 1 有快照
  for (let i = 0; i < 30; i++) {
    st.storage.map.set(`m:2:${nowMin - i}`, JSON.stringify({ cpu: 100 + i })); // 机器 2 只有热区
  }
  const { inst, call } = mkMetrics(env, st);
  const prefixes = [];
  const orig = inst.listStorage.bind(inst);
  inst.listStorage = async (p, o) => { prefixes.push(p); return orig(p, o); };

  const latest = await (await call('/latest')).json();
  assert.equal(latest[1].cpu, 42, '有快照的机器读 l:');
  assert.equal(latest[2].cpu, 100, '缺快照的机器由 m:2: 补扫出最新一帧');
  assert.deepEqual(prefixes, ['l:', 'm:2:'], '只补扫缺快照的那台前缀，不退化成全量 m: 扫描');
});

// 三条 /latest 恢复路径的容错必须一致：l: 快照、逐机补扫、以及「完全没有 l:」时的
// 升级回退全量扫描。差一行坏数据就让升级首查 500 是最糟的失败形态。
test('MetricsDO: 升级回退路径（无 l: 快照）容忍单行损坏', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const st = mockState();
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  st.storage.map.set(`m:1:${nowMin}`, 'not-json'); // 坏行
  st.storage.map.set(`m:1:${nowMin - 1}`, JSON.stringify({ cpu: 5 }));
  const { call } = mkMetrics(env, st);
  const latest = await (await call('/latest')).json();
  assert.equal(latest[1].cpu, 5, '坏行被跳过，好行照常返回（不得 500）');
});

// 升级首轮 500 台全缺 l: 时，逐机补扫要串行 500 次前缀 list（面板首连多等数秒）。
// 每轮最多补 LATEST_BACKFILL_MAX 台，其余由下一轮冷启动或首帧上报补齐。
test('MetricsDO: /latest 补扫有单轮上限（升级首轮不阻塞面板首连）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const st = mockState();
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  for (let id = 1; id <= 102; id++) {
    await env.DB.prepare('INSERT INTO servers (id, agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?,?)')
      .bind(id, `k${id}`, `s${id}`, 1, 'h').run();
  }
  st.storage.map.set('l:1', JSON.stringify({ ts: nowMin, cpu: 1 })); // 只有 1 台有快照
  for (const id of [2, 3]) st.storage.map.set(`m:${id}:${nowMin}`, JSON.stringify({ cpu: id }));
  const { inst, call } = mkMetrics(env, st);
  const prefixes = [];
  const orig = inst.listStorage.bind(inst);
  inst.listStorage = async (p, o) => { prefixes.push(p); return orig(p, o); };

  const latest = await (await call('/latest')).json();
  assert.equal(latest[1].cpu, 1);
  assert.equal(latest[2].cpu, 2, '补扫覆盖到缺快照的机器');
  assert.equal(latest[3].cpu, 3);
  const backfills = prefixes.filter((p) => p.startsWith('m:'));
  assert.equal(backfills.length, 100, '单轮最多补 100 台');
  assert.equal(prefixes.includes('m:102:'), false, '超出的机器本轮不补（下轮或首帧上报补齐）');
});

// 冷却状态原先每个冷实例全量 list('alert:') 恢复（50 台 × 4 维 ≈ 200 行/帧）；而 120s 慢采下
// 每帧几乎都是新实例。改成「先做零读的阈值判定，越界才按机恢复」后，正常帧零 alert 读。
test('MetricsDO: 告警冷却状态按需读（未越界不读，越界才按机恢复）', async () => {
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO kv_json (key, value) VALUES ('settings', ?)")
    .bind(JSON.stringify({ alerts: { webhook_url: 'https://example.com/hook', cpu_pct: 90, cooldown_min: 30 } })).run();
  const st = mockState();
  const { inst, call } = mkMetrics(env, st);
  const lists = [];
  const orig = inst.listStorage.bind(inst);
  inst.listStorage = async (p, o) => { if (p.startsWith('alert:')) lists.push(p); return orig(p, o); };
  const cap = captureFetch();
  try {
    const nowMin = Math.floor(Date.now() / 1000 / 60);
    const report = (cpu, minTs) => call('/report', {
      method: 'POST', body: JSON.stringify({ serverId: 1, serverName: 's1', minTs, cpu }),
    });

    await report(10, nowMin);
    assert.deepEqual(lists, [], '未越界：零 alert 读（含冷却状态）');
    assert.equal(cap.calls.length, 0, '未越界不告警');

    await report(95, nowMin + 1);
    assert.deepEqual(lists, ['alert:1:'], '越界才按机前缀恢复该机冷却状态');
    assert.equal(cap.calls.length, 1, '首次越界告警');

    await report(98, nowMin + 2);
    assert.equal(lists.length, 1, '同实例内该机只恢复一次');
    assert.equal(cap.calls.length, 1, '冷却期内不重复告警');
  } finally { cap.restore(); }
});

// 探活状态同样按机加载：旧实现每次 checkProbeAlerts 都 list('probe:') 全量（500 台 × 探针数）。
test('MetricsDO: 探活冷却状态按机前缀加载（不再 list 全部 probe:）', async () => {
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO kv_json (key, value) VALUES ('settings', ?)")
    .bind(JSON.stringify({ alerts: { webhook_url: 'https://example.com/hook', cooldown_min: 30 } })).run();
  const st = mockState();
  // 另一台机器的残留状态：按机加载时不该被这台机器的帧读进来
  await st.storage.put('probe:9:web', JSON.stringify({ ok: false, lastFail: Date.now() }));
  const { inst, call } = mkMetrics(env, st);
  const lists = [];
  const orig = inst.listStorage.bind(inst);
  inst.listStorage = async (p, o) => { if (p.startsWith('probe:')) lists.push(p); return orig(p, o); };
  const cap = captureFetch();
  try {
    await call('/report', {
      method: 'POST',
      body: JSON.stringify({ serverId: 1, serverName: 's1', minTs: Math.floor(Date.now() / 1000 / 60), probes: [{ name: 'web', ok: false }] }),
    });
    assert.deepEqual(lists, ['probe:1:'], '只加载本机前缀，不扫全部 probe:');
    assert.equal(inst.probeState.has('9:web'), false, '其他机器的冷却状态不进入本实例内存');
  } finally { cap.restore(); }
});

test('MetricsDO: /drop 清理 storage 告警/探活状态', async () => {
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO kv_json (key, value) VALUES ('settings', ?)")
    .bind(JSON.stringify({ alerts: { webhook_url: 'https://example.com/hook', cpu_pct: 90, cooldown_min: 30 } })).run();
  const st = mockState();
  const { inst, call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, serverName: 's1', minTs: nowMin, cpu: 95, probes: [{ name: 'web', ok: false }] }) });
  st.storage.map.set('alert:offline:1', 'off');
  st.storage.map.set('arc:1', String(nowMin - 60));
  inst.offlineState.set(1, 'off');
  inst.arcCache.set(1, nowMin - 60);
  assert.ok(st.storage.map.has('alert:1:cpu'), '告警状态已写入');
  assert.ok(st.storage.map.has('probe:1:web'), '探活状态已写入');
  await call('/drop', { method: 'POST', body: JSON.stringify({ server_id: 1 }) });
  assert.equal(st.storage.map.has('alert:1:cpu'), false, 'drop 清理告警状态');
  assert.equal(st.storage.map.has('probe:1:web'), false, 'drop 清理探活状态');
  assert.equal(st.storage.map.has('alert:offline:1'), false, 'drop 清理离线状态');
  assert.equal(st.storage.map.has('arc:1'), false, 'drop 清理归档水位');
  assert.equal(inst.offlineState.has(1), false, 'drop 清理内存离线状态');
  assert.equal(inst.arcCache.has(1), false, 'drop 清理内存归档水位');
});

// ---------------- PanelDO ----------------
test('PanelDO: /viewers 只统计已鉴权观看者，返回 fastSince 过渡标记；其他路径 404', async () => {
  const env = makeEnv();
  const ws1 = { deserializeAttachment: () => 'tok1' };
  const ws2 = { deserializeAttachment: () => 'tok2' };
  const ws3 = { deserializeAttachment: () => null }; // 未鉴权
  const inst = new PanelDO({ getWebSockets: () => [ws1, ws2, ws3] }, env);
  inst.fastSince = 12345;
  const res = await inst.fetch(new Request('https://do.internal/viewers'));
  assert.deepEqual(await res.json(), { count: 2, fastSince: 12345 });
  assert.equal((await inst.fetch(new Request('https://do.internal/other'))).status, 404);
});

test('PanelDO: alarm 回收超时未鉴权连接并续排下一截止时间', async () => {
  const now = Date.now();
  const makeWs = (attachment) => ({
    attachment, closed: false,
    deserializeAttachment() { return this.attachment; },
    close() { this.closed = true; },
  });
  const expired = makeWs({ role: 'viewer-pending', authDeadline: now - 1 });
  const future = makeWs({ role: 'viewer-pending', authDeadline: now + 5000 });
  const viewer = makeWs({ role: 'viewer', auth: { kind: 'jwt', id: 1, username: 'admin', exp: Math.floor(now / 1000) + 60 } });
  const state = mockState();
  state.getWebSockets = () => [expired, future, viewer];
  const inst = new PanelDO(state, makeEnv());
  await inst.alarm();
  assert.equal(expired.closed, true, '超时 pending 连接关闭');
  assert.equal(future.closed, false, '未到期 pending 连接保留');
  assert.equal(viewer.closed, false, '已鉴权连接不受影响');
  assert.equal(state.storage.alarmTs, future.attachment.authDeadline, '续排下一鉴权截止时间');

  const saturated = mockState();
  saturated.getWebSockets = () => Array.from({ length: 128 }, () => makeWs({ role: 'viewer-pending', authDeadline: now + 5000 }));
  const limited = await new PanelDO(saturated, makeEnv()).fetch(new Request('https://do.internal/ws/push'));
  assert.equal(limited.status, 429, 'pending 达到硬上限后拒绝新连接');
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

  // 合法 token → 鉴权通过（attachment 只存安全身份），首位观看者触发快采唤醒
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
  assert.equal(ws.attachment.role, 'viewer');
  assert.equal(ws.attachment.auth.kind, 'jwt');
  assert.doesNotMatch(JSON.stringify(ws.attachment), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
  assert.equal(inst.authCache.size, 1, '鉴权已缓存');
  assert.equal([...inst.authCache.keys()].some((k) => k.includes(token)), false, '缓存键不含 bearer 明文');
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

// 令牌降权后必须收回**已建**会话：此前重校验只确认令牌仍存在（!u），不重跑 canExec，
// 于是撤掉 server:exec 或收窄 server_ids 后，旧连接仍能把终端输入/文件写指令送给 agent。
test('TerminalDO: PAT 降权/白名单收窄后已建会话失效（不再转发输入）', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k-dg', 's-dg', 1, 'h-dg').run();
  const insertPat = async (name, scopes, serverIds) => {
    const token = `cfp_pat-${name}`;
    const hash = await I.hashSecret(token, env);
    await env.DB.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scopes, server_ids) VALUES (?,?,?,?,?)')
      .bind(1, name, hash, JSON.stringify(scopes), JSON.stringify(serverIds)).run();
    return hash;
  };
  // 建一个已挂接的会话（附件里只放 PAT HMAC，与线上一致）
  const openSession = (hash) => {
    const inst = new TerminalDO(mockState(), env);
    const forwarded = [];
    const sess = {
      streamId: '0-sid', serverId: 1, creatorUserId: 1, createdAt: Date.now(), type: 'terminal',
      userWs: null, agentWs: { send: (m) => forwarded.push(m), close() {} }, userBuf: [], agentBuf: [],
    };
    inst.sessions.set('0-sid', sess);
    const ws = {
      closed: false,
      attachment: { role: 'user', sid: '0-sid', serverId: 1, creatorUserId: 1, type: 'terminal', createdAt: Date.now(), auth: { kind: 'pat', tokenHash: hash } },
      deserializeAttachment() { return this.attachment; },
      serializeAttachment(a) { this.attachment = a; },
      send() {}, close() { this.closed = true; }, readyState: 1,
    };
    sess.userWs = ws;
    return { inst, sess, ws, forwarded };
  };

  // A：撤掉 server:exec（只读化的降权）
  const hA = await insertPat('dg-exec', ['server:read', 'server:exec'], [1]);
  const a = openSession(hA);
  await a.inst.webSocketMessage(a.ws, 'echo before');
  assert.equal(a.forwarded.length, 1, '降权前输入正常转发');
  await env.DB.prepare('UPDATE api_tokens SET scopes = ? WHERE token_hash = ?').bind(JSON.stringify(['server:read']), hA).run();
  a.sess.lastAuthCheck = 0; // 越过 10s 重校验节流
  await a.inst.webSocketMessage(a.ws, 'echo after');
  assert.equal(a.ws.closed, true, '降权后连接关闭');
  assert.equal(a.forwarded.length, 1, '降权后输入不得再转发给 agent');

  // B：scopes 仍有 exec，但 server_ids 收窄到不含本机
  const hB = await insertPat('dg-whitelist', ['server:read', 'server:exec'], [999]);
  const b = openSession(hB);
  await b.inst.webSocketMessage(b.ws, 'echo before');
  assert.equal(b.ws.closed, true, '白名单不含本机 → 建连后的首次校验即关闭');
  assert.equal(b.forwarded.length, 0, '白名单外不得转发');

  // C：权限未变 → 不受影响（避免把正常会话误杀）
  const hC = await insertPat('dg-ok', ['server:read', 'server:exec'], [1]);
  const c = openSession(hC);
  await c.inst.webSocketMessage(c.ws, 'echo 1');
  c.sess.lastAuthCheck = 0;
  await c.inst.webSocketMessage(c.ws, 'echo 2');
  assert.equal(c.ws.closed, false, '权限未变不得误关');
  assert.equal(c.forwarded.length, 2, '正常会话持续可转发');
});

// 输出方向同样要重校验：只拦浏览器→agent 时，用户停手不发消息，降权后的旧连接
// 仍会持续收到终端回显 / 文件读取结果，且连接不会关闭。
test('TerminalDO: 降权后 Agent 输出不再投递给浏览器（输出方向同校）', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k-out', 's-out', 1, 'h-out').run();
  const token = 'cfp_pat-out';
  const hash = await I.hashSecret(token, env);
  await env.DB.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scopes, server_ids) VALUES (?,?,?,?,?)')
    .bind(1, 'out', hash, JSON.stringify(['server:read', 'server:exec']), JSON.stringify([1])).run();

  const inst = new TerminalDO(mockState(), env);
  const sess = {
    streamId: '0-sid', serverId: 1, creatorUserId: 1, createdAt: Date.now(), type: 'terminal',
    userWs: null, agentWs: null, userBuf: [], agentBuf: [],
  };
  inst.sessions.set('0-sid', sess);
  const received = [];
  const userWs = {
    closed: false,
    attachment: { role: 'user', sid: '0-sid', serverId: 1, creatorUserId: 1, type: 'terminal', createdAt: Date.now(), auth: { kind: 'pat', tokenHash: hash } },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(a) { this.attachment = a; },
    send: (m) => received.push(m), close() { this.closed = true; }, readyState: 1,
  };
  const agentWs = {
    attachment: { role: 'agent', sid: '0-sid', serverId: 1, type: 'terminal', createdAt: Date.now() },
    deserializeAttachment() { return this.attachment; },
    send() {}, close() {}, readyState: 1,
  };
  sess.userWs = userWs;
  sess.agentWs = agentWs;

  // 降权前：输出正常投递
  await inst.webSocketMessage(agentWs, 'output-1');
  assert.deepEqual(received, ['output-1'], '降权前输出正常送达浏览器');

  // 降为只读
  await env.DB.prepare('UPDATE api_tokens SET scopes = ? WHERE token_hash = ?').bind(JSON.stringify(['server:read']), hash).run();
  sess.lastAuthCheck = 0; // 越过 10s 节流
  await inst.webSocketMessage(agentWs, 'sensitive output');
  assert.equal(userWs.closed, true, '输出方向触发重校验并关闭连接');
  assert.deepEqual(received, ['output-1'], '降权后的输出不得投递给浏览器');

  // 已标记 revoked：后续 agent 输出直接丢弃，不再重复校验
  await inst.webSocketMessage(agentWs, 'more output');
  assert.deepEqual(received, ['output-1'], 'revoked 后持续丢弃输出');
});

// 前端 serversCache 由 WS 推送（PanelDO.buildList 的返回值）整体覆盖。两处列表构建
// （auth.js listServersWithState 与 do-panel.js buildList）必须字段同构：新增字段只改一处，
// UI 会立刻"丢字段"——description 就踩过：推送到达后名字不再可点，且编辑弹窗回填空值、
// 保存时把已有描述静默清空。这里用键集合对比把同构关系锁死。
test('PanelDO.buildList 与 REST 列表字段同构（新增字段不能只改一处）', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash, description) VALUES (?,?,?,?,?)')
    .bind('k-parity', 'parity', 1, 'h-parity', '备份机 · 每日 2:00').run();
  const admin = { id: 1, username: 'admin', role: 1, pat: null };
  const pushed = await new PanelDO(mockState(), env).buildList(admin, {});
  const rest = await listServersWithState(env, admin);
  assert.deepEqual(Object.keys(pushed[0]).sort(), Object.keys(rest[0]).sort(), '推送与 REST 列表字段必须一致');
  assert.equal(pushed[0].description, '备份机 · 每日 2:00', '推送须带描述');
  assert.equal(rest[0].description, '备份机 · 每日 2:00', 'REST 须带描述');
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
  const ws = {
    attachment: { role: 'viewer-pending', authDeadline: Date.now() + 10000 }, closed: false,
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(att) { this.attachment = att; },
    send: (m) => sent.push(m), close() { this.closed = true; },
  };
  const inst = new PanelDO({ getWebSockets: () => [ws] }, env);
  await inst.webSocketMessage(ws, JSON.stringify({ type: 'auth', token: pat }));
  assert.equal(ws.attachment.role, 'viewer');
  assert.equal(ws.attachment.auth.kind, 'pat');
  assert.equal(ws.attachment.auth.tokenHash, hash);
  assert.equal(JSON.stringify(ws.attachment).includes(pat), false, 'Hibernation 附件不含 PAT 明文');
  await inst.webSocketMessage(ws, 'sync');
  assert.deepEqual(JSON.parse(sent[0]).map((s) => s.name), ['srv-a']);
  await env.DB.prepare('DELETE FROM api_tokens WHERE token_hash = ?').bind(hash).run();
  inst.authCache.clear();
  inst.syncAt.delete(ws);
  await inst.webSocketMessage(ws, 'sync');
  assert.equal(ws.closed, true, '安全 PAT 身份在撤销后重新查询并关闭连接');
});

// ---------------- TerminalDO ----------------
test('TerminalDO: Agent 控制与数据通道拒绝 query key', async () => {
  const inst = new TerminalDO(mockState(), makeEnv());
  for (const path of [
    '/ws/agent/control?key=secret',
    '/ws/agent/terminal?sid=0-test&key=secret',
    '/ws/agent/file?sid=0-test&key=secret',
  ]) {
    const res = await inst.fetch(new Request(`https://do.internal${path}`));
    assert.equal(res.status, 401, `${path} 应拒绝 query key`);
    assert.equal(await res.text(), 'missing agent key');
  }
});

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

test('TerminalDO: 上报间隔从连接附件恢复（evict 后不再打 PanelDO /viewers）', async () => {
  // 自定义 PANEL stub：记录 /viewers 调用次数
  const viewers = [];
  const env = makeEnv({
    PANEL: {
      idFromName: () => 'panel-main',
      get: () => ({
        fetch: async (url) => {
          viewers.push(String(url));
          return new Response(JSON.stringify({ count: 0 }), { status: 200 });
        },
      }),
    },
  });
  await insertServer(env, 'k1', 'srv1');
  // 路径 A：附件里已有上次下发的间隔（evict 后内存 Map 空，但附件还在）
  const sent = [];
  let att = { role: 'control', serverId: 1, interval: 120 };
  const ws = {
    deserializeAttachment: () => att,
    serializeAttachment: (a) => { att = a; },
    send: (m) => sent.push(m), readyState: 1,
  };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, ws);
  await inst.webSocketMessage(ws, JSON.stringify({ type: 'report', cpu: 1 }));
  assert.equal(viewers.length, 0, '附件命中时不查 PanelDO /viewers（省一次 DO 请求）');
  assert.equal(inst.agentInterval.get(1), 120, '间隔从附件恢复进内存');
  assert.equal(
    sent.filter((m) => String(m).includes('set_report_interval')).length, 0,
    'agent 侧已知间隔，不重发',
  );

  // 路径 B：附件没有 interval（升级前的老连接）→ 才走 /viewers 兜底
  const ws2 = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send: () => {}, readyState: 1 };
  const inst2 = new TerminalDO(mockState(), env);
  inst2.agents.set(1, ws2);
  await inst2.webSocketMessage(ws2, JSON.stringify({ type: 'report', cpu: 1 }));
  assert.ok(viewers.length >= 1, '附件无间隔时才查 PanelDO');
});

test('TerminalDO: pong 刷新往返时间并写入附件（evict 后可恢复）', async () => {
  const env = makeEnv();
  const att = { role: 'control', serverId: 1 };
  const ws = {
    deserializeAttachment: () => att,
    serializeAttachment: (a) => { Object.assign(att, a); },
    send() {}, readyState: 1,
  };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, ws);
  await inst.webSocketMessage(ws, JSON.stringify({ type: 'pong', id: 'p-1' }));
  assert.ok(att.rtt > 0, 'rtt 写进连接附件');
  // 模拟 evict 唤醒：新实例靠附件恢复 rtt，exec 判据拿到真实时间戳
  const inst2 = new TerminalDO({ getWebSockets: () => [ws] }, env);
  inst2.rebuildIndex();
  assert.equal(inst2.lastRoundTripAt.get(1), att.rtt, '唤醒后 rtt 从附件恢复');
});

test('TerminalDO: 唤醒重建只沿胜出连接恢复 probeCapable（旧半开连接不复活能力）', async () => {
  const env = makeEnv();
  const closed = [];
  const oldWs = {
    deserializeAttachment: () => ({ role: 'control', serverId: 1, ts: 1, probe: true }),
    send() {}, readyState: 1, close(c) { closed.push(c); },
  };
  const newWs = {
    deserializeAttachment: () => ({ role: 'control', serverId: 1, ts: 2 }), // 回滚后的新连接：不声明 probe
    send() {}, readyState: 1, close() {},
  };
  const inst = new TerminalDO({ getWebSockets: () => [oldWs, newWs] }, env);
  inst.rebuildIndex();
  assert.equal(inst.agents.get(1), newWs, '胜出的是 ts 更大的新连接');
  assert.equal(inst.probeCapable.has(1), false, '旧连接的 probe 标记不得复活能力（否则对旧 agent 持续探测→误 503）');
  assert.ok(closed.includes(4001), '旧连接被关闭');
});

test('TerminalDO: 唤醒重建只沿胜出连接恢复上报间隔与 rtt（旧半开连接的值不残留）', () => {
  const env = makeEnv();
  // 旧连接：按快采 5s 下发过，且有过往返记录；新连接附件两者都没写
  // （握手时 /viewers 查询失败则不写 interval；刚连上还没 pong 则无 rtt）
  const oldWs = {
    deserializeAttachment: () => ({ role: 'control', serverId: 1, ts: 1, interval: 5, rtt: 111 }),
    send() {}, readyState: 1, close() {},
  };
  const newWs = {
    deserializeAttachment: () => ({ role: 'control', serverId: 1, ts: 2 }),
    send() {}, readyState: 1, close() {},
  };
  const inst = new TerminalDO({ getWebSockets: () => [oldWs, newWs] }, env);
  inst.rebuildIndex();
  assert.equal(inst.agents.get(1), newWs, '胜出的是 ts 更大的新连接');
  assert.equal(inst.agentInterval.has(1), false,
    '旧连接的快采档位不得残留（syncAgentInterval 以内存已有为短路，残留会按 5s 上报、请求放大 24 倍）');
  assert.equal(inst.lastRoundTripAt.has(1), false,
    '旧连接的 rtt 不得残留（否则被判「有过期记录」而误 503，实际应乐观放行）');
});

test('TerminalDO: 被顶替的旧连接 close 不清新连接的探活能力与往返记录', async () => {
  const env = makeEnv();
  const mk = (ts) => ({ deserializeAttachment: () => ({ role: 'control', serverId: 1, ts }), send() {}, readyState: 1, close() {} });
  const oldWs = mk(1);
  const newWs = mk(2);
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, newWs); // 新连接已接管
  inst.probeCapable.add(1); // 新连接刚登记的能力
  inst.lastRoundTripAt.set(1, 12345);
  await inst.cleanup(oldWs); // 旧连接的 close 事件延迟到达
  assert.equal(inst.probeCapable.has(1), true, '被顶替连接的 close 不得清除新连接的能力');
  assert.equal(inst.lastRoundTripAt.get(1), 12345, '往返记录同样保留');
  assert.equal(inst.agents.get(1), newWs, '当前连接不变');
  // 真正的断开（isCurrent）才清理
  await inst.cleanup(newWs);
  assert.equal(inst.probeCapable.has(1), false, '真正断开时才清能力');
  assert.equal(inst.lastRoundTripAt.has(1), false, '真正断开时才清往返记录');
});

test('TerminalDO: 能力撤销同时清附件 rtt（不会在 evict 后被复活）', async () => {
  const env = makeEnv();
  let att = { role: 'control', serverId: 1, probe: true, rtt: 12345 };
  const ws = {
    deserializeAttachment: () => att,
    serializeAttachment: (a) => { att = a; },
    send() {}, readyState: 1,
  };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, ws);
  inst.probeCapable.add(1);
  inst.lastRoundTripAt.set(1, 12345);
  inst.clearProbeCapable(ws, 1);
  assert.equal(att.probe, undefined, 'probe 标记被清除');
  assert.equal(att.rtt, undefined, 'rtt 一并清除，避免陈旧记录被 rebuildIndex 复活');
  assert.equal(inst.lastRoundTripAt.has(1), false, '内存同步清除');
});

test('TerminalDO: evict 后（附件恢复 probeCapable、无 RTT）exec 乐观放行', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const jobId = `job_${'b'.repeat(32)}`;
  await seedExecJob(env, jobId);
  const sent = [];
  const att = { role: 'control', serverId: 1, probe: true }; // 只有能力标记，没有 rtt
  const agentWs = {
    deserializeAttachment: () => att,
    serializeAttachment: (a) => { Object.assign(att, a); },
    send: (m) => sent.push(m), readyState: 1,
  };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, agentWs);
  inst.probeCapable.add(1); // 等价于 rebuildIndex 从 att.probe 恢复
  const res = await inst.fetch(new Request('https://do.internal/rpc/exec/submit', {
    method: 'POST', body: JSON.stringify({ jobId, serverId: 1, command: 'echo hi', timeoutMs: 5000 }),
  }));
  assert.equal(res.status, 200, '冷启动无 RTT 记录时应放行，而不是 503');
  assert.equal(JSON.parse(sent[0]).type, 'exec', '直接下发命令');
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

test('TerminalDO: 文件写操作指令写审计（delete/zip/rename Text 帧 + write 首块 Binary 混合帧）', async () => {
  const env = makeEnv();
  const inst = new TerminalDO(mockState(), env);
  const userWs = { send() {}, close() {} };
  const agentWs = { send() {}, readyState: 1 };
  // 模拟已鉴权文件会话（首帧鉴权会写入 creatorUser；clientIp 随 /rpc 创建时传入）
  inst.sessions.set('0-fid', {
    sid: '0-fid', streamId: '0-fid', serverId: 1, creatorUserId: 7, creatorUser: 'alice',
    clientIp: '203.0.113.7',
    type: 'file', createdAt: Date.now(), userWs, agentWs, userBuf: [], agentBuf: [],
  });
  const audits = async (action) => {
    const rows = await env.DB.prepare('SELECT * FROM audit_logs WHERE action = ?').bind(action).all();
    return rows.results;
  };
  // Binary 混合帧：JSON 头 + '\n' + 原始字节（生产上传路径，api.js _sendNextUpload 同构）
  const mixFrame = (obj, bytes = 0) => {
    const head = new TextEncoder().encode(JSON.stringify(obj) + '\n');
    const buf = new Uint8Array(head.length + bytes);
    buf.set(head, 0);
    return buf.buffer;
  };

  // delete / rename / zip 各记一条（Text JSON 帧）
  await inst.webSocketMessage(userWs, JSON.stringify({ type: 'delete', path: '/tmp/a.txt' }));
  await inst.webSocketMessage(userWs, JSON.stringify({ type: 'rename', path: '/tmp/a.txt', new_name: 'b.txt' }));
  await inst.webSocketMessage(userWs, JSON.stringify({ type: 'zip', path: '/opt/dir' }));
  // write 走 Binary 混合帧：仅首块（offset=0）记一条，后续块不重复
  await inst.webSocketMessage(userWs, mixFrame({ type: 'write', path: '/tmp/up.bin', offset: 0, commit: false }));
  await inst.webSocketMessage(userWs, mixFrame({ type: 'write', path: '/tmp/up.bin', offset: 512, commit: true }, 512));

  const dels = await audits('file.delete');
  assert.equal(dels.length, 1);
  assert.equal(dels[0].username, 'alice');
  assert.equal(dels[0].target_server_id, 1);
  assert.equal(dels[0].client_ip, '203.0.113.7');
  assert.equal(dels[0].detail, '/tmp/a.txt');

  const rens = await audits('file.rename');
  assert.equal(rens.length, 1);
  assert.equal(rens[0].detail, '/tmp/a.txt → b.txt');

  const zips = await audits('file.zip');
  assert.equal(zips.length, 1);
  assert.equal(zips[0].detail, '/opt/dir');

  const wrs = await audits('file.write');
  assert.equal(wrs.length, 1, 'write 仅首块记录一次（Binary 混合帧审计生效）');
  assert.equal(wrs[0].detail, '/tmp/up.bin');
  assert.equal(wrs[0].client_ip, '203.0.113.7');

  // 非文件指令（终端输入等）不产生审计
  const all = await env.DB.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action LIKE 'file.%'").all();
  assert.equal(Number(all.results[0].c), 4, '仅 4 条文件审计（delete/rename/zip/write）');
});

test('TerminalDO: 休眠唤醒后文件审计保留 username 与 client_ip', async () => {
  const env = makeEnv();
  const createdAt = Date.now();
  const auth = { kind: 'jwt', id: 7, username: 'alice', role: 1, exp: Math.floor(Date.now() / 1000) + 3600 };
  const agentWs = {
    attachment: {
      role: 'agent', sid: '0-fid', serverId: 1, creatorUserId: 7,
      creatorUser: 'alice', clientIp: '203.0.113.7', type: 'file', createdAt,
    },
    sent: [], deserializeAttachment() { return this.attachment; }, send(m) { this.sent.push(m); },
  };
  const userWs = {
    attachment: {
      role: 'user', sid: '0-fid', serverId: 1, creatorUserId: 7,
      creatorUser: 'alice', clientIp: '203.0.113.7', type: 'file', createdAt, auth,
    },
    deserializeAttachment() { return this.attachment; }, send() {}, close() {},
  };
  const state = mockState();
  state.getWebSockets = () => [agentWs, userWs]; // agent 先重建，随后 user 补齐/挂接
  const inst = new TerminalDO(state, env);
  await inst.webSocketMessage(userWs, JSON.stringify({ type: 'delete', path: '/tmp/a.txt' }));

  const row = await env.DB.prepare("SELECT * FROM audit_logs WHERE action = 'file.delete'").first();
  assert.equal(row.user_id, 7);
  assert.equal(row.username, 'alice');
  assert.equal(row.client_ip, '203.0.113.7');
  assert.equal(agentWs.sent.length, 1, '休眠恢复后消息仍转发给 agent');
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

test('TerminalDO: alarm 回收超时 user-pending 连接', async () => {
  const now = Date.now();
  const makeWs = (authDeadline) => ({
    attachment: { role: 'user-pending', authDeadline }, closed: false,
    deserializeAttachment() { return this.attachment; },
    close() { this.closed = true; },
  });
  const expired = makeWs(now - 1);
  const future = makeWs(now + 5000);
  const st = mockState();
  st.getWebSockets = () => [expired, future];
  const inst = new TerminalDO(st, makeEnv());
  await inst.alarm();
  assert.equal(expired.closed, true, '超时 pending 连接关闭');
  assert.equal(future.closed, false, '未到期 pending 连接保留');
  assert.equal(st.storage.alarmTs, future.attachment.authDeadline + 1000, '续排下一鉴权截止时间');

  const saturated = mockState();
  saturated.getWebSockets = () => Array.from({ length: 128 }, () => makeWs(now + 5000));
  const limitedInst = new TerminalDO(saturated, makeEnv());
  limitedInst.sessions.set('0-sid', {
    streamId: '0-sid', serverId: 1, creatorUserId: 1, createdAt: now,
    type: 'terminal', userWs: null, agentWs: null,
  });
  const limited = await limitedInst.fetch(new Request('https://do.internal/ws/terminal/0-sid'));
  assert.equal(limited.status, 429, 'pending 达到硬上限后拒绝新连接');
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
  await inst.maybeSweep();
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
  await inst.maybeSweep();
  assert.ok(st.storage.alarmTs != null, '活跃会话也排 alarm');
  assert.equal(st.storage.alarmTs, createdAt + 4 * 3600 * 1000 + 1000, 'alarm 对齐绝对 TTL');
  // 模拟 4h 后：maybeSweep 强制回收（即使连接仍活跃）
  const live = { closed: false, close() { this.closed = true; } };
  inst.sessions.get('1-a').createdAt = Date.now() - (4 * 3600 * 1000 + 1000);
  inst.sessions.get('1-a').userWs = live;
  await inst.maybeSweep();
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
  assert.equal(ok.attachment.auth.kind, 'pat');
  assert.equal(ok.attachment.auth.tokenHash, await I.hashSecret(okToken, env));
  assert.equal(JSON.stringify(ok.attachment).includes(okToken), false, 'Hibernation 附件不含 PAT 明文');
  await env.DB.prepare('DELETE FROM api_tokens WHERE token_hash = ?').bind(ok.attachment.auth.tokenHash).run();
  inst.sessions.get('0-sid').lastAuthCheck = 0;
  await inst.webSocketMessage(ok, 'echo after revoke');
  assert.equal(ok.closed, true, '仅凭附件 HMAC 即可在撤销后关闭连接');

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

// ---------------- A~E + T1：控制连接索引自愈 / 断连清理 / exec 探活 ----------------

test('TerminalDO: 上报入站即刷新 agents 索引（活连接覆盖死连接）', async () => {
  const env = makeEnv();
  await insertServer(env, 'k1', 'srv1');
  const deadWs = { send() {}, readyState: 1 };
  const liveWs = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send() {}, readyState: 1 };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, deadWs); // 索引指向死连接（唤醒重建后可能出现的错误条目）
  await inst.webSocketMessage(liveWs, JSON.stringify({ type: 'report', cpu: 1 }));
  assert.equal(inst.agents.get(1), liveWs, '上报入站把索引刷成能收到消息的活连接');
});

test('TerminalDO: 唤醒重建索引时同 serverId 保留最新控制连接、关闭旧连接', () => {
  const env = makeEnv();
  const mk = (ts) => ({
    closed: false, code: 0,
    deserializeAttachment: () => ({ role: 'control', serverId: 1, ts }),
    close(c) { this.closed = true; this.code = c; }, send() {},
  });
  const oldWs = mk(100);
  const newWs = mk(200);
  const inst = new TerminalDO({ getWebSockets: () => [newWs, oldWs] }, env);
  inst.rebuildIndex();
  assert.equal(inst.agents.get(1), newWs, '保留 ts 最新的控制连接');
  assert.equal(oldWs.closed, true, '旧连接被关闭');
  assert.equal(oldWs.code, 4001, '旧连接以 4001 superseded 关闭（agent 长退避，不互踢）');
  assert.equal(newWs.closed, false, '最新连接保留');
});

test('TerminalDO: rebuildIndex 唤醒后只重建一次（不复活已摘除的连接）', () => {
  const env = makeEnv();
  const ws = {
    deserializeAttachment: () => ({ role: 'control', serverId: 1, ts: 1 }),
    close() {}, send() {},
  };
  const inst = new TerminalDO({ getWebSockets: () => [ws] }, env);
  inst.rebuildIndex();
  assert.equal(inst.agents.get(1), ws, '首次重建生效');
  inst.agents.delete(1); // 模拟 cleanup 摘除（连接已断）
  inst.rebuildIndex();
  assert.equal(inst.agents.has(1), false, '已摘除的连接不会被再次重建复活');
});

test('TerminalDO: 上报顺风车 probe —— report 后发探测帧，pong 刷新往返时间', async () => {
  const env = makeEnv();
  await insertServer(env, 'k1', 'srv1');
  const sent = [];
  const agentWs = {
    deserializeAttachment: () => ({ role: 'control', serverId: 1 }),
    send: (m) => sent.push(m), readyState: 1,
  };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, agentWs);
  inst.probeCapable.add(1);
  await inst.webSocketMessage(agentWs, JSON.stringify({
    type: 'report', cpu: 1, info: { probe_proto: 1 },
  }));
  const probe = sent.map((m) => JSON.parse(m)).find((m) => m.type === 'probe');
  assert.ok(probe && probe.id, 'report 顺带发出探活帧（出站消息不计费）');
  assert.equal(inst.lastRoundTripAt.has(1), false, '尚未收到 pong');
  await inst.webSocketMessage(agentWs, JSON.stringify({ type: 'pong', id: probe.id }));
  assert.ok(inst.lastRoundTripAt.has(1), 'pong 刷新往返时间，exec 判据随之新鲜');
});

test('TerminalDO: 往返窗口过期 → 503 并补发探活，但不关闭连接', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const jobId = `job_${'c'.repeat(32)}`;
  await seedExecJob(env, jobId);
  const sent = [];
  const agentWs = {
    deserializeAttachment: () => ({ role: 'control', serverId: 1 }),
    send: (m) => sent.push(m), readyState: 1, closed: false,
    close() { this.closed = true; },
  };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, agentWs);
  inst.probeCapable.add(1);
  // 有记录但已过期（20 分钟 > 900s 窗口）→ 判不可信；与"完全无记录"的乐观放行区分开
  inst.lastRoundTripAt.set(1, Date.now() - 20 * 60 * 1000);
  const res = await inst.fetch(new Request('https://do.internal/rpc/exec/submit', {
    method: 'POST',
    body: JSON.stringify({ jobId, serverId: 1, command: 'echo hi', timeoutMs: 5000 }),
  }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'agent link not verified, please retry');
  assert.equal(sent.length, 1, '只发探活，未把命令发进虚空');
  assert.equal(JSON.parse(sent[0]).type, 'probe');
  assert.equal(agentWs.closed, false, '只是未验证，不判死连接');
  const row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind(jobId).first();
  assert.equal(row.status, 'failed', '未验证拒绝 → 任务落 failed，不留排队态');
});

test('TerminalDO: 未协商 probe 的 agent（旧版）exec 直接下发，不做探活', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const jobId = `job_${'9'.repeat(32)}`;
  await seedExecJob(env, jobId);
  const sent = [];
  const agentWs = { send: (m) => sent.push(m), readyState: 1 };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, agentWs); // 未 add probeCapable → 旧 agent
  const pending = inst.fetch(new Request('https://do.internal/rpc/exec/submit', {
    method: 'POST',
    body: JSON.stringify({ jobId, serverId: 1, command: 'echo hi', timeoutMs: 5000 }),
  }));
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'running');
  assert.equal(JSON.parse(sent[0]).type, 'exec', '未协商 → 直接下发，保持向后兼容');
  assert.equal(JSON.parse(sent[0]).exec_id, jobId, '帧里的 exec_id 就是 job_id');
  await inst.webSocketMessage(agentWs, JSON.stringify({
    type: 'exec_result', exec_id: jobId, stdout: '', stderr: '', exit_code: 0, timed_out: false,
  }));
  const row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind(jobId).first();
  assert.equal(row.status, 'succeeded');
});

test('TerminalDO: 上报处理抛错（D1 故障）仍发送保活心跳（E）', async () => {
  const env = makeEnv();
  env.DB.prepare = () => { throw new Error('D1 quota exceeded'); }; // 模拟 handleReport 抛错
  const sent = [];
  const ws = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send: (m) => sent.push(m), readyState: 1 };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, ws);
  await inst.webSocketMessage(ws, JSON.stringify({ type: 'report', cpu: 1 }));
  const pingCount = sent.filter((m) => { try { return JSON.parse(m).type === 'ping'; } catch { return false; } }).length;
  assert.equal(pingCount, 1, 'handleReport 抛错不应连带停发心跳（否则 agent 180s 误判半开重连）');
});

test('TerminalDO: 探活能力写入连接附件，唤醒重建后恢复（evict 后 T1 不失效）', async () => {
  const env = makeEnv();
  const att = { role: 'control', serverId: 1, ts: 1 };
  const ws = {
    deserializeAttachment: () => att,
    serializeAttachment: (a) => { Object.assign(att, a); },
    send() {}, readyState: 1,
  };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, ws);
  inst.probeCapable.add(1);
  // 回执不再关联 Promise（探活由上报顺风车发出、无等待方），pong 直接按连接归属刷新
  await inst.webSocketMessage(ws, JSON.stringify({ type: 'pong', id: 'p-wake' }));
  assert.equal(att.probe, true, 'pong 后能力写入连接附件');

  // 模拟 evict 唤醒：新实例据附件恢复 probeCapable
  const inst2 = new TerminalDO({ getWebSockets: () => [ws] }, env);
  inst2.rebuildIndex();
  assert.equal(inst2.probeCapable.has(1), true, '唤醒重建从附件恢复探活能力');
});

test('TerminalDO: agent 经上报自声明 probe 能力（info.probe_proto）→ 登记并写附件', async () => {
  const env = makeEnv();
  await insertServer(env, 'k1', 'srv1');
  const att = { role: 'control', serverId: 1, ts: 1 };
  const ws = {
    deserializeAttachment: () => att,
    serializeAttachment: (a) => { Object.assign(att, a); },
    send() {}, readyState: 1,
  };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, ws);
  assert.equal(inst.probeCapable.has(1), false, '初始未登记');
  await inst.webSocketMessage(ws, JSON.stringify({ type: 'report', cpu: 1, info: { probe_proto: 1 } }));
  assert.equal(inst.probeCapable.has(1), true, '上报声明能力后登记');
  assert.equal(att.probe, true, '能力写入连接附件（evict 后可恢复）');
});

test('TerminalDO: 旧 agent 上报无 probe_proto → 不登记能力（exec 永不探活）', async () => {
  const env = makeEnv();
  await insertServer(env, 'k1', 'srv1');
  const ws = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send() {}, readyState: 1 };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, ws);
  await inst.webSocketMessage(ws, JSON.stringify({ type: 'report', cpu: 1, info: { os: 'Linux' } }));
  assert.equal(inst.probeCapable.has(1), false, '旧 agent 不登记探活能力 → 直接下发，永不误关');
});

test('TerminalDO: 探活成功（pong）刷新往返时间 → 紧邻 exec 不再重复探活', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const jobId = `job_${'8'.repeat(32)}`;
  await seedExecJob(env, jobId);
  const sent = [];
  const agentWs = {
    deserializeAttachment: () => ({ role: 'control', serverId: 1 }),
    send: (m) => sent.push(m), readyState: 1,
  };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, agentWs);
  inst.probeCapable.add(1);
  // 顺风车探活的回执：pong 无条件按连接归属刷新往返时间（已无等待方）
  await inst.webSocketMessage(agentWs, JSON.stringify({ type: 'pong', id: 'p-1' }));
  assert.ok(inst.lastRoundTripAt.has(1), 'pong 刷新往返时间');

  // 紧邻的 exec：往返窗口新鲜 → 直接下发，不重复探活
  const pending = inst.fetch(new Request('https://do.internal/rpc/exec/submit', {
    method: 'POST', body: JSON.stringify({ jobId, serverId: 1, command: 'echo hi', timeoutMs: 5000 }),
  }));
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'running');
  assert.equal(sent.length, 1, '往返新鲜时不发探活帧，只下发 exec');
  assert.equal(JSON.parse(sent[0]).type, 'exec', 'pong 已刷新往返 → exec 直接下发（不再探活）');
  assert.equal(JSON.parse(sent[0]).exec_id, jobId, '帧里的 exec_id 就是 job_id');
  await inst.webSocketMessage(agentWs, JSON.stringify({
    type: 'exec_result', exec_id: jobId, stdout: '', stderr: '', exit_code: 0, timed_out: false,
  }));
  const row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind(jobId).first();
  assert.equal(row.status, 'succeeded');
});

test('TerminalDO: agent 降级不再声明 probe_proto → 清除能力与附件标记', async () => {
  const env = makeEnv();
  await insertServer(env, 'k1', 'srv1');
  let att = { role: 'control', serverId: 1, ts: 1 };
  const ws = {
    deserializeAttachment: () => att,
    serializeAttachment: (a) => { att = a; },
    send() {}, readyState: 1,
  };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, ws);
  await inst.webSocketMessage(ws, JSON.stringify({ type: 'report', cpu: 1, info: { probe_proto: 1 } }));
  assert.equal(inst.probeCapable.has(1), true, '声明后登记');
  assert.equal(att.probe, true, '附件标记已写');

  // agent 回滚到旧版：info 不再含 probe_proto
  await inst.webSocketMessage(ws, JSON.stringify({ type: 'report', cpu: 1, info: { os: 'Linux' } }));
  assert.equal(inst.probeCapable.has(1), false, '不再声明 → 清除能力（避免 evict 后从附件误恢复）');
  assert.equal(att.probe, undefined, '附件标记同步清除');
});

test('TerminalDO: agent 更新中 → exec 立即 409（不探活、不下发任何帧）', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const jobId = `job_${'6'.repeat(32)}`;
  await seedExecJob(env, jobId);
  const sent = [];
  const agentWs = { send: (m) => sent.push(m), readyState: 1 };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, agentWs);
  inst.probeCapable.add(1);
  await seedActiveUpdate(env, 1); // D1 侧存在未过期更新：内存标记才算数（isUpdating）
  inst.updating.set(1, 'job_upd_1'); // 更新进行中：互斥判定优先于链路新鲜度
  const res = await inst.fetch(new Request('https://do.internal/rpc/exec/submit', {
    method: 'POST', body: JSON.stringify({ jobId, serverId: 1, command: 'echo hi', timeoutMs: 5000 }),
  }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'agent update in progress');
  assert.equal(sent.length, 0, '未下发任何帧（不与二进制更新帧交错，也不浪费探活）');
  const row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind(jobId).first();
  assert.equal(row.status, 'failed', '更新让路 → 任务落 failed');
});

test('TerminalDO: 过期 update 的本地互斥标记按 D1 deadline 清除（不永久挡住 exec/终端）', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, created_at, deadline_at, expires_at)
     VALUES ('job_upd_stale','agent_update','running',1,'admin',1,?,?,?)`
  ).bind(now - 900, now - 300, now + 86400).run();
  const inst = new TerminalDO(mockState(), env);
  inst.updating.set(1, 'job_upd_stale'); // Agent 挂住不回执、连接仍在：内存标记永不释放
  assert.equal(await inst.isUpdating(1), false, 'D1 已判过期 → 不再视为更新中');
  assert.equal(inst.updating.has(1), false, '本地残留标记必须清除');
  // isUpdating 只读（不顺手 UPDATE：那是每次开终端/exec 都要付的写语句）——
  // 过期行占的唯一索引只在「创建 agent_update」时挡路，由 createAgentUpdateJob 的
  // settleServerExpired 收敛（见 api 用例「已过 deadline 的 agent_update 不再阻塞命令」）。
  const row = await env.DB.prepare("SELECT status FROM operation_jobs WHERE id = 'job_upd_stale'").first();
  assert.equal(row.status, 'running', '只读判据不得改状态');

  // 未过期时仍必须拦（不误放行）
  await seedActiveUpdate(env, 2);
  const inst2 = new TerminalDO(mockState(), env);
  inst2.updating.set(2, 'job_upd_2');
  assert.equal(await inst2.isUpdating(2), true, '未过期的更新仍须互斥');
});

// evict 后新实例的 updating 是空的，但另一实例（或 evict 前）下发的更新仍在跑：
// 此时只看本地标记会放行 exec，与 self-replace 交错。必须始终以 D1 为准。
test('TerminalDO: 冷实例无本地标记时仍按 D1 拦截进行中的更新', async () => {
  const env = makeEnv();
  await seedActiveUpdate(env, 1);
  const inst = new TerminalDO(mockState(), env); // 模拟 evict 后的新实例
  assert.equal(inst.updating.size, 0);
  assert.equal(await inst.isUpdating(1), true, 'D1 有未过期更新时必须拦截（不得因本地无标记而放行）');
});

// 旧更新挂住（无回执、连接仍在）时内存标记不会释放；此时用户重试更新，新任务刚入库
// （queued、未过期）——若不排除「本次要下发的任务」，isUpdating 会被新任务自己的 D1 行挡住，
// 重试永远 409（只能等实例 evict）。旧任务的迟到回执同样不得清掉新任务的标记。
test('TerminalDO: 旧更新挂住后新任务仍可下发（互斥标记按 jobId 判定）', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  const ins = (id, status, deadline) => env.DB.prepare(
    `INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, created_at, deadline_at, expires_at)
     VALUES (?, 'agent_update', ?, 1, 'admin', 1, ?, ?, ?)`
  ).bind(id, status, now - 900, deadline, now + 86400).run();
  await ins('job_old_upd', 'running', now - 300); // A：上次更新，已过期（挂住无回执）
  // A 先被 createAgentUpdateJob 的 settleServerExpired 收敛（唯一索引随之让出），B 才能插入
  await env.DB.prepare("UPDATE operation_jobs SET status = 'expired' WHERE id = 'job_old_upd'").run();
  await ins('job_new_upd', 'queued', now + 200);  // B：本次重试新建的任务

  const inst = new TerminalDO(mockState(), env);
  inst.updating.set(1, 'job_old_upd');
  assert.equal(await inst.isUpdating(1, 'job_new_upd'), false, '新任务不得被旧标记挡住');
  assert.equal(inst.updating.has(1), false, '旧标记应被清除');

  // B 运行期间 exec 仍必须被拦（互斥没有被误放开）
  inst.updating.set(1, 'job_new_upd');
  assert.equal(await inst.isUpdating(1), true, '未过期更新仍须互斥');

  // A 的迟到回执不得释放 B 的标记（否则 exec 会与 B 的 self-replace 交错）
  await inst.settleUpdateJob('job_old_upd', { ok: false, error: 'late' });
  assert.equal(inst.updating.get(1), 'job_new_upd', '旧任务的迟到回执不得清掉新任务的标记');
});

// 旧实现一次 list('m:') 把整个热区读进内存（240×N 行）。分页后必须保证：
// 跨页时同一台机器的行不丢、每台机器处理完即可释放、源行用批量 delete 清理。
test('MetricsDO: fullSweep 分页处理热区（小页也能扫全）且批量删除', async () => {
  const env = makeEnv();
  const st = mockState();
  const { inst } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  for (let sid = 1; sid <= 3; sid++) {
    st.storage.map.set(`arc:${sid}`, String(nowMin - 400)); // 水位已覆盖全部行 → 走删除分支
    for (let i = 0; i < 5; i++) {
      st.storage.map.set(`m:${sid}:${nowMin - 300 + i}`, JSON.stringify({ cpu: sid * 10 + i }));
    }
  }
  // 强制每页 2 行（模拟后端把 limit 压得更小）：验证跨页缓冲与「空页才停」的终止条件
  const origList = st.storage.list.bind(st.storage);
  st.storage.list = async (opts = {}) => origList({ ...opts, limit: 2 });
  let batchDeletes = 0;
  const origDelete = st.storage.delete.bind(st.storage);
  st.storage.delete = async (k) => { if (Array.isArray(k)) batchDeletes += 1; return origDelete(k); };

  assert.equal(await inst.fullSweep(true), true, '分页扫描应完整完成');
  const rows = await env.DB.prepare('SELECT COUNT(*) AS c FROM metrics_min').first();
  assert.equal(rows.c, 15, '三台各 5 行全部归档（跨页不丢）');
  const hotLeft = [...st.storage.map.keys()].filter((k) => k.startsWith('m:'));
  assert.deepEqual(hotLeft, [], '被水位覆盖的源行全部删除');
  assert.ok(batchDeletes <= 3, `应按服务器批量删（每次 ≤128 键），实际 ${batchDeletes} 次`);
  assert.ok(st.storage.map.has('arc:1'), '水位键保留');
});

// /latest 冷启动（面板首连/evict 后）原来扫全量热区（240×N 行 + 逐行 parse）。
// 现在读每机一份的 l: 快照行；旧数据没有 l: 时才回退全扫（升级兼容）。
test('MetricsDO: /latest 冷启动读 l: 快照，不全量扫热区', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const st = mockState();
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  st.storage.map.set('l:1', JSON.stringify({ ts: nowMin - 5, cpu: 42, mem_used: 3 }));
  for (let i = 0; i < 50; i++) st.storage.map.set(`m:1:${nowMin - i}`, JSON.stringify({ cpu: 1 }));

  const { inst, call } = mkMetrics(env, st);
  const prefixes = [];
  const orig = inst.listStorage.bind(inst);
  inst.listStorage = async (p, o) => { prefixes.push(p); return orig(p, o); };
  const latest = await (await call('/latest')).json();
  assert.equal(latest[1].cpu, 42, '冷启动返回快照值');
  assert.deepEqual(prefixes, ['l:'], '只读 l: 快照，不扫 m:（50 行热区一行都没读）');
});

test('MetricsDO: l: 快照降频写（首帧必写，之后每 5 分钟一次）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const st = mockState();
  const { call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const base = nowMin - 20; // 不看分钟奇偶：按「距上次写」计时，避免 120s 慢采永远不命中 5 的倍数
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: base, cpu: 7 }) });
  assert.equal(JSON.parse(st.storage.map.get('l:1')).cpu, 7, '首帧（含 evict 后）必写快照');
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: base + 1, cpu: 8 }) });
  assert.equal(JSON.parse(st.storage.map.get('l:1')).cpu, 7, '1 分钟后不重写');
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: base + 5, cpu: 9 }) });
  const snap = JSON.parse(st.storage.map.get('l:1'));
  assert.equal(snap.cpu, 9, '距上次写满 5 分钟再写');
  assert.equal(snap.ts, base + 5);
});

// 归档水位原先每跨一分钟写一次（1,440 写/台/天，与热行同量）。降频到 10 分钟后，
// 内存水位照常逐分钟推进，只是落盘间隔变大（evict 后最多重放 10 行，幂等）。
test('MetricsDO: 归档水位降频持久化（10 分钟内不重复写 arc:）', async () => {
  const env = makeEnv();
  const st = mockState();
  const { call } = mkMetrics(env, st);
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const m1 = nowMin - 70; // 归档线之前
  const arcWrites = [];
  const origPut = st.storage.put.bind(st.storage);
  st.storage.put = async (k, v) => {
    if (typeof k === 'string' && k.startsWith('arc:')) arcWrites.push(k);
    else if (k && typeof k === 'object') for (const kk of Object.keys(k)) if (kk.startsWith('arc:')) arcWrites.push(kk);
    return origPut(k, v);
  };

  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: m1, cpu: 1 }) });
  assert.equal(Number(st.storage.map.get('arc:1')), m1, '首次推进立即落盘');
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: m1 + 1, cpu: 2 }) });
  assert.equal(Number(st.storage.map.get('arc:1')), m1, '推进 1 分钟不重复写');
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: m1 + 10, cpu: 3 }) });
  assert.equal(Number(st.storage.map.get('arc:1')), m1 + 10, '推进满 10 分钟落盘');
  assert.equal(arcWrites.length, 2, '三次上报只写两次水位');
});

// 兜底对账要 list 全部 probe: 键（500 台 × 10 探针 ≈ 5,000 键），按 10 分钟 alarm 扫
// 是 72 万键读/天。门控：仅告警开启 + 每小时最多一次，时间戳落 housekeep 跨 evict。
test('MetricsDO: 探活状态兜底对账每小时最多一次（读放大门控）', async () => {
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO kv_json (key, value) VALUES ('settings', ?)")
    .bind(JSON.stringify({ alerts: { webhook_url: 'https://example.com/hook', cpu_pct: 90, cooldown_min: 30 } }))
    .run();
  const st = mockState();
  const { inst } = mkMetrics(env, st);
  let lists = 0;
  const orig = inst.listStorage.bind(inst);
  inst.listStorage = async (p, o) => { if (p === 'probe:') lists += 1; return orig(p, o); };
  await st.storage.put('probe:1:web', JSON.stringify({ ok: false, lastFail: 1 })); // 服务器 1 已删除

  await inst.alarm(); // 首轮：告警开启 + 从未对账 → 扫一次并清掉孤儿键
  assert.equal(lists, 1, '本轮对账一次');
  assert.equal(st.storage.map.has('probe:1:web'), false, '服务器已删除的残留被清掉');
  assert.ok(inst.lastProbePruneAt > 0, '对账时间戳已记录');

  await st.storage.put('probe:1:db', JSON.stringify({ ok: false, lastFail: 1 }));
  await inst.alarm(); // 同一小时内：跳过对账
  assert.equal(lists, 1, '一小时内不再重复对账');
  assert.equal(st.storage.map.has('probe:1:db'), true, '本轮未清理（下轮再来，不影响正确性）');

  // 对账失败（Storage 抖动）不得推进时间戳：否则一次抖动要白等一小时才重试
  inst.lastProbePruneAt = 0;
  const orig2 = inst.listStorage.bind(inst);
  inst.listStorage = async (p, o) => {
    if (p === 'probe:') throw new Error('storage down');
    return orig2(p, o);
  };
  await inst.alarm();
  assert.equal(inst.lastProbePruneAt, 0, '失败不推进时间戳，下轮 alarm（10 分钟）重试');
  inst.listStorage = orig2;
});

test('MetricsDO: 未配置 webhook 时不对账探活状态（状态不产生通知，省读）', async () => {
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO kv_json (key, value) VALUES ('settings', ?)")
    .bind(JSON.stringify({ alerts: { cpu_pct: 90 } })) // 无 webhook_url → alertOn=false
    .run();
  const st = mockState();
  const { inst } = mkMetrics(env, st);
  let lists = 0;
  const orig = inst.listStorage.bind(inst);
  inst.listStorage = async (p, o) => { if (p === 'probe:') lists += 1; return orig(p, o); };
  await st.storage.put('probe:1:web', JSON.stringify({ ok: false, lastFail: 1 }));

  await inst.alarm();
  assert.equal(lists, 0, '未配置 webhook：不扫描探活状态');
  assert.equal(st.storage.map.has('probe:1:web'), true, '状态保留，配置 webhook 后的首轮再对账');
});

// 冷启动（evict 后）的 arcPersisted 必须从 storage 初始化，否则每个新实例的首轮归档都会
// 立刻写一次水位——慢采 + 频繁 evict 时降频就白做了（1,440 写/台/天）。
test('MetricsDO: 冷启动首轮也参与水位降频（arcPersisted 从 storage 初始化）', async () => {
  const env = makeEnv();
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const m1 = nowMin - 70;
  const st = mockState({ 'arc:1': String(m1) });
  const { call } = mkMetrics(env, st);
  const writes = [];
  const origPut = st.storage.put.bind(st.storage);
  st.storage.put = async (k, v) => {
    if (typeof k === 'string' && k.startsWith('arc:')) writes.push(k);
    else if (k && typeof k === 'object') for (const kk of Object.keys(k)) if (kk.startsWith('arc:')) writes.push(kk);
    return origPut(k, v);
  };

  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: m1 + 1, cpu: 1 }) });
  assert.equal(writes.length, 0, '推进 <10 分钟不写水位');
  assert.equal(Number(st.storage.map.get('arc:1')), m1, '水位保持原值');
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
  await inst.cleanup(ctl1);
  assert.equal(inst.agents.has(1), false);
  assert.equal(inst.pendingOpen.has('1-a'), false, 'server1 待确认被清理');
  assert.equal(inst.pendingOpen.has('2-b'), true, 'server2 待确认不受影响');

  // 会话 1-a 的 agent 数据流断开 → 清该会话待确认并回收会话，不影响 server2
  await inst.cleanup(agentFlow);
  assert.equal(inst.sessions.has('1-a'), false, '1-a 两端断开被回收');
  assert.equal(inst.pendingOpen.has('2-b'), true, 'server2 待确认仍保留');

  // server2 控制通道断开 → 全部清空
  await inst.cleanup(ctl2);
  assert.equal(inst.agents.size, 0);
  assert.equal(inst.pendingOpen.size, 0, 'server2 断开后 pendingOpen 清空');
});

test('MetricsDO: 同分钟多帧后首次 /query 返回最新帧（loadHot 不得回退到 storage 首帧）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const { call } = mkMetrics(env, mockState());
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  // 热写路径每分钟只把首帧落 storage，后续帧只更新内存
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 10 }) });
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: nowMin, cpu: 90 }) });

  // 首次 /query 触发 loadHot（从 storage 恢复）：必须与内存合并，不能整体替换
  const q = await (await call('/query?server_id=1&limit=10')).json();
  assert.equal(q.length, 1);
  assert.equal(q[0].cpu, 90, '/query 必须返回分钟内最新帧（合并而非覆盖）');
});

// ---------------- MetricsDO：按天统计（流量累计 / 可用率 / 重启检测） ----------------
// 存在理由：metrics_min 只留 30 天、7 天后降采样，且离线期间根本没有行——
// 月度流量与可用率无法事后反推，只能实时累加。以下锁定四条核心不变式。

// 日界安全的基准时刻：取当天 12:00（UTC）。addDaySpan 会按天拆分区间，
// 若直接用 Date.now() 当基准，一旦当前时刻距当天结束不足用例跨度的时长
// （如 UTC 21:00 之后跑 3 小时跨度的用例），区间会跨日拆成两行，
// 断言（单行 total_min）必然失败——此前 UTC 21:00 之后 CI 每天变红。
// 取正午可留出 12 小时余量，覆盖本文件所有用例的跨度。
function daySafeBase() {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / 86400) * 86400 + 12 * 3600;
}

test('MetricsDO: 按天统计累加在线时长与流量（速率 × 时长）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const { inst } = mkMetrics(env, mockState());
  const base = daySafeBase();
  inst.accumulateDay(7, base, 100, 200, 3600);        // 首帧：建立游标，无区间
  inst.accumulateDay(7, base + 60, 100, 200, 3600);   // 间隔 60s → 记 60s 在线
  await inst.flushDayPending();

  const rows = await env.DB.prepare('SELECT * FROM metrics_day WHERE server_id = 7').all();
  assert.equal(rows.results.length, 1);
  const r = rows.results[0];
  assert.ok(Math.abs(r.total_min - 1) < 1e-6, `分母应为 1 分钟，实际 ${r.total_min}`);
  assert.ok(Math.abs(r.online_min - 1) < 1e-6, '全程在线：分子等于分母');
  assert.equal(r.bytes_in, 6000, '入站 = 100 B/s × 60s');
  assert.equal(r.bytes_out, 12000, '出站 = 200 B/s × 60s');
  assert.equal(r.restarts, 0);
});

test('MetricsDO: 跨天区间按天拆分，不整体记入某一天', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const { inst } = mkMetrics(env, mockState());
  const day = Math.floor(Date.now() / 1000 / 86400);
  const midnight = (day + 1) * 86400; // 次日 0 点（UTC），即当天的真实结束边界
  // 从午夜前 30s 跨到午夜后 30s：总 60s，两边各 30s
  inst.accumulateDay(8, midnight - 30, 10, 10, null);
  inst.accumulateDay(8, midnight + 30, 10, 10, null);
  await inst.flushDayPending();

  const rows = await env.DB.prepare('SELECT * FROM metrics_day WHERE server_id = 8 ORDER BY day').all();
  assert.equal(rows.results.length, 2, '跨天必须拆成两天的账');
  assert.equal(rows.results[0].day, day);
  assert.equal(rows.results[1].day, day + 1);
  assert.ok(Math.abs(rows.results[0].total_min - 0.5) < 1e-6, '当天 30s');
  assert.ok(Math.abs(rows.results[1].total_min - 0.5) < 1e-6, '次日 30s');
});

test('MetricsDO: 长时间离线只补可用率分母——可用率不得虚高', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const { inst } = mkMetrics(env, mockState());
  const base = daySafeBase();
  inst.accumulateDay(9, base, 0, 0, 100);
  // 间隔 3 小时（远超 DAY_ONLINE_GAP_S=300s）：仅尾部 300s 视为在线
  inst.accumulateDay(9, base + 3 * 3600, 0, 0, 100);
  await inst.flushDayPending();

  const r = await env.DB.prepare('SELECT * FROM metrics_day WHERE server_id = 9').first();
  assert.ok(Math.abs(r.total_min - 180) < 1e-6, `分母应为 180 分钟，实际 ${r.total_min}`);
  assert.ok(Math.abs(r.online_min - 5) < 1e-6, `分子应只有 5 分钟，实际 ${r.online_min}`);
  // 这是本表存在的意义：若把离线段也算在线，可用率会恒为 100% 而完全失真
  assert.ok(r.online_min / r.total_min < 0.04, '可用率必须显著低于 100%');
});

test('MetricsDO: 离线机器由 alarm 补记分母（不再上报也不虚高）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const state = mockState();
  await insertServerWithId(env, 11, daySafeBase());
  const { inst } = mkMetrics(env, state);
  const base = daySafeBase();
  await inst.ensureDayCursor(11);
  inst.accumulateDay(11, base, 0, 0, 100);
  inst.lastSeenSec.set(11, base);
  await inst.flushDayPending(); // 先落一次在线段（同时持久化游标）

  // 模拟 2 小时后 alarm，且实例已被 evict（新实例内存游标与 lastSeenSec 均为空）：
  // 必须仍能从 D1 servers.last_seen 认出该机并补分母——否则「整段时间都在别的实例上报」
  // 的机器永远补不到分母，长时间离线反而显示 100%
  const cold = new MetricsDO(state, env);
  await cold.sweepOfflineDaySpans(base + 2 * 3600);
  await cold.flushDayPending();

  const r = await env.DB.prepare('SELECT * FROM metrics_day WHERE server_id = 11').first();
  assert.ok(r.total_min > 100, `离线 2 小时应补约 120 分钟分母，实际 ${r.total_min}`);
  assert.ok(r.online_min < 6, `分子不得随分母增长，实际 ${r.online_min}`);
});

test('MetricsDO: 实例 evict 后天账继续累加（游标持久化跨实例）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const state = mockState();
  const base = daySafeBase();
  const a = new MetricsDO(state, env);
  await a.ensureDayCursor(7);
  a.accumulateDay(7, base, 100, 200, 3600);
  await a.flushDayPending(); // 落 D1 + 持久化游标

  // 第二个实例（模拟 evict）：内存里没有任何游标，必须从 Storage 恢复后继续累加
  const b = new MetricsDO(state, env);
  await b.ensureDayCursor(7);
  b.accumulateDay(7, base + 120, 100, 200, 3720);
  await b.flushDayPending();

  const r = await env.DB.prepare('SELECT * FROM metrics_day WHERE server_id = 7').first();
  assert.ok(Math.abs(r.total_min - 2) < 1e-6, `跨实例两帧应累计 2 分钟，实际 ${r.total_min}`);
  assert.ok(Math.abs(r.online_min - 2) < 1e-6, '两帧都在线：分子等于分母');
  assert.equal(r.bytes_in, 12000, '入站 = 100 B/s × 120s');
  assert.equal(r.bytes_out, 24000, '出站 = 200 B/s × 120s');
});

test('MetricsDO: 游标缺失时用 D1 last_seen 播种（慢采首帧不丢区间）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const state = mockState(); // 空 Storage：首次部署/游标被清
  const base = daySafeBase();
  await insertServerWithId(env, 21, base);

  const inst = new MetricsDO(state, env);
  await inst.ensureDayCursor(21);
  inst.accumulateDay(21, base + 120, 50, 60, 3600); // 慢采间隔 120s
  await inst.flushDayPending();

  const r = await env.DB.prepare('SELECT * FROM metrics_day WHERE server_id = 21').first();
  assert.ok(r.total_min > 0, `首帧必须借助 D1 播种补上区间，实际 ${r.total_min}`);
  assert.ok(Math.abs(r.total_min - 2) < 1e-6, `120s 慢采应记 2 分钟，实际 ${r.total_min}`);
  assert.equal(r.bytes_in, 6000, '入站 = 50 B/s × 120s');
});

test('MetricsDO: 游标持久化失败时本轮不写 D1（避免下次按旧游标重复记账）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const state = mockState();
  const inst = new MetricsDO(state, env);
  const base = daySafeBase();
  inst.dayAccum.set(7, { lastSec: base, uptimeMin: null });
  inst.dayCurDirty.add(7);
  inst.accumulateDay(7, base + 120, 100, 100, 100);
  assert.equal(inst.dayPending.size, 1);

  const origPut = state.storage.put.bind(state.storage);
  state.storage.put = async (k, v) => {
    if (k === 'daycur:7') throw new Error('storage down');
    return origPut(k, v);
  };
  await inst.flushDayPending();
  let row = await env.DB.prepare('SELECT * FROM metrics_day WHERE server_id = 7').first();
  assert.equal(row, null, '游标没落盘时不得写增量（否则下次冷启动会重复记账）');
  assert.equal(inst.dayPending.size, 1, '增量保留到下次 flush');

  state.storage.put = origPut; // 恢复后重试：游标与增量一起落库
  await inst.flushDayPending();
  row = await env.DB.prepare('SELECT * FROM metrics_day WHERE server_id = 7').first();
  assert.ok(row && Math.abs(row.total_min - 2) < 1e-6, '恢复后应补写 2 分钟');
});

test('MetricsDO: uptime 下降沿计为重启（与可用率互补）', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const { inst } = mkMetrics(env, mockState());
  const base = Math.floor(Date.now() / 1000);
  inst.accumulateDay(10, base, 0, 0, 86400 * 10);         // 开机 10 天
  inst.accumulateDay(10, base + 60, 0, 0, 86400 * 10 + 60); // 正常增长 → 不计
  inst.accumulateDay(10, base + 120, 0, 0, 120);          // 骤降 → 重启
  await inst.flushDayPending();

  const r = await env.DB.prepare('SELECT * FROM metrics_day WHERE server_id = 10').first();
  assert.equal(r.restarts, 1, '仅一次下降沿');
  // 可用率视角这台机器全程在线（100%），但 uptime 暴露了它重启过——两者互补
  assert.ok(Math.abs(r.online_min - r.total_min) < 1e-6);
});

test('MetricsDO: flush 采用增量 UPSERT，多次 flush 累加而非覆盖', async () => {
  const env = makeEnv({ ARCHIVE_TO_D1: '0' });
  const { inst } = mkMetrics(env, mockState());
  const base = Math.floor(Date.now() / 1000);
  inst.accumulateDay(12, base, 0, 0, null);
  inst.accumulateDay(12, base + 60, 100, 0, null);
  await inst.flushDayPending();
  inst.accumulateDay(12, base + 120, 100, 0, null);
  await inst.flushDayPending();

  const r = await env.DB.prepare('SELECT * FROM metrics_day WHERE server_id = 12').first();
  assert.ok(Math.abs(r.total_min - 2) < 1e-6, '两次 flush 的分母应累加为 2 分钟');
  assert.equal(r.bytes_in, 12000, '流量累加而非被第二次 flush 覆盖');
});

// ---------------- 异步 exec：DO 只下发与落库，不等待 ----------------
async function seedExecJob(env, id, { status = 'queued', startedAt = null } = {}) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs
      (id, kind, status, user_id, username, client_ip, server_id, command, timeout_s, created_at, started_at, deadline_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, 'exec', status, 1, 'admin', '1.1.1.1', 1, 'echo hi', 5, now - 5, startedAt, now + 35, now + 86400)
    .run();
}

test('TerminalDO /rpc/exec/submit：只下发不等待，queued → running', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const jobId = `job_${'a'.repeat(32)}`;
  await seedExecJob(env, jobId);

  const inst = new TerminalDO(mockState(), env);
  const sent = [];
  inst.agents.set(1, { send: (m) => sent.push(m), readyState: 1, close() {} });
  const res = await inst.fetch(new Request('https://do.internal/rpc/exec/submit', {
    method: 'POST', body: JSON.stringify({ jobId, serverId: 1, command: 'echo hi', timeoutMs: 5000 }),
  }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'running');

  const row = await env.DB.prepare('SELECT status, started_at FROM operation_jobs WHERE id = ?').bind(jobId).first();
  assert.equal(row.status, 'running');
  assert.ok(row.started_at > 0, '记录执行开始时间（duration 基准）');

  const frame = JSON.parse(sent.find((m) => JSON.parse(m).type === 'exec'));
  assert.equal(frame.exec_id, jobId, '帧里的 exec_id 就是 job_id，回执据此落库');
  assert.equal(frame.timeout_s, 5);
  // 异步化的核心：DO 不持有等待 Promise、不设 timer
});

test('TerminalDO /rpc/exec/submit：Agent 离线 / 更新中 → 任务落 failed', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();

  // 离线
  const offId = `job_${'b'.repeat(32)}`;
  await seedExecJob(env, offId);
  const inst = new TerminalDO(mockState(), env);
  const off = await inst.fetch(new Request('https://do.internal/rpc/exec/submit', {
    method: 'POST', body: JSON.stringify({ jobId: offId, serverId: 1, command: 'id', timeoutMs: 5000 }),
  }));
  assert.equal(off.status, 503);
  const offRow = await env.DB.prepare('SELECT status, error FROM operation_jobs WHERE id = ?').bind(offId).first();
  assert.equal(offRow.status, 'failed');
  assert.match(offRow.error, /agent offline/);

  // 更新中：内存里已有同步更新标记
  const updId = `job_${'c'.repeat(32)}`;
  await seedExecJob(env, updId);
  inst.agents.set(1, { send() {}, readyState: 1, close() {} });
  await seedActiveUpdate(env, 1); // isUpdating 以 D1 deadline 为准，标记需有对应活动任务
  inst.updating.set(1, 'job_upd_1');
  const upd = await inst.fetch(new Request('https://do.internal/rpc/exec/submit', {
    method: 'POST', body: JSON.stringify({ jobId: updId, serverId: 1, command: 'id', timeoutMs: 5000 }),
  }));
  assert.equal(upd.status, 409);
  const updRow = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind(updId).first();
  assert.equal(updRow.status, 'failed');
});

test('TerminalDO exec_result：终态落 D1 + 审计；DO evict 后仍能完成；重复回执不覆盖', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const jobId = `job_${'d'.repeat(32)}`;
  await seedExecJob(env, jobId, { status: 'running', startedAt: Math.floor(Date.now() / 1000) - 3 });

  // 模拟 evict：全新实例，内存 Map 全空，仅有一条 agent 控制连接
  const inst = new TerminalDO(mockState(), env);
  const ws = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send() {}, readyState: 1, close() {} };
  inst.agents.set(1, ws);

  await inst.webSocketMessage(ws, JSON.stringify({
    type: 'exec_result', exec_id: jobId, exit_code: 0, stdout: 'hi\n', stderr: '', timed_out: false,
  }));
  const row = await env.DB.prepare('SELECT * FROM operation_jobs WHERE id = ?').bind(jobId).first();
  assert.equal(row.status, 'succeeded');
  assert.equal(row.exit_code, 0);
  assert.equal(row.stdout, 'hi\n');
  assert.ok(row.duration_ms >= 3000, 'duration_ms 由 started_at 计算');

  const audit = await env.DB.prepare("SELECT * FROM audit_logs WHERE action = 'exec.command' AND job_id = ?").bind(jobId).all();
  assert.equal(audit.results.length, 1, '终态写一条 exec.command 审计');
  assert.equal(audit.results[0].target_server_id, 1);
  assert.match(audit.results[0].detail, /^exit=0 echo hi/);
  assert.equal(audit.results[0].duration_ms, row.duration_ms);

  // 重复回执：不得覆盖终态、不得重复审计
  await inst.webSocketMessage(ws, JSON.stringify({
    type: 'exec_result', exec_id: jobId, exit_code: 9, stdout: 'dup', stderr: '', timed_out: false,
  }));
  const row2 = await env.DB.prepare('SELECT * FROM operation_jobs WHERE id = ?').bind(jobId).first();
  assert.equal(row2.exit_code, 0);
  assert.equal(row2.stdout, 'hi\n');
  const audit2 = await env.DB.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE job_id = ?").bind(jobId).first();
  assert.equal(audit2.c, 1);
});

test('TerminalDO exec_result：命令超时回执 → timed_out（非 failed/succeeded）', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const jobId = `job_${'e'.repeat(32)}`;
  await seedExecJob(env, jobId, { status: 'running', startedAt: Math.floor(Date.now() / 1000) - 25 });
  const inst = new TerminalDO(mockState(), env);
  const ws = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send() {}, readyState: 1, close() {} };
  inst.agents.set(1, ws);
  await inst.webSocketMessage(ws, JSON.stringify({
    type: 'exec_result', exec_id: jobId, exit_code: null, stdout: '', stderr: '', timed_out: true,
  }));
  const row = await env.DB.prepare('SELECT status, timed_out FROM operation_jobs WHERE id = ?').bind(jobId).first();
  assert.equal(row.status, 'timed_out');
  assert.equal(row.timed_out, 1);
});

// ---------------- 阶段 B/C：DO 只下发元数据，不推字节 ----------------
test('TerminalDO /rpc/upload/submit：只下发 upload_fetch 元数据，不推文件字节', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, target_path, overwrite, size_bytes, r2_key, created_at, deadline_at, expires_at)
    VALUES ('job_up', 'upload', 'staged', 1, 'admin', 1, '/opt/a.bin', 0, 100, 'upload-jobs/job_up', ?, ?, ?)`)
    .bind(now, now + 600, now + 86400).run();

  const inst = new TerminalDO(mockState(), env);
  const sent = [];
  const ws = {
    attachment: { role: 'control', serverId: 1, caps: { upload_fetch_proto: 1 } },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(a) { this.attachment = a; },
    send: (m) => sent.push(m), readyState: 1, close() {},
  };
  inst.agents.set(1, ws);

  const res = await inst.fetch(new Request('https://do.internal/rpc/upload/submit', {
    method: 'POST',
    body: JSON.stringify({
      jobId: 'job_up', serverId: 1, path: '/opt/a.bin', overwrite: false,
      size: 100, downloadUrl: 'https://panel.local/mcp/upload-jobs/download?id=job_up',
    }),
  }));
  assert.equal(res.status, 200);
  const frame = JSON.parse(sent.at(-1));
  assert.equal(frame.type, 'upload_fetch');
  assert.equal(frame.upload_id, 'job_up');
  assert.equal(frame.path, '/opt/a.bin');
  assert.match(frame.url, /^https:\/\/panel\.local\//);
  // 关键：帧里没有文件内容（数据面已移出 DO）
  assert.equal('data' in frame, false);
  assert.equal(typeof sent.at(-1), 'string', '只发 JSON 文本帧，不发二进制混合帧');
  const row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_up').first();
  assert.equal(row.status, 'running');
});

test('TerminalDO /rpc/upload/submit：Agent 无 upload_fetch_proto → 明确要求升级', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, target_path, size_bytes, r2_key, created_at, deadline_at, expires_at)
    VALUES ('job_old', 'upload', 'staged', 1, 'admin', 1, '/opt/a.bin', 10, 'upload-jobs/job_old', ?, ?, ?)`)
    .bind(now, now + 600, now + 86400).run();
  const inst = new TerminalDO(mockState(), env);
  // 旧 Agent：附件无 caps
  inst.agents.set(1, { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send() {}, readyState: 1, close() {} });
  const res = await inst.fetch(new Request('https://do.internal/rpc/upload/submit', {
    method: 'POST',
    body: JSON.stringify({ jobId: 'job_old', serverId: 1, path: '/opt/a.bin', size: 10, downloadUrl: 'https://p/x' }),
  }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'AGENT_UPGRADE_REQUIRED');
  const row = await env.DB.prepare('SELECT status, error FROM operation_jobs WHERE id = ?').bind('job_old').first();
  assert.equal(row.status, 'failed');
  assert.match(row.error, /does not support async upload/);
});

test('TerminalDO upload_result：commit 才终态；非 commit 帧不改状态', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, client_ip, server_id, target_path, size_bytes, r2_key, created_at, started_at, deadline_at, expires_at)
    VALUES ('job_c', 'upload', 'running', 1, 'admin', '', 1, '/opt/a.bin', 5, 'upload-jobs/job_c', ?, ?, ?, ?)`)
    .bind(now - 2, now - 2, now + 120, now + 86400).run();
  await env.UPLOADS.put('upload-jobs/job_c', 'hello');
  const inst = new TerminalDO(mockState(), env);
  const ws = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send() {}, readyState: 1, close() {} };
  inst.agents.set(1, ws);

  // 非 commit 帧（仅表示该块已写入临时文件）→ 不改终态
  await inst.webSocketMessage(ws, JSON.stringify({
    type: 'upload_result', upload_id: 'job_c', ok: true, commit: false, size: 5,
  }));
  let row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_c').first();
  assert.equal(row.status, 'running', '非 commit 回执不得提前判成功');
  assert.ok(await env.UPLOADS.head('upload-jobs/job_c'), '此时对象仍需保留');

  // commit 帧 → succeeded，对象删除
  await inst.webSocketMessage(ws, JSON.stringify({
    type: 'upload_result', upload_id: 'job_c', ok: true, commit: true, size: 5,
  }));
  row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_c').first();
  assert.equal(row.status, 'succeeded');
  assert.equal(await env.UPLOADS.head('upload-jobs/job_c'), null, '成功后立刻删 staging 对象');
});

// 更新互斥释放：updating 只在 send 抛错时清过。成功后不清会让这台机器在本 DO 实例
// 存活期内再也无法 exec/upload（反复 409），而 D1 侧任务已是终态——纯内存泄漏。
test('TerminalDO /rpc/agent_update/submit：回执后释放 updating，同机 exec 恢复正常', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, build_id, from_version, to_version, platform, size_bytes, sha256, asset_url, created_at, deadline_at, expires_at)
    VALUES ('job_u1','agent_update','queued',1,'admin',1,'2026.10.28-1200','2020.01.01-0000','2026.10.28-1200','linux-x86_64',4,'aa','https://p/x',?,?,?)`)
    .bind(now, now + 210, now + 86400).run();

  const inst = new TerminalDO(mockState(), env);
  const sent = [];
  const ws = {
    attachment: { role: 'control', serverId: 1, caps: { update_fetch_proto: 1, upload_fetch_proto: 1 } },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(a) { this.attachment = a; },
    send: (m) => sent.push(m), readyState: 1, close() {},
  };
  inst.agents.set(1, ws);

  const res = await inst.fetch(new Request('https://do.internal/rpc/agent_update/submit', {
    method: 'POST',
    body: JSON.stringify({ jobId: 'job_u1', serverId: 1, buildId: '2026.10.28-1200', platform: 'linux-x86_64', size: 4, sha256: 'aa', downloadUrl: 'https://p/mcp/agent-update-asset?x=1' }),
  }));
  assert.equal(res.status, 200);
  assert.equal(inst.updating.has(1), true, '下发期间持有互斥');

  // Agent 回执成功 → 互斥必须释放
  await inst.webSocketMessage(ws, JSON.stringify({
    type: 'agent_update_result', update_id: 'job_u1', ok: true, build_id: '2026.10.28-1200', size: 4,
  }));
  assert.equal(inst.updating.has(1), false, '回执后必须释放 updating（否则同机永久 409）');
  const row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_u1').first();
  assert.equal(row.status, 'succeeded');

  // 后续 exec 不再被"agent update in progress"挡住
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, command, timeout_s, created_at, deadline_at, expires_at)
    VALUES ('job_e1','exec','queued',1,'admin',1,'echo hi',5,?,?,?)`).bind(now, now + 35, now + 86400).run();
  const execRes = await inst.fetch(new Request('https://do.internal/rpc/exec/submit', {
    method: 'POST', body: JSON.stringify({ jobId: 'job_e1', serverId: 1, command: 'echo hi', timeoutMs: 5000 }),
  }));
  assert.equal(execRes.status, 200, '更新结束后同机 exec 必须恢复正常');
});

test('TerminalDO /rpc/agent_update/submit：回执 build 不符不判成功', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, build_id, from_version, to_version, platform, size_bytes, sha256, asset_url, created_at, deadline_at, expires_at)
    VALUES ('job_u2','agent_update','queued',1,'admin',1,'2026.10.28-1200','2020.01.01-0000','2026.10.28-1200','linux-x86_64',4,'aa','https://p/x',?,?,?)`)
    .bind(now, now + 210, now + 86400).run();
  const inst = new TerminalDO(mockState(), env);
  const ws = {
    attachment: { role: 'control', serverId: 1, caps: { update_fetch_proto: 1 } },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(a) { this.attachment = a; },
    send() {}, readyState: 1, close() {},
  };
  inst.agents.set(1, ws);
  await inst.fetch(new Request('https://do.internal/rpc/agent_update/submit', {
    method: 'POST',
    body: JSON.stringify({ jobId: 'job_u2', serverId: 1, buildId: '2026.10.28-1200', platform: 'linux-x86_64', size: 4, sha256: 'aa', downloadUrl: 'https://p/x' }),
  }));
  // 回执声明了别的 build → 不能标成功
  await inst.webSocketMessage(ws, JSON.stringify({
    type: 'agent_update_result', update_id: 'job_u2', ok: true, build_id: '2026.01.01-0000', size: 4,
  }));
  const row = await env.DB.prepare('SELECT status, error FROM operation_jobs WHERE id = ?').bind('job_u2').first();
  assert.equal(row.status, 'failed');
  assert.match(row.error, /build mismatch/);
});

test('TerminalDO /rpc/upload/submit：回执 size 与 staged 不符不判成功', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, target_path, size_bytes, r2_key, created_at, started_at, deadline_at, expires_at)
    VALUES ('job_ss','upload','running',1,'admin',1,'/opt/a.bin',100,'upload-jobs/job_ss',?,?,?,?)`)
    .bind(now - 2, now - 2, now + 120, now + 86400).run();
  const inst = new TerminalDO(mockState(), env);
  const ws = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send() {}, readyState: 1, close() {} };
  inst.agents.set(1, ws);
  // Agent 报"写完 40 字节"，但 staged 是 100 → 下载被截断，不能算成功
  await inst.webSocketMessage(ws, JSON.stringify({
    type: 'upload_result', upload_id: 'job_ss', ok: true, commit: true, size: 40,
  }));
  const row = await env.DB.prepare('SELECT status, error FROM operation_jobs WHERE id = ?').bind('job_ss').first();
  assert.equal(row.status, 'failed');
  assert.match(row.error, /size mismatch/);
});

// 文档 §9：Agent 离线时任务停在 waiting_agent，重连后自动重发（URL 需重新签发）。
test('upload：Agent 离线停 waiting_agent，重连后自动重发并重新签发 URL', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, target_path, overwrite, size_bytes, r2_key, created_at, deadline_at, expires_at)
    VALUES ('job_w','upload','staged',1,'admin',1,'/opt/a.bin',0,100,'upload-jobs/job_w',?,?,?)`)
    .bind(now, now + 600, now + 86400).run();

  const inst = new TerminalDO(mockState(), env);
  // Agent 离线 → 不失败，转 waiting_agent
  const r1 = await inst.fetch(new Request('https://do.internal/rpc/upload/submit', {
    method: 'POST',
    body: JSON.stringify({ jobId: 'job_w', serverId: 1, path: '/opt/a.bin', size: 100, downloadUrl: 'https://p/old' }),
  }));
  assert.equal(r1.status, 202);
  assert.equal((await r1.json()).status, 'waiting_agent');
  let row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_w').first();
  assert.equal(row.status, 'waiting_agent', '离线保留可恢复状态，不判失败');

  // 重连：resendWaitingUploads 重新签发 URL 并下发
  const sent = [];
  const ws = {
    attachment: { role: 'control', serverId: 1, caps: { upload_fetch_proto: 1 } },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(a) { this.attachment = a; },
    send: (m) => sent.push(JSON.parse(m)), readyState: 1, close() {},
  };
  inst.agents.set(1, ws);
  await inst.resendWaitingUploads(1, ws, 'https://panel.example');
  const frames = sent.filter((f) => f.type === 'upload_fetch');
  assert.equal(frames.length, 1, '重连后应重发一次');
  assert.equal(frames[0].upload_id, 'job_w');
  assert.match(frames[0].url, /^https:\/\/panel\.example\/mcp\/upload-jobs\/download\?/, 'URL 重新签发且为绝对地址');
  assert.notEqual(frames[0].url, 'https://p/old', '不得复用建任务时的旧 URL（已过期）');
  // 回归：DO 收到的 URL 已被 handleWs 改写成 do.internal，若拿它拼 URL 会下发内网地址，
  // Agent 侧 DNS 必然失败 —— 这条断言防止再次被内部改写绕过。
  assert.notEqual(new URL(frames[0].url).host, 'do.internal', '下发给 Agent 的 URL 必须是公网地址');
  row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_w').first();
  assert.equal(row.status, 'running');
});

// P1 回归：重发路径必须拒绝非公网 origin（do.internal / localhost / *.internal），
// 宁可不下发也不能把内网地址交给 Agent —— 那种失败只会表现为 deadline 超时，极难排查。
test('upload 重连重发：非公网 origin 直接放弃（不下发内网 URL）', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, target_path, overwrite, size_bytes, r2_key, created_at, deadline_at, expires_at)
    VALUES ('job_np','upload','waiting_agent',1,'admin',1,'/opt/a.bin',0,10,'upload-jobs/job_np',?,?,?)`)
    .bind(now, now + 600, now + 86400).run();
  const inst = new TerminalDO(mockState(), env);
  const sent = [];
  const ws = {
    attachment: { role: 'control', serverId: 1, caps: { upload_fetch_proto: 1 } },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(a) { this.attachment = a; },
    send: (m) => sent.push(JSON.parse(m)), readyState: 1, close() {},
  };
  inst.agents.set(1, ws);
  for (const bad of ['https://do.internal', 'http://localhost:8787', 'https://x.internal']) {
    await inst.resendWaitingUploads(1, ws, bad);
  }
  assert.equal(sent.filter((f) => f.type === 'upload_fetch').length, 0, '非公网 origin 不得下发');
  const row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_np').first();
  assert.equal(row.status, 'waiting_agent', '任务保持可恢复状态，等真正的公网连接');
});

// 重发循环必须复用能力校验：积压的旧 Agent 任务不能发它不认识的帧
test('upload 重连重发：Agent 无 upload_fetch_proto → 任务失败而非静默超时', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, target_path, overwrite, size_bytes, r2_key, created_at, deadline_at, expires_at)
    VALUES ('job_nc','upload','waiting_agent',1,'admin',1,'/opt/a.bin',0,10,'upload-jobs/job_nc',?,?,?)`)
    .bind(now, now + 600, now + 86400).run();
  const inst = new TerminalDO(mockState(), env);
  const sent = [];
  const ws = {
    attachment: { role: 'control', serverId: 1 }, // 无 caps
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(a) { this.attachment = a; },
    send: (m) => sent.push(JSON.parse(m)), readyState: 1, close() {},
  };
  inst.agents.set(1, ws);
  await inst.resendWaitingUploads(1, ws, 'https://panel.example');
  assert.equal(sent.filter((f) => f.type === 'upload_fetch').length, 0, '不支持异步的 Agent 不得收到 upload_fetch');
  const row = await env.DB.prepare('SELECT status, error FROM operation_jobs WHERE id = ?').bind('job_nc').first();
  assert.equal(row.status, 'failed');
  assert.match(row.error, /does not support async upload/);
});

// 断线收敛：exec/agent_update 的 running 任务在连接断开时立即 failed，不等 deadline；
// upload 不在此时判失败（它走重连重发，判死就没有恢复机会）。
test('断线收敛 D1：exec/update 立即 failed，upload 保持可恢复', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  const ins = (id, kind) => env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, created_at, started_at, deadline_at, expires_at)
    VALUES (?,?, 'running', 1,'admin',1, ?, ?, ?, ?)`).bind(id, kind, now - 1, now - 1, now + 600, now + 86400).run();
  await ins('job_x', 'exec');
  await ins('job_y', 'agent_update');
  await ins('job_z', 'upload');

  const inst = new TerminalDO(mockState(), env);
  const ws = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send() {}, readyState: 1, close() {} };
  inst.agents.set(1, ws);
  await inst.cleanup(ws);
  // cleanup 内部已 await D1 收敛（settleJobsOnDisconnect）；留一拍兜住将来改回 fire-and-forget 的情况
  await new Promise((r) => setTimeout(r, 30));

  const get = async (id) => (await env.DB.prepare('SELECT status, error FROM operation_jobs WHERE id = ?').bind(id).first());
  assert.equal((await get('job_x')).status, 'failed', 'exec 断线即失败');
  assert.match((await get('job_x')).error, /agent disconnected/);
  assert.equal((await get('job_y')).status, 'failed', 'update 断线即失败（不自动重试）');
  assert.equal((await get('job_z')).status, 'running', 'upload 不在断线时判死，等重连重发');
});

// 端到端回归：Worker 转发给 DO 的 query 必须携带公网 origin（handleWs 会把 host
// 改写成 do.internal，改写前必须把真实 origin 传下去，否则重发 URL 指向内网）。
test('handleWs 转发：query 携带公网 origin，DO 侧据此签发可用的下载 URL', async () => {
  const { default: workerEntry, requestBuilder } = await import('../src/index.js').then(async (m) => ({
    default: m.default, requestBuilder: (await import('./helpers.js')).requestBuilder,
  }));
  const call = requestBuilder(workerEntry);
  const env = makeEnv();
  const token = (await (await call(env, { method: 'POST', path: '/api/login', body: { password: 'admin123' } })).json()).token;
  const created = await (await call(env, { method: 'POST', path: '/api/servers', token, body: { name: 'origin' } })).json();
  let forwarded = null;
  env.TERMINAL.get = () => ({ fetch: async (u) => { forwarded = String(u); return new Response(null, { status: 200 }); } });
  await call(env, {
    method: 'GET', path: '/ws/agent/control', headers: { 'x-agent-key': created.agent_key },
    base: 'https://panel.example',
  });
  assert.ok(forwarded, '应转发到 DO');
  const u = new URL(forwarded);
  assert.equal(u.host, 'do.internal', '转发目标仍是内部地址');
  assert.equal(u.searchParams.get('panel_origin'), 'https://panel.example', '公网 origin 必须随 query 透传');
});

// 审计 action 必须与同步路径、前端翻译表一致：写裸 'agent.update' 会让审计页
// 显示原始英文（前端只映射 agent.update.request / .installed / .failed）。
test('agent_update_result：审计 action 用 agent.update.installed（与前端映射一致）', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, client_ip, server_id, build_id, from_version, to_version, platform, size_bytes, sha256, asset_url, created_at, started_at, deadline_at, expires_at)
    VALUES ('job_au','agent_update','running',1,'admin','',1,'2026.10.28-1200','2020.01.01-0000','2026.10.28-1200','linux-x86_64',4,'aa','https://p/x',?,?,?,?)`)
    .bind(now - 3, now - 3, now + 210, now + 86400).run();
  const inst = new TerminalDO(mockState(), env);
  const ws = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send() {}, readyState: 1, close() {} };
  inst.agents.set(1, ws);
  await inst.webSocketMessage(ws, JSON.stringify({
    type: 'agent_update_result', update_id: 'job_au', ok: true, build_id: '2026.10.28-1200', size: 4,
  }));
  const audits = await env.DB.prepare("SELECT action FROM audit_logs WHERE job_id = 'job_au'").all();
  assert.deepEqual(audits.results.map((a) => a.action), ['agent.update.installed'],
    '成功必须写 .installed（写裸 agent.update 前端无法翻译）');
});

// 迟到回执：服务端窗口(330s)窄于 Agent 兜底(360s)，慢链路下必然存在"服务端已判 expired、
// Agent 随后真的把文件落盘了"的窗口。若丢弃回执，用户会永远看到 expired（而文件已存在），
// 且这次上传在审计里完全消失。允许 expired → succeeded 的纠正，并保留"曾判过期"的事实。
test('upload 迟到回执：expired 后收到成功回执 → 纠正为 succeeded 并写审计', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, client_ip, server_id, target_path, size_bytes, r2_key, created_at, started_at, deadline_at, expires_at)
    VALUES ('job_late','upload','expired',1,'admin','',1,'/opt/a.bin',10,'upload-jobs/job_late',?,?,?,?)`)
    .bind(now - 400, now - 390, now - 60, now + 86400).run();
  const inst = new TerminalDO(mockState(), env);
  const ws = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send() {}, readyState: 1, close() {} };
  inst.agents.set(1, ws);

  await inst.webSocketMessage(ws, JSON.stringify({
    type: 'upload_result', upload_id: 'job_late', ok: true, commit: true, size: 10,
  }));

  const row = await env.DB.prepare('SELECT status, error FROM operation_jobs WHERE id = ?').bind('job_late').first();
  assert.equal(row.status, 'succeeded', '迟到成功必须纠正状态，不能停在 expired');
  assert.match(row.error, /late result after expiry/, '保留"曾判过期"的事实');

  const audits = await env.DB.prepare("SELECT action, detail FROM audit_logs WHERE job_id = 'job_late'").all();
  assert.equal(audits.results.length, 1, '迟到回执也必须写审计（否则这次上传完全无记录）');
  assert.equal(audits.results[0].action, 'file.upload');
  assert.match(audits.results[0].detail, /\[late\]/, '审计标注迟到');
});

// 真正的终态仍不可覆盖：重复回执不能把 succeeded 改成 failed
test('upload 重复回执：已 succeeded 不被后续 failed 覆盖', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, client_ip, server_id, target_path, size_bytes, r2_key, created_at, started_at, deadline_at, expires_at)
    VALUES ('job_dup','upload','running',1,'admin','',1,'/opt/b.bin',10,'upload-jobs/job_dup',?,?,?,?)`)
    .bind(now - 5, now - 5, now + 300, now + 86400).run();
  const inst = new TerminalDO(mockState(), env);
  const ws = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send() {}, readyState: 1, close() {} };
  inst.agents.set(1, ws);
  await inst.webSocketMessage(ws, JSON.stringify({ type: 'upload_result', upload_id: 'job_dup', ok: true, commit: true, size: 10 }));
  await inst.webSocketMessage(ws, JSON.stringify({ type: 'upload_result', upload_id: 'job_dup', ok: false, commit: true, error: 'dup' }));
  const row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_dup').first();
  assert.equal(row.status, 'succeeded', '真实终态不可被重复回执覆盖');
  const n = await env.DB.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE job_id = 'job_dup'").first();
  assert.equal(n.c, 1, '审计不重复');
});

// P1-1：被顶替的旧连接（重连时先 close 旧的、再把 agents 指向新的）其 cleanup 到达时
// agents.get(sid) 已是新连接，老的 map 值比较分支会被整体跳过 —— updating 永不释放，
// 该机器在本 DO 实例存活期内永久 409，且断连收敛也不执行。
test('superseded 旧连接：cleanup 仍释放 updating（不依赖 map 命中）', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const inst = new TerminalDO(mockState(), env);
  const mk = () => ({
    attachment: { role: 'control', serverId: 1, ts: Date.now() },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(a) { this.attachment = a; },
    send() {}, readyState: 1, close() {},
  });
  const ws1 = mk();
  const ws2 = mk();
  inst.agents.set(1, ws1);
  inst.updating.set(1, 'job_superseded');

  // 重连：新连接顶替
  inst.agents.set(1, ws2);
  // 旧连接的 close 事件这才到达（异步）
  await inst.cleanup(ws1);

  assert.equal(inst.updating.has(1), false, '被顶替的旧连接也必须释放 updating');
  assert.equal(inst.agents.get(1), ws2, '不能误删当前连接的索引');
});

// P1-2：requeueOrphanUploads 判 timed_out 时必须删 R2 暂存件
test('requeueOrphanUploads：过 deadline 的 running upload → timed_out 且删 R2', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, target_path, size_bytes, r2_key, created_at, started_at, deadline_at, expires_at)
    VALUES ('job_o','upload','running',1,'admin',1,'/opt/a.bin',10,'upload-jobs/job_o',?,?,?,?)`)
    .bind(now - 400, now - 390, now - 60, now + 86400).run();
  await env.UPLOADS.put('upload-jobs/job_o', 'bytes');
  assert.ok(await env.UPLOADS.head('upload-jobs/job_o'), '前提：对象存在');

  const { requeueOrphanUploads } = await import('../src/jobs.js');
  const n = await requeueOrphanUploads(env, 1, now);
  assert.equal(n, 1);
  const row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_o').first();
  assert.equal(row.status, 'timed_out');
  assert.equal(await env.UPLOADS.head('upload-jobs/job_o'), null, '判 timed_out 时必须删暂存件（不能等 24h cron）');
});

// P2-3：已过 deadline 的 waiting_agent 不得重发（否则旧包延迟覆盖生产文件）
test('重连重发：过期 waiting_agent 不重发，并收敛为 expired + 删 R2', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, target_path, overwrite, size_bytes, r2_key, created_at, deadline_at, expires_at)
    VALUES ('job_stale','upload','waiting_agent',1,'admin',1,'/opt/app.tar.gz',0,10,'upload-jobs/job_stale',?,?,?)`)
    .bind(now - 3000, now - 3000, now + 86400).run();
  await env.UPLOADS.put('upload-jobs/job_stale', 'old-bytes');

  const inst = new TerminalDO(mockState(), env);
  const sent = [];
  const ws = {
    attachment: { role: 'control', serverId: 1, caps: { upload_fetch_proto: 1 } },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(a) { this.attachment = a; },
    send: (m) => sent.push(JSON.parse(m)), readyState: 1, close() {},
  };
  inst.agents.set(1, ws);
  await inst.resendWaitingUploads(1, ws, 'https://panel.example');

  assert.equal(sent.filter((f) => f.type === 'upload_fetch').length, 0, '过期任务绝不能再下发（会覆盖生产文件）');
  const row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_stale').first();
  assert.equal(row.status, 'expired', '过期任务要有终态，不能永远挂在 waiting_agent');
  assert.equal(await env.UPLOADS.head('upload-jobs/job_stale'), null, '收敛时同样清暂存件');
});

// listWaitingUploads 自身必须过滤 deadline：只靠 settleExpiredWaitingUploads 收敛会让
// "过滤缺失"这个 bug 被掩盖（两者都在重连路径上，前者先执行）。这里直接测函数本身。
test('listWaitingUploads：只返回未过 deadline 的任务', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  // 两台服务器各一个任务：同一 server 只允许一个非终态 upload（部分唯一索引），
  // 所以用不同 server_id 分别验证"未过期保留 / 已过期排除"。
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k2', 's2', 1, 'h2').run();
  const ins = (id, serverId, deadline) => env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, target_path, overwrite, size_bytes, r2_key, created_at, deadline_at, expires_at)
    VALUES (?, 'upload', 'waiting_agent', 1,'admin',?,'/opt/x',0,10,?,?,?,?)`)
    .bind(id, serverId, `upload-jobs/${id}`, now - 100, deadline, now + 86400).run();
  await ins('job_live', 1, now + 300);
  await ins('job_dead', 2, now - 60);

  const { listWaitingUploads } = await import('../src/jobs.js');
  assert.deepEqual((await listWaitingUploads(env, 1, now)).map((r) => r.id), ['job_live']);
  assert.deepEqual((await listWaitingUploads(env, 2, now)).map((r) => r.id), [],
    '过期任务不得进入重发列表');
});

// P2-4：exec 失败路径必须留审计（旧同步路径这几种场景都会写 exec.command）
test('exec 失败留审计：Agent 离线提交 → exec.command.failed', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, client_ip, server_id, command, timeout_s, created_at, deadline_at, expires_at)
    VALUES ('job_ef','exec','queued',1,'admin','',1,'rm -rf /tmp/x',5,?,?,?)`).bind(now, now + 35, now + 86400).run();
  const inst = new TerminalDO(mockState(), env); // 不注册 agent → 离线

  const res = await inst.fetch(new Request('https://do.internal/rpc/exec/submit', {
    method: 'POST', body: JSON.stringify({ jobId: 'job_ef', serverId: 1, command: 'rm -rf /tmp/x', timeoutMs: 5000 }),
  }));
  assert.equal(res.status, 503);
  const row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_ef').first();
  assert.equal(row.status, 'failed');
  const audits = await env.DB.prepare("SELECT action, detail FROM audit_logs WHERE job_id = 'job_ef'").all();
  assert.equal(audits.results.length, 1, '最高权限的写操作失败时不能无痕');
  assert.equal(audits.results[0].action, 'exec.command.failed');
  assert.match(audits.results[0].detail, /rm -rf \/tmp\/x/, '审计必须保留被拒绝的命令内容');
});

// P2-5：exec/update 的迟到回执也要留 [late] 痕迹（与 upload 对齐）
test('迟到的 exec 回执：纠正状态并标 [late]', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, client_ip, server_id, command, timeout_s, exit_code, created_at, started_at, deadline_at, expires_at)
    VALUES ('job_le','exec','expired',1,'admin','',1,'systemctl restart app',5,NULL,?,?,?,?)`)
    .bind(now - 100, now - 99, now - 60, now + 86400).run();
  const inst = new TerminalDO(mockState(), env);
  const ws = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send() {}, readyState: 1, close() {} };
  inst.agents.set(1, ws);

  await inst.webSocketMessage(ws, JSON.stringify({
    type: 'exec_result', exec_id: 'job_le', stdout: 'ok', stderr: '', exit_code: 0, timed_out: false,
  }));
  const row = await env.DB.prepare('SELECT status, stderr FROM operation_jobs WHERE id = ?').bind('job_le').first();
  assert.equal(row.status, 'succeeded', '命令真的执行了，状态必须纠正');
  // 迟到标注写在 stderr：finishExecJob 用 error 判状态，塞进 error 会把成功误判成 failed
  assert.match(row.stderr, /\[late\]/, '保留曾判过期的事实');
  const a = await env.DB.prepare("SELECT detail FROM audit_logs WHERE job_id = 'job_le'").first();
  assert.ok(a, '迟到回执也要写审计');
  assert.match(a.detail, /\[late\]/, '审计标注迟到，避免复盘误判为首次成功');
});

// P1 回归：cleanup 是所有 WS 关闭的统一入口，会话流（role 'user'/'agent'）的附件同样带
// serverId。若不限定 role 就拿来兜底，用户关闭终端页会误清该机的 updating/probeCapable，
// 等于"更新期间能新建终端会话"——把互斥又开了一个口子。
test('cleanup(会话 ws) 不得误清控制连接的互斥与探活状态', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)')
    .bind('k1', 's1', 1, 'h1').run();
  const inst = new TerminalDO(mockState(), env);
  const controlWs = {
    attachment: { role: 'control', serverId: 1, ts: Date.now() },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(a) { this.attachment = a; },
    send() {}, readyState: 1, close() {},
  };
  inst.agents.set(1, controlWs);
  inst.updating.set(1, 'job_sess');
  inst.probeCapable.add(1);
  inst.lastRoundTripAt.set(1, Date.now());

  // 用户关闭终端/文件页：会话流的 ws 关闭
  const sessWs = {
    attachment: { role: 'user', sid: 'sess-1', serverId: 1 },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(a) { this.attachment = a; },
    send() {}, readyState: 1, close() {},
  };
  inst.sessions.set('sess-1', {
    streamId: 'sess-1', serverId: 1, type: 'terminal',
    userWs: sessWs, agentWs: null, creatorUserId: 1, creatorUser: 'admin',
    createdAt: Date.now(), clientIp: '', auth: null,
  });
  await inst.cleanup(sessWs);

  assert.equal(inst.updating.has(1), true, '关会话页不得释放更新互斥');
  assert.equal(inst.probeCapable.has(1), true, '关会话页不得丢掉探活能力');
  assert.ok(inst.lastRoundTripAt.has(1), '关会话页不得丢掉 RTT 记录');
  assert.equal(inst.agents.get(1), controlWs, '控制连接不应被误删');
});
