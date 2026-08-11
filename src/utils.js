// cf-panel — 通用工具函数（无业务耦合，供各模块与 DO 类导入）
import { SHARDS } from './config.js';

// API 响应统一附加的安全响应头（防点击劫持/嗅探/Referrer 泄露）
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
};
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  });
}
export function err(message, status = 400) {
  return json({ error: message }, status);
}
const JWT_SECRET_CONFIG_ERROR = 'server misconfigured: JWT_SECRET not set';
export function secret(env) {
  const value = env && env.JWT_SECRET;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(JWT_SECRET_CONFIG_ERROR);
  return value;
}
export function requireJwtSecret(env) {
  try {
    secret(env);
    return null;
  } catch {
    return err(JWT_SECRET_CONFIG_ERROR, 503);
  }
}

export function b64u(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}
export async function signJwt(payload, env) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const sig = b64u(await hmacSha256(new TextEncoder().encode(secret(env)), new TextEncoder().encode(h + '.' + p)));
  return `${h}.${p}.${sig}`;
}
export async function verifyJwt(token, env) {
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
export function randomHex(len = 32) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return bytesToHex(a);
}
// key 指纹：无盐 SHA-256，用于"用 key 反查服务器"（检索键，不参与校验）
export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
  return bytesToHex(new Uint8Array(digest));
}
// 解析监控时间范围："1h"/"12h"/"3d"/"7d"/"30d" → 小时数（非法/非白名单回退 12h）。
// 白名单收在函数内：拒绝任意 \d+(h|d)（如 99999d）——超大 range 会让 D1 查询走
// `ts % step` 抽样（ts 列取模无法用索引）→ 全表扫描行读放大，一个登录用户即可耗尽 D1 免费行读
const RANGE_HOURS_WHITELIST = new Set([1, 12, 72, 168, 720]); // 1h / 12h / 3d / 7d / 30d
export function parseRangeHours(range) {
  const m = String(range).match(/^(\d+)(h|d)$/);
  if (!m) return 12;
  const n = Number(m[1]);
  const hours = m[2] === 'd' ? n * 24 : n;
  return RANGE_HOURS_WHITELIST.has(hours) ? hours : 12;
}
// 安全解析 JSON 字符串（extra/info 列），失败回退 null
export function safeJson(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}
// 数值归一化：字符串数字转 number，对象/数组/NaN/Infinity → null（上报数据入口校验用）
export function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// 清洗告警配置（PUT /api/settings 用）：只保留合法字段，空 webhook_url 即禁用
export function sanitizeAlerts(a) {
  if (!a || typeof a !== 'object') return {};
  const out = {};
  const num = (v, def) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const url = String(a.webhook_url || '').trim();
  if (url) out.webhook_url = url;
  const token = String(a.webhook_token || '').trim();
  if (token) out.webhook_token = token;
  const method = String(a.method || '').trim().toUpperCase();
  if (method === 'GET' || method === 'POST' || method === 'PUT') out.method = method;
  const bt = String(a.body_template || '').trim();
  if (bt) out.body_template = bt;
  const ct = String(a.content_type || '').trim();
  if (ct) out.content_type = ct;
  let hdrs = a.headers;
  if (typeof hdrs === 'string') {
    try { hdrs = JSON.parse(hdrs); } catch { hdrs = null; }
  }
  if (hdrs && typeof hdrs === 'object') out.headers = hdrs;
  if (a.cpu_pct !== undefined) out.cpu_pct = num(a.cpu_pct, 90);
  if (a.mem_pct !== undefined) out.mem_pct = num(a.mem_pct, 90);
  if (a.disk_pct !== undefined) out.disk_pct = num(a.disk_pct, 90);
  if (a.load !== undefined) out.load = num(a.load, 0);
  if (a.cooldown_min !== undefined) out.cooldown_min = num(a.cooldown_min, 30);
  if (a.offline_after_s !== undefined) out.offline_after_s = num(a.offline_after_s, 180);
  return out;
}
// 任何秘密（agent key / PAT token）统一用 HMAC 哈希后落库
// 哈希密钥与 JWT 签名密钥隔离（纵深防御）：优先 HASH_SECRET，未配置时回退 JWT_SECRET（平滑迁移）。
// ⚠️ 配置/切换 HASH_SECRET 后，已存的 servers.agent_key_hash 与 api_tokens.token_hash 全部失效，
// 需重新添加服务器（重新生成 agent key）并重建 PAT；agent_key_id（无盐 SHA-256 检索键）不受影响。
export async function hashSecret(value, env) {
  const hashKey = env.HASH_SECRET || secret(env);
  return bytesToHex(await hmacSha256(new TextEncoder().encode(hashKey), new TextEncoder().encode(value)));
}

