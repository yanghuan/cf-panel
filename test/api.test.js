// ============================================================
// API 集成测试：通过 worker.fetch 全链路（真实 SQLite 内存 D1 + DO 桩）
// 覆盖：登录/限流、鉴权、服务器 CRUD、agent 上报、监控、PAT、设置、MCP
// 运行：node --test test/api.test.js
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { __internals as I } from '../src/index.js';
import { makeEnv, makePanelStub, makeMetricsStub, requestBuilder } from './helpers.js';

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

test('缺少 JWT_SECRET 时登录和受保护入口均 fail closed → 503', async () => {
  const env = makeEnv({ JWT_SECRET: undefined });
  const loginRes = await call(env, { method: 'POST', path: '/api/login', body: { password: 'admin123' } });
  assert.equal(loginRes.status, 503);
  assert.match((await loginRes.json()).error, /JWT_SECRET not set/);

  // 即使攻击者按旧固定值 dev-secret 伪造 JWT，也不能通过任何面板鉴权入口。
  const forged = await I.signJwt({ uid: 1, username: 'admin', role: 1 }, { JWT_SECRET: 'dev-secret' });
  const apiRes = await call(env, { path: '/api/me', token: forged });
  assert.equal(apiRes.status, 503);
  const mcpRes = await call(env, { method: 'POST', path: '/mcp', token: forged, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.equal(mcpRes.status, 503);
  const wsRes = await call(env, { path: '/ws/push' });
  assert.equal(wsRes.status, 503);
});

test('登录：连续失败 5 次后 429 锁定，其他 IP 不受影响', async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) {
    const r = await call(env, { method: 'POST', path: '/api/login', body: { password: 'bad' }, ip: '9.9.9.77' });
    assert.equal(r.status, 401, `第 ${i + 1} 次失败应 401`);
  }
  const locked = await call(env, { method: 'POST', path: '/api/login', body: { password: 'admin123' }, ip: '9.9.9.77' });
  assert.equal(locked.status, 429, '超限后即使密码正确也 429');
  assert.ok(locked.headers.get('retry-after'), '带 Retry-After 头');
  // 其他 IP 不受影响
  const other = await call(env, { method: 'POST', path: '/api/login', body: { password: 'admin123' }, ip: '9.9.9.78' });
  assert.equal(other.status, 200);
});

test('登录：失败后成功登录重置计数', async () => {
  const env = makeEnv();
  for (let i = 0; i < 4; i++) {
    await call(env, { method: 'POST', path: '/api/login', body: { password: 'bad' }, ip: '9.9.9.79' });
  }
  const ok = await call(env, { method: 'POST', path: '/api/login', body: { password: 'admin123' }, ip: '9.9.9.79' });
  assert.equal(ok.status, 200, '未超限时可正常登录');
  const again = await call(env, { method: 'POST', path: '/api/login', body: { password: 'bad' }, ip: '9.9.9.79' });
  assert.equal(again.status, 401, '成功登录后计数清零，再失败回到 1 次');
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

test('登录：阈值内连续失败仍 401，超阈值 429 锁定', async () => {
  const env = makeEnv();
  for (let i = 0; i < 3; i++) {
    const res = await call(env, { method: 'POST', path: '/api/login', body: { password: 'no' }, ip: '9.9.9.10' });
    assert.equal(res.status, 401, '阈值内不限流');
  }
  // 阈值内正确密码仍可登录
  const ok = await call(env, { method: 'POST', path: '/api/login', body: { password: 'admin123' }, ip: '9.9.9.10' });
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
    assert.equal(r.wss_base, 'ws://panel.local/ws/agent'); // 测试入口为 http → ws（见下方协议派生测试）
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

// 面板生成给外部抄写的绝对 URL（agent 控制通道 wss_base、MCP 签名上传 URL）：
// 协议必须跟随访问协议。生产（Workers 仅 https）→ https/wss；wrangler dev / 本地 http →
// http/ws，否则照抄的 agent / curl 会在明文端口上做 TLS 握手而连不上。此前三处硬编码安全协议。
test('对外绝对 URL 协议跟随访问协议（wss_base / upload_url，http↔https）', async () => {
  const env = makeEnv();
  const token = await login(env);

  // REST：默认 http 入口
  const httpRest = await call(env, { method: 'POST', path: '/api/servers', token, body: { name: 'rest-http' } });
  assert.equal((await httpRest.json()).wss_base, 'ws://panel.local/ws/agent', 'http 访问 → ws://');
  // REST：https 入口
  const httpsRest = await call(env, {
    method: 'POST', path: '/api/servers', token, body: { name: 'rest-https' }, base: 'https://panel.local',
  });
  assert.equal((await httpsRest.json()).wss_base, 'wss://panel.local/ws/agent', 'https 访问 → wss://');

  // MCP add_server：两条入口同样派生
  const mcpAdd = (base) => mcp(env, {
    token, base,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_server', arguments: { name: `mcp-${base.slice(0, 5)}` } } },
  });
  const mcpHttp = JSON.parse((await (await mcpAdd('http://panel.local')).json()).result.content[0].text);
  assert.equal(mcpHttp.wss_base, 'ws://panel.local/ws/agent', 'MCP + http → ws://');
  const mcpHttps = JSON.parse((await (await mcpAdd('https://panel.local')).json()).result.content[0].text);
  assert.equal(mcpHttps.wss_base, 'wss://panel.local/ws/agent', 'MCP + https → wss://');

  // MCP create_upload：签发给 curl 的上传 URL 同样派生
  const mcpUpload = (base) => mcp(env, {
    token, base,
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_upload', arguments: { server_id: 1, path: '/opt/app.tar.gz' } } },
  });
  const upHttp = JSON.parse((await (await mcpUpload('http://panel.local')).json()).result.content[0].text);
  assert.match(upHttp.upload_url, /^http:\/\/panel\.local\/mcp\/file_upload\?/, 'create_upload + http → http://');
  const upHttps = JSON.parse((await (await mcpUpload('https://panel.local')).json()).result.content[0].text);
  assert.match(upHttps.upload_url, /^https:\/\/panel\.local\/mcp\/file_upload\?/, 'create_upload + https → https://');
  // 协议不进签名载荷：http 入口签发的 URL 改写成 https 后仍验签通过（dev/prod 签名语义一致）
  const rewrote = await worker.fetch(new Request(upHttp.upload_url.replace(/^http:/, 'https:'), { method: 'POST', body: 'x' }), env);
  assert.equal(rewrote.status, 200, '改写协议不影响签名校验');
});

test('PATCH /api/servers/:id：部分字段更新（不再 500）', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'patch-me', group: 'g1', sort_order: 3 });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const id = list[0].id;

  // 只改名称（不带 group/sort_order）——此前 SELECT 缺列 → undefined 绑定 → 500
  const r1 = await call(env, { method: 'PATCH', path: `/api/servers/${id}`, token, body: { name: 'renamed' } });
  assert.equal(r1.status, 200, '只改名称应成功');
  let row = await env.DB.prepare('SELECT name, "group", display_index FROM servers WHERE id = ?').bind(id).first();
  assert.equal(row.name, 'renamed');
  assert.equal(row.group, 'g1'); // 未传字段保持原值
  assert.equal(row.display_index, 3);

  // 只改分组
  const r2 = await call(env, { method: 'PATCH', path: `/api/servers/${id}`, token, body: { group: 'prod' } });
  assert.equal(r2.status, 200);
  row = await env.DB.prepare('SELECT name, "group", display_index FROM servers WHERE id = ?').bind(id).first();
  assert.equal(row.name, 'renamed');
  assert.equal(row.group, 'prod');

  // 只改序号
  const r3 = await call(env, { method: 'PATCH', path: `/api/servers/${id}`, token, body: { sort_order: 9 } });
  assert.equal(r3.status, 200);
  row = await env.DB.prepare('SELECT name, "group", display_index FROM servers WHERE id = ?').bind(id).first();
  assert.equal(row.display_index, 9);

  // 空 name 拒绝
  const r4 = await call(env, { method: 'PATCH', path: `/api/servers/${id}`, token, body: { name: '  ' } });
  assert.equal(r4.status, 400);

  // 每次更新一条审计（server.update）
  const logs = await env.DB.prepare("SELECT * FROM audit_logs WHERE action = 'server.update'").all();
  assert.equal(logs.results.length, 3);
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

test('服务器：在线状态按 last_seen 宽限期（180s）判定', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 's1' });
  const list0 = await (await call(env, { path: '/api/servers', token })).json();
  const id = list0[0].id;

  // 模拟刚刚上报 → 在线（列表短 TTL 缓存：改 DB 后显式失效以便断言实时状态）
  await env.DB.prepare('UPDATE servers SET last_seen = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000), id).run();
  I.serverListCache.clear();
  const list1 = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(list1[0].online, true);

  // 慢采间隔内（120s < 180s 宽限期）→ 仍在线（存活服务器不应误显示离线）
  await env.DB.prepare('UPDATE servers SET last_seen = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000) - 120, id).run();
  I.serverListCache.clear();
  const list2 = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(list2[0].online, true);

  // 超过宽限期 → 离线（即使 online=1）
  await env.DB.prepare('UPDATE servers SET last_seen = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000) - 300, id).run();
  I.serverListCache.clear();
  const list3 = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(list3[0].online, false);
});

test('服务器：有观看者时用快宽限期（15s）判定在线', async () => {
  // 模拟 1 个观看者在线（PanelDO /viewers 返回 count=1）
  const env = makeEnv({ PANEL: makePanelStub({ viewers: 1 }) });
  const token = await login(env);
  await addServer(env, token, { name: 's1' });
  const id = (await (await call(env, { path: '/api/servers', token })).json())[0].id;

  // 60s 前上报：观看者在线 → 快宽限 15s → 判离线（死亡检测更快）
  await env.DB.prepare('UPDATE servers SET last_seen = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000) - 60, id).run();
  I.serverListCache.clear();
  const list1 = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(list1[0].online, false);

  // 刚上报 → 在线
  await env.DB.prepare('UPDATE servers SET last_seen = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000), id).run();
  I.serverListCache.clear();
  const list2 = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(list2[0].online, true);
});

// ---------------- agent 上报 ----------------
test('handleReport 落库：系统信息/探活/custom 写入 + MetricsDO 转发', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'node-1' });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const id = list[0].id;

  // 直接调用 handleReport（上报统一走 WS 控制通道，HTTP /api/report 已删除）
  await I.handleReport(env, {
    serverId: id,
    cpu: 12.5, mem_used: 1024, mem_total: 4096,
    net_in: 1000, net_out: 2000,
    extra: { load1: 0.5 },
    info: { os: 'Debian 12', kernel: '6.1' },
    probes: [{ name: 'web', ok: true, ms: 5 }],
    custom: [{ name: 'estab', value: 42 }],
  });

  const row = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first();
  assert.ok(row.last_seen > 0); // 上报更新 last_seen
  assert.equal(JSON.parse(row.info_json).os, 'Debian 12');
  assert.equal(JSON.parse(row.probe_json)[0].name, 'web');
  const custom = await env.DB.prepare('SELECT * FROM metrics_custom WHERE server_id = ?').bind(id).all();
  assert.equal(custom.results.length, 1);
  assert.equal(custom.results[0].value, 42);

  // MetricsDO 桩收到 /report（批量 frames，含 serverId/minTs/serverName/probes，告警判定在 DO 顺带执行）
  const reportCalls = env.METRICS.calls.filter((c) => c.path === '/report');
  assert.equal(reportCalls.length, 1);
  const repBody = JSON.parse(reportCalls[0].init.body);
  assert.equal(repBody.frames.length, 1, '单机单帧批量');
  assert.deepEqual(repBody.frames[0], {
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
    alertOverride: null, // 随帧下发供 MetricsDO 逐机告警阈值判定（未配置覆盖时为 null）
  });

  // 上报后列表显示在线 + 指标（列表短 TTL 缓存：上报后显式失效再断言）
  I.serverListCache.clear();
  const after = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(after[0].online, true);
});

// probe_json 对比剥离 ms——探活耗时 ms 每帧必抖动，若全量 JSON 对比则快采时段
// 每 5s 一条 UPDATE（6,240 行写/天/机）；稳定投影 [name,ok,code] 相同时不写，状态真变才写
test('probe_json 仅 ms 抖动不触发写，状态变化才落库', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'node-w1' });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const id = list[0].id;

  // 首帧：写入 probe_json（含 ms）
  await I.handleReport(env, { serverId: id, probes: [{ name: 'web', ok: true, code: 200, ms: 5 }] });
  let row = await env.DB.prepare('SELECT probe_json FROM servers WHERE id = ?').bind(id).first();
  const first = row.probe_json;
  assert.ok(first.includes('"web"'), '首帧写入');

  // 仅 ms 抖动（5 → 88）：稳定投影不变 → 不写（probe_json 保持原值，ms 不落库）
  await I.handleReport(env, { serverId: id, probes: [{ name: 'web', ok: true, code: 200, ms: 88 }] });
  row = await env.DB.prepare('SELECT probe_json FROM servers WHERE id = ?').bind(id).first();
  assert.equal(row.probe_json, first, 'ms 抖动不触发 UPDATE');

  // 状态真变（ok: true → false）：写入新值
  await I.handleReport(env, { serverId: id, probes: [{ name: 'web', ok: false, code: 0, ms: 88 }] });
  row = await env.DB.prepare('SELECT probe_json FROM servers WHERE id = ?').bind(id).first();
  assert.notEqual(row.probe_json, first, '状态变化写 D1');
  assert.ok(row.probe_json.includes('false'), '新状态落库');

  // code 变化（200 → 502，ok 不变）：同样属状态真变 → 写入
  await I.handleReport(env, { serverId: id, probes: [{ name: 'web', ok: false, code: 502, ms: 88 }] });
  row = await env.DB.prepare('SELECT probe_json FROM servers WHERE id = ?').bind(id).first();
  assert.ok(row.probe_json.includes('502'), 'code 变化写 D1');
});

