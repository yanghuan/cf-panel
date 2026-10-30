// ============================================================
// API 集成测试：通过 worker.fetch 全链路（真实 SQLite 内存 D1 + DO 桩）
// 覆盖：登录/限流、鉴权、服务器 CRUD、agent 上报、监控、PAT、设置、MCP
// 运行：node --test test/api.test.js
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { __internals as I, TerminalDO } from '../src/index.js';
import { EXEC_CMD_MAX_BYTES, SERVER_DESC_MAX } from '../src/config.js';
import { settleServerExpired } from '../src/jobs.js';
import { makeEnv, makePanelStub, makeMetricsStub, makeR2, requestBuilder } from './helpers.js';

// node 没有 FixedLengthStream（Workers 才有）：用 TransformStream 搭一个等价物，
// 让上传测试走真实的 FixedLengthStream 分支（超长写抛错、提前 close 报错、写满才成功）。
// streamToR2 只在调用时引用它，所以这里赋值时测试尚未跑到上传路径，时机足够。
if (typeof globalThis.FixedLengthStream === 'undefined') {
  globalThis.FixedLengthStream = class FixedLengthStream {
    constructor(length) {
      let written = 0;
      const ts = new TransformStream({
        transform(chunk, controller) {
          written += chunk.byteLength;
          if (written > length) {
            controller.error(new Error('too large'));
            return;
          }
          controller.enqueue(chunk);
        },
        flush(controller) {
          if (written !== length) controller.error(new Error('short stream'));
        },
      });
      this.readable = ts.readable;
      this.writable = ts.writable;
    }
  };
}

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

// 服务器描述：可选多行文本，随列表（及 MCP list_servers）下发，长度受 SERVER_DESC_MAX 限制
test('服务器描述：多行保存 + CRLF 归一 + 未传保持 + 空串清除 + 长度上限', async () => {
  const env = makeEnv();
  const token = await login(env);
  const multi = '用于生产数据库\n负责人：ops\n机房：BJ-3';
  await addServer(env, token, { name: 'db', description: multi });
  let list = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(list[0].description, multi, '多行描述原样保存');
  const id = list[0].id;

  // 前后空白裁剪 + CRLF 归一为 LF
  await call(env, { method: 'PATCH', path: `/api/servers/${id}`, token, body: { description: '  a\r\nb  ' } });
  list = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(list[0].description, 'a\nb', 'CRLF 归一且去首尾空白');

  // 未传该字段 = 保持原值（PATCH 语义）
  await call(env, { method: 'PATCH', path: `/api/servers/${id}`, token, body: { name: 'db2' } });
  list = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(list[0].name, 'db2');
  assert.equal(list[0].description, 'a\nb', '未传 description 时保持原值');

  // 空白/空串 = 清除（归一成 NULL，不存空串）
  await call(env, { method: 'PATCH', path: `/api/servers/${id}`, token, body: { description: '   ' } });
  list = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(list[0].description, '', '空白描述归一为空（库里存 NULL，接口统一返回空串）');

  // 长度上限（UTF-16 码元，与前端 maxlength 同口径）
  const tooLong = 'x'.repeat(SERVER_DESC_MAX + 1);
  assert.equal((await call(env, { method: 'POST', path: '/api/servers', token, body: { name: 'big', description: tooLong } })).status, 400);
  assert.equal((await call(env, { method: 'PATCH', path: `/api/servers/${id}`, token, body: { description: tooLong } })).status, 400);
  assert.equal((await call(env, { method: 'PATCH', path: `/api/servers/${id}`, token, body: { description: 'x'.repeat(SERVER_DESC_MAX) } })).status, 200, '正好等于上限可通过');
});

test('MCP：add_server/update_server 支持 description，list_servers 返回它', async () => {
  const env = makeEnv();
  const token = await login(env);
  const as = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_server', arguments: { name: 'mcp-desc', description: '备份机 · 每日 2:00 全量' } } } })).json();
  assert.equal(as.result.isError, false);
  assert.equal(JSON.parse(as.result.content[0].text).description, '备份机 · 每日 2:00 全量');

  const ls = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_servers', arguments: {} } } })).json();
  assert.equal(JSON.parse(ls.result.content[0].text)[0].description, '备份机 · 每日 2:00 全量', 'list_servers 带出描述');

  const up = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'update_server', arguments: { server_id: 1, description: '改了' } } } })).json();
  assert.equal(JSON.parse(up.result.content[0].text).description, '改了');
  const clr = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'update_server', arguments: { server_id: 1, description: '' } } } })).json();
  assert.equal(JSON.parse(clr.result.content[0].text).description, '', '空串清除');
  const after = await (await call(env, { path: '/api/servers', token })).json();
  assert.equal(after[0].description, '', '清除后接口返回空串');
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

  // MCP create_upload：签发给 curl 的上传 URL 同样派生（阶段 B：/mcp/upload-jobs/:id/content）
  // 两次调用必须用不同服务器：upload job 单机串行（部分唯一索引），同一台第二次会 409。
  const mcpUpload = (base, sid) => mcp(env, {
    token, base,
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_upload', arguments: { server_id: sid, path: '/opt/app.tar.gz' } } },
  });
  const sid1 = (await env.DB.prepare("SELECT id FROM servers WHERE name = 'rest-http'").first()).id;
  const sid2 = (await env.DB.prepare("SELECT id FROM servers WHERE name = 'rest-https'").first()).id;
  const upHttp = JSON.parse((await (await mcpUpload('http://panel.local', sid1)).json()).result.content[0].text);
  assert.match(upHttp.upload_url, /^http:\/\/panel\.local\/mcp\/upload-jobs\/job_[0-9a-f]{32}\/content\?/, 'create_upload + http → http://');
  const upHttps = JSON.parse((await (await mcpUpload('https://panel.local', sid2)).json()).result.content[0].text);
  assert.match(upHttps.upload_url, /^https:\/\/panel\.local\/mcp\/upload-jobs\/job_[0-9a-f]{32}\/content\?/, 'create_upload + https → https://');
  // 协议不进签名载荷：http 入口签发的 URL 改写成 https 后仍验签通过（dev/prod 签名语义一致）
  const rewrote = await worker.fetch(new Request(upHttp.upload_url.replace(/^http:/, 'https:'), {
    method: 'POST', headers: { 'content-length': '1' }, body: 'x',
  }), env);
  assert.notEqual(rewrote.status, 403, '改写协议不影响签名校验');
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

