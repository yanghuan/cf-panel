// ============================================================
// cf-panle — Cloudflare Worker 主逻辑
// REST API + WebSocket 中转（Durable Object: TerminalDO，多分片）
// 依赖：D1(DB)、DO(TERMINAL/METRICS/PANEL)、secret: JWT_SECRET / PANEL_PASSWORD
// 对齐 docs/architecture.md §3.2 / §3.3 / §6
// ============================================================

// ---------------- 常量 ----------------

const SHARDS = 4; // 终端 DO 分片数（改大后旧会话不可达，一般不用动）
const SESSION_TTL_MS = 10 * 60 * 1000; // 会话两端都断开超过 10 分钟 → 回收
const PAT_PREFIX = 'cfp_'; // PAT token 前缀
const SCOPE_READ = 'server:read';
const SCOPE_EXEC = 'server:exec';

// 监控时序：内存 DO 热区 + alarm 归档 D1（默认开启，ARCHIVE_TO_D1=0 可关闭）
const METRICS_KEEP_MIN = 720; // 内存保留最近 12 小时（分钟粒度）
const ARCHIVE_INTERVAL_MS = 10 * 60 * 1000; // 归档周期
const ARCHIVE_AFTER_MIN = 60; // 超过 1 小时的旧数据才归档/可淘汰
const METRICS_RETENTION_DAYS = 30; // D1 历史保留期（天），过期行每日清理
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 保留期清理周期

// 省配额上报策略：有前端观看者时 agent 快采，否则低频采样
const REPORT_FAST_INTERVAL_S = 3;  // 有观看者：3 秒上报
const REPORT_SLOW_INTERVAL_S = 120; // 无人查看：120 秒上报

// MCP（Model Context Protocol）标准 AI 接入：无状态 Streamable HTTP（2026-07-28 修订版）
// 端点 /mcp 仅接受 POST；每请求独立用 Authorization: Bearer 鉴权（JWT 或 PAT），无会话状态
const MCP_VERSION = '2025-11-25'; // 服务器声明支持的协议版本（缺失头时客户端按 2025-03-26 兼容）

// 简单登录限流：同一 IP 60 秒内最多 5 次失败（Worker 实例内存，重启清零）
const LOGIN_FAILS = new Map();
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
];

// ---------------- 通用工具 ----------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
function err(message, status = 400) {
  return json({ error: message }, status);
}
function secret(env) {
  return env.JWT_SECRET || 'dev-secret'; // 生产务必 wrangler secret put JWT_SECRET
}

function b64u(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}
async function signJwt(payload, env) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const sig = b64u(await hmacSha256(new TextEncoder().encode(secret(env)), new TextEncoder().encode(h + '.' + p)));
  return `${h}.${p}.${sig}`;
}
async function verifyJwt(token, env) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const sig = await hmacSha256(new TextEncoder().encode(secret(env)), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (b64u(sig) !== parts[2]) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64uDecode(parts[1])));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
function randomHex(len = 32) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return bytesToHex(a);
}
// key 指纹：无盐 SHA-256，用于"用 key 反查服务器"（检索键，不参与校验）
async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
  return bytesToHex(new Uint8Array(digest));
}
// 解析监控时间范围："1h"/"12h"/"3d"/"7d"/"30d" → 小时数（非法回退 12h）
function parseRangeHours(range) {
  const m = String(range).match(/^(\d+)(h|d)$/);
  if (!m) return 12;
  const n = Number(m[1]);
  return m[2] === 'd' ? n * 24 : n;
}
// 安全解析 JSON 字符串（extra/info 列），失败回退 null
function safeJson(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}
// 任何秘密（agent key / PAT token）统一用 HMAC 哈希后落库
async function hashSecret(value, env) {
  return bytesToHex(await hmacSha256(new TextEncoder().encode(secret(env)), new TextEncoder().encode(value)));
}