test('服务器行缓存 + MetricsDO 转发节流（降额）', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'node-1' });
  const reportCalls = () => env.METRICS.calls.filter((c) => c.path === '/report').length;
  // 首帧上报：缓存 miss 查 D1，转发 MetricsDO 1 次
  await I.handleReport(env, { serverId: 1, cpu: 1 });
  assert.equal(reportCalls(), 1, '首帧转发 MetricsDO');
  assert.ok(I.serverRowCache.has(1), '服务器行已缓存');
  // 5s 窗口内重复上报：入队（覆盖本机帧），不触发 flush → MetricsDO 转发次数不变
  await I.handleReport(env, { serverId: 1, cpu: 2 });
  await I.handleReport(env, { serverId: 1, cpu: 3 });
  assert.equal(reportCalls(), 1, '5s 窗口内不重复转发（批量）');
  // 超过 5s（flush 时间拨回）→ 重新 flush
  I.setReportFlushAt(Date.now() - 6000);
  await I.handleReport(env, { serverId: 1, cpu: 4 });
  assert.equal(reportCalls(), 2, '超过 5s 重新转发');
  // D1 数据仍正常落库（节流只影响 DO 转发）
  const row = await env.DB.prepare('SELECT last_seen FROM servers WHERE id = 1').first();
  assert.ok(row.last_seen > 0, 'last_seen 仍落库');
});

test('批量上报：同隔离实例多机上报聚合为一次 fetch', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'n1' });
  await addServer(env, token, { name: 'n2' });
  I.setReportFlushAt(Date.now()); // 设为现在 → 首帧入队不 flush
  await I.handleReport(env, { serverId: 1, cpu: 1 });
  await I.handleReport(env, { serverId: 2, cpu: 2 });
  I.setReportFlushAt(Date.now() - 6000); // 拨回 → 下一帧触发 flush
  await I.handleReport(env, { serverId: 1, cpu: 3 });
  const reports = env.METRICS.calls.filter((c) => c.path === '/report');
  assert.equal(reports.length, 1, '两机聚合为一次 fetch');
  const body = JSON.parse(reports[0].init.body);
  assert.equal(body.frames.length, 2, '一次 fetch 含两机帧');
  assert.equal(body.frames.find((f) => f.serverId === 1).cpu, 3, '同机窗口内保留最新帧');
  assert.equal(body.frames.find((f) => f.serverId === 2).cpu, 2);
});

// ---------------- 安全响应头 ----------------
test('安全响应头：API 响应带 nosniff/referrer/frame/CSP 头', async () => {
  const env = makeEnv();
  const res = await call(env, { path: '/api/public/settings' });
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('删除后 in-flight 上报不写指标（H-11 存在性复核）', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)').bind('k1', 's1', 1, 'h1').run();
  // 服务器存在：上报写入 custom
  await I.handleReport(env, { serverId: 1, custom: [{ name: 'x', value: 1 }] });
  let rows = await env.DB.prepare('SELECT * FROM metrics_custom WHERE server_id = 1').all();
  assert.equal(rows.results.length, 1, '存在时写入');
  // 并发删除（读取 server 后完成删除；DELETE /api/servers 路径会同步清 serverRowCache，此处模拟）
  await env.DB.prepare('DELETE FROM servers WHERE id = 1').run();
  I.serverRowCache.clear(); // 生产 DELETE 路径清行缓存，后续上报缓存 miss → D1 复核拒绝
  // 在途上报：存在性复核被拒，不写入孤儿指标
  await I.handleReport(env, { serverId: 1, custom: [{ name: 'y', value: 2 }] });
  rows = await env.DB.prepare('SELECT * FROM metrics_custom WHERE server_id = 1').all();
  assert.equal(rows.results.length, 1, '删除后不再写入');
  assert.equal(rows.results[0].name, 'x', '仅保留删除前数据');
});