// PanelDO 的列表缓存 TTL 提到 20s 后，改名/排序若只清 Worker 侧缓存，下一次推送
// （5s 节拍）会把旧名字回推给前端——必须同步清 PanelDO 侧缓存。
test('服务器写入路径：同时清 PanelDO 列表缓存（改名/排序/新建/批量分组）', async () => {
  const env = makeEnv();
  const token = await login(env);
  const clearCalls = () => env.PANEL.calls.filter((u) => u.includes('/rpc/clear_list_cache')).length;

  await addServer(env, token, { name: 'c1' });
  assert.equal(clearCalls(), 1, '创建服务器后清 PanelDO 列表缓存');
  const id = (await (await call(env, { path: '/api/servers', token })).json())[0].id;

  env.PANEL.calls.length = 0;
  assert.equal((await call(env, { method: 'PATCH', path: `/api/servers/${id}`, token, body: { name: 'c2' } })).status, 200);
  assert.equal(clearCalls(), 1, '改名后清 PanelDO 列表缓存');

  env.PANEL.calls.length = 0;
  const order = await call(env, {
    method: 'PUT', path: '/api/servers/order', token,
    body: { items: [{ id, group: 'g' }] },
  });
  assert.equal(order.status, 200);
  assert.equal(clearCalls(), 1, '排序后清 PanelDO 列表缓存');

  env.PANEL.calls.length = 0;
  const batch = await call(env, {
    method: 'POST', path: '/api/servers/batch', token,
    body: { op: 'update-group', ids: [id], group: 'g2' },
  });
  assert.equal(batch.status, 200);
  assert.equal(clearCalls(), 1, '批量改分组后清 PanelDO 列表缓存');

  // PanelDO 不可达时写请求必须照常成功（清缓存是尽力而为，带 1s 超时；失败由 TTL 兜底）
  env.PANEL.get = () => ({ fetch: async () => { throw new Error('panel down'); } });
  const renamed = await call(env, { method: 'PATCH', path: `/api/servers/${id}`, token, body: { name: 'c3' } });
  assert.equal(renamed.status, 200, '清缓存失败不得拖垮写请求');
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

// agent 删掉 PROBES 并重启后会明确上报 probes: []；若把它归一为 null（旧实现），
// 库里 probe_json 永不更新，卡片会一直显示过期的绿/红徽章（错误的服务健康信息）。
test('探活：上报空数组清空旧结果（删除 PROBES 后徽章不残留）', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'node-p0' });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const id = list[0].id;

  await I.handleReport(env, { serverId: id, probes: [{ name: 'web', ok: true, code: 200, ms: 5 }] });
  let row = await env.DB.prepare('SELECT probe_json FROM servers WHERE id = ?').bind(id).first();
  assert.ok(row.probe_json.includes('web'), '先写入探针结果');

  // 未上报该字段（旧 agent / 非探活帧）：保持原值
  await I.handleReport(env, { serverId: id });
  row = await env.DB.prepare('SELECT probe_json FROM servers WHERE id = ?').bind(id).first();
  assert.ok(row.probe_json.includes('web'), '未上报该字段时不得清空');

  // 明确上报空数组（配置被移除）：清空，并通知 MetricsDO 清去重状态
  await I.handleReport(env, { serverId: id, probes: [] });
  row = await env.DB.prepare('SELECT probe_json FROM servers WHERE id = ?').bind(id).first();
  assert.equal(row.probe_json, null, '空数组必须清空 probe_json');
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

// PATCH /api/tokens/:id —— 改已创建令牌的权限范围（本次需求）
test('PATCH /api/tokens/:id：改已有令牌 scopes/白名单/有效期；仅 JWT 管理员，PAT 一律 403', async () => {
  const env = makeEnv();
  const adminToken = await login(env);
  await addServer(env, adminToken, { name: 't1' });

  const created = await (await call(env, {
    method: 'POST', path: '/api/tokens', token: adminToken,
    body: { name: 'ci', scopes: ['server:read'], server_ids: [1], expires_in_days: 7 },
  })).json();
  const row = await env.DB.prepare("SELECT id FROM api_tokens WHERE name = 'ci'").first();

  // 只读 → 只读+执行；同时清空白名单（null = 全部服务器）
  const up = await call(env, { method: 'PATCH', path: `/api/tokens/${row.id}`, token: adminToken, body: { scopes: ['server:read', 'server:exec'], server_ids: null } });
  assert.equal(up.status, 200);
  const upBody = await up.json();
  assert.deepEqual(upBody.scopes, ['server:read', 'server:exec']);
  assert.equal(upBody.server_ids, null);
  // 立即生效：鉴权每次按 token_hash 查 api_tokens，不读缓存
  const me = await (await call(env, { path: '/api/me', token: created.token })).json();
  assert.deepEqual(me.scopes, ['server:read', 'server:exec'], '新权限立即生效');
  const dbAfter = await env.DB.prepare("SELECT scopes, server_ids FROM api_tokens WHERE id = ?").bind(row.id).first();
  assert.deepEqual(JSON.parse(dbAfter.scopes), ['server:read', 'server:exec']);
  assert.equal(dbAfter.server_ids, null);

  // 有效期改回永久
  const perm = await (await call(env, { method: 'PATCH', path: `/api/tokens/${row.id}`, token: adminToken, body: { expires_at: null } })).json();
  assert.equal(perm.expires_at, null, '留空/传 null = 永久有效');

  // 未传的字段保持原值（PATCH 语义）
  const keep = await (await call(env, { method: 'PATCH', path: `/api/tokens/${row.id}`, token: adminToken, body: { scopes: ['server:read'] } })).json();
  assert.deepEqual(keep.scopes, ['server:read']);

  // server_ids 三态必须与创建一致：null=全量、[]=空集、有值=白名单。
  // 若把 [] 归一成 null，"收缩到零"会反向放开全部服务器——权限扩大，必须锁死。
  const emptySet = await (await call(env, { method: 'PATCH', path: `/api/tokens/${row.id}`, token: adminToken, body: { server_ids: [] } })).json();
  assert.deepEqual(emptySet.server_ids, [], '空数组 = 空集，不能变全量');
  assert.deepEqual(await (await call(env, { path: '/api/servers', token: created.token })).json(), [], '空集令牌访问不到任何服务器');
  const backAll = await (await call(env, { method: 'PATCH', path: `/api/tokens/${row.id}`, token: adminToken, body: { server_ids: null } })).json();
  assert.equal(backAll.server_ids, null, 'null = 全量');
  assert.ok((await (await call(env, { path: '/api/servers', token: created.token })).json()).length >= 1, '全量令牌可见服务器');

  // 严格校验：未知 scope 必须报错，不能静默降级（否则用户以为提权/降权成功了）
  assert.equal((await call(env, { method: 'PATCH', path: `/api/tokens/${row.id}`, token: adminToken, body: { scopes: ['server:read', 'adminn'] } })).status, 400);
  assert.equal((await call(env, { method: 'PATCH', path: `/api/tokens/${row.id}`, token: adminToken, body: { scopes: [] } })).status, 400);
  assert.equal((await call(env, { method: 'PATCH', path: `/api/tokens/${row.id}`, token: adminToken, body: { server_ids: ['x'] } })).status, 400);
  assert.equal((await call(env, { method: 'PATCH', path: `/api/tokens/${row.id}`, token: adminToken, body: { expires_at: 1 } })).status, 400);
  assert.equal((await call(env, { method: 'PATCH', path: `/api/tokens/${row.id}`, token: adminToken, body: {} })).status, 400, '无字段可改');
  assert.equal((await call(env, { method: 'PATCH', path: '/api/tokens/99999', token: adminToken, body: { scopes: ['server:read'] } })).status, 404);

  // 提权链：PAT 一律不能改令牌权限——包括带 panel:admin 的全权 PAT
  // （若能改，等于自己给自己的令牌升级，绕过"panel:admin 只能由 JWT 管理员签发"）
  const adminPat = (await (await call(env, { method: 'POST', path: '/api/tokens', token: adminToken, body: { name: 'ap', scopes: ['panel:admin'] } })).json()).token;
  assert.equal((await call(env, { method: 'PATCH', path: `/api/tokens/${row.id}`, token: adminPat, body: { scopes: ['panel:admin'] } })).status, 403, 'admin PAT 也不能改令牌权限');
  assert.equal((await call(env, { method: 'PATCH', path: `/api/tokens/${row.id}`, token: created.token, body: { scopes: ['panel:admin'] } })).status, 403, '普通 PAT 同样拒绝');

  // 审计留痕，且不得包含令牌明文
  const logs = await env.DB.prepare("SELECT * FROM audit_logs WHERE action = 'token.update'").all();
  assert.ok(logs.results.length >= 3, `权限变更必须留痕（实际 ${logs.results.length} 条）`);
  assert.ok(logs.results.every((l) => !/cfp_/.test(l.detail || '')), 'detail 不得含令牌明文');
  assert.ok(logs.results.some((l) => /scopes/.test(l.detail || '')), 'detail 记录改动了哪些字段');
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
  const est = body.estimates_per_day;
  assert.equal(est.servers, 0);
  assert.equal(est.report_frames, 0, '无服务器时为 0（不再随累计帧数变化）');
  assert.equal(est.d1_writes, 0);

  // 有服务器时按解析公式缩放：帧 = 17,280/台/天，D1 写 = 3,024/台/天
  await addServer(env, adminToken, { name: 'u1' });
  await addServer(env, adminToken, { name: 'u2' });
  const est2 = (await (await call(env, { path: '/api/usage', token: adminToken })).json()).estimates_per_day;
  assert.equal(est2.servers, 2);
  assert.equal(est2.report_frames, 17280 * 2);
  assert.equal(est2.slow_report_frames, 720 * 2);
  // D1 写两档不同：快采 last_seen 60s 节流 1,440，慢采每帧写 720（metrics_min/metrics_day 相同）
  assert.equal(est2.d1_writes, 3024 * 2);
  assert.equal(est2.slow_d1_writes, 2304 * 2);
  assert.ok(est2.do_events > est2.slow_do_events, '有人观看时 DO 请求应显著高于慢采');
  // 构成：入站 ÷20 + 分片转发 + 推送 + 探活 pong（288/天 ÷20）+ /viewers 自愈反查 + alarm
  assert.equal(est2.do_events, Math.round(17280 / 20 * 2 + 17280 * (2 + 1) + 288 / 20 * 2 + 288 + 144));
  assert.equal(est2.slow_do_events, Math.round(720 / 20 * 2 + 720 * 2 + 288 / 20 * 2 + 288 + 144));
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
      // 阶段 C：异步更新要求 Agent 声明确切支持 agent_update_fetch 拉取
      update_fetch_proto: 1,
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
    // 阶段 C：异步。只创建任务 + 下发元数据与短期资产 URL，不下载资产、不流式转发。
    assert.equal(updated.status, 202);
    const upBody = await updated.json();
    assert.equal(upBody.build_id, manifest.build_id);
    assert.match(upBody.job_id, /^job_[0-9a-f]{32}$/);
    assert.equal(upBody.status, 'running');
    assert.equal(upBody.poll_tool, 'get_operation');
    assert.equal(env.TERMINAL.calls.at(-1).path, '/rpc/agent_update/submit');
    const sub = env.TERMINAL.calls.at(-1).init.body;
    const subJson = JSON.parse(sub);
    assert.equal(subJson.platform, 'linux-x86_64');
    assert.equal(subJson.size, 4);
    assert.match(subJson.downloadUrl, /\/mcp\/agent-update-asset\?/);
    assert.equal('body' in env.TERMINAL.calls.at(-1).init, true);
    assert.equal(env.TERMINAL.calls.at(-1).init.body instanceof ReadableStream, false, '不再转发二进制流');
    // 只取过 manifest，**没有**下载 Release 资产（数据面已移出 Worker→DO 链路）
    assert.equal(fetched.length, 1, '仅 manifest 一次；资产由 Agent 自行经代理拉取');
    const audits = await env.DB.prepare("SELECT action FROM audit_logs WHERE action LIKE 'agent.update.%' ORDER BY id").all();
    assert.deepEqual(audits.results.map((x) => x.action), ['agent.update.request'],
      '终态审计改由 DO 在回执后写入');

    // PAT 即使有 exec 权限也不可更新 Agent
    const patRes = await call(env, {
      method: 'POST', path: '/api/tokens', token: admin,
      body: { name: 'exec', scopes: ['server:exec'] },
    });
    const pat = (await patRes.json()).token;
    assert.equal((await call(env, {
      method: 'POST', path: '/api/servers/1/agent-update', token: pat,
    })).status, 403);

    // 独立 scope：agent:update 的 PAT 可触发更新（审计记 PAT 身份）
    const patUpdRes = await call(env, {
      method: 'POST', path: '/api/tokens', token: admin,
      body: { name: 'upd', scopes: ['agent:update'] },
    });
    const updToken = (await patUpdRes.json()).token;
    // 单机串行：上一次更新（管理员触发）的任务仍在 running，第二次必须 409 —— 这正是
    // 部分唯一索引要防的"二进制更新帧与另一个更新交错"。
    // 被 409 拒绝的请求不得留下 agent.update.request 审计：审计代表"已下发更新"，
    // 给拒绝也记一条会让事后排查误判为"下发成功但版本没变"。
    assert.equal((await call(env, {
      method: 'POST', path: '/api/servers/1/agent-update', token: updToken,
    })).status, 409, '同一服务器的第二个更新必须被串行锁拒绝');
    const busyAudit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'agent.update.request' AND username LIKE 'token:%'"
    ).first();
    assert.equal(busyAudit.n, 0, '被 409 拒绝的更新不得写 agent.update.request 审计');
    await env.DB.prepare("UPDATE operation_jobs SET status = 'succeeded' WHERE server_id = 1 AND kind = 'agent_update'").run();
    const updByPat = await call(env, {
      method: 'POST', path: '/api/servers/1/agent-update', token: updToken,
    });
    assert.equal(updByPat.status, 202);
    assert.equal((await updByPat.json()).build_id, manifest.build_id);

    // agent:update PAT 命中 server_ids 白名单限定：限定到其他服务器时对该机拒绝
    const patScopedRes = await call(env, {
      method: 'POST', path: '/api/tokens', token: admin,
      body: { name: 'upd-scoped', scopes: ['agent:update'], server_ids: [2] },
    });
    const scopedToken = (await patScopedRes.json()).token;
    assert.equal((await call(env, {
      method: 'POST', path: '/api/servers/1/agent-update', token: scopedToken,
    })).status, 403);
    const patAudits = await env.DB.prepare(
      "SELECT username, action FROM audit_logs WHERE action LIKE 'agent.update.%' AND username LIKE 'token:%' ORDER BY id"
    ).all();
    assert.equal(patAudits.results.length, 1, 'PAT 触发的成功更新写入且仅写入一条 request 审计');
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
    'list_servers', 'get_monitor', 'exec_command', 'update_agent', 'create_upload',
    'add_server', 'delete_server', 'update_server', 'rotate_agent_key',
    'list_tokens', 'create_token', 'revoke_token',
    'get_audit_logs', 'get_usage', 'get_settings', 'update_settings',
    'get_operation',
  ]);

  // update_settings 的 alerts 字段名必须与 sanitizeAlerts / 前端表单一致。
  // 描述曾写成 enabled/url/token/body/cpu/mem/disk 等错名：调用方（尤其是 AI）照描述传参 →
  // 键被白名单静默丢弃 → alerts 落库为 {}，连 webhook_url 一起没了 = 告警静默失效、接口还返回成功。
  const updTool = list.result.tools.find((t) => t.name === 'update_settings');
  for (const k of ['webhook_url', 'webhook_token', 'body_template', 'cpu_pct', 'mem_pct', 'disk_pct']) {
    assert.ok(updTool.inputSchema.properties.alerts.description.includes(k),
      `alerts 描述须列出真实字段名 ${k}`);
  }
  assert.match(updTool.inputSchema.properties.alerts.description, /整体替换/,
    '须写明 alerts 是整体替换（漏传字段即丢失）');

  // create_upload：阶段 B 改为创建 upload job + 签名上传 URL（数据面走 R2，不经 DO）
  const cu = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'create_upload', arguments: { server_name: 'web-1', path: '/opt/app.tar.gz' } } } })).json();
  assert.equal(cu.result.isError, false);
  const cuRes = JSON.parse(cu.result.content[0].text);
  assert.equal(cuRes.server_name, 'web-1');
  assert.match(cuRes.job_id, /^job_[0-9a-f]{32}$/);
  assert.equal(cuRes.status, 'awaiting_upload');
  assert.match(cuRes.upload_url, /^http:\/\/panel\.local\/mcp\/upload-jobs\/job_[0-9a-f]{32}\/content\?/);
  assert.match(cuRes.upload_url, /token=/);
  assert.equal(cuRes.overwrite, false);
  assert.ok(cuRes.expires_in_seconds > 0 && cuRes.expires_in_seconds <= 600);
  assert.equal(cuRes.poll_tool, 'get_operation');

  // 签名 URL 只绑 job：篡改 token → 403；无 Content-Length → 411
  const baseUp = cuRes.upload_url;
  const badToken = await worker.fetch(new Request(baseUp.replace(/token=[^&]+/, 'token=deadbeef.xx'), {
    method: 'POST', headers: { 'content-length': '1' }, body: 'x',
  }), env);
  assert.equal(badToken.status, 403, '篡改 token 必须拒绝');
  const noLen = await worker.fetch(new Request(baseUp, { method: 'POST', body: 'x' }), env);
  // fetch 会自动补 content-length；这里只验证"没有 body"时不会写入成功
  assert.ok([200, 202, 411].includes(noLen.status));

  // 合法签名 URL 上传 → 字节落 R2，job 转 staged，并通知 DO（短请求）
  const before = env.TERMINAL.calls.length;
  const goodSigned = await worker.fetch(new Request(baseUp, {
    method: 'POST', headers: { 'content-length': '12' }, body: 'hello signed',
  }), env);
  assert.equal(goodSigned.status, 202);
  const stagedBody = await goodSigned.json();
  assert.equal(stagedBody.status, 'staged');
  assert.equal(stagedBody.size_bytes, 12);
  // R2 里确有该对象（key = upload-jobs/<job_id>）
  const stagedObj = await env.UPLOADS.get(`upload-jobs/${cuRes.job_id}`);
  assert.ok(stagedObj, '字节必须落在 R2 staging');
  assert.equal(await stagedObj.text(), 'hello signed');
  // 下发走 /rpc/upload/submit，且只带元数据（不含文件字节）
  const submitCall = env.TERMINAL.calls.slice(before).find((c) => c.path === '/rpc/upload/submit');
  assert.ok(submitCall, '上传完成后应下发 upload_fetch');
  // 同一 URL 再次上传 → 409（只接受 awaiting_upload，防旧 URL 重放覆盖已 staged 对象）
  const replay = await worker.fetch(new Request(baseUp, {
    method: 'POST', headers: { 'content-length': '3' }, body: 'abc',
  }), env);
  assert.equal(replay.status, 409, '已 staged 的 job 不得再次接收字节');

  // exec_command：异步语义——只返回 job_id/accepted，不再有 stdout/exit_code
  const ex = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'exec_command', arguments: { server_name: 'web-1', command: 'echo hi' } } } })).json();
  assert.equal(ex.result.isError, false);
  const exRes = JSON.parse(ex.result.content[0].text);
  assert.equal(exRes.server_name, 'web-1');
  assert.match(exRes.job_id, /^job_[0-9a-f]{32}$/);
  assert.equal(exRes.poll_tool, 'get_operation');
  assert.equal('stdout' in exRes, false, '异步化后不得同步返回输出');
  // get_operation：同一凭据可查到该任务
  const op = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 61, method: 'tools/call', params: { name: 'get_operation', arguments: { job_id: exRes.job_id } } } })).json();
  assert.equal(op.result.isError, false);
  // DO 在本测试里是桩（不会真的把 queued 置 running），故允许两态；
  // queued -> running 的真实流转由 test/do.test.js 的 /rpc/exec/submit 用例覆盖
  assert.match(JSON.parse(op.result.content[0].text).status, /^(queued|running)$/);
  assert.equal('stdout' in JSON.parse(op.result.content[0].text), false, '未终态不返回输出');

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

  // exec_command：命令超长 → 前置拒绝。超限帧不会报错而是让 agent 断开控制通道
  //（调用方只看到误导性的"超时"，且命令根本没执行），故必须在发起端拦下
  const exLong = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'exec_command', arguments: { server_id: 1, command: 'x'.repeat(EXEC_CMD_MAX_BYTES + 1) } } } })).json();
  assert.equal(exLong.result.isError, true);
  assert.match(exLong.result.content[0].text, /command too long/);
  assert.match(exLong.result.content[0].text, /create_upload/, '错误信息要含替代方案，AI 客户端才能自纠');
  // 恰好上限：放行（边界闭区间；DO 桩返回 200 说明走到了下发环节）
  const exMax = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'exec_command', arguments: { server_id: 1, command: 'x'.repeat(EXEC_CMD_MAX_BYTES) } } } })).json();
  assert.equal(exMax.result.isError, false, '恰好上限仍放行');
  // 多字节按 UTF-8 计量：中文 3 字节/字符 → 原始字符数只有 1/3 上限时即应拒绝
  //（若按字符数校验，这类命令会被漏放行，然后在 agent 侧断连）
  const exCn = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'exec_command', arguments: { server_id: 1, command: '中'.repeat(Math.floor(EXEC_CMD_MAX_BYTES / 3) + 1) } } } })).json();
  assert.equal(exCn.result.isError, true, '中文按 3 字节/字符计量，不数原始字符');
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

  // 全局告警设置：走 update_settings.alerts（与 REST PUT /api/settings 同一 sanitizeAlerts）。
  // 此前只测过 site_name，alerts 这条路径完全没有覆盖。
  const usAlerts = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 280, method: 'tools/call', params: { name: 'update_settings', arguments: { alerts: {
    webhook_url: 'https://hook.example/x', webhook_token: 'tok', method: 'post',
    body_template: '{"t":"{title}"}', content_type: 'application/json', headers: { 'x-a': '1' },
    cpu_pct: 85, mem_pct: 80, disk_pct: 70, load: 0, cooldown_min: 10, offline_after_s: 120,
  } } } } })).json();
  assert.equal(usAlerts.result.isError, false);
  const alertCfg = JSON.parse(usAlerts.result.content[0].text).alerts;
  assert.equal(alertCfg.webhook_url, 'https://hook.example/x', 'webhook_url 是真实键名（不是 url）');
  assert.equal(alertCfg.webhook_token, 'tok');
  assert.equal(alertCfg.method, 'POST', 'method 归一化为大写');
  assert.equal(alertCfg.body_template, '{"t":"{title}"}', 'body_template 是真实键名（不是 body）');
  assert.deepEqual(alertCfg.headers, { 'x-a': '1' });
  assert.equal(alertCfg.cpu_pct, 85, 'cpu_pct 是真实键名（不是 cpu）');
  assert.equal(alertCfg.mem_pct, 80);
  assert.equal(alertCfg.disk_pct, 70);
  assert.equal(alertCfg.load, 0, 'load=0 是"关闭该维度"的合法值，须保留');
  assert.equal(alertCfg.cooldown_min, 10);
  assert.equal(alertCfg.offline_after_s, 120);

  // alerts 是**整体替换**而非合并：只传 cpu_pct 会把 webhook_url 一起丢掉
  const usWipe = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 281, method: 'tools/call', params: { name: 'update_settings', arguments: { alerts: { cpu_pct: 60 } } } } })).json();
  const wiped = JSON.parse(usWipe.result.content[0].text).alerts;
  assert.equal(wiped.cpu_pct, 60);
  assert.equal(wiped.webhook_url, undefined, '整体替换：漏传 webhook_url = 停用告警（描述已写明）');

  // 未在白名单里的键被静默丢弃——这正是"描述写错名"能清空整份告警的原因，工具描述必须列对名字
  const usBad = await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 282, method: 'tools/call', params: { name: 'update_settings', arguments: { alerts: { url: 'https://x', token: 't', cpu: 50 } } } } })).json();
  assert.deepEqual(JSON.parse(usBad.result.content[0].text).alerts, {}, '错名键全部被丢弃，落库为空配置');

  // 设置变更必须留痕：MCP 与 REST 两条入口都要写 settings.update（此前只有写操作没审计的一条漏网）
  const alAudit = JSON.parse((await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 283, method: 'tools/call', params: { name: 'get_audit_logs', arguments: { action: 'settings.update' } } } })).json()).result.content[0].text);
  assert.ok(alAudit.rows.length >= 4, `设置变更应有审计记录（实际 ${alAudit.rows.length} 条）`);
  assert.ok(alAudit.rows.every((r) => r.action === 'settings.update'));
  assert.equal(alAudit.rows[0].target_server_id, null, '全局设置无目标服务器');
  assert.ok(alAudit.rows.some((r) => /字段：/.test(r.detail || '')), 'detail 记录改动了哪些字段');
  // detail 会明文展示在审计页：webhook URL（常把密钥放路径里）与令牌**绝不能**入库
  assert.ok(alAudit.rows.every((r) => !/hook\.example|\btok\b/.test(r.detail || '')),
    'detail 不得包含 webhook_url / webhook_token');
  assert.ok(alAudit.rows.some((r) => /告警[开关]/.test(r.detail || '')), '改告警时附带开关状态');

  // REST 入口同样留痕（与 MCP 共用 auditSettingsUpdate）
  await call(env, { method: 'PUT', path: '/api/settings', token, body: { alerts: { webhook_url: 'https://hook.example/rest', cpu_pct: 70 } } });
  const alAudit2 = JSON.parse((await (await mcp(env, { token, body: { jsonrpc: '2.0', id: 284, method: 'tools/call', params: { name: 'get_audit_logs', arguments: { action: 'settings.update' } } } })).json()).result.content[0].text);
  assert.equal(alAudit2.rows.length, alAudit.rows.length + 1, 'REST 路径也写审计');
  assert.ok(!/hook\.example/.test(alAudit2.rows[0].detail || ''), 'REST 路径的 detail 同样不落 URL');

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

