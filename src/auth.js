// cf-panel — 鉴权与权限（JWT/PAT + 服务器列表）
import { PAT_PREFIX, SCOPE_READ, SCOPE_EXEC, ONLINE_GRACE_FAST_S, ONLINE_GRACE_SLOW_S } from './config.js';
import { hashSecret, verifyJwt, safeJson, doPanel, doMetrics } from './utils.js';

export async function authUserByToken(token, env) {
  if (!token) return null;

  // 1) PAT：以 cfp_ 开头
  if (token.startsWith(PAT_PREFIX)) {
    const hash = await hashSecret(token, env);
    const row = await env.DB.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').bind(hash).first();
    if (!row) return null;
    // 有效期：expires_at 为 unix 秒，NULL=永久；已过期拒绝（token 本身不删除，列表可见）
    if (row.expires_at && row.expires_at < Math.floor(Date.now() / 1000)) return null;
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
  return { id: payload.uid, username: payload.username || 'admin', role: 1, pat: null };
}

export async function authUser(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return authUserByToken(token, env);
}

// 面板管理员（JWT 登录，非 PAT）
export function isAdmin(user) {
  return user && user.role === 1 && !user.pat;
}
export function canAccessServer(user, server) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (user.pat) {
    if (user.pat.serverIDs && !user.pat.serverIDs.includes(server.id)) return false;
    return user.pat.scopes.includes(SCOPE_READ);
  }
  return server.user_id === user.id;
}
export function canExec(user, server) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (user.pat) {
    if (user.pat.serverIDs && !user.pat.serverIDs.includes(server.id)) return false;
    return user.pat.scopes.includes(SCOPE_EXEC);
  }
  return server.user_id === user.id;
}

// 按用户权限查询服务器列表（admin 全量；PAT 按白名单+read scope 在 SQL 层过滤，避免查全表再 JS 过滤；member 看自己的）。
// 三处共用：GET /api/servers、PanelDO 实时推送、MCP list_servers。
export async function queryServersForUser(env, user) {
  if (isAdmin(user)) {
    return env.DB.prepare('SELECT * FROM servers ORDER BY "group", display_index, id').all();
  }
  if (user.pat) {
    // 只读 scope 是 PAT 访问服务器的前提
    if (!user.pat.scopes.includes(SCOPE_READ)) return { results: [] };
    if (user.pat.serverIDs == null) {
      // server_ids 为 NULL：未限制 → 全部服务器
      return env.DB.prepare('SELECT * FROM servers ORDER BY "group", display_index, id').all();
    }
    // 白名单模式：空数组 → 空集（不再返回全量，与 canAccessServer 的拒绝语义一致）
    const ids = [...new Set(user.pat.serverIDs.map(Number).filter((n) => n > 0))];
    if (!ids.length) return { results: [] };
    return env.DB.prepare(`SELECT * FROM servers WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY "group", display_index, id`).bind(...ids).all();
  }
  return env.DB.prepare('SELECT * FROM servers WHERE user_id = ? ORDER BY "group", display_index, id').bind(user.id).all();
}

// 在线判定宽限期（秒）：与 PanelDO buildList 的过渡期语义对齐——有观看者且距 0→1 切快采
// 已超 30s 过渡期才用快宽限 15s；过渡期内（agent 尚未切快采完成首帧上报）用慢宽限 180s，
// 避免首观者上线后 REST/MCP 列表短暂误判离线。查询失败按无观看者（慢宽限）处理。
const PANEL_SWITCH_GRACE_MS = 30 * 1000;
// 独立 2s TTL 缓存：/viewers 结果是全局量（与用户无关），却挂在按用户缓存的
// listServersWithState 路径上——多用户/PAT 并发轮询时该 DO 调用数 = 用户数 × (1/2s)。
// 独立缓存把读放大收敛为全局 1 次/2s（与 listCache 4.5s 错峰，防同频 miss）
const GRACE_CACHE_TTL_MS = 2000;
let graceCache = null; // { ts, value }
// 测试隔离：__internals.__reset 调用（宽限期缓存是模块级静态，跨测试 mock 会互相污染）
export function __clearGraceCache() {
  graceCache = null;
}
export async function panelGraceSeconds(env) {
  const now = Date.now();
  if (graceCache && now - graceCache.ts < GRACE_CACHE_TTL_MS) return graceCache.value;
  let value = ONLINE_GRACE_SLOW_S;
  try {
    const resp = await doPanel(env).fetch('https://do.internal/viewers');
    const v = await resp.json();
    const count = Number(v.count || 0);
    const fastSince = Number(v.fastSince || 0);
    if (count > 0 && (!fastSince || now - fastSince >= PANEL_SWITCH_GRACE_MS)) {
      value = ONLINE_GRACE_FAST_S;
    }
  } catch { /* 查询失败按无观看者（慢宽限）处理 */ }
  graceCache = { ts: now, value };
  return value;
}

// 服务器列表 + 实时状态公共构建（GET /api/servers 与 MCP list_servers 共用）：
// 短 TTL（2s）按用户维度缓存，多入口/多观看者重复读时命中，避免每次都读 D1 全表 +
// MetricsDO /latest + PanelDO /viewers（Worker 侧读放大）。
// 正确性：权限过滤在 SQL 层（queryServersForUser）完成，不缓存越权结论；
// 服务器增删改（POST/DELETE）时显式 clear，最长滞后 2s。
const SERVER_LIST_CACHE_TTL_MS = 2000;
export const serverListCache = new Map(); // userKey -> { ts, list }
function serverListCacheKey(user) {
  return `${user.id}:${user.role}:${user.username}:${user.pat
    ? `${user.pat.scopes.join(',')}|${user.pat.serverIDs == null ? '*' : user.pat.serverIDs.join(',')}`
    : ''}`;
}
export async function listServersWithState(env, user) {
  const key = serverListCacheKey(user);
  const now = Date.now();
  const cached = serverListCache.get(key);
  if (cached && now - cached.ts < SERVER_LIST_CACHE_TTL_MS) return cached.list;
  const rows = await queryServersForUser(env, user);
  let latest = {};
  try {
    const lResp = await doMetrics(env).fetch('https://do.internal/latest');
    latest = await lResp.json();
  } catch { /* 无最新指标 */ }
  const nowSec = Math.floor(now / 1000);
  const grace = await panelGraceSeconds(env);
  const list = rows.results.map((s) => ({
    id: s.id,
    name: s.name,
    group: s.group || '',
    display_index: s.display_index || 0,
    // 在线判定优先用 MetricsDO 秒级 last_seen_s（内存热区实时）；D1 last_seen 节流写，仅冷启动兜底
    online: nowSec - (latest[s.id]?.last_seen_s || s.last_seen || 0) < grace,
    wan_ip: s.wan_ip || '',
    info: safeJson(s.info_json),
    probes: safeJson(s.probe_json),
    metric: latest[s.id] || null,
  }));
  if (serverListCache.size > 500) serverListCache.clear(); // 防 Map 无限增长
  serverListCache.set(key, { ts: now, list });
  return list;
}