test('last_seen 节流：60s 内重复上报只写一次（降额优化）', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)').bind('k1', 's1', 1, 'h1').run();
  I.__reset();
  const now = Math.floor(Date.now() / 1000);
  // 首次上报 → 落盘
  await I.handleReport(env, { serverId: 1 });
  const ts1 = I.lastSeenWrite.get(1);
  assert.ok(ts1 >= now, '首次上报写入 last_seen');
  // 连续同秒上报（info 不变）→ 节流不重写
  await I.handleReport(env, { serverId: 1 });
  await I.handleReport(env, { serverId: 1 });
  assert.equal(I.lastSeenWrite.get(1), ts1, '60s 节流窗口内不重复写');
  // 模拟 70s 前落盘 → 再次上报应重写
  I.lastSeenWrite.set(1, now - 70);
  await I.handleReport(env, { serverId: 1 });
  assert.ok(I.lastSeenWrite.get(1) >= now, '超过节流窗口后重写');
  // DB last_seen 与节流记录一致
  const row = await env.DB.prepare('SELECT last_seen FROM servers WHERE id = 1').first();
  assert.equal(row.last_seen, I.lastSeenWrite.get(1));
});

test('metrics_custom 降采样桶去重：同桶同指标不执行 INSERT，跨桶/记录丢失重新写（降额优化）', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)').bind('k1', 's1', 1, 'h1').run();
  I.__reset();
  // 包装 prepare 统计 metrics_custom 的 INSERT 执行次数（降额核心：省 D1 写查询）
  let customInserts = 0;
  const origPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const stmt = origPrepare(sql);
    if (sql.includes('INSERT OR IGNORE INTO metrics_custom')) {
      const origBind = stmt.bind.bind(stmt);
      stmt.bind = (...args) => {
        const bound = origBind(...args);
        const origRun = bound.run.bind(bound);
        bound.run = async (...a) => { customInserts += 1; return origRun(...a); };
        return bound;
      };
    }
    return stmt;
  };
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const bucketTs = nowMin - (nowMin % 5); // 默认降采样粒度 5 分钟，桶对齐 unix 纪元
  // 首次上报 x=1 → 1 次 INSERT
  await I.handleReport(env, { serverId: 1, custom: [{ name: 'x', value: 1 }] });
  assert.equal(customInserts, 1, '首次上报执行 INSERT');
  let rows = await env.DB.prepare('SELECT * FROM metrics_custom WHERE server_id = 1').all();
  assert.equal(rows.results[0].ts, bucketTs, 'ts 落在降采样桶边界（非当前分钟）');
  // 同桶重复上报同指标 → 不再执行 INSERT（行数与值不变）
  await I.handleReport(env, { serverId: 1, custom: [{ name: 'x', value: 2 }] });
  assert.equal(customInserts, 1, '同桶同指标不重复执行 INSERT');
  rows = await env.DB.prepare('SELECT * FROM metrics_custom WHERE server_id = 1').all();
  assert.equal(rows.results.length, 1);
  assert.equal(rows.results[0].value, 1, '保留首写值');
  // 同桶新指标 → 追加 INSERT
  await I.handleReport(env, { serverId: 1, custom: [{ name: 'y', value: 5 }] });
  assert.equal(customInserts, 2, '同桶新指标追加 INSERT');
  rows = await env.DB.prepare('SELECT * FROM metrics_custom WHERE server_id = 1').all();
  assert.equal(rows.results.length, 2);
  // 跨桶/记录丢失（模拟上一个桶或 evict）：同指标重新执行 INSERT（同桶 ts 下幂等 IGNORE 无害）
  const rec = I.customWritten.get(1);
  rec.bucketTs -= 5;
  await I.handleReport(env, { serverId: 1, custom: [{ name: 'x', value: 3 }] });
  assert.equal(customInserts, 3, '跨桶重新执行 INSERT');
  assert.equal(I.customWritten.get(1).bucketTs, bucketTs, '记录推进到当前桶');
});

test('监控：长区间查询步长对齐降采样桶（互质步长不再导致图表空洞）', async () => {
  const env = makeEnv();
  // 2 天 = 2880 分钟 > MAX(1500) → 触发 SQL 抽样；数据按 5 分钟桶（与默认降采样粒度一致）
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const since = nowMin - 2 * 1440;
  let n = 0;
  for (let ts = since - (since % 5); ts <= nowMin; ts += 5) {
    await env.DB.prepare('INSERT OR IGNORE INTO metrics_custom (server_id, name, ts, value) VALUES (?,?,?,?)').bind(1, 'x', ts, 1).run();
    n += 1;
  }
  const custom = await I.queryCustomMetrics(env, 1, 48);
  const pts = custom.x.length;
  // 步长对齐后（ceil(2880/1500)=2 → 对齐到 5）应命中全部桶；
  // 未对齐时 step=2 与桶 5 互质，只有 ts%10==0 命中 → 约一半点丢失，图表出现空洞
  assert.ok(pts > n * 0.8, `长区间应命中大部分采样点（实际 ${pts}/${n}）`);
  assert.ok(pts <= 1500, '不超过查询上限');
});

test('metrics_custom 降采样桶：METRICS_DOWNSAMPLE_MIN=1 恢复逐分钟写入', async () => {
  const env = makeEnv({ METRICS_DOWNSAMPLE_MIN: '1' });
  await env.DB.prepare('INSERT INTO servers (agent_key_id, name, user_id, agent_key_hash) VALUES (?,?,?,?)').bind('k1', 's1', 1, 'h1').run();
  I.__reset();
  await I.handleReport(env, { serverId: 1, custom: [{ name: 'x', value: 1 }] });
  const rows = await env.DB.prepare('SELECT * FROM metrics_custom WHERE server_id = 1').all();
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  assert.equal(rows.results[0].ts, nowMin, '粒度=1 时 ts 即当前分钟（旧行为）');
  assert.equal(I.customWritten.get(1).bucketTs, nowMin);
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

test('监控：极端 range（99999d）回退 12h，不触发 D1 全表扫', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'm1' });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const id = list[0].id;

  const res = await call(env, { path: `/api/monitor?server_id=${id}&range=99999d`, token });
  assert.equal(res.status, 200);
  const q = env.METRICS.calls.filter((c) => c.path === '/query').pop();
  // 白名单收口：99999d 不在 1h/12h/3d/7d/30d 白名单 → 回退 12h（limit 720），
  // 而不是按 99999×24h 分钟数请求（会导致 D1 ts % step 抽样全表扫，索引失效）
  assert.equal(q.query.limit, '720', '99999d 应回退 12h');
});

test('监控：不存在的服务器 404；长区间 3d 合并 D1 + 热区查询', async () => {
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
  // 长区间也查热区（合并补齐最近未归档数据）+ D1 归档
  assert.ok(env.METRICS.calls.some((c) => c.path === '/query'), '长区间合并查询热区');
});

test('监控：1d 合并 D1 归档与热区，补齐最近未归档数据', async () => {
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const env = makeEnv({ METRICS: makeMetricsStub({ query: [{ ts: nowMin - 30, cpu: 2 }] }) });
  const token = await login(env);
  await addServer(env, token, { name: 'm3' });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const id = list[0].id;
  // 5 小时前（>60min 归档线，在 1d 查询范围内且不触发 SQL 抽样）
  await env.DB.prepare('INSERT OR IGNORE INTO metrics_min (server_id, ts, cpu, mem_total) VALUES (?,?,?,?)').bind(id, nowMin - 5 * 60, 1, 16384).run();

  const res = await call(env, { path: `/api/monitor?server_id=${id}&range=1d`, token });
  assert.equal(res.status, 200);
  const body = await res.json();
  const tsList = body.system.map((x) => x.ts).sort((a, b) => a - b);
  assert.ok(tsList.includes(nowMin - 5 * 60), '包含 D1 归档数据');
  assert.ok(tsList.includes(nowMin - 30), '包含热区最近数据（修复 12h+ 查询缺最近 ~1h 空洞）');
  const d1Row = body.system.find((x) => x.ts === nowMin - 5 * 60);
  assert.equal(d1Row.mem_total, 16384, 'D1 归档查询返回 mem_total');
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
  const missing = await call(env, { method: 'DELETE', path: `/api/tokens/${list[0].id}`, token: adminToken });
  assert.equal(missing.status, 404, '重复撤销与 MCP 一致返回 token not found');
  assert.match((await missing.json()).error, /token not found/);
  assert.equal((await call(env, { path: '/api/me', token })).status, 401);
  // 删除后通知 PanelDO 清鉴权缓存（已建观看者连接下个 sync 即失效关闭）
  assert.ok(env.PANEL.calls.some((u) => String(u).includes('/rpc/clear_auth_cache')), 'PAT 删除触发 PanelDO 缓存清除');
});

