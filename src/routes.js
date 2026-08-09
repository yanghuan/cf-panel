// cf-panel — 路由层：REST API（handleApi）+ MCP（handleMcp）+ WebSocket 路由（handleWs）
import {
  SCOPE_READ, SCOPE_EXEC, PAT_PREFIX, SHARDS, parsePanelUsers,
} from './config.js';

// 本模块专用常量（PAT scope 白名单 / MCP 协议与工具，就近定义便于对照使用代码）
const ALLOWED_SCOPES = [SCOPE_READ, SCOPE_EXEC]; // PAT 合法 scope 白名单
const MCP_VERSION = '2025-11-25'; // 服务器声明支持的协议版本（缺失头时客户端按 2025-03-26 兼容）
const MCP_TOOLS = [
  {
    name: 'list_servers',
    description: '列出面板中所有可访问的服务器，返回每台的状态：在线与否、实时 CPU%/内存/负载，以及系统信息（OS/内核/IP）。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_monitor',
    description: '查询某台服务器的监控历史（分钟序列）：CPU、内存、网络速率及扩展项（Swap/负载/温度/进程数/TCP-UDP 连接数）。提供 server_id 或 server_name 之一；range 可选 1h/12h/3d/7d/30d，默认 12h。',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'integer', description: '服务器 ID（见 list_servers 返回值中的 id）' },
        server_name: { type: 'string', description: '服务器名称（与 server_id 二选一）' },
        range: { type: 'string', enum: ['1h', '12h', '3d', '7d', '30d'], description: '查询时间范围，默认 12h' },
      },
      required: [],
    },
  },
  {
    name: 'exec_command',
    description: '在指定服务器上通过 agent 执行一次 shell 命令并返回输出（一次性执行、非交互、无 PTY，经控制通道直达；适合只读查询、进程/服务管理、快速运维）。需要 exec 权限（管理员或带 server:exec scope 的 PAT）。提供 server_id 或 server_name 之一；command 必填；timeout 可选（秒，默认 25，最大 25）；输出上限约 44KB（stdout）。',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'integer', description: '服务器 ID（见 list_servers 返回值中的 id）' },
        server_name: { type: 'string', description: '服务器名称（与 server_id 二选一）' },
        command: { type: 'string', description: '要执行的 shell 命令（agent 端以 sh -c 执行）' },
        timeout: { type: 'integer', description: '超时秒数，默认 25，最大 25' },
      },
      required: ['command'],
    },
  },
];
import {
  json, err, requireJwtSecret, signJwt, randomHex, sha256Hex, hashSecret,
  kvGet, kvPut, sanitizeAlerts, parseRangeHours,
  doMetrics, doForShard, doPanel, shardForServerId, makeStreamId, shardFromStreamId,
} from './utils.js';
import { queryMonitorRows, queryCustomMetrics, kvClearCache } from './db.js';
import { authUser, isAdmin, canAccessServer, canExec, listServersWithState, serverListCache } from './auth.js';
import { handleReport, serverRowCache } from './report.js';

// ---------------- 登录失败限流 ----------------
// 登录失败限流（应用层纵深防御）。内存窗口按 IP 计数，缓解单 IP 爆破；
// 注意多边缘实例间非全局一致，生产仍建议 Cloudflare Access / Rate Limiting。
const LOGIN_FAIL_LIMIT = 5; // 15 分钟窗口内失败上限
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000; // 超限锁定时长
export const loginFails = new Map(); // ip -> { count, firstAt, lockedUntil }

function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

// 返回剩余锁定秒数；未锁定返回 null（并惰性清理过期窗口）
function loginLockRemaining(ip) {
  const now = Date.now();
  const rec = loginFails.get(ip);
  if (!rec) return null;
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return Math.ceil((rec.lockedUntil - now) / 1000);
  }
  if (now - rec.firstAt > LOGIN_FAIL_WINDOW_MS || (rec.lockedUntil && now >= rec.lockedUntil)) {
    loginFails.delete(ip);
  }
  return null;
}