// D1 键值表（替代 Workers KV）：value 直接存 JSON 字符串
async function kvGet(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM kv_json WHERE key = ?').bind(key).first();
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
async function kvPut(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO kv_json (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).bind(key, JSON.stringify(value)).run();
}

// ---------------- 分片路由 ----------------

function shardForServerId(serverId) {
  return Number(serverId) % SHARDS;
}
function makeStreamId(serverId) {
  return `${shardForServerId(serverId)}-${crypto.randomUUID()}`;
}
function shardFromStreamId(streamId) {
  const n = parseInt(String(streamId).split('-')[0], 10);
  return Number.isInteger(n) ? n % SHARDS : 0;
}
function doForShard(env, n) {
  return env.TERMINAL.get(env.TERMINAL.idFromName(`shard-${n}`));
}
function doMetrics(env) {
  return env.METRICS.get(env.METRICS.idFromName('main'));
}
function doPanel(env) {
  return env.PANEL.get(env.PANEL.idFromName('main')); // 单实例：服务器列表实时推送
}

// 监控历史查询（/api/monitor 与 MCP 共用）：≤12h 走内存热区秒回，更长走 D1 归档（超长 SQL 抽样）
async function queryMonitorRows(env, serverId, hours) {
  if (hours <= 12) {
    const resp = await doMetrics(env).fetch(`https://do.internal/query?server_id=${serverId}&limit=${Math.max(1, Math.round(hours * 60))}`);
    return resp.json();
  }
  const minutes = hours * 60;
  const sinceMin = Math.floor(Date.now() / 1000 / 60) - minutes;
  const MONITOR_D1_MAX_ROWS = 1500; // 长区间 SQL 抽样上限，防响应/解析放大
  const q = 'SELECT ts, cpu, mem_used, net_in, net_out, extra FROM metrics_min WHERE server_id = ? AND ts >= ?';
  let r;
  if (minutes > MONITOR_D1_MAX_ROWS) {
    const step = Math.ceil(minutes / MONITOR_D1_MAX_ROWS);
    r = await env.DB.prepare(`${q} AND ts % ? = 0 ORDER BY ts`).bind(serverId, sinceMin, step).all();
  } else {
    r = await env.DB.prepare(`${q} ORDER BY ts`).bind(serverId, sinceMin).all();
  }
  return r.results.map((x) => ({ ...x, extra: safeJson(x.extra) }));
}

// agent 监控上报落库：更新 last_seen/online（系统信息变更才写 info_json），
// 时序写入 MetricsDO 热区（供 /api/report 与控制通道复用）
async function handleReport(env, payload) {
  const ts = Math.floor(Date.now() / 1000);
  const minTs = Math.floor(ts / 60);
  const server = await env.DB.prepare('SELECT info_json FROM servers WHERE id = ?').bind(payload.serverId).first();
  if (!server) return;
  if (payload.info) {
    const infoJson = JSON.stringify(payload.info);
    if (server.info_json !== infoJson) {
      await env.DB.prepare('UPDATE servers SET last_seen = ?, online = 1, info_json = ? WHERE id = ?')
        .bind(ts, payload.serverId, infoJson, payload.serverId).run();
    } else {
      await env.DB.prepare('UPDATE servers SET last_seen = ?, online = 1 WHERE id = ?').bind(ts, payload.serverId).run();
    }
  } else {
    await env.DB.prepare('UPDATE servers SET last_seen = ?, online = 1 WHERE id = ?').bind(ts, payload.serverId).run();
  }
  const mdo = doMetrics(env);
  await mdo.fetch('https://do.internal/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverId: payload.serverId,
      minTs,
      cpu: payload.cpu ?? null,
      mem_used: payload.mem_used ?? null,
      net_in: payload.net_in ?? null,   // 网络速率（字节/秒）
      net_out: payload.net_out ?? null,
      extra: payload.extra ?? null,     // 扩展监控项对象 → 序列化存入 extra 列
    }),
  });
}

// ---------------- 鉴权（JWT 或 PAT） ----------------

async function authUserByToken(token, env) {
  if (!token) return null;

  // 1) PAT：以 cfp_ 开头
  if (token.startsWith(PAT_PREFIX)) {
    const hash = await hashSecret(token, env);
    const row = await env.DB.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').bind(hash).first();
    if (!row) return null;
    let scopes = [];
    try { scopes = JSON.parse(row.scopes || '[]'); } catch { /* ignore */ }
    let serverIDs = null;
    if (row.server_ids) {
      try { serverIDs = JSON.parse(row.server_ids); } catch { serverIDs = null; }
    }
    return { id: row.user_id, username: `token:${row.name}`, role: 0, pat: { scopes, serverIDs } };
  }

  // 2) JWT（面板登录）
  const payload = await verifyJwt(token, env);
  if (!payload || !payload.uid) return null;
  return { id: payload.uid, username: 'admin', role: 1, pat: null };
}