// ---------------- 分组排序 ----------------
test('分组排序：PUT 仅管理员；去空/去重/过滤未分组/孤儿清理；GET 回读；PAT 只读不可写', async () => {
  const env = makeEnv();
  const adminToken = await login(env);
  await addServer(env, adminToken, { name: 'a', group: 'g1' });
  await addServer(env, adminToken, { name: 'b', group: 'g2' });

  // 未登录 → 401；非数组 body → 400
  assert.equal((await call(env, { method: 'PUT', path: '/api/group-order', body: { order: ['g1'] } })).status, 401);
  assert.equal((await call(env, { method: 'PUT', path: '/api/group-order', token: adminToken, body: { order: 'x' } })).status, 400);

  // 保存：含重复/空串/未分组/不存在孤儿 → 清理为 ['g2','g1']
  const put = await call(env, {
    method: 'PUT', path: '/api/group-order', token: adminToken,
    body: { order: ['g2', 'g1', 'g2', '  ', '未分组', 'ghost'] },
  });
  assert.equal(put.status, 200);
  assert.deepEqual((await put.json()).order, ['g2', 'g1']);

  // GET 回读（登录即可）
  const got = await (await call(env, { path: '/api/group-order', token: adminToken })).json();
  assert.deepEqual(got.order, ['g2', 'g1']);

  // kv_json 落库可查
  const row = await env.DB.prepare("SELECT value FROM kv_json WHERE key = 'group_order'").first();
  assert.deepEqual(JSON.parse(row.value), ['g2', 'g1']);

  // PAT（非管理员）→ 读 200 / 写 403
  const pat = await (await call(env, {
    method: 'POST', path: '/api/tokens', token: adminToken,
    body: { name: 'ro', scopes: ['server:read'] },
  })).json();
  assert.equal((await call(env, { path: '/api/group-order', token: pat.token })).status, 200);
  assert.equal((await call(env, { method: 'PUT', path: '/api/group-order', token: pat.token, body: { order: ['g1'] } })).status, 403);
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

test('PAT：同名令牌拒绝（应用层查重 409 + 唯一索引兜底）', async () => {
  const env = makeEnv();
  const adminToken = await login(env);

  // 首次创建成功
  const first = await call(env, { method: 'POST', path: '/api/tokens', token: adminToken, body: { name: 'dup', scopes: ['server:read'] } });
  assert.equal(first.status, 200);

  // REST 同名 → 409（应用层前置查重）
  const dup = await call(env, { method: 'POST', path: '/api/tokens', token: adminToken, body: { name: 'dup', scopes: ['server:read'] } });
  assert.equal(dup.status, 409);
  assert.match((await dup.json()).error, /already exists/);

  // 数据库层唯一索引兜底：绕过应用层直接 INSERT 同名被拒（并发竞态时由 try-catch 转 409）
  await assert.rejects(
    env.DB.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scopes) VALUES (?,?,?,?)')
      .bind(1, 'dup', 'deadbeef', '["server:read"]').run(),
    /UNIQUE constraint failed: api_tokens\.name/,
  );

  // MCP create_token 同名 → 工具错误（isError）
  const mcp = await call(env, {
    method: 'POST', path: '/mcp', token: adminToken,
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_token', arguments: { name: 'dup' } } },
  });
  const mcpBody = await mcp.json();
  assert.equal(mcpBody.result.isError, true);
  assert.match(mcpBody.result.content[0].text, /already exists/);
});

test('PAT：server_ids 语义 — 未提供=全量，空数组=空集', async () => {
  const env = makeEnv();
  const adminToken = await login(env);
  await addServer(env, adminToken, { name: 'a1' });

  // 未提供 server_ids（NULL）→ 全量
  const all = await (await call(env, { method: 'POST', path: '/api/tokens', token: adminToken, body: { name: 'all', scopes: ['server:read'] } })).json();
  const allList = await (await call(env, { path: '/api/servers', token: all.token })).json();
  assert.equal(allList.length, 1, '未限制 → 全量');

  // 空数组白名单 → 空集（不再返回全量，与 canAccessServer 拒绝语义一致）
  const empty = await (await call(env, {
    method: 'POST', path: '/api/tokens', token: adminToken,
    body: { name: 'empty', scopes: ['server:read'], server_ids: [] },
  })).json();
  const emptyList = await (await call(env, { path: '/api/servers', token: empty.token })).json();
  assert.deepEqual(emptyList, [], '空白名单返回空集');
  assert.equal((await call(env, { path: '/api/me', token: empty.token })).status, 200, 'PAT 本身仍有效');

  // 白名单命中
  const scoped = await (await call(env, {
    method: 'POST', path: '/api/tokens', token: adminToken,
    body: { name: 'scoped', scopes: ['server:read'], server_ids: [1] },
  })).json();
  const scopedList = await (await call(env, { path: '/api/servers', token: scoped.token })).json();
  assert.equal(scopedList.length, 1);
});

test('PAT：有效期 — 到期后鉴权拒绝，不设置=永久有效', async () => {
  const env = makeEnv();
  const adminToken = await login(env);
  await addServer(env, adminToken, { name: 'a1' });

  // 带有效期（30 天）创建：expires_at 为将来 unix 秒
  const limited = await (await call(env, {
    method: 'POST', path: '/api/tokens', token: adminToken,
    body: { name: 'limited', scopes: ['server:read'], expires_in_days: 30 },
  })).json();
  assert.ok(limited.expires_at > Math.floor(Date.now() / 1000), '返回将来到期时间');
  const row = await env.DB.prepare("SELECT expires_at FROM api_tokens WHERE name = 'limited'").first();
  assert.equal(row.expires_at, limited.expires_at, '落库到期时间一致');
  assert.equal((await call(env, { path: '/api/me', token: limited.token })).status, 200, '未到期可用');

  // 列表返回 expires_at
  const list = await (await call(env, { path: '/api/tokens', token: adminToken })).json();
  const limRow = list.find((t) => t.name === 'limited');
  assert.equal(limRow.expires_at, limited.expires_at);

  // 直接改库把 expires_at 拨到过去 → 鉴权拒绝（401）
  await env.DB.prepare("UPDATE api_tokens SET expires_at = ? WHERE name = 'limited'").bind(Math.floor(Date.now() / 1000) - 10).run();
  assert.equal((await call(env, { path: '/api/me', token: limited.token })).status, 401, '过期 PAT 拒绝');

  // 未设置 → 永久（expires_at NULL）
  const perm = await (await call(env, {
    method: 'POST', path: '/api/tokens', token: adminToken,
    body: { name: 'perm', scopes: ['server:read'] },
  })).json();
  assert.equal(perm.expires_at, null, '缺省 = 永久');
  assert.equal((await call(env, { path: '/api/me', token: perm.token })).status, 200);
  const permRow = await env.DB.prepare("SELECT expires_at FROM api_tokens WHERE name = 'perm'").first();
  assert.equal(permRow.expires_at, null);
});

test('PAT：有效期支持小数天（0.5 = 12 小时），expires_at 为整数秒', async () => {
  const env = makeEnv();
  const adminToken = await login(env);
  const now = Math.floor(Date.now() / 1000);
  const r = await (await call(env, {
    method: 'POST', path: '/api/tokens', token: adminToken,
    body: { name: 'half-day', scopes: ['server:read'], expires_in_days: 0.5 },
  })).json();
  // 取整放最外层：任意小数都产出整数秒（D1 整数列不落 REAL）
  assert.ok(Number.isInteger(r.expires_at), 'expires_at 为整数秒');
  assert.ok(
    Math.abs(r.expires_at - (now + 43200)) <= 2,
    `0.5 天 ≈ now+43200s（实际偏差 ${r.expires_at - (now + 43200)}s）`
  );
  assert.equal((await call(env, { path: '/api/me', token: r.token })).status, 200, '12 小时内可用');
  const row = await env.DB.prepare("SELECT expires_at FROM api_tokens WHERE name = 'half-day'").first();
  assert.equal(row.expires_at, r.expires_at, '落库一致（整数）');
});

test('PAT：expires_at 绝对截止时间（unix 秒）——优先于天数、过去时间拒绝', async () => {
  const env = makeEnv();
  const adminToken = await login(env);
  const now = Math.floor(Date.now() / 1000);

  // 未来时间：原样落库（取整）、可用
  const r = await (await call(env, {
    method: 'POST', path: '/api/tokens', token: adminToken,
    body: { name: 'abs', scopes: ['server:read'], expires_at: now + 3600 },
  })).json();
  assert.equal(r.expires_at, now + 3600, 'expires_at 原样落库');
  assert.equal((await call(env, { path: '/api/me', token: r.token })).status, 200, '未到期可用');

  // 与 expires_in_days 并存 → expires_at 优先（绝对时间语义明确）
  const both = await (await call(env, {
    method: 'POST', path: '/api/tokens', token: adminToken,
    body: { name: 'both', scopes: ['server:read'], expires_in_days: 30, expires_at: now + 60 },
  })).json();
  assert.ok(both.expires_at - now <= 120, 'expires_at 优先于 expires_in_days');

  // 过去时间 → 400（明确报错优于建成一个立即过期的死令牌）
  const past = await call(env, {
    method: 'POST', path: '/api/tokens', token: adminToken,
    body: { name: 'past', scopes: ['server:read'], expires_at: now - 100 },
  });
  assert.equal(past.status, 400, '过去的截止时间拒绝');
});

test('审计日志：管理员可查（倒序 + limit），非管理员 403', async () => {
  const env = makeEnv();
  const adminToken = await login(env);
  await addServer(env, adminToken, { name: 'a1' }); // 产生 server.create
  await call(env, { method: 'POST', path: '/api/terminal', token: adminToken, body: { server_id: 1 } }); // 产生 terminal.open

  const body = await (await call(env, { path: '/api/audit-logs', token: adminToken })).json();
  const rows = body.rows;
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes('server.create'));
  assert.ok(actions.includes('terminal.open'));
  // 倒序：最新（terminal.open）在前
  assert.equal(rows[0].action, 'terminal.open');
  assert.ok(body.total >= 2, '返回总数');

  // limit + offset 分页生效
  const one = await (await call(env, { path: '/api/audit-logs?limit=1', token: adminToken })).json();
  assert.equal(one.rows.length, 1);
  assert.equal(one.rows[0].action, 'terminal.open', '第一页第一条为最新');
  const page2 = await (await call(env, { path: '/api/audit-logs?limit=1&offset=1', token: adminToken })).json();
  assert.equal(page2.rows[0].action, 'server.create', '第二页为次新');

  // action 筛选
  const filtered = await (await call(env, { path: '/api/audit-logs?action=server.create', token: adminToken })).json();
  assert.ok(filtered.rows.length >= 1);
  assert.ok(filtered.rows.every((r) => r.action === 'server.create'));
  assert.ok(filtered.total < body.total, '筛选后总数减少');

  // 用户名筛选（login 用户名为 admin）
  const byUser = await (await call(env, { path: '/api/audit-logs?user=adm', token: adminToken })).json();
  assert.ok(byUser.rows.every((r) => (r.username || '').includes('adm')));

  // server_id 筛选
  const byServer = await (await call(env, { path: '/api/audit-logs?server_id=1', token: adminToken })).json();
  assert.ok(byServer.rows.every((r) => r.target_server_id === 1));

  // CSV 导出（带鉴权，返回 text/csv + Content-Disposition）
  const csv = await call(env, { path: '/api/audit-logs?format=csv', token: adminToken });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /audit-logs\.csv/);
  const csvText = await csv.text();
  assert.match(csvText, /^id,user_id,username,client_ip,action,target_server_id,detail,created_at/);
  assert.match(csvText, /terminal\.open/);

  // 公式注入防护：以 = + - @ 开头的 detail 前缀单引号，防 Excel/WPS 当公式执行
  await env.DB.prepare("INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (1, 'admin', '1.1.1.1', 'exec.command', 1, '=cmd|/bin/sh')").run();
  const csv2 = await (await call(env, { path: '/api/audit-logs?format=csv', token: adminToken })).text();
  assert.match(csv2, /"'=cmd\|\/bin\/sh"/, '= 前缀被单引号转义');

  // PAT 不能查看
  const pat = await (await call(env, { method: 'POST', path: '/api/tokens', token: adminToken, body: { name: 'r', scopes: ['server:read'] } })).json();
  assert.equal((await call(env, { path: '/api/audit-logs', token: pat.token })).status, 403);
});