function recordLoginFail(ip) {
  const now = Date.now();
  let rec = loginFails.get(ip);
  if (!rec || now - rec.firstAt > LOGIN_FAIL_WINDOW_MS) {
    rec = { count: 0, firstAt: now, lockedUntil: 0 };
    loginFails.set(ip, rec);
  }
  rec.count += 1;
  if (rec.count >= LOGIN_FAIL_LIMIT) {
    rec.lockedUntil = now + LOGIN_LOCK_MS;
  }
  // 防 Map 无限增长：超阈值条数时清理过期窗口
  if (loginFails.size > 10000) {
    for (const [k, v] of loginFails) {
      if (Date.now() - v.firstAt > LOGIN_FAIL_WINDOW_MS) loginFails.delete(k);
    }
  }
}

// ---------------- 用量观测（Worker 请求计数） ----------------
// 用量观测：Worker 侧请求计数（实例级，evict/重启清零，仅趋势参考；
// MetricsDO 侧计数每 10 分钟 alarm 汇总到 storage，跨 evict 保留近似量级）
export const apiCounts = new Map(); // `${method} ${path}` -> 次数
function countApi(method, path) {
  const key = `${method} ${path}`;
  apiCounts.set(key, (apiCounts.get(key) || 0) + 1);
  if (apiCounts.size > 200) apiCounts.clear(); // 防 Map 无限增长
}