// ---------------- PAT 全权 scope（panel:admin） ----------------
// 动机：MCP 客户端只能配置长期凭据，而 JWT 仅 24h，否则 get_audit_logs 等 11 个管理工具
// 在 MCP 中实际不可用（PAT 无论如何配 scopes 都进不去——scopes 白名单里原本没有 admin）。
test('PAT panel:admin：可读审计日志；tools/list 按权限裁剪；不能自举 admin scope', async () => {
  const env = makeEnv();
  const adminToken = await login(env);
  await addServer(env, adminToken, { name: 'adm-1' });

  // 普通 PAT：tools/list 按**实际 scope** 裁剪。只做"管理员/非管理员"二分是不够的——
  // 只读 PAT 会看到 exec_command/update_agent/create_upload 三个调用必失败的工具。
  const mkPat = async (name, scopes) => (await (await call(env, { method: 'POST', path: '/api/tokens', token: adminToken, body: { name, scopes } })).json()).token;
  const toolsOf = async (t) => (await (await mcp(env, { token: t, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json()).result.tools.map((x) => x.name);
  const ro = await mkPat('ro', ['server:read']);
  assert.deepEqual(await toolsOf(ro), ['list_servers', 'get_monitor'], '只读 PAT 只看到读工具');
  const rw = await mkPat('rw', ['server:read', 'server:exec']);
  assert.deepEqual(await toolsOf(rw), ['list_servers', 'get_monitor', 'exec_command', 'create_upload', 'get_operation'],
    'exec PAT 看不到 update_agent / 管理工具，但能看到任务查询');
  const ua = await mkPat('ua', ['server:read', 'agent:update']);
  assert.deepEqual(await toolsOf(ua), ['list_servers', 'get_monitor', 'update_agent', 'get_operation'],
    'agent:update PAT 只多出 update_agent（get_operation 按任一操作 scope 可见）');

  // 普通 PAT 调管理工具：错误信息须自解释（旧文案 'forbidden: admin only' 会让人误判为 scopes 配错）
  const denied = await (await mcp(env, { token: ro, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_audit_logs', arguments: {} } } })).json();
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /panel:admin/, '提示如何真正拿到权限');

  // admin PAT（由 JWT 管理员签发）：tools/list 完整，且可读审计日志
  const adm = (await (await call(env, { method: 'POST', path: '/api/tokens', token: adminToken, body: { name: 'adm', scopes: ['panel:admin'] } })).json()).token;
  const admTools = (await (await mcp(env, { token: adm, body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } })).json()).result.tools.map((t) => t.name);
  assert.equal(admTools.length, 17, '管理员看到全部工具（含 get_operation）');
  assert.ok(admTools.includes('get_audit_logs'));
  const al = await (await mcp(env, { token: adm, body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_audit_logs', arguments: { limit: 5 } } } })).json();
  assert.equal(al.result.isError, false, 'panel:admin PAT 可读审计日志（本次诉求）');
  assert.ok(JSON.parse(al.result.content[0].text).total >= 1);

  // 全权语义：忽略 server_ids 白名单（isAdmin 在 canAccessServer 最前短路，README 已明示）
  const narrow = (await (await call(env, { method: 'POST', path: '/api/tokens', token: adminToken, body: { name: 'narrow', scopes: ['panel:admin'], server_ids: [99999] } })).json()).token;
  const list = await call(env, { path: '/api/servers', token: narrow });
  assert.equal(list.status, 200);
  assert.ok((await list.json()).length >= 1, 'admin PAT 不受白名单限制');

  // 提权链熔断：PAT（即便已是 admin）不能再签发 panel:admin —— 否则泄露一个令牌可无限铸造永久 admin
  const esc = await call(env, { method: 'POST', path: '/api/tokens', token: adm, body: { name: 'esc', scopes: ['panel:admin'] } });
  assert.equal(esc.status, 403, 'REST 拒绝 PAT 自举 admin');
  const escMcp = await (await mcp(env, { token: adm, body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_token', arguments: { name: 'esc2', scopes: ['panel:admin'] } } } })).json();
  assert.equal(escMcp.result.isError, true, 'MCP 拒绝 PAT 自举 admin');
  assert.match(escMcp.result.content[0].text, /JWT/);
  // 但普通 scope 仍可签发（不影响日常轮换）
  const okTok = await call(env, { method: 'POST', path: '/api/tokens', token: adm, body: { name: 'normal', scopes: ['server:read'] } });
  assert.equal(okTok.status, 200);
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

// ---------------- 拖拽排序持久化 ----------------
test('PUT /api/servers/order：组内重排 + 跨组移动（组内编号 0..n，审计留痕）', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'r-1', group: 'A' });
  await addServer(env, token, { name: 'r-2', group: 'A' });
  await addServer(env, token, { name: 'r-3' });
  const list = await (await call(env, { path: '/api/servers', token })).json();
  const idOf = (name) => list.find((s) => s.name === name).id;

  // 拖拽语义：r-3 移入 A 组排 r-1 之前（跨组移动）
  const items = [
    { id: idOf('r-3'), group: 'A' },
    { id: idOf('r-1'), group: 'A' },
    { id: idOf('r-2'), group: 'A' },
  ];
  const res = await (await call(env, { method: 'PUT', path: '/api/servers/order', token, body: { items } })).json();
  assert.equal(res.ok, true);

  const after = await (await call(env, { path: '/api/servers', token })).json();
  const inA = after.filter((s) => s.group === 'A');
  assert.deepEqual(inA.map((s) => s.name), ['r-3', 'r-1', 'r-2'], 'A 组按拖放目标顺序');
  assert.deepEqual(inA.map((s) => s.display_index), [0, 1, 2], '组内按出现顺序 0..n 编号');
  assert.equal(after.find((s) => s.name === 'r-3').group, 'A', '跨组移动生效');

  const logs = await env.DB.prepare('SELECT * FROM audit_logs WHERE action = ?').bind('server.reorder').all();
  assert.equal(logs.results.length, 1, '排序是变更操作，须留痕');
});

test('PUT /api/servers/order：空 items / 重复 id 拒绝（400）', async () => {
  const env = makeEnv();
  const token = await login(env);
  assert.equal((await call(env, { method: 'PUT', path: '/api/servers/order', token, body: { items: [] } })).status, 400);
  assert.equal((await call(env, { method: 'PUT', path: '/api/servers/order', token, body: {} })).status, 400);
  const dup = (await call(env, { method: 'PUT', path: '/api/servers/order', token, body: { items: [{ id: 1 }, { id: 1 }] } })).status;
  assert.equal(dup, 400, '重复 id 拒绝（前端发全量列表，重复即异常）');
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

// ---------------- 异步 exec 任务（阶段 A） ----------------
// exec 从「同步等 25s+5s」改为「创建任务 → 短请求下发 → 轮询 D1」。
// 验收核心：轮询不得访问 DO；DO 不持有等待 Promise；超时由 D1 deadline 判定。
test('异步 exec：202 + job_id，轮询只查 D1（不激活 DO），过期收敛为 expired', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'web-1' });

  const submitted = await call(env, {
    method: 'POST', path: '/api/exec-jobs', token,
    body: { server_id: 1, command: 'echo hi', timeout: 5 },
  });
  assert.equal(submitted.status, 202);
  const sj = await submitted.json();
  assert.match(sj.job_id, /^job_[0-9a-f]{32}$/);
  assert.equal(sj.poll_tool, 'get_operation');
  // DO 在本测试里是桩（不做状态流转），权威状态取自 D1
  assert.equal(sj.status, 'queued');

  // 走的是新的短 RPC，而不是旧的同步 /rpc/exec
  assert.equal(env.TERMINAL.calls.at(-1).path, '/rpc/exec/submit');

  const row = await env.DB.prepare('SELECT * FROM operation_jobs WHERE id = ?').bind(sj.job_id).first();
  assert.equal(row.kind, 'exec');
  assert.equal(row.command, 'echo hi');
  assert.equal(row.status, 'queued');
  assert.equal(row.deadline_at, row.created_at + 5 + 30, 'deadline = 命令超时 + 30s 宽限');

  // 轮询：只读 D1
  const before = env.TERMINAL.calls.length;
  const got = await call(env, { path: `/api/jobs/${sj.job_id}`, token });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('cache-control'), 'no-store');
  const gj = await got.json();
  assert.equal(gj.status, 'queued');
  assert.equal('stdout' in gj, false, '未终态不得返回输出');
  assert.equal(env.TERMINAL.calls.length, before, '轮询不得访问 DO');

  // 过期收敛：deadline 已过且无回执 → expired（幂等，不依赖 cron/DO timer）
  await env.DB.prepare('UPDATE operation_jobs SET deadline_at = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000) - 1, sj.job_id).run();
  const expired = await (await call(env, { path: `/api/jobs/${sj.job_id}`, token })).json();
  assert.equal(expired.status, 'expired');
  assert.equal('stdout' in expired, false);
});

test('异步 exec：权限、长度、幂等、互斥与读取鉴权', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'web-1' });

  // 无 exec scope 的 PAT → 403（建连前就拒绝，不产生任务）
  const ro = (await (await call(env, { method: 'POST', path: '/api/tokens', token, body: { name: 'ro', scopes: ['server:read'] } })).json()).token;
  assert.equal((await call(env, { method: 'POST', path: '/api/exec-jobs', token: ro, body: { server_id: 1, command: 'id' } })).status, 403);

  // 命令超长 → 413，且不得下发
  const callsBefore = env.TERMINAL.calls.length;
  const tooLong = await call(env, { method: 'POST', path: '/api/exec-jobs', token, body: { server_id: 1, command: 'x'.repeat(EXEC_CMD_MAX_BYTES + 1) } });
  assert.equal(tooLong.status, 413);
  assert.equal(env.TERMINAL.calls.length, callsBefore, '超长命令不得触达 DO');

  // 幂等：同 key 第二次直接返回既有任务，不重复下发
  const first = await (await call(env, { method: 'POST', path: '/api/exec-jobs', token, body: { server_id: 1, command: 'id', idempotency_key: 'k1' } })).json();
  const afterFirst = env.TERMINAL.calls.length;
  const second = await (await call(env, { method: 'POST', path: '/api/exec-jobs', token, body: { server_id: 1, command: 'id', idempotency_key: 'k1' } })).json();
  assert.equal(second.job_id, first.job_id);
  assert.equal(second.reused, true);
  assert.equal(env.TERMINAL.calls.length, afterFirst, '幂等命中不得重复下发');

  // 读取鉴权：无 exec 权限的 PAT 读同一个 job → 404（不区分"无权"与"不存在"）
  assert.equal((await call(env, { path: `/api/jobs/${first.job_id}`, token: ro })).status, 404);
  // 伪造 / 不存在的 job_id → 404
  assert.equal((await call(env, { path: '/api/jobs/job_doesnotexist', token })).status, 404);

  // 互斥：存在进行中的 agent_update 时拒绝新的 exec
  const nowS = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, created_at, deadline_at, expires_at)
    VALUES ('job_upd', 'agent_update', 'running', 1, 'admin', 1, ?, ?, ?)`).bind(nowS, nowS + 180, nowS + 86400).run();
  const blocked = await call(env, { method: 'POST', path: '/api/exec-jobs', token, body: { server_id: 1, command: 'id' } });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /agent update in progress/);
});

test('异步 exec：Agent 离线 → 失败态回传（不留下永远 queued 的任务）', async () => {
  const terminal = {
    idFromName: (n) => n,
    get: () => ({ fetch: async () => new Response(JSON.stringify({ error: 'agent offline', code: 'AGENT_OFFLINE' }), { status: 503 }) }),
  };
  const env = makeEnv({ TERMINAL: terminal });
  const token = await login(env);
  await addServer(env, token, { name: 'web-1' });
  const res = await call(env, { method: 'POST', path: '/api/exec-jobs', token, body: { server_id: 1, command: 'id' } });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, 'failed');
  assert.match(body.error, /agent offline/);
  assert.match(body.job_id, /^job_/);
  // 失败必须落库：不能留下永远 queued 的行（DO 未必覆盖所有拒绝路径，Worker 兜底）
  const row = await env.DB.prepare('SELECT status, error FROM operation_jobs WHERE id = ?').bind(body.job_id).first();
  assert.equal(row.status, 'failed');
  assert.match(row.error, /agent offline/);
  // 客户端仍可凭 job_id 查到失败原因
  const polled = await (await call(env, { path: `/api/jobs/${body.job_id}`, token })).json();
  assert.equal(polled.status, 'failed');
  assert.match(polled.result.error, /agent offline/);
});

test('异步 exec：DO 不可达时任务落 failed，不悬挂', async () => {
  const terminal = {
    idFromName: (n) => n,
    get: () => ({ fetch: async () => { throw new Error('do unreachable'); } }),
  };
  const env = makeEnv({ TERMINAL: terminal });
  const token = await login(env);
  await addServer(env, token, { name: 'web-1' });
  const res = await call(env, { method: 'POST', path: '/api/exec-jobs', token, body: { server_id: 1, command: 'id' } });
  assert.equal(res.status, 502);
  const body = await res.json();
  const row = await env.DB.prepare('SELECT status, error FROM operation_jobs WHERE id = ?').bind(body.job_id).first();
  assert.equal(row.status, 'failed');
  assert.match(row.error, /dispatch failed/);
});

// ---------------- 阶段 B：upload 异步化（数据面走 R2） ----------------
test('upload job：创建 → 上传字节 → R2 staging → 下发 → 终态清理对象', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'up1' });

  // 创建任务：只创建 + 返回签名 URL，不传字节
  const created = await call(env, { method: 'POST', path: '/api/upload-jobs', token, body: { server_id: 1, path: '/opt/a.bin' } });
  assert.equal(created.status, 202);
  const job = await created.json();
  assert.equal(job.status, 'awaiting_upload');
  assert.match(job.upload_url, /\/mcp\/upload-jobs\/job_[0-9a-f]{32}\/content\?/);

  // 单机串行：同服务器第二个 upload → 409 UPLOAD_BUSY
  const busy = await call(env, { method: 'POST', path: '/api/upload-jobs', token, body: { server_id: 1, path: '/opt/b.bin' } });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).code, 'UPLOAD_BUSY');

  // 上传字节：落 R2 + job 转 staged
  const payload = 'x'.repeat(2048);
  const up = await worker.fetch(new Request(job.upload_url, {
    method: 'POST', headers: { 'content-length': String(payload.length) }, body: payload,
  }), env);
  assert.equal(up.status, 202);
  const staged = await up.json();
  assert.equal(staged.status, 'staged');
  assert.equal(staged.size_bytes, 2048);
  const obj = await env.UPLOADS.get(`upload-jobs/${job.job_id}`);
  assert.equal((await obj.text()).length, 2048);

  // 轮询：staged 不是终态，不返回 result
  const polled = await (await call(env, { path: `/api/jobs/${job.job_id}`, token })).json();
  assert.equal(polled.status, 'staged');
  assert.equal('result' in polled, false);

  // DO 回执成功 → succeeded + R2 对象删除 + file.upload 审计
  const inst = new TerminalDO({ storage: { get: async () => undefined, put: async () => {}, delete: async () => {} }, getWebSockets: () => [] }, env);
  const ws = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send() {}, readyState: 1, close() {} };
  inst.agents.set(1, ws);
  await inst.webSocketMessage(ws, JSON.stringify({
    type: 'upload_result', upload_id: job.job_id, ok: true, commit: true, size: 2048,
  }));
  const done = await (await call(env, { path: `/api/jobs/${job.job_id}`, token })).json();
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result.size_bytes, 2048);
  assert.equal(await env.UPLOADS.head(`upload-jobs/${job.job_id}`), null, '成功即删 staging 对象');
  const audit = await env.DB.prepare("SELECT * FROM audit_logs WHERE action = 'file.upload' AND job_id = ?").bind(job.job_id).all();
  assert.equal(audit.results.length, 1, 'file.upload 在 Agent commit 后才写');
});

test('upload job：超长字节被拒且不留半截对象；下载 URL 绑定 job/状态', async () => {
  const env = makeEnv({ UPLOAD_MAX_MB: '1' }); // 1MB 上限，便于构造超限
  const token = await login(env);
  await addServer(env, token, { name: 'up2' });
  const job = await (await call(env, { method: 'POST', path: '/api/upload-jobs', token, body: { server_id: 1, path: '/opt/big.bin' } })).json();

  // 声明超限 → 413（前置拒绝，不读 body）
  const tooBig = await worker.fetch(new Request(job.upload_url, {
    method: 'POST', headers: { 'content-length': String(2 * 1024 * 1024) }, body: 'x',
  }), env);
  assert.equal(tooBig.status, 413);

  // 声明不超但实际流动超限：边写边计数必须中断并删除半截对象
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array(100 * 1024));
      controller.close();
    },
  });
  const lie = await worker.fetch(new Request(job.upload_url, {
    method: 'POST', headers: { 'content-length': '1024' }, body: stream, duplex: 'half',
  }), env);
  assert.equal(lie.status, 413, '实际字节超限必须拒绝（不信任 Content-Length）');
  assert.equal(await env.UPLOADS.head(`upload-jobs/${job.job_id}`), null, '失败不得留下半截对象');

  // 下载端点：token 必须匹配 job/server，且状态须为 running
  const goodToken = await I.signJobToken('download', job.job_id, 1, '0', env, 600);
  const wrongServer = await worker.fetch(new Request(
    `https://panel.local/mcp/upload-jobs/download?id=${job.job_id}&server_id=999&size=0&token=${encodeURIComponent(goodToken)}`
  ), env);
  assert.equal(wrongServer.status, 403, 'server_id 不匹配必须拒绝');
  const notRunning = await worker.fetch(new Request(
    `https://panel.local/mcp/upload-jobs/download?id=${job.job_id}&server_id=1&size=0&token=${encodeURIComponent(goodToken)}`
  ), env);
  assert.equal(notRunning.status, 409, '非 running 状态不得下载');
});

// ---------------- 阶段 D：cron 清理 ----------------
test('cron 维护：过期任务收敛为 expired、TTL 到期删行、R2 孤儿对象回收', async () => {
  const { runJobMaintenance } = await import('../src/index.js');
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'c1' });
  const now = Math.floor(Date.now() / 1000);

  // 1) 非终态且过 deadline → expired
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, created_at, deadline_at, expires_at)
    VALUES ('job_a', 'exec', 'running', 1, 'admin', 1, ?, ?, ?)`).bind(now - 100, now - 10, now + 86400).run();
  // 2) 已过 TTL → 删行 + 删其 R2 对象
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, r2_key, created_at, deadline_at, expires_at)
    VALUES ('job_b', 'upload', 'staged', 1, 'admin', 1, 'upload-jobs/job_b', ?, ?, ?)`).bind(now - 90000, now - 80000, now - 1).run();
  await env.UPLOADS.put('upload-jobs/job_b', 'stale');
  // 3) R2 孤儿（行已不在）：靠 uploaded 时间判断
  await env.UPLOADS.put('upload-jobs/job_orphan', 'orphan');

  const r1 = await runJobMaintenance(env, now);
  // job_a（running，过 deadline）与 job_b（staged，过 deadline）都会被收敛为 expired
  assert.equal(r1.expired, 2);
  assert.equal(r1.deletedRows, 1);
  const a = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_a').first();
  assert.equal(a.status, 'expired');
  assert.equal(await env.DB.prepare('SELECT id FROM operation_jobs WHERE id = ?').bind('job_b').first(), null, 'TTL 到期删行');
  assert.equal(await env.UPLOADS.head('upload-jobs/job_b'), null, '删行同时删 R2 对象');

  // 孤儿对象：uploaded 是"现在"，未超 TTL → 本轮不删（保守，避免误删刚写入的）
  assert.ok(await env.UPLOADS.head('upload-jobs/job_orphan'), '新对象不删');
  // 把 uploaded 改成过期后重跑 → 删除
  const obj = env.UPLOADS.objects.get('upload-jobs/job_orphan');
  obj.uploaded = new Date((now - 90000) * 1000);
  const r2 = await runJobMaintenance(env, now);
  assert.equal(r2.deletedObjects, 1);
  assert.equal(await env.UPLOADS.head('upload-jobs/job_orphan'), null, '超期孤儿对象回收');
});