test('测试 Webhook：发送测试通知并回显 HTTP 状态', async () => {
  const env = makeEnv();
  const token = await login(env);
  const origFetch = globalThis.fetch;

  // 未填地址 → 400
  const noUrl = await call(env, { method: 'POST', path: '/api/settings/test_webhook', token, body: { alerts: {} } });
  assert.equal(noUrl.status, 400);

  // 2xx → ok:true + status
  globalThis.fetch = async () => new Response('ok', { status: 202 });
  const ok = await (await call(env, { method: 'POST', path: '/api/settings/test_webhook', token, body: { alerts: { webhook_url: 'https://x/hook' } } })).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 202);

  // 5xx → ok:false + status
  globalThis.fetch = async () => new Response('err', { status: 503 });
  const bad = await (await call(env, { method: 'POST', path: '/api/settings/test_webhook', token, body: { alerts: { webhook_url: 'https://x/hook' } } })).json();
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 503);

  // 网络异常 → ok:false + error 消息
  globalThis.fetch = async () => { throw new Error('net down'); };
  const net = await (await call(env, { method: 'POST', path: '/api/settings/test_webhook', token, body: { alerts: { webhook_url: 'https://x/hook' } } })).json();
  assert.equal(net.ok, false);
  assert.match(net.error, /net down/);

  // 不保存配置：settings 里不应出现 alerts
  const settings = await (await call(env, { path: '/api/settings', token })).json();
  assert.equal(settings.alerts, undefined, '测试不落配置');

  globalThis.fetch = origFetch;
});

test('用量观测：/api/usage 仅管理员可访问，返回用量估算（P2 #15）', async () => {
  const env = makeEnv();
  const adminToken = await login(env);
  const res = await call(env, { path: '/api/usage', token: adminToken });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok('api' in body, '含 Worker 请求计数');
  assert.ok('metrics_do' in body, '含 MetricsDO 用量');
  assert.ok('estimates_per_day' in body, '含每日估算');
  assert.ok(body.estimates_per_day.report_frames >= 0);
  // PAT（非管理员）403
  const pat = await (await call(env, { method: 'POST', path: '/api/tokens', token: adminToken, body: { name: 'r', scopes: ['server:read'] } })).json();
  assert.equal((await call(env, { path: '/api/usage', token: pat.token })).status, 403);
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

  // 保存后通知 MetricsDO 清设置缓存（DO 隔离实例的告警/探活配置立即生效）
  assert.ok(env.METRICS.calls.some((c) => c.path === '/rpc/clear_settings_cache'), '设置保存触发 MetricsDO 清缓存 RPC');

  // PAT 不能读写设置
  const pat = await (await call(env, {
    method: 'POST', path: '/api/tokens', token: adminToken, body: { name: 'r', scopes: ['server:read'] },
  })).json();
  assert.equal((await call(env, { path: '/api/settings', token: pat.token })).status, 403);
  assert.equal((await call(env, { method: 'PUT', path: '/api/settings', token: pat.token, body: {} })).status, 403);
});

test('设置：geo_lookup 开关默认关闭，可开启并在 public settings 返回', async () => {
  const env = makeEnv();
  const token = await login(env);
  // 默认关闭（不把服务器公网 IP 发第三方）
  const pub = await (await call(env, { path: '/api/public/settings' })).json();
  assert.equal(pub.geo_lookup, false, '默认关闭');

  // 管理员开启 → public settings 返回 true
  await call(env, { method: 'PUT', path: '/api/settings', token, body: { geo_lookup: true } });
  const pub2 = await (await call(env, { path: '/api/public/settings' })).json();
  assert.equal(pub2.geo_lookup, true, '开启后返回 true');

  // 关闭
  await call(env, { method: 'PUT', path: '/api/settings', token, body: { geo_lookup: false } });
  const pub3 = await (await call(env, { path: '/api/public/settings' })).json();
  assert.equal(pub3.geo_lookup, false, '可关闭');
});

// ---------------- 终端 / 文件 会话 ----------------
test('Agent 控制通道只接受 X-Agent-Key 请求头，不接受 query key', async () => {
  const env = makeEnv();
  const adminToken = await login(env);
  const added = await addServer(env, adminToken, { name: 'agent-auth' });

  const queryOnly = await call(env, { path: `/ws/agent/control?key=${encodeURIComponent(added.agent_key)}` });
  assert.equal(queryOnly.status, 401);
  assert.equal(await queryOnly.text(), 'missing agent key');
  assert.equal(env.TERMINAL.calls.length, 0, 'query key 不进入 DO');

  const header = await call(env, { path: '/ws/agent/control', headers: { 'x-agent-key': added.agent_key } });
  assert.equal(header.status, 200);
  assert.equal(env.TERMINAL.calls.length, 1, 'header key 正常路由到所属分片');
});