async function authUser(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return authUserByToken(token, env);
}

// 面板管理员（JWT 登录，非 PAT）
function isAdmin(user) {
  return user && user.role === 1 && !user.pat;
}
function canAccessServer(user, server) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (user.pat) {
    if (user.pat.serverIDs && !user.pat.serverIDs.includes(server.id)) return false;
    return user.pat.scopes.includes(SCOPE_READ);
  }
  return server.user_id === user.id;
}
function canExec(user, server) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (user.pat) {
    if (user.pat.serverIDs && !user.pat.serverIDs.includes(server.id)) return false;
    return user.pat.scopes.includes(SCOPE_EXEC);
  }
  return server.user_id === user.id;
}

// ---------------- REST API ----------------

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // POST /api/login —— 面板单密码（CF secret: PANEL_PASSWORD，同 IP 60s 内 5 次失败限流）
  if (method === 'POST' && path === '/api/login') {
    const body = await request.json().catch(() => ({}));
    const password = String(body.password || '');
    if (!env.PANEL_PASSWORD) return err('server misconfigured: PANEL_PASSWORD not set', 500);
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const nowMs = Date.now();
    const rec = LOGIN_FAILS.get(ip);
    if (rec && nowMs - rec.ts < 60000 && rec.count >= 5) {
      return err('too many attempts, try again later', 429);
    }
    if (password !== env.PANEL_PASSWORD) {
      const cur = rec && nowMs - rec.ts < 60000 ? rec : { count: 0, ts: nowMs };
      cur.count += 1;
      cur.ts = nowMs;
      LOGIN_FAILS.set(ip, cur);
      return err('bad password', 401);
    }
    LOGIN_FAILS.delete(ip);
    const token = await signJwt({ uid: 1, role: 1, exp: Math.floor(Date.now() / 1000) + 86400 }, env);
    return json({ token, user: { id: 1, username: 'admin', role: 1 } });
  }

  // GET /api/public/settings —— 公开配置（D1 kv_json，无需登录）
  if (method === 'GET' && path === '/api/public/settings') {
    const settings = (await kvGet(env, 'settings', {})) || {};
    return json({ site_name: settings.site_name || 'cf-panle', notice: settings.notice || '' });
  }

  // ---- 以下全部需要登录（JWT 或 PAT）----
  const user = await authUser(request, env);
  if (!user) return err('unauthorized', 401);

  // GET /api/me —— 当前用户
  if (method === 'GET' && path === '/api/me') {
    return json({ id: user.id, username: user.username, role: user.role, is_pat: !!user.pat });
  }

  // GET /api/servers —— 服务器列表（admin 全量；PAT 按白名单+read scope；member 看自己的）
  if (method === 'GET' && path === '/api/servers') {
    let rows;
    if (isAdmin(user)) {
      rows = await env.DB.prepare('SELECT * FROM servers ORDER BY "group", display_index, id').all();
    } else if (user.pat) {
      rows = await env.DB.prepare('SELECT * FROM servers ORDER BY "group", display_index, id').all();
      rows.results = rows.results.filter((s) => canAccessServer(user, s));
    } else {
      rows = await env.DB.prepare('SELECT * FROM servers WHERE user_id = ? ORDER BY "group", display_index, id').bind(user.id).all();
    }
    let latest = {};
    try {
      const lResp = await doMetrics(env).fetch('https://do.internal/latest');
      latest = await lResp.json();
    } catch { /* 无最新指标 */ }
    const now = Date.now();
    const list = rows.results.map((s) => ({
      id: s.id,
      name: s.name,
      group: s.group || '',
      display_index: s.display_index || 0,
      online: s.online === 1 && now - (s.last_seen || 0) < 60000,
      info: safeJson(s.info_json),
      metric: latest[s.id] || null,
    }));
    return json(list);
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
    await env.DB.prepare('INSERT INTO audit_logs (user_id, action) VALUES (?,?)').bind(user.id, 'server.create').run();
    return json({
      agent_key: key,
      wss_base: `wss://${url.host}/ws/agent`,
      report_url: `https://${url.host}/api/report`,
    });
  }

  // DELETE /api/servers/:id —— 仅管理员
  if (method === 'DELETE' && path.startsWith('/api/servers/')) {
    if (!isAdmin(user)) return err('forbidden', 403);
    const id = Number(path.split('/')[3]) || 0;
    await env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(id).run();
    return json({ ok: true });
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
    await env.DB.prepare('INSERT INTO audit_logs (user_id, action, target_server_id) VALUES (?,?,?)')
      .bind(user.id, 'terminal.open', server.id)
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
    await env.DB.prepare('INSERT INTO audit_logs (user_id, action, target_server_id) VALUES (?,?,?)')
      .bind(user.id, 'file.open', server.id)
      .run();
    return json({ session_id: streamId, server_id: server.id, server_name: server.name });
  }

  // POST /api/report —— agent 监控上报（key 指纹定位 + hash 校验，无需登录）
  // 时序数据写入内存 DO（MetricsDO 热区）；last_seen/online 仍落 D1
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
      net_in: body.net_in,
      net_out: body.net_out,
      extra: body.extra,
      info: body.info,
    });
    return json({ ok: true });
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
    return json(await queryMonitorRows(env, serverId, hours));
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
      let scopes = body.scopes || [SCOPE_READ];
      if (Array.isArray(body.scopes) && body.scopes.length) scopes = body.scopes;
      scopes = scopes.filter((s) => typeof s === 'string');
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
    return json({ ok: true });
  }

  // ---- 面板设置（D1 kv_json，仅管理员） ----
  if (method === 'PUT' && path === '/api/settings') {
    if (!isAdmin(user)) return err('forbidden', 403);
    const body = await request.json().catch(() => ({}));
    const current = (await kvGet(env, 'settings', {})) || {};
    const next = {
      site_name: body.site_name !== undefined ? String(body.site_name).trim() : current.site_name,
      notice: body.notice !== undefined ? String(body.notice).trim() : current.notice,
    };
    await kvPut(env, 'settings', next);
    return json(next);
  }

  return err('not found', 404);
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