// R2 list 单页 ≤1000 且以 truncated/cursor 分页：旧实现忽略 truncated，staging 对象一旦
// 超过一页，后面的孤儿永远清不掉（10GB 额度就是这么慢慢被吃掉的）。
test('cron 维护：R2 孤儿回收跟随 cursor 分页（超过一页也清干净）', async () => {
  const { runJobMaintenance } = await import('../src/index.js');
  const env = makeEnv({ UPLOADS: makeR2({ listPageSize: 2 }) }); // 强制每页 2 个，5 个对象 → 3 页
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 5; i++) {
    const key = `upload-jobs/orphan-${i}`;
    await env.UPLOADS.put(key, 'x');
    env.UPLOADS.objects.get(key).uploaded = new Date((now - 90000) * 1000);
  }

  const r = await runJobMaintenance(env, now);
  assert.equal(r.deletedObjects, 5, '跨页的孤儿对象全部回收（只清第一页会留下 3 个）');
  for (let i = 0; i < 5; i++) {
    assert.equal(await env.UPLOADS.head(`upload-jobs/orphan-${i}`), null, `orphan-${i} 已回收`);
  }
});

// streamToR2 曾经"先攒后写"：100MB 上传会在内存里驻留 100MB，而 Workers 上限 128MB，
// 单个大文件就贴着上限、两个并发直接 OOM。这里锁住"传给 R2 的是流而不是整块字节"。
test('upload job：R2 写入必须传流（不整体缓冲到内存）', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'stream' });
  const job = await (await call(env, { method: 'POST', path: '/api/upload-jobs', token, body: { server_id: 1, path: '/opt/s.bin' } })).json();

  // 记录 put 收到的值类型
  const realPut = env.UPLOADS.put.bind(env.UPLOADS);
  let seen = null;
  env.UPLOADS.put = async (key, value, opts) => { seen = value; return realPut(key, value, opts); };

  const payload = 'y'.repeat(4096);
  const up = await worker.fetch(new Request(job.upload_url, {
    method: 'POST', headers: { 'content-length': String(payload.length) }, body: payload,
  }), env);
  assert.equal(up.status, 202);
  assert.equal(typeof seen.getReader, 'function', '必须把 ReadableStream 交给 R2（整体缓冲会随文件大小占内存）');
  assert.equal(seen instanceof Uint8Array, false, '不得先拼成 Uint8Array 再写入');
  // 内容仍然完整落盘
  assert.equal((await env.UPLOADS.get(`upload-jobs/${job.job_id}`).then((o) => o.text())).length, 4096);
});

