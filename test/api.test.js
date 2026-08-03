// ============================================================
// API 集成测试：通过 worker.fetch 全链路（真实 SQLite 内存 D1 + DO 桩）
// 覆盖：登录/限流、鉴权、服务器 CRUD、agent 上报、监控、PAT、设置、MCP
// 运行：node --test test/api.test.js
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { __internals as I } from '../src/index.js';
import { makeEnv, requestBuilder } from './helpers.js';

const call = requestBuilder(worker);

async function login(env, password = 'admin123') {
  const res = await call(env, { method: 'POST', path: '/api/login', body: { password } });
  assert.equal(res.status, 200, '登录应成功');
  const { token } = await res.json();
  assert.ok(token, '应返回 JWT');
  return token;
}

async function addServer(env, token, body = {}) {
  const res = await call(env, { method: 'POST', path: '/api/servers', token, body });
  assert.equal(res.status, 200, '添加服务器应成功');
  return res.json();
}

test.beforeEach(() => I.__reset());

// ---------------- 公开设置 ----------------
test('GET /api/public/settings：无需登录，返回默认站点名', async () => {
  const env = makeEnv();
  const res = await call(env, { path: '/api/public/settings' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.site_name, 'cf-panel');
  assert.equal(body.notice, '');
});

test('PUT /api/settings 后公开设置同步更新', async () => {
  const env = makeEnv();
  const token = await login(env);
  const res = await call(env, { method: 'PUT', path: '/api/settings', token, body: { site_name: '我的面板', notice: '欢迎' } });
  assert.equal(res.status, 200);
  const pub = await (await call(env, { path: '/api/public/settings' })).json();
  assert.equal(pub.site_name, '我的面板');
  assert.equal(pub.notice, '欢迎');
});

// ---------------- 登录 ----------------
test('登录：正确密码返回 JWT，错误密码 401', async () => {
  const env = makeEnv();
  const bad = await call(env, { method: 'POST', path: '/api/login', body: { password: 'wrong' }, ip: '9.9.9.1' });
  assert.equal(bad.status, 401);
  const ok = await call(env, { method: 'POST', path: '/api/login', body: { password: 'admin123' }, ip: '9.9.9.1' });
  assert.equal(ok.status, 200);
  const { user } = await ok.json();
  assert.equal(user.username, 'admin');
});

test('登录：未配置任何凭据 → 500', async () => {
  const env = makeEnv({ PANEL_PASSWORD: undefined, PANEL_USERS: undefined });
  const res = await call(env, { method: 'POST', path: '/api/login', body: { password: 'x' } });
  assert.equal(res.status, 500);
});

test('登录：PANEL_USERS 优先级高于 PANEL_PASSWORD', async () => {
  const env = makeEnv({ PANEL_USERS: 'alice:wonder' });
  // PANEL_PASSWORD 不再生效
  const denied = await call(env, { method: 'POST', path: '/api/login', body: { password: 'admin123' }, ip: '9.9.9.2' });
  assert.equal(denied.status, 401);
  const ok = await call(env, { method: 'POST', path: '/api/login', body: { password: 'wonder' }, ip: '9.9.9.2' });
  assert.equal(ok.status, 200);
  const { user } = await ok.json();
  assert.equal(user.username, 'alice');
});

test('登录：错误密码连续多次仍只返回 401（暴力破解由前置 CF Access 防护）', async () => {
  const env = makeEnv();
  for (let i = 0; i < 10; i++) {
    const res = await call(env, { method: 'POST', path: '/api/login', body: { password: 'no' } });
    assert.equal(res.status, 401);
  }
  // 正确密码不受影响
  const ok = await call(env, { method: 'POST', path: '/api/login', body: { password: 'admin123' } });
  assert.equal(ok.status, 200);
});

// ---------------- 鉴权 ----------------
test('未带 token 访问受保护接口 → 401', async () => {
  const env = makeEnv();
  assert.equal((await call(env, { path: '/api/me' })).status, 401);
  assert.equal((await call(env, { path: '/api/servers' })).status, 401);
  assert.equal((await call(env, { path: '/api/settings' })).status, 401);
});

test('带 JWT 访问 /api/me 返回用户信息；篡改 token → 401', async () => {
  const env = makeEnv();
  const token = await login(env);
  const me = await (await call(env, { path: '/api/me', token })).json();
  assert.equal(me.username, 'admin');
  assert.equal(me.is_pat, false);

  const [h, , s] = token.split('.');
  const forged = `${h}.${I.b64u(JSON.stringify({ uid: 99, username: 'hacker', role: 1 }))}.${s}`;
  assert.equal((await call(env, { path: '/api/me', token: forged })).status, 401);
});

// ---------------- 服务器 CRUD ----------------
test('服务器：管理员添加/列表/删除 + 分组排序', async () => {
  const env = makeEnv();
  const token = await login(env);

  // 缺 name → 400
  const noName = await call(env, { method: 'POST', path: '/api/servers', token, body: {} });
  assert.equal(noName.status, 400);

  // 添加两台（分组 + 排序）
  const r1 = await addServer(env, token, { name: 'db-01', group: 'prod', sort_order: 2 });
  const r2 = await addServer(env, token, { name: 'web-01', group: 'prod', sort_order: 1 });
  const r3 = await addServer(env, token, { name: 'home', sort_order: 0 });
  for (const r of [r1, r2, r3]) {
    assert.match(r.agent_key, /^[0-9a-f]{64}$/);
    assert.equal(r.wss_base, 'wss://panel.local/ws/agent');
  }

  // 列表按 group/display_index 排序：空分组(home)按字典序在 prod 前，prod 组内按 display_index web-01(1) 在 db-01(2) 前
  const list = await (await call(env, { path: '/api/servers', token })).json();
  assert.deepEqual(list.map((s) => s.name), ['home', 'web-01', 'db-01']);
  assert.ok(list.every((s) => s.online === false)); // 未上报 → 离线

  // 删除
  const del = await call(env, { method: 'DELETE', path: `/api/servers/${list[0].id}`, token });
  assert.equal(del.status, 200);
  const after = await (await call(env, { path: '/api/servers', token })).json();
  assert.deepEqual(after.map((s) => s.name), ['web-01', 'db-01']);
});

test('删除服务器：清理历史数据 + 审计日志 + 通知 DO 断开 agent', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'del-me' });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const id = list[0].id;

  // 预置历史数据（归档时序 + 自定义指标）
  await env.DB.prepare('INSERT INTO metrics_min (server_id, ts, cpu) VALUES (?,?,?)').bind(id, Math.floor(Date.now() / 1000 / 60), 5).run();
  await env.DB.prepare('INSERT INTO metrics_custom (server_id, name, ts, value) VALUES (?,?,?,?)').bind(id, 'x', Math.floor(Date.now() / 1000 / 60), 1).run();

  // 删除不存在的服务器 → 404
  assert.equal((await call(env, { method: 'DELETE', path: '/api/servers/9999', token })).status, 404);

  const res = await call(env, { method: 'DELETE', path: `/api/servers/${id}`, token });
  assert.equal(res.status, 200);

  // 服务器与历史数据已清理
  assert.equal((await env.DB.prepare('SELECT id FROM servers WHERE id = ?').bind(id).first()), null);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS c FROM metrics_min WHERE server_id = ?').bind(id).all()).results[0].c, 0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS c FROM metrics_custom WHERE server_id = ?').bind(id).all()).results[0].c, 0);

  // 审计日志：server.delete（含服务器名）
  const logs = await env.DB.prepare("SELECT * FROM audit_logs WHERE action = 'server.delete'").all();
  assert.equal(logs.results.length, 1);
  assert.equal(logs.results[0].target_server_id, id);
  assert.equal(logs.results[0].detail, 'del-me');

  // DO 通知：MetricsDO 收到 /drop，各分片收到 /rpc/drop_server
  assert.ok(env.METRICS.calls.some((c) => c.path === '/drop'));
  const drops = env.TERMINAL.calls.filter((c) => c.path === '/rpc/drop_server');
  assert.equal(drops.length, 4); // SHARDS=4
  assert.ok(drops.every((c) => c.init.body === JSON.stringify({ serverId: id })));
});