// ---------------- REST API ----------------

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  countApi(method, path);

  // POST /api/login —— 面板登录（PANEL_USERS 多用户 或 PANEL_PASSWORD 单管理员）
  // 暴力破解防护：应用层按 IP 失败限流（纵深防御，默认生效）；
  // 生产仍强烈建议前置 Cloudflare Access / Rate Limiting（跨边缘实例更一致）。
  if (method === 'POST' && path === '/api/login') {
    const configError = requireJwtSecret(env);
    if (configError) return configError;
    const ip = clientIp(request);
    const lockRemain = loginLockRemaining(ip);
    if (lockRemain != null) {
      return json({ error: `too many failed logins, retry in ${lockRemain}s` }, 429, { 'retry-after': String(lockRemain) });
    }
    const body = await request.json().catch(() => ({}));
    const password = String(body.password || '');
    const users = parsePanelUsers(env);
    if (!users.length) return err('server misconfigured: PANEL_USERS/PANEL_PASSWORD not set', 500);
    const userIdx = users.findIndex((u) => u.password === password);
    if (userIdx < 0) {
      recordLoginFail(ip);
      return err('bad password', 401);
    }
    loginFails.delete(ip); // 登录成功：清零该 IP 失败计数
    const uid = userIdx + 1;
    const username = users[userIdx].username;
    const token = await signJwt({ uid, username, role: 1, exp: Math.floor(Date.now() / 1000) + 86400 }, env);
    return json({ token, user: { id: uid, username, role: 1 } });
  }

  // GET /api/public/settings —— 公开配置（D1 kv_json，无需登录）
  if (method === 'GET' && path === '/api/public/settings') {
    const settings = (await kvGet(env, 'settings', {})) || {};
    return json({ site_name: settings.site_name || 'cf-panel', notice: settings.notice || '', geo_lookup: !!settings.geo_lookup });
  }

  // POST /api/report —— agent 监控上报（key 指纹定位 + hash 校验，无需登录）
  // 时序数据写入内存 DO（MetricsDO 热区）；last_seen 仍落 D1
  if (method === 'POST' && path === '/api/report') {
    const body = await request.json().catch(() => ({}));
    const keyId = await sha256Hex(String(body.key || ''));
    const server = await env.DB.prepare('SELECT * FROM servers WHERE agent_key_id = ?').bind(keyId).first();
    if (!server) return err('unknown agent', 401);
    const hash = await hashSecret(String(body.key || ''), env);
    if (hash !== server.agent_key_hash) return err('bad key', 401);
    await handleReport(env, {
      serverId: server.id,
      cpu: body.cpu,
      mem_used: body.mem_used,
      mem_total: body.mem_total,
      net_in: body.net_in,
      net_out: body.net_out,
      extra: body.extra,
      info: body.info,
      probes: body.probes,
      custom: body.custom,
    });
    return json({ ok: true });
  }

  // ---- 以下全部需要登录（JWT 或 PAT）----
  // JWT_SECRET 是整个面板鉴权的必需安全边界；缺失时 PAT 也不得绕过配置错误继续访问。
  const configError = requireJwtSecret(env);
  if (configError) return configError;
  const user = await authUser(request, env);
  if (!user) return err('unauthorized', 401);

  // GET /api/me —— 当前用户
  if (method === 'GET' && path === '/api/me') {
    return json({ id: user.id, username: user.username, role: user.role, is_pat: !!user.pat, scopes: user.pat ? user.pat.scopes : null });
  }

  // GET /api/servers —— 服务器列表（权限过滤由 queryServersForUser 在 SQL 层完成；列表短 TTL 缓存降读放大）
  if (method === 'GET' && path === '/api/servers') {
    return json(await listServersWithState(env, user));
  }

  // POST /api/servers —— 注册一台服务器（name + 可选 group + 可选序号；仅管理员）
  if (method === 'POST' && path === '/api/servers') {
    if (!isAdmin(user)) return err('forbidden', 403);
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return err('name required');
    const group = String(body.group || '').trim();
    const displayIndex = Number(body.sort_order) || 0;
    const key = randomHex(32); // key 即唯一身份 + 凭证，agent 侧只保留这一个
    const keyId = await sha256Hex(key);
    const hash = await hashSecret(key, env);
    await env.DB.prepare('INSERT INTO servers (agent_key_id, name, "group", display_index, user_id, agent_key_hash) VALUES (?,?,?,?,?,?)')
      .bind(keyId, name, group, displayIndex, user.id, hash)
      .run();
    await env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action) VALUES (?,?,?,?)').bind(user.id, user.username, clientIp(request), 'server.create').run();
    serverListCacheClear();
    return json({
      agent_key: key,
      wss_base: `wss://${url.host}/ws/agent`,
      report_url: `https://${url.host}/api/report`,
    });
  }

  // PATCH /api/servers/:id —— 仅管理员；修改名称/分组/序号（不动 agent key，在线状态不受影响）
  if (method === 'PATCH' && path.startsWith('/api/servers/')) {
    if (!isAdmin(user)) return err('forbidden', 403);
    const id = Number(path.split('/')[3]) || 0;
    const server = await env.DB.prepare('SELECT name FROM servers WHERE id = ?').bind(id).first();
    if (!server) return err('not found', 404);
    const body = await request.json().catch(() => ({}));
    const name = body.name !== undefined ? String(body.name).trim() : server.name;
    if (!name) return err('name required');
    const group = body.group !== undefined ? String(body.group).trim() : server.group;
    const displayIndex = body.sort_order !== undefined ? Number(body.sort_order) || 0 : server.display_index;
    await env.DB.prepare('UPDATE servers SET name = ?, "group" = ?, display_index = ? WHERE id = ?')
      .bind(name, group, displayIndex, id).run();
    serverListCacheClear();
    await env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (?,?,?,?,?,?)')
      .bind(user.id, user.username, clientIp(request), 'server.update', id, `${server.name} → ${name}`).run();
    return json({ ok: true, id, name, group, display_index: displayIndex });
  }

  // DELETE /api/servers/:id —— 仅管理员；清理历史数据 + 审计 + 通知 DO 断开 agent
  if (method === 'DELETE' && path.startsWith('/api/servers/')) {
    if (!isAdmin(user)) return err('forbidden', 403);
    const id = Number(path.split('/')[3]) || 0;
    const server = await env.DB.prepare('SELECT name FROM servers WHERE id = ?').bind(id).first();
    if (!server) return err('not found', 404);
    // 1) 清理该服务器的全部历史数据（归档时序 + 自定义指标）
    await env.DB.batch([
      env.DB.prepare('DELETE FROM metrics_min WHERE server_id = ?').bind(id),
      env.DB.prepare('DELETE FROM metrics_custom WHERE server_id = ?').bind(id),
    ]);
    // 2) 删除服务器本体（agent key 随之失效，重连返回 401）
    await env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(id).run();
    serverListCacheClear();
    // 3) 审计日志
    await env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (?,?,?,?,?,?)')
      .bind(user.id, user.username, clientIp(request), 'server.delete', id, server.name).run();
    // 4) MetricsDO 清内存热区（避免残留数据被 alarm 重新归档回 D1）
    try {
      await doMetrics(env).fetch('https://do.internal/drop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ server_id: id }),
      });
    } catch { /* 热区清理失败不影响删除 */ }
    // 5) 通知各分片 DO 断开该 agent 的常驻控制通道与活跃会话
    for (let i = 0; i < SHARDS; i++) {
      try {
        await doForShard(env, i).fetch('https://do.internal/rpc/drop_server', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ serverId: id }),
        });
      } catch { /* 分片暂不可达；agent 重连会因 key 失效被拒 */ }
    }
    return json({ ok: true });
  }

  // GET /api/usage —— 用量观测（仅管理员）：Worker 请求计数 + MetricsDO 上报/查询计数（近 24h 估算参考）
  if (method === 'GET' && path === '/api/usage') {
    if (!isAdmin(user)) return err('forbidden', 403);
    let doUsage = {};
    try {
      doUsage = await (await doMetrics(env).fetch('https://do.internal/usage')).json();
    } catch { /* 用量读取失败不影响 */ }
    const reportFrames = Number(doUsage.persisted?.report || 0);
    const api = {};
    for (const [k, v] of apiCounts) api[k] = v;
    return json({
      note: 'Worker 计数为实例级（evict/重启清零，趋势参考）；MetricsDO 计数每 10 分钟 alarm 汇总到 storage（跨 evict 保留）。',
      api,
      metrics_do: doUsage,
      estimates_per_day: {
        report_frames: reportFrames, // 上报帧：快采 17,280/天/机、慢采 720/天/机
        do_events: reportFrames * 2, // 每帧上报链约 2 个 DO 事件（report + 推送/告警顺风车）
        d1_writes: Math.round(reportFrames * 0.5), // last_seen 60s 节流(~0.08/帧) + custom 去重 + info/probe 变更
      },
    });
  }

  // POST /api/terminal —— 创建终端会话（exec 权限 + 服务器归属）
  if (method === 'POST' && path === '/api/terminal') {
    const body = await request.json().catch(() => ({}));
    const server = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(Number(body.server_id) || 0).first();
    if (!server) return err('server not found', 404);
    if (!canExec(user, server)) return err('forbidden', 403);
    const streamId = makeStreamId(server.id);
    const stub = doForShard(env, shardForServerId(server.id));
    const resp = await stub.fetch('https://do.internal/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'create', streamId, serverId: server.id, creatorUserId: user.id }),
    });
    if (!resp.ok) return err(`agent not reachable: ${await resp.text()}`, 502);
    await env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id) VALUES (?,?,?,?,?)')
      .bind(user.id, user.username, clientIp(request), 'terminal.open', server.id)
      .run();
    return json({ session_id: streamId, server_id: server.id, server_name: server.name });
  }

  // POST /api/file/open —— 创建文件管理会话（exec 权限 + 服务器归属）
  if (method === 'POST' && path === '/api/file/open') {
    const body = await request.json().catch(() => ({}));
    const server = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(Number(body.server_id) || 0).first();
    if (!server) return err('server not found', 404);
    if (!canExec(user, server)) return err('forbidden', 403);
    const streamId = makeStreamId(server.id);
    const stub = doForShard(env, shardForServerId(server.id));
    const resp = await stub.fetch('https://do.internal/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'open_file', streamId, serverId: server.id, creatorUserId: user.id }),
    });
    if (!resp.ok) return err(`agent not reachable: ${await resp.text()}`, 502);
    await env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id) VALUES (?,?,?,?,?)')
      .bind(user.id, user.username, clientIp(request), 'file.open', server.id)
      .run();
    return json({ session_id: streamId, server_id: server.id, server_name: server.name });
  }

  // GET /api/monitor?server_id=&range= —— 监控历史
  // range: 1h|12h|3d|7d|30d（默认 12h 走内存秒回；>12h 走 D1 归档历史）
  if (method === 'GET' && path === '/api/monitor') {
    const serverId = Number(url.searchParams.get('server_id')) || 0;
    const range = String(url.searchParams.get('range') || '12h');
    const s = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(serverId).first();
    if (!s) return err('not found', 404);
    if (!canAccessServer(user, s)) return err('forbidden', 403);
    const hours = parseRangeHours(range);
    const [system, custom] = await Promise.all([
      queryMonitorRows(env, serverId, hours),
      queryCustomMetrics(env, serverId, hours),
    ]);
    return json({ system, custom });
  }

  // ---- PAT 管理（仅管理员）----
  if (path === '/api/tokens') {
    if (!isAdmin(user)) return err('forbidden', 403);
    if (method === 'GET') {
      const rows = await env.DB.prepare('SELECT id, name, scopes, server_ids, created_at FROM api_tokens ORDER BY id').all();
      return json(rows.results);
    }
    if (method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || '').trim();
      if (!name) return err('name required');
      // scopes 白名单校验：只允许 server:read / server:exec，非法值直接拒绝
      let scopes;
      if (Array.isArray(body.scopes) && body.scopes.length) {
        scopes = [...new Set(body.scopes.filter((s) => ALLOWED_SCOPES.includes(s)))];
        if (!scopes.length) return err(`invalid scope, allowed: ${ALLOWED_SCOPES.join(', ')}`, 400);
      } else {
        scopes = [SCOPE_READ];
      }
      const serverIDs = Array.isArray(body.server_ids) ? body.server_ids.map(Number).filter((n) => n > 0) : null;
      const token = PAT_PREFIX + randomHex(32);
      const hash = await hashSecret(token, env);
      await env.DB.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scopes, server_ids) VALUES (?,?,?,?,?)')
        .bind(user.id, name, hash, JSON.stringify(scopes), serverIDs ? JSON.stringify(serverIDs) : null)
        .run();
      return json({ token }); // 明文只返回一次
    }
    return err('method not allowed', 405);
  }
  if (method === 'DELETE' && path.startsWith('/api/tokens/')) {
    if (!isAdmin(user)) return err('forbidden', 403);
    const id = Number(path.split('/')[3]) || 0;
    await env.DB.prepare('DELETE FROM api_tokens WHERE id = ?').bind(id).run();
    // PAT 撤销即时生效：清 PanelDO 鉴权缓存，已建观看者连接下个推送（≤5s）内关闭
    try {
      await doPanel(env).fetch('https://do.internal/rpc/clear_auth_cache', { method: 'POST' });
    } catch { /* 清缓存失败由 authCache 5s TTL 兜底 */ }
    return json({ ok: true });
  }

  // GET /api/audit-logs —— 审计日志（仅管理员，倒序分页，保留 90 天）
  if (method === 'GET' && path === '/api/audit-logs') {
    if (!isAdmin(user)) return err('forbidden', 403);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    const rows = await env.DB.prepare('SELECT id, user_id, username, client_ip, action, target_server_id, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT ?').bind(limit).all();
    return json(rows.results);
  }

  // ---- 面板设置（D1 kv_json，仅管理员） ----
  if (method === 'GET' && path === '/api/settings') {
    if (!isAdmin(user)) return err('forbidden', 403);
    return json((await kvGet(env, 'settings', {})) || {});
  }
  if (method === 'PUT' && path === '/api/settings') {
    if (!isAdmin(user)) return err('forbidden', 403);
    const body = await request.json().catch(() => ({}));
    const current = (await kvGet(env, 'settings', {})) || {};
    const next = {
      site_name: body.site_name !== undefined ? String(body.site_name).trim() : current.site_name,
      notice: body.notice !== undefined ? String(body.notice).trim() : current.notice,
      alerts: body.alerts !== undefined ? sanitizeAlerts(body.alerts) : current.alerts,
      // IP 归属地第三方查询开关（默认关闭，避免服务器公网 IP 泄露给 ipapi.co/ipwho.is）
      geo_lookup: body.geo_lookup !== undefined ? !!body.geo_lookup : !!current.geo_lookup,
    };
    await kvPut(env, 'settings', next);
    kvClearCache('settings'); // 告警配置立即生效（Worker 侧）
    // MetricsDO 是独立隔离实例，其 SETTINGS_CACHE 需 RPC 清除（否则告警/探活判定最长滞后 300s）
    try {
      await doMetrics(env).fetch('https://do.internal/rpc/clear_settings_cache', { method: 'POST' });
    } catch { /* 清缓存失败：MetricsDO 侧按 300s TTL 自然过期 */ }
    return json(next);
  }

  return err('not found', 404);
}