// 工具：服务器列表 + 实时状态 + 系统信息
async function mcpListServers(user, env) {
  const rows = await env.DB.prepare('SELECT * FROM servers ORDER BY "group", display_index, id').all();
  let latest = {};
  try {
    const lResp = await doMetrics(env).fetch('https://do.internal/latest');
    latest = await lResp.json();
  } catch { /* 无最新指标 */ }
  const now = Date.now();
  const list = [];
  for (const s of rows.results) {
    if (!canAccessServer(user, s)) continue;
    const m = latest[s.id] || null;
    list.push({
      id: s.id,
      name: s.name,
      group: s.group || '',
      online: s.online === 1 && now - (s.last_seen || 0) < 60000,
      info: safeJson(s.info_json),
      metrics: m ? {
        cpu_pct: m.cpu,
        mem_used_bytes: m.mem_used,
        net_in_rate_bps: m.net_in,
        net_out_rate_bps: m.net_out,
        load1: m.extra && m.extra.load1,
        swap_bytes: m.extra && m.extra.swap,
        temp_c: m.extra && m.extra.temp,
        procs: m.extra && m.extra.procs,
        tcp_conns: m.extra && m.extra.tcp,
        udp_conns: m.extra && m.extra.udp,
      } : null,
    });
  }
  return list;
}

// 工具：监控历史（内存热区 ≤12h，D1 归档更长；长区间 SQL 抽样）
async function mcpGetMonitor(user, env, args) {
  const serverId = Number(args.server_id) || 0;
  const range = ['1h', '12h', '3d', '7d', '30d'].includes(args.range) ? args.range : '12h';
  let server = null;
  if (serverId) {
    server = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(serverId).first();
  } else if (args.server_name) {
    server = await env.DB.prepare('SELECT * FROM servers WHERE name = ?').bind(String(args.server_name)).first();
  }
  if (!server) throw new Error('server not found（请先用 list_servers 确认 id 或名称）');
  if (!canAccessServer(user, server)) throw new Error('forbidden');
  const rows = await queryMonitorRows(env, server.id, parseRangeHours(range));
  return { server: { id: server.id, name: server.name }, range, count: rows.length, points: rows };
}