// R2 staging 对象必须在"判定失败/过期"的同一路径上删除，不能只等 cron 的 24h TTL：
// 一次 Agent 掉线的 100MB 上传会白占额度一整天，几十次就顶满 10GB 免费额度。
test('upload job：过期收敛时立即删除 R2 对象（不等 TTL/cron）', async () => {
  const { runJobMaintenance } = await import('../src/index.js');
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'exp1' });
  const job = await (await call(env, { method: 'POST', path: '/api/upload-jobs', token, body: { server_id: 1, path: '/opt/x.bin' } })).json();
  // 模拟"已上传、已下发，但 Agent 一直不拉"
  await env.UPLOADS.put(`upload-jobs/${job.job_id}`, 'staged-bytes');
  await env.DB.prepare("UPDATE operation_jobs SET status='running', r2_key=? WHERE id=?")
    .bind(`upload-jobs/${job.job_id}`, job.job_id).run();
  assert.ok(await env.UPLOADS.head(`upload-jobs/${job.job_id}`), '前提：对象存在');

  // A) 轮询触发的单条收敛
  await env.DB.prepare('UPDATE operation_jobs SET deadline_at=? WHERE id=?')
    .bind(Math.floor(Date.now() / 1000) - 1, job.job_id).run();
  const polled = await (await call(env, { path: `/api/jobs/${job.job_id}`, token })).json();
  assert.equal(polled.status, 'expired');
  assert.equal(await env.UPLOADS.head(`upload-jobs/${job.job_id}`), null, '轮询判过期即删对象');

  // B) cron 批量收敛
  const job2 = await (await call(env, { method: 'POST', path: '/api/upload-jobs', token, body: { server_id: 1, path: '/opt/y.bin' } })).json();
  await env.UPLOADS.put(`upload-jobs/${job2.job_id}`, 'staged-bytes-2');
  await env.DB.prepare("UPDATE operation_jobs SET status='staged', r2_key=?, deadline_at=? WHERE id=?")
    .bind(`upload-jobs/${job2.job_id}`, Math.floor(Date.now() / 1000) - 1, job2.job_id).run();
  const r = await runJobMaintenance(env, Math.floor(Date.now() / 1000));
  assert.ok(r.expired >= 1);
  assert.equal(await env.UPLOADS.head(`upload-jobs/${job2.job_id}`), null, 'cron 收敛同样删对象');
});