// 上传签名 URL（无状态自验证）：HMAC(secret, serverId|path|overwrite|exp)。
// 验证所需信息全部编码在 URL（server_id/path/overwrite/exp），secret 只在环境变量——
// 不落任何存储；篡改任一字段签名对不上，过期即失效。密钥复用 HASH_SECRET（回退 JWT_SECRET）。
export async function signUploadToken(serverId, path, overwrite, env, ttlS = 600) {
  const exp = Math.floor(Date.now() / 1000) + ttlS;
  const payload = `${serverId}|${path}|${overwrite ? 1 : 0}|${exp}`;
  const hashKey = env.HASH_SECRET || secret(env);
  const sig = b64u(await hmacSha256(new TextEncoder().encode(hashKey), new TextEncoder().encode(payload)));
  return { token: `${exp}.${sig}`, exp };
}
export async function verifyUploadToken(token, serverId, path, overwrite, env) {
  try {
    const dot = token.indexOf('.');
    if (dot <= 0) return { ok: false, error: 'bad token' };
    const exp = Number(token.slice(0, dot));
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return { ok: false, error: 'token expired' };
    const payload = `${serverId}|${path}|${overwrite ? 1 : 0}|${exp}`;
    const hashKey = env.HASH_SECRET || secret(env);
    const expect = b64u(await hmacSha256(new TextEncoder().encode(hashKey), new TextEncoder().encode(payload)));
    const got = token.slice(dot + 1);
    // 恒定时间比较（防时序侧信道）
    if (expect.length !== got.length) return { ok: false, error: 'bad token' };
    let diff = 0;
    for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ got.charCodeAt(i);
    return diff === 0 ? { ok: true } : { ok: false, error: 'bad token' };
  } catch {
    return { ok: false, error: 'bad token' };
  }
}

// D1 键值表（替代 Workers KV）：value 直接存 JSON 字符串
export async function kvGet(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM kv_json WHERE key = ?').bind(key).first();
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
export async function kvPut(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO kv_json (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).bind(key, JSON.stringify(value)).run();
}

// ---------------- 分片路由 ----------------

export function shardForServerId(serverId) {
  return Number(serverId) % SHARDS;
}
export function makeStreamId(serverId) {
  return `${shardForServerId(serverId)}-${crypto.randomUUID()}`;
}
export function shardFromStreamId(streamId) {
  const n = parseInt(String(streamId).split('-')[0], 10);
  return Number.isInteger(n) ? n % SHARDS : 0;
}
export function doForShard(env, n) {
  return env.TERMINAL.get(env.TERMINAL.idFromName(`shard-${n}`));
}
export function doMetrics(env) {
  return env.METRICS.get(env.METRICS.idFromName('main'));
}
export function doPanel(env) {
  return env.PANEL.get(env.PANEL.idFromName('main')); // 单实例：服务器列表实时推送
}

// ---------------- Webhook 模板化发送 ----------------

// 告警占位符替换：{event} {title} {message} {server_name} {server_id} {details_json} {time} {token}
export function renderTemplate(tpl, vars) {
  if (!tpl) return '';
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

// 解析自定义 headers（对象或 JSON 字符串），值支持占位符
export function parseHeaders(s, vars) {
  if (!s) return {};
  let obj = s;
  if (typeof s === 'string') {
    try { obj = JSON.parse(s); } catch { return {}; }
  }
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = renderTemplate(String(v), vars);
  return out;
}

// 发送告警 Webhook（模板化）：method/url/body/headers 均支持占位符；
// token 仅作为 {token} 占位符变量，由用户放在 URL/header/body 任意位置。
// 检查 HTTP 状态，失败/异常记 console.error（Cloudflare 后台 Worker 日志可见，便于排查丢失的告警）。
// sendWebhookRaw 返回 {ok, status, error}（测试 Webhook 按钮回显状态用）；sendWebhook 转布尔供告警链路复用。
export async function sendWebhookRaw(cfg, payload) {
  if (!cfg.enabled || !cfg.webhook_url) return { ok: false, status: 0, error: 'webhook not configured' };
  const vars = {
    event: payload.event,
    title: payload.title,
    message: payload.message,
    server_name: payload.server && payload.server.name,
    server_id: payload.server && payload.server.id,
    details_json: JSON.stringify(payload.details || []),
    time: payload.time,
    token: cfg.webhook_token,
  };
  // 统一允许的 HTTP 方法（GET/POST/PUT），不再把 PUT 静默当 POST
  const method = ['GET', 'POST', 'PUT'].includes(cfg.method) ? cfg.method : 'POST';
  const url = renderTemplate(cfg.webhook_url, vars);
  const headers = parseHeaders(cfg.headers, vars);
  if (!headers['content-type']) headers['content-type'] = cfg.content_type || 'application/json';
  const body = method === 'GET' ? undefined : (cfg.body_template ? renderTemplate(cfg.body_template, vars) : JSON.stringify(payload));
  try {
    const resp = await fetch(url, { method, headers, body });
    if (!resp.ok) {
      console.error(`[cf-panel] webhook failed: ${payload.event} → ${url} HTTP ${resp.status}`);
      return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
    }
    return { ok: true, status: resp.status, error: null };
  } catch (e) {
    console.error(`[cf-panel] webhook error: ${payload.event} → ${url} ${e && e.message ? e.message : e}`);
    return { ok: false, status: 0, error: (e && e.message) || String(e) };
  }
}
export async function sendWebhook(cfg, payload) {
  return (await sendWebhookRaw(cfg, payload)).ok;
}