// /mcp 主入口（无状态 Streamable HTTP）
async function handleMcp(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return new Response(null, { status: 405 });

  // Origin 校验（防 DNS rebinding，2026-07-28 修订要求）
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
        serverInfo: { name: 'cf-panle', version: '0.1.0' },
        instructions: 'cf-panle 面板只读查询。可用工具：list_servers（服务器状态）、get_monitor（监控历史）。认证：Authorization: Bearer <JWT 或 PAT>',
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

async function handleWs(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 面板实时推送：服务器列表每 3 秒广播给在线前端（单实例 PanelDO，非分片）
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
    // 用 key 指纹反查服务器定位分片（身份与凭证合一，uuid 已废弃）
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

// ---------------- Durable Object：WebSocket 中转核心（分片实例） ----------------

export class TerminalDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // streamId -> {streamId, serverId, creatorUserId, createdAt, userWs, agentWs}
    this.agents = new Map(); // serverId -> 控制 WS
    this.agentInterval = new Map(); // serverId -> 当前下发的上报间隔（秒），避免重复下发
    this.lastSweep = 0;
  }

  async fetch(request) {
    this.maybeSweep();
    const url = new URL(request.url);
    const path = url.pathname;

    // 内部 RPC：首位观看者上线，本分片所有 agent 立即切快采（省配额策略）
    if (path === '/rpc/wakeup' && request.method === 'POST') {
      for (const [serverId, w] of this.agents) {
        this.agentInterval.set(serverId, REPORT_FAST_INTERVAL_S);
        try { w.send(JSON.stringify({ type: 'set_report_interval', interval: REPORT_FAST_INTERVAL_S })); } catch { /* ignore */ }
      }
      return json({ ok: true });
    }

    // 内部 RPC：worker 创建终端/文件会话时调用
    if (path === '/rpc' && request.method === 'POST') {
      const body = await request.json();
      if (body.op === 'create' || body.op === 'open_file') {
        const isFile = body.op === 'open_file';
        this.sessions.set(body.streamId, {
          streamId: body.streamId,
          serverId: body.serverId,
          creatorUserId: body.creatorUserId,
          createdAt: Date.now(),
          type: isFile ? 'file' : 'terminal',
          userWs: null,
          agentWs: null,
        });
        const agentWs = this.agents.get(body.serverId);
        if (!agentWs) return json({ error: 'agent offline' }, 502);
        agentWs.send(JSON.stringify({ type: isFile ? 'open_file' : 'open_terminal', stream_id: body.streamId }));
        return json({ ok: true });
      }
      return err('bad op');
    }

    // GET /ws/terminal/:id | /ws/file/:id —— 浏览器会话（校验创建者/admin，防 UUID 劫持 §6.1）
    let m = path.match(/^\/ws\/(terminal|file)\/(.+)$/);
    if (m) {
      const streamId = m[2];
      const sess = this.sessions.get(streamId);
      if (!sess) return new Response('session not found', { status: 404 });
      const token = url.searchParams.get('token') || '';
      const payload = await verifyJwt(token, this.env);
      if (!payload || !payload.uid) return new Response('unauthorized', { status: 401 });
      if (!(payload.role === 1 || payload.uid === sess.creatorUserId)) return new Response('forbidden', { status: 403 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      sess.userWs = pair[1];
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // GET /ws/agent/control —— agent 常驻控制通道（key 指纹定位 + hash 校验）
    if (path === '/ws/agent/control') {
      const key = request.headers.get('x-agent-key') || url.searchParams.get('key') || '';
      const keyId = await sha256Hex(key);
      const server = await this.env.DB.prepare('SELECT * FROM servers WHERE agent_key_id = ?').bind(keyId).first();
      if (!server) return new Response('unknown agent', { status: 401 });
      const hash = await hashSecret(key, this.env);
      if (hash !== server.agent_key_hash) return new Response('bad key', { status: 401 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      this.agents.set(server.id, pair[1]);
      pair[1].serializeAttachment(String(server.id)); // 休眠唤醒后靠附件识别 serverId（上报用）
      // 连接建立即下发当前上报间隔（省配额：有观看者快采 3s / 无观看者慢采 120s）
      try {
        const vResp = await doPanel(this.env).fetch('https://do.internal/viewers');
        const v = await vResp.json();
        const iv = (v.count || 0) > 0 ? REPORT_FAST_INTERVAL_S : REPORT_SLOW_INTERVAL_S;
        this.agentInterval.set(server.id, iv);
        pair[1].send(JSON.stringify({ type: 'set_report_interval', interval: iv }));
      } catch { /* 查询失败则 agent 用自身默认间隔 */ }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // GET /ws/agent/terminal?sid= | /ws/agent/file?sid= —— agent 数据流（key 校验 + stream 归属校验 §6.2）
    if (path === '/ws/agent/terminal' || path === '/ws/agent/file') {
      const sid = url.searchParams.get('sid') || '';
      const key = request.headers.get('x-agent-key') || url.searchParams.get('key') || '';
      const sess = this.sessions.get(sid);
      if (!sess) return new Response('session not found', { status: 404 });
      const server = await this.env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(sess.serverId).first();
      if (!server) return new Response('unknown agent', { status: 401 });
      const hash = await hashSecret(key, this.env);
      if (hash !== server.agent_key_hash) return new Response('bad key', { status: 401 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      sess.agentWs = pair[1];
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('not found', { status: 404 });
  }

  // 惰性清理：两端都断开且超过 TTL 的僵尸会话（每 60s 至多扫一次）
  maybeSweep() {
    const now = Date.now();
    if (now - this.lastSweep < 60 * 1000) return;
    this.lastSweep = now;
    for (const [sid, sess] of this.sessions) {
      if (!sess.userWs && !sess.agentWs && now - sess.createdAt > SESSION_TTL_MS) {
        this.sessions.delete(sid);
      }
    }
  }

  // Hibernation：消息转发（§3.3 双向对拷 + resize 走控制通道）
  async webSocketMessage(ws, message) {
    // agent 控制通道（不在任何 session）：仅处理监控上报 {type:"report"}
    const sess = [...this.sessions.values()].find((s) => s.userWs === ws || s.agentWs === ws);
    if (!sess) {
      if (typeof message === 'string') {
        try {
          const j = JSON.parse(message);
          if (j && j.type === 'report') {
            const serverId = Number(ws.deserializeAttachment());
            if (serverId) {
              await handleReport(this.env, {
                serverId,
                cpu: j.cpu,
                mem_used: j.mem_used,
                net_in: j.net_in,
                net_out: j.net_out,
                extra: j.extra,
                info: j.info,
              });
              await this.syncAgentInterval(ws, serverId);
            }
          }
        } catch { /* 忽略非 JSON 的控制消息 */ }
      }
      return;
    }

    if (ws === sess.userWs) {
      // 浏览器 → DO
      if (typeof message === 'string') {
        try {
          const j = JSON.parse(message);
          if (j && j.type === 'resize') {
            const agentWs = this.agents.get(sess.serverId);
            if (agentWs) {
              agentWs.send(JSON.stringify({ type: 'resize', stream_id: sess.streamId, rows: Number(j.rows) || 24, cols: Number(j.cols) || 80 }));
            }
            return;
          }
        } catch {
          /* 不是 JSON，当普通输入透传 */
        }
      }
      if (sess.agentWs) sess.agentWs.send(message);
    } else if (ws === sess.agentWs) {
      // agent → DO → 浏览器（纯字节透传）
      if (sess.userWs) sess.userWs.send(message);
    }
  }

  // 省配额策略：根据当前在线观看者数决定该 agent 的上报间隔，仅变化时下发指令
  async syncAgentInterval(ws, serverId) {
    try {
      const resp = await doPanel(this.env).fetch('https://do.internal/viewers');
      const v = await resp.json();
      const want = (v.count || 0) > 0 ? REPORT_FAST_INTERVAL_S : REPORT_SLOW_INTERVAL_S;
      if (this.agentInterval.get(serverId) !== want) {
        this.agentInterval.set(serverId, want);
        ws.send(JSON.stringify({ type: 'set_report_interval', interval: want }));
      }
    } catch { /* 查询失败维持现状 */ }
  }

  async webSocketClose(ws) {
    this.cleanup(ws);
  }
  async webSocketError(ws) {
    this.cleanup(ws);
  }

  cleanup(ws) {
    for (const [sid, sess] of this.sessions) {
      if (sess.userWs === ws) {
        sess.userWs = null;
        if (sess.agentWs) {
          try { sess.agentWs.close(); } catch { /* ignore */ }
        }
      }
      if (sess.agentWs === ws) {
        sess.agentWs = null;
        if (sess.userWs) {
          try { sess.userWs.close(); } catch { /* ignore */ }
        }
      }
      if (!sess.userWs && !sess.agentWs) this.sessions.delete(sid);
    }
    for (const [serverId, w] of this.agents) {
      if (w === ws) this.agents.delete(serverId);
    }
  }
}

// ---------------- Durable Object：监控时序内存热区 ----------------
// 内存热区（12h 秒回）+ alarm 归档 D1（默认开启，ARCHIVE_TO_D1=0 可关闭）；
// 归档时按 METRICS_RETENTION_DAYS 保留期每日清理过期历史

export class MetricsDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.data = new Map(); // serverId -> Map(minTs -> {cpu, mem_used, net_in, net_out})
    this.archived = new Map(); // serverId -> Set(minTs) 已归档标记（避免重复写 D1）
    this.lastPrune = 0; // 上次执行保留期清理的时间
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/report' && request.method === 'POST') {
      const b = await request.json();
      let m = this.data.get(b.serverId);
      if (!m) {
        m = new Map();
        this.data.set(b.serverId, m);
      }
      m.set(b.minTs, { cpu: b.cpu, mem_used: b.mem_used, net_in: b.net_in, net_out: b.net_out, extra: b.extra });
      this.trim(m);
      this.scheduleArchive();
      return json({ ok: true });
    }

    if (url.pathname === '/query' && request.method === 'GET') {
      const serverId = Number(url.searchParams.get('server_id')) || 0;
      const limit = Number(url.searchParams.get('limit')) || METRICS_KEEP_MIN;
      const m = this.data.get(serverId);
      if (!m) return json([]);
      const arr = [...m.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(-limit)
        .map(([ts, v]) => ({ ts, cpu: v.cpu, mem_used: v.mem_used, net_in: v.net_in, net_out: v.net_out, extra: v.extra }));
      return json(arr);
    }

    // 返回所有服务器的最新一条指标（面板卡片实时指标用）
    if (url.pathname === '/latest' && request.method === 'GET') {
      const out = {};
      for (const [serverId, m] of this.data) {
        if (!m.size) continue;
        let lastTs = -1;
        let lastV = null;
        for (const [ts, v] of m) {
          if (ts > lastTs) { lastTs = ts; lastV = v; }
        }
        if (lastV) {
          out[serverId] = { ts: lastTs, cpu: lastV.cpu, mem_used: lastV.mem_used, net_in: lastV.net_in, net_out: lastV.net_out, extra: lastV.extra };
        }
      }
      return json(out);
    }

    return err('not found', 404);
  }

  // 内存滚动窗口：只保留最近 METRICS_KEEP_MIN 分钟
  trim(m) {
    const cutoff = Math.floor(Date.now() / 1000 / 60) - METRICS_KEEP_MIN;
    for (const ts of m.keys()) {
      if (ts < cutoff) m.delete(ts);
    }
  }

  // 归档默认开启（ARCHIVE_TO_D1=0 关闭），每次上报后注册 alarm
  scheduleArchive() {
    if (this.env.ARCHIVE_TO_D1 !== '0') {
      this.state.storage.setAlarm(Date.now() + ARCHIVE_INTERVAL_MS);
    }
  }

  // alarm：把超过 1 小时的数据批量 INSERT 进 D1（INSERT OR IGNORE 幂等），再从内存移除；
  // 每天顺带清理超过保留期的历史行
  async alarm() {
    if (this.env.ARCHIVE_TO_D1 === '0') return;
    const cutoff = Math.floor(Date.now() / 1000 / 60) - ARCHIVE_AFTER_MIN;
    const stmts = [];
    for (const [serverId, m] of this.data) {
      const done = this.archived.get(serverId) || new Set();
      for (const [ts, v] of m) {
        if (ts <= cutoff && !done.has(ts)) {
          stmts.push(
            this.env.DB.prepare(
              'INSERT OR IGNORE INTO metrics_min (server_id, ts, cpu, mem_used, net_in, net_out, extra) VALUES (?,?,?,?,?,?,?)'
            ).bind(serverId, ts, v.cpu, v.mem_used, v.net_in, v.net_out, v.extra ? JSON.stringify(v.extra) : null)
          );
          done.add(ts);
        }
      }
      if (done.size) this.archived.set(serverId, done);
    }
    if (stmts.length) await this.env.DB.batch(stmts);
    for (const [, m] of this.data) {
      for (const ts of [...m.keys()]) {
        if (ts <= cutoff) m.delete(ts);
      }
    }
    // 保留期清理（每天一次）：删除超过 METRICS_RETENTION_DAYS 的旧数据
    const now = Date.now();
    if (now - this.lastPrune > PRUNE_INTERVAL_MS) {
      this.lastPrune = now;
      const minTs = Math.floor(now / 1000 / 60) - METRICS_RETENTION_DAYS * 1440;
      await this.env.DB.prepare('DELETE FROM metrics_min WHERE ts < ?').bind(minTs).run();
    }
    this.state.storage.setAlarm(Date.now() + ARCHIVE_INTERVAL_MS);
  }
}

// ---------------- Durable Object：面板实时推送 ----------------
// 前端登录后建 WS 到 /ws/push?token=...，之后每 3 秒发一条 'sync' 请求；
// 本 DO 用 WebSocket Hibernation API：空闲时实例休眠（不计时长），
// 只有收到客户端消息才短暂唤醒查一次 D1 并回发 → 费用开销趋近普通 Worker。
// token 通过 serializeAttachment 随连接持久化，休眠唤醒后取回。

export class PanelDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    // 内部 RPC：供 TerminalDO 查询当前在线前端观看者数（省配额上报策略用）
    if (url.pathname === '/viewers') {
      return json({ count: this.state.getWebSockets().length });
    }
    if (url.pathname !== '/ws/push') return new Response('not found', { status: 404 });
    const token = url.searchParams.get('token') || '';
    if (!(await authUserByToken(token, this.env))) return new Response('unauthorized', { status: 401 });

    // 首位观看者上线：立即唤醒各分片 agent 切到快采（省配额策略，免等下一次上报）
    if (this.state.getWebSockets().length === 0) {
      this.wakeupAgents();
    }

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(token);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // 广播唤醒：让所有分片上的 agent 立即切到快采间隔
  async wakeupAgents() {
    for (let i = 0; i < SHARDS; i++) {
      try {
        await doForShard(this.env, i).fetch('https://do.internal/rpc/wakeup', { method: 'POST' });
      } catch { /* 分片暂不可达，后续 report 同步兜底 */ }
    }
  }

  // 客户端 sync 请求 → 查库 → 按该连接的用户权限过滤后回发
  async webSocketMessage(ws) {
    const token = ws.deserializeAttachment() || '';
    const user = await authUserByToken(token, this.env);
    if (!user) return;
    let rows;
    try {
      rows = await this.env.DB.prepare('SELECT * FROM servers ORDER BY "group", display_index, id').all();
    } catch {
      return; // D1 临时故障，下个周期再试
    }
    // 附带每台机器的最新指标（卡片实时展示）
    let latest = {};
    try {
      const lResp = await doMetrics(this.env).fetch('https://do.internal/latest');
      latest = await lResp.json();
    } catch { /* 无最新指标 */ }
    const now = Date.now();
    const list = [];
    for (const s of rows.results) {
      if (!canAccessServer(user, s)) continue;
      list.push({
        id: s.id,
        name: s.name,
        group: s.group || '',
        display_index: s.display_index || 0,
        online: s.online === 1 && now - (s.last_seen || 0) < 60000,
        info: safeJson(s.info_json),
        metric: latest[s.id] || null,
      });
    }
    try { ws.send(JSON.stringify(list)); } catch { /* ignore */ }
  }
}

// ---------------- Worker 入口 ----------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/ws/')) return handleWs(request, env);
    if (url.pathname === '/mcp') return handleMcp(request, env);
    return handleApi(request, env);
  },
};