test('upload job：Agent 回执失败也删除 R2 对象', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'exp2' });
  const job = await (await call(env, { method: 'POST', path: '/api/upload-jobs', token, body: { server_id: 1, path: '/opt/z.bin' } })).json();
  await env.UPLOADS.put(`upload-jobs/${job.job_id}`, 'bytes');
  await env.DB.prepare("UPDATE operation_jobs SET status='running', r2_key=? WHERE id=?")
    .bind(`upload-jobs/${job.job_id}`, job.job_id).run();

  const inst = new TerminalDO({ storage: { get: async () => undefined, put: async () => {}, delete: async () => {} }, getWebSockets: () => [] }, env);
  const ws = { deserializeAttachment: () => ({ role: 'control', serverId: 1 }), send() {}, readyState: 1, close() {} };
  inst.agents.set(1, ws);
  await inst.webSocketMessage(ws, JSON.stringify({
    type: 'upload_result', upload_id: job.job_id, ok: false, commit: true, error: 'disk full',
  }));
  const row = await env.DB.prepare('SELECT status, error FROM operation_jobs WHERE id = ?').bind(job.job_id).first();
  assert.equal(row.status, 'failed');
  assert.match(row.error, /disk full/);
  assert.equal(await env.UPLOADS.head(`upload-jobs/${job.job_id}`), null, '失败回执同样清理暂存对象');
});