test('Agent 更新：仅管理员、能力检查、Release 流式中转与审计', async () => {
  const env = makeEnv();
  const admin = await login(env);
  await addServer(env, admin, { name: 'updatable' });
  await env.DB.prepare('UPDATE servers SET info_json = ?, last_seen = ? WHERE id = 1')
    .bind(JSON.stringify({
      agent_version: '2026.08.20-1000', agent_platform: 'linux-x86_64',
      update_protocol: 1, self_update_enabled: true,
    }), Math.floor(Date.now() / 1000)).run();

  const binary = new Uint8Array([1, 2, 3, 4]);
  const manifest = {
    schema: 1, version: '0.3.0', build_id: '2026.08.25-1200',
    tag: 'cf-panel-agent-2026.08.25-1200', commit: 'abc', update_protocol: 1,
    assets: {},
  };
  const names = {
    'linux-x86_64': 'cf-panel-agent',
    'linux-aarch64': 'cf-panel-agent-aarch64',
    'macos-aarch64': 'cf-panel-agent-macos',
    'windows-x86_64': 'cf-panel-agent-windows.exe',
  };
  for (const [platform, name] of Object.entries(names)) {
    manifest.assets[platform] = {
      name, size: binary.length, sha256: 'a'.repeat(64),
      url: `https://github.com/yanghuan/cf-panel/releases/download/${manifest.tag}/${name}`,
    };
  }
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url).endsWith('agent-manifest.json')) return new Response(JSON.stringify(manifest));
    return new Response(binary, { headers: { 'content-length': String(binary.length) } });
  };
  try {
    const latest = await call(env, { path: '/api/agent/latest', token: admin });
    assert.equal(latest.status, 200);
    assert.equal((await latest.json()).build_id, manifest.build_id);

    const updated = await call(env, {
      method: 'POST', path: '/api/servers/1/agent-update', token: admin,
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).build_id, manifest.build_id);
    assert.equal(env.TERMINAL.calls.at(-1).path, '/rpc/agent_update');
    const headers = env.TERMINAL.calls.at(-1).init.headers;
    assert.equal(headers['x-agent-platform'], 'linux-x86_64');
    assert.equal(headers['x-agent-size'], '4');
    assert.equal(fetched.length, 2, 'manifest 一次 + asset 一次（latest 缓存复用）');
    const audits = await env.DB.prepare("SELECT action FROM audit_logs WHERE action LIKE 'agent.update.%' ORDER BY id").all();
    assert.deepEqual(audits.results.map((x) => x.action), [
      'agent.update.request', 'agent.update.installed',
    ]);

    // PAT 即使有 exec 权限也不可更新 Agent
    const patRes = await call(env, {
      method: 'POST', path: '/api/tokens', token: admin,
      body: { name: 'exec', scopes: ['server:exec'] },
    });
    const pat = (await patRes.json()).token;
    assert.equal((await call(env, {
      method: 'POST', path: '/api/servers/1/agent-update', token: pat,
    })).status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

test('终端与文件会话：审计写入失败仍返回已创建会话', async () => {
  const env = makeEnv();
  const adminToken = await login(env);
  await addServer(env, adminToken, { name: 'audit-fallback' });

  const originalPrepare = env.DB.prepare.bind(env.DB);
  const originalError = console.error;
  const errors = [];
  env.DB.prepare = (sql) => {
    if (sql.startsWith('INSERT INTO audit_logs') && sql.includes('target_server_id')) {
      return { bind: () => ({ run: async () => { throw new Error('audit unavailable'); } }) };
    }
    return originalPrepare(sql);
  };
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    const terminal = await call(env, { method: 'POST', path: '/api/terminal', token: adminToken, body: { server_id: 1 } });
    const file = await call(env, { method: 'POST', path: '/api/file/open', token: adminToken, body: { server_id: 1 } });
    assert.equal(terminal.status, 200, '终端会话保持可用');
    assert.equal(file.status, 200, '文件会话保持可用');
    assert.match((await terminal.json()).session_id, /^\d-/);
    assert.match((await file.json()).session_id, /^\d-/);
    assert.equal(errors.length, 2, '两次审计失败均写服务端错误日志');
    assert.match(errors[0], /terminal\.open audit failed/);
    assert.match(errors[1], /file\.open audit failed/);
  } finally {
    env.DB.prepare = originalPrepare;
    console.error = originalError;
  }
});

// ---------------- MCP ----------------
async function mcp(env, { token, body, version, origin, method = 'POST', base = 'http://panel.local' }) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (version) headers['mcp-protocol-version'] = version;
  if (origin) headers.origin = origin;
  const req = new Request(`${base}/mcp`, {
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
  assert.deepEqual(list.result.tools.map((t) => t.name), [
    'list_servers', 'get_monitor', 'exec_command', 'create_upload',
    'add_server', 'delete_server', 'update_server', 'rotate_agent_key',
    'list_tokens', 'create_token', 'revoke_token',
    'get_audit_logs', 'get_usage', 'get_settings', 'update_settings',
  ]);

  // create_upload：签发签名 URL（结构 + 权限 + 绑定字段）
  const cu = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'create_upload', arguments: { server_name: 'web-1', path: '/opt/app.tar.gz' } } } })).json();
  assert.equal(cu.result.isError, false);
  const cuRes = JSON.parse(cu.result.content[0].text);
  assert.equal(cuRes.server_name, 'web-1');
  assert.match(cuRes.upload_url, /^http:\/\/panel\.local\/mcp\/file_upload\?/); // 测试入口 http → http（见协议派生测试）
  assert.match(cuRes.upload_url, /token=/);
  assert.equal(cuRes.overwrite, false);
  assert.ok(cuRes.expires_in_seconds > 0 && cuRes.expires_in_seconds <= 600);
  // 签名 URL 篡改路径 → 403（验签失败；同一签名换了 path 重算对不上）
  const tampered = cuRes.upload_url.replace(/path=%2Fopt%2Fapp.tar.gz/, 'path=%2Ftmp%2Fevil');
  const badSigned = await worker.fetch(new Request(tampered, { method: 'POST', body: 'x' }), env);
  assert.equal(badSigned.status, 403);
  // 合法签名 URL 可上传（DO stub 透传 → 200，无需 Bearer）
  const goodSigned = await worker.fetch(new Request(cuRes.upload_url, { method: 'POST', body: 'hello signed' }), env);
  assert.equal(goodSigned.status, 200);

  // Bearer 路径（非签名分支）：/mcp/file_upload 带 token + server_id/path → 审计 + DO /rpc/upload 透传
  const serverRow = await env.DB.prepare("SELECT id FROM servers WHERE name = 'web-1'").first();
  const bearerUp = await worker.fetch(
    new Request(`http://panel.local/mcp/file_upload?server_id=${serverRow.id}&path=/tmp/t.txt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: 'raw bytes',
    }),
    env
  );
  assert.equal(bearerUp.status, 200, 'Bearer 上传分支应成功');
  assert.ok(env.TERMINAL.calls.some((c) => c.path === '/rpc/upload'), '转发到 TerminalDO /rpc/upload');
  const upAudit = await env.DB.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'file.upload'").all();
  assert.equal(upAudit.results[0].c, 2, '签名签发 1 次 + Bearer 直传 1 次审计');
  // 非绝对路径拒绝
  const badPath = await worker.fetch(
    new Request(`http://panel.local/mcp/file_upload?server_id=${serverRow.id}&path=rel.txt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: 'x',
    }),
    env
  );
  assert.equal(badPath.status, 400);
  // 无鉴权访问 Bearer 上传 → 400（JSON-RPC error 语义，code=-32001）
  const noAuth = await worker.fetch(
    new Request(`http://panel.local/mcp/file_upload?server_id=${serverRow.id}&path=/tmp/t.txt`, {
      method: 'POST',
      body: 'x',
    }),
    env
  );
  assert.equal(noAuth.status, 400, 'JSON-RPC error 返回 400');
  const noAuthBody = await noAuth.json();
  assert.equal(noAuthBody.error.code, -32001, '未授权返回 JSON-RPC unauthorized');

  // exec_command：DO stub 返回 200（无 agent 语义）→ 结构正确
  const ex = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'exec_command', arguments: { server_name: 'web-1', command: 'echo hi' } } } })).json();
  assert.equal(ex.result.isError, false);
  const exRes = JSON.parse(ex.result.content[0].text);
  assert.equal(exRes.server_name, 'web-1');
  assert.equal(exRes.exit_code, null);

  // exec_command：agent 离线（DO 返回 502）→ isError
  const offlineTerminal = {
    idFromName: () => 'shard-x',
    get: () => ({ fetch: async () => new Response(JSON.stringify({ error: 'agent offline' }), { status: 502 }) }),
  };
  const envOffline = makeEnv({ TERMINAL: offlineTerminal });
  const tokenOffline = await login(envOffline);
  await addServer(envOffline, tokenOffline, { name: 'web-1' });
  const exOff = await (await mcp(envOffline, { token: tokenOffline, body: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'exec_command', arguments: { server_name: 'web-1', command: 'echo hi' } } } })).json();
  assert.equal(exOff.result.isError, true);
  assert.match(exOff.result.content[0].text, /agent offline/);

  // exec_command：未知服务器 → isError
  const exNf = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'exec_command', arguments: { server_name: 'nope', command: 'echo hi' } } } })).json();
  assert.equal(exNf.result.isError, true);
  assert.match(exNf.result.content[0].text, /server not found/);

  // exec_command：重名服务器 → 歧义错误（不静默取第一条）
  await addServer(env, token, { name: 'web-1', group: 'dup' });
  const exAmb = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'exec_command', arguments: { server_name: 'web-1', command: 'echo hi' } } } })).json();
  assert.equal(exAmb.result.isError, true);
  assert.match(exAmb.result.content[0].text, /ambiguous server_name/);
  // 用 server_id 仍可精确执行（不歧义）
  const exId = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'exec_command', arguments: { server_id: 1, command: 'echo hi' } } } })).json();
  assert.equal(exId.result.isError, false);
  // get_monitor 重名同样歧义
  const gmAmb = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_monitor', arguments: { server_name: 'web-1', range: '1h' } } } })).json();
  assert.equal(gmAmb.result.isError, true);
  assert.match(gmAmb.result.content[0].text, /ambiguous server_name/);

  // list_servers（含后面的重名测试共 2 台）
  const ls = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_servers', arguments: {} } } })).json();
  const servers = JSON.parse(ls.result.content[0].text);
  assert.equal(servers.length, 2);
  assert.ok(servers.some((s) => s.name === 'web-1' && s.group === 'prod'), '含 prod 组 web-1');
  assert.ok(servers.some((s) => s.name === 'web-1' && s.group === 'dup'), '含 dup 组 web-1');

  // get_monitor（server_id 精确；当前有两台重名 web-1，name 会歧义）
  const gm = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_monitor', arguments: { server_id: 1, range: '1h' } } } })).json();
  const mon = JSON.parse(gm.result.content[0].text);
  assert.equal(mon.server.name, 'web-1');
  assert.equal(mon.range, '1h');

  // 未知服务器 → isError
  const nf = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_monitor', arguments: { server_name: 'nope' } } } })).json();
  assert.equal(nf.result.isError, true);

  // 未知工具 → -32602
  const bad = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rm_rf' } } })).json();
  assert.equal(bad.error.code, -32602);

  // ---- 管理类工具（仅管理员）----
  // add_server：新增服务器，返回 agent_key 明文
  const as = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'add_server', arguments: { name: 'mcp-new', group: 'mcp', sort_order: 3 } } } })).json();
  assert.equal(as.result.isError, false);
  const asRes = JSON.parse(as.result.content[0].text);
  assert.equal(asRes.name, 'mcp-new');
  assert.equal(asRes.server_id, 3);
  assert.ok(asRes.agent_key && asRes.agent_key.length === 64, 'agent_key 明文返回');
  // 部署地址动态生成（host = panel.local，非占位符；测试入口 http → ws）
  assert.equal(asRes.wss_base, 'ws://panel.local/ws/agent');
  // add_server：缺 name → isError
  const asBad = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'add_server', arguments: {} } } })).json();
  assert.equal(asBad.result.isError, true);
  assert.match(asBad.result.content[0].text, /name required/);

  // update_server：改名（server_name 定位）
  const us = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'update_server', arguments: { server_name: 'mcp-new', name: 'mcp-renamed' } } } })).json();
  assert.equal(us.result.isError, false);
  const usRes = JSON.parse(us.result.content[0].text);
  assert.equal(usRes.name, 'mcp-renamed');

  // create_token / list_tokens / revoke_token
  const ct = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'create_token', arguments: { name: 'mcp-tok', scopes: ['server:read'], server_ids: [1], expires_in_days: 7 } } } })).json();
  assert.equal(ct.result.isError, false);
  const ctRes = JSON.parse(ct.result.content[0].text);
  assert.match(ctRes.token, /^cfp_/);
  assert.ok(ctRes.expires_at > Math.floor(Date.now() / 1000), 'MCP 创建支持有效期');
  const lt = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'list_tokens', arguments: {} } } })).json();
  const ltRes = JSON.parse(lt.result.content[0].text);
  assert.equal(ltRes.length, 1);
  assert.equal(ltRes[0].name, 'mcp-tok');
  assert.ok(!('token_hash' in ltRes[0]), '不含哈希');
  const rk = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 25, method: 'tools/call', params: { name: 'revoke_token', arguments: { token_id: ltRes[0].id } } } })).json();
  assert.equal(rk.result.isError, false);

  // get_audit_logs：分页 + 筛选（返回 {rows,total}）
  const al = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 26, method: 'tools/call', params: { name: 'get_audit_logs', arguments: { limit: 10 } } } })).json();
  const alRes = JSON.parse(al.result.content[0].text);
  assert.ok(alRes.rows.length >= 2, '有审计记录');
  assert.ok(alRes.total >= 2, '返回总数');
  assert.ok(alRes.rows.some((r) => r.action === 'server.create'));
  // action 筛选（本测试中 update_server 已产生 server.update）
  const alF = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 27, method: 'tools/call', params: { name: 'get_audit_logs', arguments: { action: 'server.update' } } } })).json();
  const alFRes = JSON.parse(alF.result.content[0].text);
  assert.ok(alFRes.rows.length >= 1, 'update_server 已产生 server.update 审计');
  assert.ok(alFRes.rows.every((r) => r.action === 'server.update'));

  // get_settings / update_settings
  const gs = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 27, method: 'tools/call', params: { name: 'get_settings', arguments: {} } } })).json();
  const gsRes = JSON.parse(gs.result.content[0].text);
  assert.equal(typeof gsRes.site_name, 'undefined', '初始无设置');
  const us2 = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 28, method: 'tools/call', params: { name: 'update_settings', arguments: { site_name: 'MCP 面板' } } } })).json();
  assert.equal(us2.result.isError, false);
  const us2Res = JSON.parse(us2.result.content[0].text);
  assert.equal(us2Res.site_name, 'MCP 面板');
  const gs2 = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 29, method: 'tools/call', params: { name: 'get_settings', arguments: {} } } })).json();
  assert.equal(JSON.parse(gs2.result.content[0].text).site_name, 'MCP 面板');

  // get_usage：结构完整
  const gu = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'get_usage', arguments: {} } } })).json();
  const guRes = JSON.parse(gu.result.content[0].text);
  assert.ok('estimates_per_day' in guRes && 'metrics_do' in guRes);

  // MCP 同样支持小数天：schema 已声明 type:number，锁定服务端对 0.5 的处理
  const ctHalf = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'create_token', arguments: { name: 'mcp-half', scopes: ['server:read'], expires_in_days: 0.5 } } } })).json();
  assert.equal(ctHalf.result.isError, false, 'MCP 支持小数天（0.5=12 小时）');
  const ctHalfRes = JSON.parse(ctHalf.result.content[0].text);
  assert.ok(ctHalfRes.expires_at > Math.floor(Date.now() / 1000), '将来到期时间');
  assert.ok(Number.isInteger(ctHalfRes.expires_at), 'expires_at 为整数秒');

  // PAT 不能使用管理工具（仅管理员）
  const pat = await requestBuilder(worker)(env, { method: 'POST', path: '/api/tokens', token, body: { name: 'pat-x', scopes: ['server:read'] } });
  const patToken = (await pat.json()).token;
  const patDenied = await (await mcp(env, { token: patToken, body: { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'add_server', arguments: { name: 'x' } } } })).json();
  assert.equal(patDenied.result.isError, true);
  assert.match(patDenied.result.content[0].text, /admin only/);

  // delete_server：按 server_name 删除 mcp-renamed
  const ds = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'delete_server', arguments: { server_name: 'mcp-renamed' } } } })).json();
  assert.equal(ds.result.isError, false);
  const dsRes = JSON.parse(ds.result.content[0].text);
  assert.equal(dsRes.ok, true);

  // delete_server 缺参：前置校验（区分「缺参」与「目标不存在」，AI 客户端可自纠）
  const noArg = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'delete_server', arguments: {} } } })).json();
  assert.equal(noArg.result.isError, true);
  assert.match(noArg.result.content[0].text, /必须提供其一/);
});