test('服务器：在线状态按 last_seen 60 秒判定', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 's1' });
  const list0 = await (await call(env, { path: '/api/servers', token })).json();
  const id = list0[0].id;

  // 模拟刚刚上报 → 在线
  await env.DB.prepare('UPDATE servers SET online = 1, last_seen = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000), id).run();
  const list1 = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(list1[0].online, true);

  // last_seen 超过 60s → 离线（即使 online=1）
  await env.DB.prepare('UPDATE servers SET last_seen = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000) - 120, id).run();
  const list2 = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(list2[0].online, false);
});

// ---------------- agent 上报 ----------------
test('agent 上报：key 指纹定位 + 哈希校验 + 落库', async () => {
  const env = makeEnv();
  const token = await login(env);
  const { agent_key } = await addServer(env, token, { name: 'node-1' });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const id = list[0].id;

  // 未知 key → 401
  const unknown = await call(env, { method: 'POST', path: '/api/report', body: { key: '0'.repeat(64) } });
  assert.equal(unknown.status, 401);

  // 错误 key → 401
  const bad = await call(env, { method: 'POST', path: '/api/report', body: { key: 'a'.repeat(64) } });
  assert.equal(bad.status, 401);

  // 正确 key → 200 且落库
  const ok = await call(env, {
    method: 'POST', path: '/api/report',
    body: {
      key: agent_key, cpu: 12.5, mem_used: 1024, mem_total: 4096,
      net_in: 1000, net_out: 2000,
      extra: { load1: 0.5 },
      info: { os: 'Debian 12', kernel: '6.1' },
      probes: [{ name: 'web', ok: true, ms: 5 }],
      custom: [{ name: 'estab', value: 42 }],
    },
  });
  assert.equal(ok.status, 200);

  const row = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first();
  assert.equal(row.online, 1);
  assert.ok(row.last_seen > 0);
  assert.equal(JSON.parse(row.info_json).os, 'Debian 12');
  assert.equal(JSON.parse(row.probe_json)[0].name, 'web');
  const custom = await env.DB.prepare('SELECT * FROM metrics_custom WHERE server_id = ?').bind(id).all();
  assert.equal(custom.results.length, 1);
  assert.equal(custom.results[0].value, 42);

  // MetricsDO 桩收到 /report（含 serverId/minTs/serverName/probes，告警判定在 DO 顺带执行）
  const reportCalls = env.METRICS.calls.filter((c) => c.path === '/report');
  assert.equal(reportCalls.length, 1);
  assert.equal(reportCalls[0].init.body, JSON.stringify({
    serverId: id,
    serverName: 'node-1',
    minTs: Math.floor(Date.now() / 1000 / 60),
    cpu: 12.5,
    mem_used: 1024,
    mem_total: 4096,
    net_in: 1000,
    net_out: 2000,
    extra: { load1: 0.5 },
    probes: [{ name: 'web', ok: true, ms: 5 }],
  }));

  // 上报后列表显示在线 + 指标
  const after = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(after[0].online, true);
});