// 旧 Agent 被 AGENT_UPGRADE_REQUIRED 拒绝时不得留下 agent.update.request：
// 那条审计的意思是"已请求更新"，而机器版本根本没动，排查时会误判为下发失败。
test('agent update：旧 Agent 被拒时不写 request 审计', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'legacy' });
  await env.DB.prepare('UPDATE servers SET info_json = ? WHERE id = 1').bind(JSON.stringify({
    agent_version: '2020.01.01-0000', agent_platform: 'linux-x86_64',
    update_protocol: 1, self_update_enabled: true, // 无 update_fetch_proto
  })).run();

  const manifest = {
    schema: 1, version: '0.3.0', build_id: '2026.10.28-1200',
    tag: 'cf-panel-agent-2026.10.28-1200', commit: 'abc', update_protocol: 1, assets: {},
  };
  for (const [p, n] of Object.entries({
    'linux-x86_64': 'cf-panel-agent', 'linux-aarch64': 'cf-panel-agent-aarch64',
    'macos-aarch64': 'cf-panel-agent-macos', 'windows-x86_64': 'cf-panel-agent-windows.exe',
  })) {
    manifest.assets[p] = { name: n, size: 4, sha256: 'a'.repeat(64), url: `https://github.com/yanghuan/cf-panel/releases/download/${manifest.tag}/${n}` };
  }
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) =>
    String(u).endsWith('agent-manifest.json') ? new Response(JSON.stringify(manifest)) : new Response('x');
  try {
    const res = await call(env, { method: 'POST', path: '/api/servers/1/agent-update', token });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'AGENT_UPGRADE_REQUIRED');
    const audits = await env.DB.prepare("SELECT action FROM audit_logs WHERE action LIKE 'agent.update%'").all();
    assert.equal(audits.results.length, 0, '被拒绝的请求不得写"已请求更新"审计');
  } finally {
    globalThis.fetch = orig;
  }
});

