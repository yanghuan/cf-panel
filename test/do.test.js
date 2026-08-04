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
  assert.equal(rows.results[0].mem_total, 8000, '归档保留 mem_total（M-06）');

  // H-03：热区保留 12h（60min 前的行仍在热区，≤12h 查询完整）
  const q = await (await call('/query?server_id=1&limit=100')).json();
  assert.deepEqual(q.map((x) => x.ts).sort((a, b) => a - b), [oldTs, recentTs], '热区保留归档前数据');

  await inst.alarm();
  const rows2 = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = 1').all();
  assert.equal(rows2.results.length, 1, '二次归档不重复写 D1（OR IGNORE）');
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

  await inst.alarm();

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
  assert.ok(env.TERMINAL.calls.some((c) => c.path === '/rpc/wakeup')); // 快采唤醒

  await inst2.webSocketMessage(ws, 'sync');
  assert.equal(ws.sent.length, 1);
  const list = JSON.parse(ws.sent[0]);
  assert.deepEqual(list.map((s) => s.name), ['srv-a']);
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

test('TerminalDO: 僵尸会话超 TTL 由 alarm 清理，未到期安排下次 alarm', async () => {
  const env = makeEnv();
  const st = mockState();
  const inst = new TerminalDO(st, env);
  const now = Date.now();
  const TTL = 10 * 60 * 1000; // SESSION_TTL_MS
  // 过期僵尸 → 直接清掉，其 pendingTerm 也清理
  inst.sessions.set('0-old', { streamId: '0-old', serverId: 1, creatorUserId: 1, createdAt: now - TTL - 1000, userWs: null, agentWs: null });
  inst.pendingTerm.set('0-old', { tries: 0, timer: null });
  // 未过期僵尸 → 保留并安排 alarm 到其到期时间
  inst.sessions.set('0-young', { streamId: '0-young', serverId: 1, creatorUserId: 1, createdAt: now - 1000, userWs: null, agentWs: null });
  // 任一端有连接 → 不回收（即使创建很久）
  inst.sessions.set('0-live', { streamId: '0-live', serverId: 1, creatorUserId: 1, createdAt: now - TTL * 2, userWs: {}, agentWs: null });

  await inst.alarm();

  assert.equal(inst.sessions.has('0-old'), false);
  assert.equal(inst.pendingTerm.has('0-old'), false);
  assert.equal(inst.sessions.has('0-young'), true);
  assert.equal(inst.sessions.has('0-live'), true);
  // 安排了 alarm：最早僵尸到期时间 +1s
  assert.equal(st.storage.alarmTs, now - 1000 + TTL + 1000);
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

test('TerminalDO: user-pending 首帧鉴权接受 PAT（server:exec + 白名单）（M-01）', async () => {
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
  t.mock.timers.enable({ apis: ['setTimeout'] }); // 屏蔽 scheduleTermAck 的 5s 定时器
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

test('TerminalDO: cleanup 按归属清理 pendingTerm，跨服务器/会话隔离（M-02）', async () => {
  const env = makeEnv();
  const ctl1 = { send() {}, readyState: 1 }; // server 1 控制通道
  const ctl2 = { send() {}, readyState: 1 }; // server 2 控制通道
  const agentFlow = { send() {}, readyState: 1 }; // 会话 agent 数据流
  const inst = new TerminalDO(mockState(), env);
  inst.agents.set(1, ctl1);
  inst.agents.set(2, ctl2);
  inst.sessions.set('1-a', { streamId: '1-a', serverId: 1, creatorUserId: 1, createdAt: Date.now(), userWs: null, agentWs: agentFlow, userBuf: [] });
  inst.sessions.set('2-b', { streamId: '2-b', serverId: 2, creatorUserId: 1, createdAt: Date.now(), userWs: null, agentWs: null, userBuf: [] });
  inst.pendingTerm.set('1-a', { tries: 0, timer: null, serverId: 1, agentWs: ctl1 });
  inst.pendingTerm.set('2-b', { tries: 0, timer: null, serverId: 2, agentWs: ctl2 });

  // server1 控制通道断开 → 只清 server1 的待确认
  inst.cleanup(ctl1);
  assert.equal(inst.agents.has(1), false);
  assert.equal(inst.pendingTerm.has('1-a'), false, 'server1 待确认被清理');
  assert.equal(inst.pendingTerm.has('2-b'), true, 'server2 待确认不受影响');

  // 会话 1-a 的 agent 数据流断开 → 清该会话待确认并回收会话，不影响 server2
  inst.cleanup(agentFlow);
  assert.equal(inst.sessions.has('1-a'), false, '1-a 两端断开被回收');
  assert.equal(inst.pendingTerm.has('2-b'), true, 'server2 待确认仍保留');

  // server2 控制通道断开 → 全部清空
  inst.cleanup(ctl2);
  assert.equal(inst.agents.size, 0);
  assert.equal(inst.pendingTerm.size, 0, 'server2 断开后 pendingTerm 清空');
});