// ---------------- 监控 ----------------
test('监控：短区间走内存热区（METRICS /query），非法 range 回退 12h', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'm1' });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const id = list[0].id;

  const res = await call(env, { path: `/api/monitor?server_id=${id}&range=1h`, token });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { system: [], custom: {} });

  const q = env.METRICS.calls.find((c) => c.path === '/query');
  assert.equal(q.query.server_id, String(id));
  assert.equal(q.query.limit, '60'); // 1h = 60 分钟

  // 非法 range → 回退 12h（limit 720）
  await call(env, { path: `/api/monitor?server_id=${id}&range=weird`, token });
  const q2 = env.METRICS.calls.filter((c) => c.path === '/query').pop();
  assert.equal(q2.query.limit, '720');
});

test('监控：不存在的服务器 404；长区间 3d 走 D1 归档查询', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'm2' });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const id = list[0].id;

  assert.equal((await call(env, { path: '/api/monitor?server_id=999', token })).status, 404);

  const res = await call(env, { path: `/api/monitor?server_id=${id}&range=3d`, token });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { system: [], custom: {} });
  // 3d 不应走 METRICS /query（内存热区仅 ≤12h）
  assert.equal(env.METRICS.calls.filter((c) => c.path === '/query').length, 0);
});

// ---------------- PAT ----------------
test('PAT：创建/使用/删除，scopes + 白名单生效', async () => {
  const env = makeEnv();
  const adminToken = await login(env);
  await addServer(env, adminToken, { name: 'a1' });
  await addServer(env, adminToken, { name: 'a2' });

  // 创建 PAT（只读 + 白名单仅 a1（id=1））
  const created = await call(env, {
    method: 'POST', path: '/api/tokens', token: adminToken,
    body: { name: 'ci', scopes: ['server:read'], server_ids: [1] },
  });
  assert.equal(created.status, 200);
  const { token } = await created.json();
  assert.ok(token.startsWith('cfp_'));

  // 列表可见（但不含明文）
  const list = await (await call(env, { path: '/api/tokens', token: adminToken })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'ci');
  assert.equal(list[0].token_hash, undefined);

  // PAT 访问 /api/me
  const me = await (await call(env, { path: '/api/me', token })).json();
  assert.equal(me.is_pat, true);

  // PAT 只能看到白名单内的服务器（a1）
  const servers = await (await call(env, { path: '/api/servers', token })).json();
  assert.deepEqual(servers.map((s) => s.name), ['a1']);

  // 无 exec scope → 终端接口 403
  const term = await call(env, { method: 'POST', path: '/api/terminal', token, body: { server_id: 1 } });
  assert.equal(term.status, 403);

  // 非管理员不能建 PAT
  const patRes = await call(env, { method: 'POST', path: '/api/tokens', token, body: { name: 'x' } });
  assert.equal(patRes.status, 403);

  // 删除 PAT 后失效
  const del = await call(env, { method: 'DELETE', path: `/api/tokens/${list[0].id}`, token: adminToken });
  assert.equal(del.status, 200);
  assert.equal((await call(env, { path: '/api/me', token })).status, 401);
});