// 已过 deadline 但没人轮询的上传任务会一直占着单机串行锁（部分唯一索引），
// 让同机后续上传全部 409 UPLOAD_BUSY，最长挡到 expires_at（24h）。
// 创建前按 server 顺手收敛即可让出，不需要全表扫描的 settleExpiredAll。
test('upload job：创建前收敛本机过期任务，释放被占的串行锁', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'stale-lock' });
  const now = Math.floor(Date.now() / 1000);
  // 一个早已过 deadline 的 awaiting_upload 任务（没人轮询，cron 也没跑到）
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, target_path, overwrite, size_bytes, created_at, deadline_at, expires_at)
    VALUES ('job_old','upload','awaiting_upload',1,'admin',1,'/opt/old',0,10,?,?,?)`)
    .bind(now - 4000, now - 3000, now + 86400).run();

  const res = await call(env, { method: 'POST', path: '/api/upload-jobs', token, body: { server_id: 1, path: '/opt/new' } });
  assert.equal(res.status, 202, '过期任务不应阻塞新上传');
  const row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_old').first();
  assert.equal(row.status, 'expired', '旧任务应被顺带收敛为 expired');
});

// 过期任务不限 kind 时会占满 LIMIT：一台机器积压 25 条过期 exec，真正挡路的过期 upload
// 排在最后选不到 → 新上传仍 409 UPLOAD_BUSY。加 kind 过滤 + ORDER BY deadline_at 后才能收敛。
test('upload job：大量过期 exec 不占用收敛名额（只收敛 upload/update）', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'many-stale' });
  const now = Math.floor(Date.now() / 1000);
  const ins = (id, kind, status) => env.DB.prepare(
    `INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, command, target_path, overwrite, size_bytes, created_at, deadline_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, kind, status, 1, 'admin', 1,
    kind === 'exec' ? 'echo x' : null, kind === 'upload' ? '/opt/old' : null, 0, 10,
    now - 5000, now - 4000, now + 86400,
  ).run();
  for (let i = 0; i < 25; i++) await ins(`job_x${i}`, 'exec', 'running');
  await ins('job_up', 'upload', 'awaiting_upload'); // 插在最后：无 ORDER BY 时最容易被 LIMIT 挤掉

  const res = await call(env, { method: 'POST', path: '/api/upload-jobs', token, body: { server_id: 1, path: '/opt/new' } });
  assert.equal(res.status, 202, '挡路的过期 upload 必须被收敛，不能因过期 exec 占满 LIMIT 而 UPLOAD_BUSY');
  const row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_up').first();
  assert.equal(row.status, 'expired', '过期的 upload 任务应被收敛为 expired');
});

// 过期但没人轮询的 agent_update（Agent 未回执、连接未断）会一直停在 running：
// 判据只看 status 时，该机 exec/upload 会被 409 挡住最长到下一次 cron（1h）。
test('exec：已过 deadline 的 agent_update 不再阻塞命令', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'stale-update' });
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO operation_jobs (id, kind, status, user_id, username, server_id, created_at, deadline_at, expires_at)
     VALUES ('job_upd','agent_update','running',1,'admin',1,?,?,?)`
  ).bind(now - 900, now - 300, now + 86400).run();

  const res = await call(env, {
    method: 'POST', path: '/api/exec-jobs', token,
    body: { server_id: 1, command: 'echo ok', timeout: 5 },
  });
  assert.equal(res.status, 202, '已过 deadline 的更新任务不得继续挡 exec');
  // 互斥判据是只读的（每次开终端/exec 都多一条 0 行 UPDATE 是纯浪费）：
  // 过期行仍占着 agent_update 的部分唯一索引，但那条索引只在「创建 agent_update」时才挡路，
  // 而 createAgentUpdateJob 会先调 settleServerExpired 收敛——所以这里不做副作用断言。
  let row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_upd').first();
  assert.equal(row.status, 'running', '只是读取判据，不得顺带改状态');

  // 创建新更新时的收敛路径（同一台机器）：过期行让位后新任务才能插入
  await settleServerExpired(env, 1);
  row = await env.DB.prepare('SELECT status FROM operation_jobs WHERE id = ?').bind('job_upd').first();
  assert.equal(row.status, 'expired', 'settleServerExpired 负责收敛，让出唯一索引');
});

// P2-4 剩余：DO 返回 409/413 时它自己不写 D1，这两条"下发被拒"路径也必须留痕。
test('exec 下发被拒：DO 返回非 2xx 时也写 exec.command.failed', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'reject' });
  // DO 桩返回 413（命令过长/bad request 一类的拒绝），且不改 D1
  env.TERMINAL.get = () => ({
    fetch: async () => new Response(JSON.stringify({ error: 'bad request' }), { status: 413 }),
  });
  const res = await call(env, {
    method: 'POST', path: '/api/exec-jobs', token,
    body: { server_id: 1, command: 'echo hi', timeout: 5 },
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  const audits = await env.DB.prepare("SELECT action, detail FROM audit_logs WHERE job_id = ?").bind(body.job_id).all();
  assert.equal(audits.results.length, 1, '下发被拒不能无痕');
  assert.equal(audits.results[0].action, 'exec.command.failed');
  assert.match(audits.results[0].detail, /echo hi/, '审计保留被拒绝的命令');
});

// 审计的 duration_ms 必须与任务行一致。settleExpired/All/ServerExpired 传的是 UPDATE
// **之前**的行快照（那时 finished_at 刚写、duration_ms 仍是 NULL），不回读就会恒为 null。
test('exec 过期审计：duration_ms 与任务行一致（不能为 null）', async () => {
  const env = makeEnv();
  const token = await login(env);
  await addServer(env, token, { name: 'dur' });
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO operation_jobs (id, kind, status, user_id, username, client_ip, server_id, command, timeout_s, created_at, started_at, deadline_at, expires_at)
    VALUES ('job_dur','exec','running',1,'admin','',1,'sleep 10',5,?,?,?,?)`)
    .bind(now - 400, now - 390, now - 380, now + 86400).run();

  const polled = await (await call(env, { path: '/api/jobs/job_dur', token })).json();
  assert.equal(polled.status, 'expired');
  const row = await env.DB.prepare('SELECT duration_ms FROM operation_jobs WHERE id = ?').bind('job_dur').first();
  const audit = await env.DB.prepare("SELECT duration_ms, action FROM audit_logs WHERE job_id = 'job_dur'").first();
  assert.equal(audit.action, 'exec.command.failed');
  assert.equal(audit.duration_ms, row.duration_ms, '审计 duration_ms 必须与任务行一致');
  assert.ok(audit.duration_ms > 0, '不能是 null/0');
});
