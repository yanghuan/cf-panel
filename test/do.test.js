// ============================================================
// Durable Object 行为测试：MetricsDO（热区/归档/保留期/离线告警）、
// PanelDO（viewers/推送过滤）、TerminalDO（wakeup/create 确认重发/report）
// 运行：node --test test/do.test.js
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsDO, PanelDO, TerminalDO, __internals as I } from '../src/index.js';
import { makeEnv, captureFetch } from './helpers.js';

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
    setAlarm(ts) {
      this.alarmTs = ts;
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
    'INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash, online, last_seen) VALUES (?,?,?,?,?,?)'
  ).bind(keyId, name, 1, 'h', extra.online ?? 0, extra.last_seen ?? null).run();
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

test('MetricsDO: scheduleArchive 按 ARCHIVE_TO_D1 与告警开关注册 alarm', async () => {
  const env1 = makeEnv();
  const st1 = mockState();
  const { inst: inst1 } = mkMetrics(env1, st1);
  await inst1.scheduleArchive();
  assert.ok(st1.storage.alarmTs > 0, '默认归档开启 → 注册 alarm');

  const env2 = makeEnv({ ARCHIVE_TO_D1: '0' });
  const st2 = mockState();
  const { inst: inst2 } = mkMetrics(env2, st2);
  await inst2.scheduleArchive();
  assert.equal(st2.storage.alarmTs, undefined, '归档关闭且无告警 → 不注册');
});

// ---------------- MetricsDO：归档 / 保留期 ----------------
test('MetricsDO: alarm 归档超 1 小时数据到 D1 并清理内存，不重复归档', async () => {
  const env = makeEnv();
  const { inst, call } = mkMetrics(env, mockState());
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const oldTs = nowMin - 90;
  const recentTs = nowMin - 5;
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: oldTs, cpu: 5 }) });
  await call('/report', { method: 'POST', body: JSON.stringify({ serverId: 1, minTs: recentTs, cpu: 6 }) });

  await inst.alarm();

  const rows = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows.results.length, 1);
  assert.equal(rows.results[0].ts, oldTs);
  assert.equal(rows.results[0].cpu, 5);

  const q = await (await call('/query?server_id=1&limit=100')).json();
  assert.deepEqual(q.map((x) => x.ts), [recentTs]);

  await inst.alarm();
  const rows2 = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows2.results.length, 1);
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

test('MetricsDO: alarm 离线/恢复告警（DO Storage 状态去重）', async () => {
  const env = makeEnv();
  await insertServer(env, 'k1', 'srv1', { online: 1, last_seen: Math.floor(Date.now() / 1000) - 1000 });
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

// ---------------- PanelDO ----------------
test('PanelDO: /viewers 返回在线观看者数；其他路径 404', async () => {
  const env = makeEnv();
  const inst = new PanelDO({ getWebSockets: () => [{}, {}] }, env);
  const res = await inst.fetch(new Request('https://do.internal/viewers'));
  assert.deepEqual(await res.json(), { count: 2 });
  assert.equal((await inst.fetch(new Request('https://do.internal/other'))).status, 404);
});

test('PanelDO: webSocketMessage 按 token 推送过滤后的服务器列表', async () => {
  const env = makeEnv();
  const token = await I.signJwt({ uid: 1, username: 'admin', role: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, env);
  await insertServer(env, 'k1', 'srv-a');
  await insertServer(env, 'k2', 'srv-b');

  const sent = [];
  const inst = new PanelDO({ getWebSockets: () => [] }, env);
  await inst.webSocketMessage({ deserializeAttachment: () => token, send: (m) => sent.push(m) });
  assert.equal(sent.length, 1);
  const list = JSON.parse(sent[0]);
  assert.deepEqual(list.map((s) => s.name), ['srv-a', 'srv-b']);

  // 非法 token → 不发送
  await inst.webSocketMessage({ deserializeAttachment: () => 'bogus', send: (m) => sent.push(m) });
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
  await inst.webSocketMessage({ deserializeAttachment: () => pat, send: (m) => sent.push(m) });
  assert.deepEqual(JSON.parse(sent[0]).map((s) => s.name), ['srv-a']);
});

// ---------------- TerminalDO ----------------
test('TerminalDO: /rpc/wakeup 给本分片全部 agent 下发快采间隔', async () => {
  const env = makeEnv();
  const sent = [];
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, { send: (m) => sent.push(m), readyState: 1 });
  inst.agents.set(2, { send: (m) => sent.push(m), readyState: 1 });
  const res = await inst.fetch(new Request('https://do.internal/rpc/wakeup', { method: 'POST' }));
  assert.equal(res.status, 200);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent, [
    JSON.stringify({ type: 'set_report_interval', interval: 3 }),
    JSON.stringify({ type: 'set_report_interval', interval: 3 }),
  ]);
});

test('TerminalDO: /rpc create 时 agent 离线 → 502', async () => {
  const env = makeEnv();
  const inst = new TerminalDO(mockState(), env);
  const res = await inst.fetch(new Request('https://do.internal/rpc', {
    method: 'POST',
    body: JSON.stringify({ op: 'create', streamId: '0-abc', serverId: 1, creatorUserId: 1 }),
  }));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'agent offline');
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
  assert.equal(row.online, 1);
  assert.ok(row.last_seen > 0);
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

test('TerminalDO: cleanup 断开后清空 agents/sessions/pendingTerm', async () => {
  const env = makeEnv();
  const ws1 = { send() {}, readyState: 1 };
  const ws2 = { send() {}, readyState: 1 };
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, ws1);
  inst.sessions.set('0-x', { streamId: '0-x', userWs: ws2, agentWs: null, createdAt: Date.now() });
  inst.pendingTerm.set('0-x', { tries: 0, timer: null });

  inst.cleanup(ws1);
  assert.equal(inst.agents.size, 0);
  assert.equal(inst.pendingTerm.size, 0);

  inst.cleanup(ws2);
  assert.equal(inst.sessions.size, 0);
});