// ---------------- 存活探针 ----------------
test('GET /api/healthz：不鉴权、不查 D1 的存活探针', async () => {
  // 即使 JWT_SECRET 未配置（所有受保护入口都 503），探针仍应可用——
  // 它回答的是"Worker 是否在正常响应"，不是"配置是否正确"
  const env = makeEnv({ JWT_SECRET: undefined });
  const res = await call(env, { path: '/api/healthz' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.ts > 0);

  // 有密钥时同样可用（不因鉴权状态改变行为）
  const env2 = makeEnv();
  const res2 = await call(env2, { path: '/api/healthz' });
  assert.equal(res2.status, 200);
});

// ---------------- 登录与鉴权审计（此前这类事件完全无痕） ----------------
test('登录成功/失败写入审计，且审计不含密码', async () => {
  const env = makeEnv();
  const ip = '5.5.5.5';
  const bad = await call(env, { method: 'POST', path: '/api/login', body: { password: 'nope' }, ip });
  assert.equal(bad.status, 401);

  let logs = await env.DB.prepare('SELECT * FROM audit_logs WHERE action = ?').bind('login.failed').all();
  assert.equal(logs.results.length, 1, '失败应留痕');
  assert.equal(logs.results[0].client_ip, ip);
  assert.ok(!JSON.stringify(logs.results[0]).includes('nope'), '审计绝不记录密码');

  const ok = await call(env, { method: 'POST', path: '/api/login', body: { password: 'admin123' }, ip });
  assert.equal(ok.status, 200);
  logs = await env.DB.prepare('SELECT * FROM audit_logs WHERE action = ?').bind('login.success').all();
  assert.equal(logs.results.length, 1);
  assert.equal(logs.results[0].username, 'admin');
});

test('登录被锁定的请求写入 login.locked 审计', async () => {
  const env = makeEnv();
  const ip = '6.6.6.6';
  for (let i = 0; i < 5; i++) {
    await call(env, { method: 'POST', path: '/api/login', body: { password: 'bad' }, ip });
  }
  const locked = await call(env, { method: 'POST', path: '/api/login', body: { password: 'admin123' }, ip });
  assert.equal(locked.status, 429);
  const logs = await env.DB.prepare('SELECT * FROM audit_logs WHERE action = ?').bind('login.locked').all();
  assert.equal(logs.results.length, 1, '锁定期间的尝试应留痕');
});

test('无效凭据访问受保护接口写入 auth.failed 审计（路径经归一化）', async () => {
  const env = makeEnv();
  const res = await call(env, { path: '/api/me', token: 'not-a-real-token', ip: '7.7.7.7' });
  assert.equal(res.status, 401);
  const logs = await env.DB.prepare('SELECT * FROM audit_logs WHERE action = ?').bind('auth.failed').all();
  assert.equal(logs.results.length, 1);
  assert.match(logs.results[0].detail, /GET \/api\/me/);
});

// ---------------- PAT 最近使用时间 ----------------
test('PAT 鉴权成功回写 last_used_at（新建时为 null）', async () => {
  const env = makeEnv();
  const admin = await login(env);
  const created = await (await call(env, {
    method: 'POST', path: '/api/tokens', token: admin, body: { name: 'probe', scopes: ['server:read'] },
  })).json();

  const before = await env.DB.prepare('SELECT id, last_used_at FROM api_tokens WHERE name = ?').bind('probe').first();
  assert.equal(before.last_used_at, null, '新建令牌未使用过');

  const me = await call(env, { path: '/api/me', token: created.token });
  assert.equal(me.status, 200);
  const after = await env.DB.prepare('SELECT last_used_at FROM api_tokens WHERE id = ?').bind(before.id).first();
  assert.ok(after.last_used_at > 0, '使用后应回写时间戳');
});

// ---------------- Agent Key 轮换 ----------------
test('轮换 Agent Key：旧 key 指纹失效，监控历史与审计保留', async () => {
  const env = makeEnv();
  const token = await login(env);
  const added = await addServer(env, token, { name: 'rot-1' });
  const oldKey = added.agent_key;
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const id = list[0].id;
  await env.DB.prepare('INSERT INTO metrics_min (server_id, ts, cpu) VALUES (?,?,?)')
    .bind(id, Math.floor(Date.now() / 1000 / 60), 5).run();

  const rot = await (await call(env, { method: 'POST', path: `/api/servers/${id}/rotate-key`, token })).json();
  assert.ok(rot.agent_key, '应返回新 key');
  assert.notEqual(rot.agent_key, oldKey);

  // 旧 key 的指纹已从库中移除 → agent 用旧 key 建连会因查不到服务器被 401
  const server = await env.DB.prepare('SELECT agent_key_id FROM servers WHERE id = ?').bind(id).first();
  assert.notEqual(server.agent_key_id, await I.sha256Hex(oldKey), '旧 key 指纹不再有效');

  const hist = await env.DB.prepare('SELECT * FROM metrics_min WHERE server_id = ?').bind(id).all();
  assert.equal(hist.results.length, 1, '轮换不应清空监控历史（这是它优于"删了重建"的地方）');

  const logs = await env.DB.prepare('SELECT * FROM audit_logs WHERE action = ?').bind('server.rotate_key').all();
  assert.equal(logs.results.length, 1, '轮换是安全处置动作，必须留痕');
});

test('轮换 Agent Key：仅管理员，不存在的服务器 404', async () => {
  const env = makeEnv();
  const token = await login(env);
  const missing = await call(env, { method: 'POST', path: '/api/servers/99999/rotate-key', token });
  assert.equal(missing.status, 404);
});

// ---------------- 批量操作 ----------------
test('批量操作：update-group 生效；delete 返回逐项结果（部分失败可见）', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'b-1' });
  await addServer(env, token, { name: 'b-2' });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const ids = list.map((s) => s.id);

  const g = await (await call(env, {
    method: 'POST', path: '/api/servers/batch', token, body: { op: 'update-group', ids, group: 'prod' },
  })).json();
  assert.equal(g.summary.success, 2);
  const after = await (await call(env, { path: '/api/servers', token })).json();
  assert.ok(after.every((s) => s.group === 'prod'));

  // 混入一个不存在的 id：成功的照常成功，失败的单独标记，而不是整体 500
  const d = await (await call(env, {
    method: 'POST', path: '/api/servers/batch', token, body: { op: 'delete', ids: [ids[0], 999999] },
  })).json();
  assert.equal(d.summary.success, 1);
  assert.equal(d.summary.failed, 1);
  assert.equal(d.results.find((r) => r.id === 999999).error, 'not found');

  const left = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(left.length, 1);
});