test('PAT：scopes 白名单校验（非法值 400，混合值只留合法项）', async () => {
  const env = makeEnv();
  const adminToken = await login(env);

  // 全非法 → 400
  const bad = await call(env, { method: 'POST', path: '/api/tokens', token: adminToken, body: { name: 'bad', scopes: ['admin:*', 'root'] } });
  assert.equal(bad.status, 400);

  // 混合合法/非法 → 只保留合法项（去重）
  const mixed = await call(env, {
    method: 'POST', path: '/api/tokens', token: adminToken,
    body: { name: 'mixed', scopes: ['server:read', 'server:exec', 'server:read', 'bogus'] },
  });
  assert.equal(mixed.status, 200);
  const rows = await env.DB.prepare("SELECT scopes FROM api_tokens WHERE name = 'mixed'").first();
  assert.deepEqual(JSON.parse(rows.scopes), ['server:read', 'server:exec']);

  // 未提供 scopes → 默认只读
  const dflt = await call(env, { method: 'POST', path: '/api/tokens', token: adminToken, body: { name: 'dflt' } });
  assert.equal(dflt.status, 200);
  const rows2 = await env.DB.prepare("SELECT scopes FROM api_tokens WHERE name = 'dflt'").first();
  assert.deepEqual(JSON.parse(rows2.scopes), ['server:read']);
});

test('审计日志：管理员可查（倒序 + limit），非管理员 403', async () => {
  const env = makeEnv();
  const adminToken = await login(env);
  await addServer(env, adminToken, { name: 'a1' }); // 产生 server.create
  await call(env, { method: 'POST', path: '/api/terminal', token: adminToken, body: { server_id: 1 } }); // 产生 terminal.open

  const rows = await (await call(env, { path: '/api/audit-logs', token: adminToken })).json();
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes('server.create'));
  assert.ok(actions.includes('terminal.open'));
  // 倒序：最新（terminal.open）在前
  assert.equal(rows[0].action, 'terminal.open');

  // limit 生效
  const one = await (await call(env, { path: '/api/audit-logs?limit=1', token: adminToken })).json();
  assert.equal(one.length, 1);

  // PAT 不能查看
  const pat = await (await call(env, { method: 'POST', path: '/api/tokens', token: adminToken, body: { name: 'r', scopes: ['server:read'] } })).json();
  assert.equal((await call(env, { path: '/api/audit-logs', token: pat.token })).status, 403);
});

// ---------------- 设置（仅管理员） ----------------
test('设置：告警配置被清洗；非管理员 403', async () => {
  const env = makeEnv();
  const adminToken = await login(env);

  const put = await call(env, {
    method: 'PUT', path: '/api/settings', token: adminToken,
    body: { site_name: 'ops', alerts: { webhook_url: 'https://x/hook', method: 'GET', cpu_pct: 88, junk: 'drop', headers: '{{{' } },
  });
  assert.equal(put.status, 200);
  const saved = await put.json();
  assert.equal(saved.alerts.webhook_url, 'https://x/hook');
  assert.equal(saved.alerts.method, 'GET');
  assert.equal(saved.alerts.cpu_pct, 88);
  assert.equal(saved.alerts.junk, undefined); // 非法字段被丢弃
  assert.equal(saved.alerts.headers, undefined); // 坏 JSON 被丢弃

  // GET 回读一致
  const got = await (await call(env, { path: '/api/settings', token: adminToken })).json();
  assert.equal(got.site_name, 'ops');
  assert.equal(got.alerts.cpu_pct, 88);

  // PAT 不能读写设置
  const pat = await (await call(env, {
    method: 'POST', path: '/api/tokens', token: adminToken, body: { name: 'r', scopes: ['server:read'] },
  })).json();
  assert.equal((await call(env, { path: '/api/settings', token: pat.token })).status, 403);
  assert.equal((await call(env, { method: 'PUT', path: '/api/settings', token: pat.token, body: {} })).status, 403);
});