// 服务器增删改后清列表缓存（serverListCache 在 auth.js）
function serverListCacheClear() {
  serverListCache.clear(); // 服务器增删改后立即使列表缓存失效
  serverRowCache.clear(); // 行缓存同步失效
}

// ---------------- MCP（Model Context Protocol）----------------
// 无状态 Streamable HTTP：/mcp 仅 POST，每请求独立 Bearer 鉴权（JWT/PAT），复用现有数据查询

function mcpResult(id, result, error) {
  const payload = { jsonrpc: '2.0' };
  if (error) payload.error = error;
  else payload.result = result;
  if (id !== null && id !== undefined) payload.id = id;
  return new Response(JSON.stringify(payload), {
    status: error && !result ? 400 : 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

// 工具：服务器列表 + 实时状态 + 系统信息（复用 listServersWithState 短 TTL 缓存，映射 MCP 字段格式）
async function mcpListServers(user, env) {
  const list = await listServersWithState(env, user);
  return list.map((s) => ({
    id: s.id,
    name: s.name,
    group: s.group || '',
    online: s.online,
    wan_ip: s.wan_ip || '',
    info: s.info,
    metrics: s.metric ? {
      cpu_pct: s.metric.cpu,
      mem_used_bytes: s.metric.mem_used,
      net_in_rate_bps: s.metric.net_in,
      net_out_rate_bps: s.metric.net_out,
      load1: s.metric.extra && s.metric.extra.load1,
      swap_bytes: s.metric.extra && s.metric.extra.swap,
      temp_c: s.metric.extra && s.metric.extra.temp,
      procs: s.metric.extra && s.metric.extra.procs,
      tcp_conns: s.metric.extra && s.metric.extra.tcp,
      udp_conns: s.metric.extra && s.metric.extra.udp,
    } : null,
  }));
}

// 工具：在 agent 上执行一次性命令（经 TerminalDO 控制通道，等待 exec_result）
// 鉴权：管理员或 PAT 带 server:exec scope 且命中 server_ids 白名单（canExec）
async function mcpExecCommand(user, env, args) {
  const serverId = Number(args.server_id) || 0;
  const command = String(args.command || '').trim();
  if (!command) throw new Error('command is required');
  let server = null;
  if (serverId) {
    server = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(serverId).first();
  } else if (args.server_name) {
    // exec 是写操作：重名时拒绝静默取第一条（防在错误的机器上执行）
    const rows = await env.DB.prepare('SELECT * FROM servers WHERE name = ?').bind(String(args.server_name)).all();
    if (rows.results.length > 1) {
      throw new Error(
        `ambiguous server_name "${args.server_name}": matches ${rows.results.length} servers (ids: ${rows.results.map((r) => r.id).join(', ')}); use server_id to disambiguate`
      );
    }
    server = rows.results[0] || null;
  }
  if (!server) throw new Error(`server not found (server_id=${args.server_id || ''}, server_name=${args.server_name || ''})`);
  if (!canExec(user, server)) throw new Error(`no exec permission on server ${server.id} (${server.name})`);
  const timeout = Math.min(Math.max(Number(args.timeout) || 25, 1), 25);
  const resp = await doForShard(env, shardForServerId(server.id)).fetch('https://do.internal/rpc/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverId: server.id, command, timeoutMs: timeout * 1000 }),
  });
  const result = await resp.json();
  if (!resp.ok) throw new Error(result.error || `exec failed (${resp.status})`);
  return {
    server_id: server.id,
    server_name: server.name,
    exit_code: typeof result.exit_code === 'number' ? result.exit_code : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    timed_out: !!result.timed_out,
    error: result.error || null,
  };
}

// 工具：监控历史（内存热区 ≤12h，D1 归档更长；长区间 SQL 抽样）
async function mcpGetMonitor(user, env, args) {
  const serverId = Number(args.server_id) || 0;
  const range = ['1h', '12h', '3d', '7d', '30d'].includes(args.range) ? args.range : '12h';
  let server = null;
  if (serverId) {
    server = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(serverId).first();
  } else if (args.server_name) {
    // 重名时同样拒绝静默取第一条（与 exec_command 行为一致，避免"看错机器"）
    const rows = await env.DB.prepare('SELECT * FROM servers WHERE name = ?').bind(String(args.server_name)).all();
    if (rows.results.length > 1) {
      throw new Error(
        `ambiguous server_name "${args.server_name}": matches ${rows.results.length} servers (ids: ${rows.results.map((r) => r.id).join(', ')}); use server_id to disambiguate`
      );
    }
    server = rows.results[0] || null;
  }
  if (!server) throw new Error('server not found（请先用 list_servers 确认 id 或名称）');
  if (!canAccessServer(user, server)) throw new Error('forbidden');
  const hours = parseRangeHours(range);
  const [system, custom] = await Promise.all([
    queryMonitorRows(env, server.id, hours),
    queryCustomMetrics(env, server.id, hours),
  ]);
  return { server: { id: server.id, name: server.name }, range, count: system.length, points: system, custom };
}

// /mcp 主入口（无状态 Streamable HTTP）
export async function handleMcp(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const configError = requireJwtSecret(env);
  if (configError) return configError;

  // Origin 校验（防 DNS rebinding）
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== url.host) return new Response('forbidden', { status: 403 });
    } catch {
      return new Response('forbidden', { status: 403 });
    }
  }

  // 每请求独立鉴权（与现有 API 一致：Bearer JWT 或 PAT）
  const user = await authUser(request, env);
  if (!user) return mcpResult(null, null, { code: -32001, message: 'unauthorized' });

  let body;
  try { body = await request.json(); } catch {
    return mcpResult(null, null, { code: -32700, message: 'Parse error' });
  }
  const id = body.id;

  // 协议版本协商：MCP-Protocol-Version 头须与 body _meta 一致（缺失头时按 2025-03-26 兼容）
  const headerVersion = request.headers.get('mcp-protocol-version') || '2025-03-26';
  const metaVersion = body._meta && body._meta['io.modelcontextprotocol/protocolVersion'];
  if (metaVersion && metaVersion !== headerVersion) {
    return mcpResult(id, null, { code: -32020, message: 'HeaderMismatch: MCP-Protocol-Version 与 body _meta 不一致' });
  }

  switch (body.method) {
    case 'initialize':
      return mcpResult(id, {
        protocolVersion: MCP_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'cf-panel', version: '0.1.0' },
        instructions: 'cf-panel 面板。可用工具：list_servers（服务器状态）、get_monitor（监控历史）、exec_command（在服务器上执行命令，需 exec 权限）。认证：Authorization: Bearer <JWT 或 PAT>',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return new Response(null, { status: 202 }); // 通知：接受无 body
    case 'ping':
      return mcpResult(id, {});
    case 'tools/list':
      return mcpResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const params = body.params || {};
      const tool = MCP_TOOLS.find((t) => t.name === params.name);
      if (!tool) return mcpResult(id, null, { code: -32602, message: `Unknown tool: ${params.name}` });
      try {
        let content;
        if (params.name === 'list_servers') content = await mcpListServers(user, env);
        else if (params.name === 'get_monitor') content = await mcpGetMonitor(user, env, params.arguments || {});
        else if (params.name === 'exec_command') content = await mcpExecCommand(user, env, params.arguments || {});
        return mcpResult(id, { content: [{ type: 'text', text: JSON.stringify(content) }], isError: false });
      } catch (e) {
        // 工具执行错误作为 isError 结果返回（MCP 客户端可读）
        return mcpResult(id, { content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      }
    }
    default:
      return mcpResult(id, null, { code: -32601, message: `Method not found: ${body.method}` });
  }
}

// ---------------- WebSocket 路由（按分片转发 DO） ----------------

export async function handleWs(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const isPanelSocket = path === '/ws/push' || path.startsWith('/ws/terminal/') || path.startsWith('/ws/file/');
  if (isPanelSocket) {
    const configError = requireJwtSecret(env);
    if (configError) return configError;
  }

  // 面板实时推送：列表/推送广播（单实例 PanelDO，非分片）
  if (path === '/ws/push') {
    const stub = doPanel(env);
    const target = new URL(request.url);
    target.protocol = 'https:';
    target.hostname = 'do.internal';
    return stub.fetch(target.toString(), request);
  }

  let shard = 0;

  if (path.startsWith('/ws/terminal/')) {
    shard = shardFromStreamId(path.slice('/ws/terminal/'.length));
  } else if (path.startsWith('/ws/file/')) {
    shard = shardFromStreamId(path.slice('/ws/file/'.length));
  } else if (path === '/ws/agent/control') {
    // 用 key 指纹反查服务器定位分片（身份与凭证合一）
    const key = request.headers.get('x-agent-key') || url.searchParams.get('key') || '';
    const keyId = await sha256Hex(key);
    const server = await env.DB.prepare('SELECT * FROM servers WHERE agent_key_id = ?').bind(keyId).first();
    if (!server) return new Response('unknown agent', { status: 401 });
    shard = shardForServerId(server.id);
  } else if (path === '/ws/agent/terminal' || path === '/ws/agent/file') {
    shard = shardFromStreamId(url.searchParams.get('sid') || '');
  }

  const stub = doForShard(env, shard);
  const target = new URL(request.url);
  target.protocol = 'https:';
  target.hostname = 'do.internal';
  return stub.fetch(target.toString(), request);
}