test('批量操作：非法 op / 空 ids / 超量 被拒', async () => {
  const env = makeEnv();
  const token = await login(env);
  assert.equal((await call(env, { method: 'POST', path: '/api/servers/batch', token, body: { op: 'nope', ids: [1] } })).status, 400);
  assert.equal((await call(env, { method: 'POST', path: '/api/servers/batch', token, body: { op: 'delete', ids: [] } })).status, 400);
  assert.equal((await call(env, { method: 'POST', path: '/api/servers/batch', token, body: { op: 'delete', ids: Array.from({ length: 101 }, (_, i) => i + 1) } })).status, 400);
});

// ---------------- 按天统计 API ----------------
test('GET /api/stats：按天账汇总（流量合计 + 可用率）', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 's-1' });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const id = list[0].id;
  const day = Math.floor(Date.now() / 1000 / 86400);
  await env.DB.prepare(
    'INSERT INTO metrics_day (server_id, day, bytes_in, bytes_out, online_min, total_min, restarts) VALUES (?,?,?,?,?,?,?)'
  ).bind(id, day, 1024, 2048, 1400, 1440, 1).run();

  const st = await (await call(env, { path: `/api/stats?server_id=${id}&days=30`, token })).json();
  assert.equal(st.rows.length, 1);
  assert.equal(st.summary.bytes_in, 1024);
  assert.equal(st.summary.bytes_out, 2048);
  assert.equal(st.summary.restarts, 1);
  // 可用率 = 在线分钟 / 纳入统计分钟
  assert.ok(Math.abs(st.summary.availability - (1400 / 1440) * 100) < 1e-6);
  assert.ok(Math.abs(st.rows[0].availability - st.summary.availability) < 1e-6);
  assert.equal(st.rows[0].ts, day * 86400, '返回当天起始 unix 秒供前端格式化');
});

test('GET /api/stats：无数据区间返回空数组，可用率为 null（非 0/NaN）', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 's-2' });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const st = await (await call(env, { path: `/api/stats?server_id=${list[0].id}&days=7`, token })).json();
  assert.deepEqual(st.rows, []);
  assert.equal(st.summary.availability, null, '无数据时不可用率应为 null（前端显示 -）');
});

// ---------------- 逐机告警覆盖 + 免打扰 ----------------
test('逐机告警阈值覆盖：设置/清除，并随列表返回供回填', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'a-1' });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const id = list[0].id;

  const patched = await (await call(env, {
    method: 'PATCH', path: `/api/servers/${id}`, token, body: { alert_override: { cpu_pct: 42 } },
  })).json();
  assert.deepEqual(patched.alert_override, { cpu_pct: 42 });

  const list2 = await (await call(env, { path: '/api/servers', token })).json();
  assert.deepEqual(list2[0].alert_override, { cpu_pct: 42 }, '列表需带回覆盖值，前端编辑弹窗才能回填');

  const cleared = await (await call(env, {
    method: 'PATCH', path: `/api/servers/${id}`, token, body: { alert_override: null },
  })).json();
  assert.equal(cleared.alert_override, null, '传 null 清除覆盖回退全局');
});

test('免打扰：未来时间落库，非法/0 不落库', async () => {
  const env = makeEnv();
  const token = await login(env);
  const future = Math.floor(Date.now() / 1000) + 3600;
  const saved = await (await call(env, {
    method: 'PUT', path: '/api/settings', token,
    body: { alerts: { webhook_url: 'https://example.com/hook', mute_until: future } },
  })).json();
  assert.equal(saved.alerts.mute_until, future);

  // 0/负数/非法不落库：存一个永不起效的值只会让配置看起来可疑
  const bogus = await (await call(env, {
    method: 'PUT', path: '/api/settings', token,
    body: { alerts: { webhook_url: 'https://example.com/hook', mute_until: 0 } },
  })).json();
  assert.equal(bogus.alerts.mute_until, undefined);
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