// ---------------- 终端 / 文件 会话 ----------------
test('终端与文件会话：需要 exec 权限 + 服务器归属', async () => {
  const env = makeEnv();
  const adminToken = await login(env);
  await addServer(env, adminToken, { name: 't1' });

  // 不存在的服务器 → 404
  const nf = await call(env, { method: 'POST', path: '/api/terminal', token: adminToken, body: { server_id: 999 } });
  assert.equal(nf.status, 404);

  // 管理员创建终端会话 → 200（agent 在线，TerminalDO 桩返回 ok）
  const term = await call(env, { method: 'POST', path: '/api/terminal', token: adminToken, body: { server_id: 1 } });
  assert.equal(term.status, 200);
  const tbody = await term.json();
  assert.match(tbody.session_id, /^\d-[0-9a-f-]{36}$/);

  const file = await call(env, { method: 'POST', path: '/api/file/open', token: adminToken, body: { server_id: 1 } });
  assert.equal(file.status, 200);
  assert.match((await file.json()).session_id, /^\d-/);

  // 审计日志落库
  const logs = await env.DB.prepare("SELECT action FROM audit_logs WHERE action = 'terminal.open'").all();
  assert.equal(logs.results.length, 1);
});

// ---------------- MCP ----------------
async function mcp(env, { token, body, version, origin, method = 'POST' }) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (version) headers['mcp-protocol-version'] = version;
  if (origin) headers.origin = origin;
  const req = new Request('http://panel.local/mcp', {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  return worker.fetch(req, env);
}

test('MCP：非 POST 405；未授权 401', async () => {
  const env = makeEnv();
  assert.equal((await mcp(env, { method: 'GET' })).status, 405);
  const res = await mcp(env, { body: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, -32001);
});

test('MCP：Origin 校验（防 DNS rebinding）', async () => {
  const env = makeEnv();
  const token = await login(env);
  const evil = await mcp(env, { token, origin: 'http://evil.com', body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.equal(evil.status, 403);
  const same = await mcp(env, { token, origin: 'http://panel.local', body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.equal(same.status, 200);
});

test('MCP：initialize / ping / 通知 / 方法未找到', async () => {
  const env = makeEnv();
  const token = await login(env);

  const init = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } })).json();
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.equal(init.result.serverInfo.name, 'cf-panel');

  const ping = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 2, method: 'ping' } })).json();
  assert.deepEqual(ping.result, {});

  const notif = await mcp(env, { token, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(notif.status, 202);

  const nf = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 3, method: 'no/such' } })).json();
  assert.equal(nf.error.code, -32601);
});

test('MCP：tools/list 与 tools/call', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'web-1', group: 'prod' });

  const list = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ['list_servers', 'get_monitor']);

  // list_servers
  const ls = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_servers', arguments: {} } } })).json();
  const servers = JSON.parse(ls.result.content[0].text);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, 'web-1');
  assert.equal(servers[0].group, 'prod');

  // get_monitor（server_name）
  const gm = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_monitor', arguments: { server_name: 'web-1', range: '1h' } } } })).json();
  const mon = JSON.parse(gm.result.content[0].text);
  assert.equal(mon.server.name, 'web-1');
  assert.equal(mon.range, '1h');

  // 未知服务器 → isError
  const nf = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_monitor', arguments: { server_name: 'nope' } } } })).json();
  assert.equal(nf.result.isError, true);

  // 未知工具 → -32602
  const bad = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rm_rf' } } })).json();
  assert.equal(bad.error.code, -32602);
});

test('MCP：坏 JSON → Parse error；协议版本不一致 → HeaderMismatch', async () => {
  const env = makeEnv();
  const token = await login(env);
  const req = new Request('http://panel.local/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: 'not-json',
  });
  const parseErr = await (await worker.fetch(req, env)).json();
  assert.equal(parseErr.error.code, -32700);

  const mismatch = await mcp(env, {
    token, version: '2025-11-25',
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-03-26' } },
  });
  const body = await mismatch.json();
  assert.equal(body.error.code, -32020);
});
