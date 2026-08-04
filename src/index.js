// ============================================================
// cf-panel — Cloudflare Worker 主逻辑
// REST API + WebSocket 中转（Durable Object: TerminalDO，多分片）
// 依赖：D1(DB)、DO(TERMINAL/METRICS/PANEL)、secret: JWT_SECRET / PANEL_PASSWORD
// 对齐 docs/architecture.md §3.2 / §3.3 / §6
// ============================================================

// ---------------- 常量 ----------------

const SHARDS = 4; // 终端 DO 分片数（改大后旧会话不可达，一般不用动）
const SESSION_TTL_MS = 10 * 60 * 1000; // 会话两端都断开超过 10 分钟 → 回收
const MAX_SESSIONS_PER_SERVER = 8; // 每服务器并发会话上限（超限 429，防 PTY/bash/FD 耗尽）
const SESSION_ABS_MS = 4 * 60 * 60 * 1000; // 会话绝对最长时长（含活跃连接，到期强制回收）
const PAT_PREFIX = 'cfp_'; // PAT token 前缀
const SCOPE_READ = 'server:read';
const SCOPE_EXEC = 'server:exec';
const ALLOWED_SCOPES = [SCOPE_READ, SCOPE_EXEC]; // PAT 合法 scope 白名单

// 监控时序：内存 DO 热区 + alarm 归档 D1（默认开启，ARCHIVE_TO_D1=0 可关闭）
const METRICS_KEEP_MIN = 720; // 内存保留最近 12 小时（分钟粒度）
const ARCHIVE_INTERVAL_MS = 10 * 60 * 1000; // 归档周期
const ARCHIVE_AFTER_MIN = 60; // 超过 1 小时的旧数据才归档/可淘汰
const METRICS_RETENTION_DAYS = 30; // D1 历史保留期（天），过期行每日清理
const AUDIT_RETENTION_DAYS = 90; // 审计日志保留期（天），过期行随每日清理删除
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 保留期清理周期
// 在线判定宽限期（秒）：按观看者状态动态选择——
// 无观看者：agent 慢采 120s，需约 1.5 倍间隔宽限（与离线告警阈值 offline_after_s=180 对齐）；
// 有观看者：agent 快采 3s，5 次未上报（15s）即判定离线。15s = 5 个快采周期，
// 留足"切快采 ≤5s + 控制通道重连间隙 3~6s + 网络抖动"的余量，又远快于 180s。
const ONLINE_GRACE_SLOW_S = 180;
const ONLINE_GRACE_FAST_S = 15;

// 省配额上报策略：有前端观看者时 agent 快采，否则低频采样
const REPORT_FAST_INTERVAL_S = 3;  // 有观看者：3 秒上报
const REPORT_SLOW_INTERVAL_S = 120; // 无人查看：120 秒上报

// MCP（Model Context Protocol）标准 AI 接入：无状态 Streamable HTTP（2026-07-28 修订版）
// 端点 /mcp 仅接受 POST；每请求独立用 Authorization: Bearer 鉴权（JWT 或 PAT），无会话状态
const MCP_VERSION = '2025-11-25'; // 服务器声明支持的协议版本（缺失头时客户端按 2025-03-26 兼容）

// 解析面板用户：PANEL_USERS="alice:pass1,bob:pass2"；未设置时回退 PANEL_PASSWORD 单管理员
function parsePanelUsers(env) {
  const raw = String(env.PANEL_USERS || '').trim();
  if (!raw) {
    return env.PANEL_PASSWORD ? [{ username: 'admin', password: String(env.PANEL_PASSWORD) }] : [];
  }
  return raw.split(',').map((pair) => {
    const idx = pair.indexOf(':');
    if (idx <= 0) return null; // 无冒号或用户名缺失（idx=-1/0）→ 丢弃，避免截断末字符
    return { username: pair.slice(0, idx).trim(), password: pair.slice(idx + 1).trim() };
  }).filter((u) => u && u.username && u.password);
}
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

// API 响应统一附加的安全响应头（防点击劫持/嗅探/Referrer 泄露）
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
};
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  });
}
function err(message, status = 400) {
  return json({ error: message }, status);
}
const JWT_SECRET_CONFIG_ERROR = 'server misconfigured: JWT_SECRET not set';
function secret(env) {
  const value = env && env.JWT_SECRET;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(JWT_SECRET_CONFIG_ERROR);
  return value;
}
function requireJwtSecret(env) {
  try {
    secret(env);
    return null;
  } catch {
    return err(JWT_SECRET_CONFIG_ERROR, 503);
  }
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
// 清洗告警配置（PUT /api/settings 用）：只保留合法字段，空 webhook_url 即禁用
function sanitizeAlerts(a) {
  if (!a || typeof a !== 'object') return undefined;
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
async function hashSecret(value, env) {
  const hashKey = env.HASH_SECRET || secret(env);
  return bytesToHex(await hmacSha256(new TextEncoder().encode(hashKey), new TextEncoder().encode(value)));
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

// 监控历史查询（/api/monitor 与 MCP 共用）：统一合并「MetricsDO 热区（最近 ≤12h）」与
// 「D1 归档（≥1h 前）」后按时间戳去重（热区优先，补齐最近未归档数据），超上限时 JS 降采样。
// 热区不再只保留 1h，≤12h 查询完整；长区间查询不再缺最近 ~1h 数据。
const MONITOR_D1_MAX_ROWS = 1500; // 长区间 SQL 抽样上限，防响应/解析放大
async function queryMonitorRows(env, serverId, hours) {
  const minutes = hours * 60;
  const nowMin = Math.floor(Date.now() / 1000 / 60);
  const sinceMin = nowMin - minutes;
  // 1) 热区：最近数据（MetricsDO 保留 12h 上限），补齐尚未归档的最近 ~1h
  let hot = [];
  try {
    const resp = await doMetrics(env).fetch(`https://do.internal/query?server_id=${serverId}&limit=${Math.max(1, Math.round(minutes))}`);
    hot = await resp.json();
  } catch { hot = []; }
  // 2) D1 归档：查询 sinceMin ~ 归档线（归档线之后的数据仍在热区，避免重复且无需 D1 读）
  let rows = [];
  if (minutes > ARCHIVE_AFTER_MIN) {
    const archiveSince = Math.max(sinceMin, nowMin - ARCHIVE_AFTER_MIN);
    const q = 'SELECT ts, cpu, mem_used, mem_total, net_in, net_out, extra FROM metrics_min WHERE server_id = ? AND ts >= ? AND ts < ?';
    let r;
    if (minutes > MONITOR_D1_MAX_ROWS) {
      const step = Math.ceil(minutes / MONITOR_D1_MAX_ROWS);
      r = await env.DB.prepare(`${q} AND ts % ? = 0 ORDER BY ts`).bind(serverId, sinceMin, archiveSince, step).all();
    } else {
      r = await env.DB.prepare(`${q} ORDER BY ts`).bind(serverId, sinceMin, archiveSince).all();
    }
    rows = r.results.map((x) => ({ ...x, extra: safeJson(x.extra) }));
  }
  // 3) 合并去重：热区优先（同 ts 覆盖 D1，取最近上报值）
  const merged = new Map();
  for (const x of rows) merged.set(x.ts, x);
  for (const x of hot) merged.set(x.ts, x);
  let arr = [...merged.values()].sort((a, b) => a.ts - b.ts);
  // 4) 超上限时均匀降采样
  if (arr.length > MONITOR_D1_MAX_ROWS) {
    const step = Math.ceil(arr.length / MONITOR_D1_MAX_ROWS);
    arr = arr.filter((_, i) => i % step === 0);
  }
  return arr;
}

// 自定义监控项查询：按时间段读 D1（低频直写，无需热区），超长区间 SQL 抽样
async function queryCustomMetrics(env, serverId, hours) {
  const minutes = hours * 60;
  const sinceMin = Math.floor(Date.now() / 1000 / 60) - minutes;
  const custom = {};
  const MAX = 1500;
  let r;
  if (minutes > MAX) {
    const step = Math.ceil(minutes / MAX);
    r = await env.DB.prepare('SELECT name, ts, value FROM metrics_custom WHERE server_id = ? AND ts >= ? AND ts % ? = 0 ORDER BY ts').bind(serverId, sinceMin, step).all();
  } else {
    r = await env.DB.prepare('SELECT name, ts, value FROM metrics_custom WHERE server_id = ? AND ts >= ? ORDER BY ts').bind(serverId, sinceMin).all();
  }
  for (const row of r.results) {
    (custom[row.name] = custom[row.name] || []).push({ ts: row.ts, value: row.value });
  }
  return custom;
}

// 设置缓存（避免告警检查每次上报读 D1），TTL 60s，保存设置时清除
// 注意：告警冷却（ALERT_LAST）与探活去重（PROBE_STATE）状态已移至 MetricsDO 实例内存
// （单实例全局一致，且复用每次上报已有的 /report 调用，零额外请求），见 MetricsDO.checkAlerts/checkProbeAlerts
const SETTINGS_CACHE = new Map();
const SETTINGS_TTL_MS = 60 * 1000;
async function kvGetCached(env, key, fallback) {
  const c = SETTINGS_CACHE.get(key);
  if (c && Date.now() - c.ts < SETTINGS_TTL_MS) return c.value;
  const v = await kvGet(env, key, fallback);
  SETTINGS_CACHE.set(key, { value: v, ts: Date.now() });
  return v;
}
function kvClearCache(key) {
  SETTINGS_CACHE.delete(key);
}

// 告警配置：从 D1 settings.alerts 读取（网页设置弹窗配置，不再用 ALERT_* 环境变量）
async function getAlertCfg(env) {
  const settings = (await kvGetCached(env, 'settings', {})) || {};
  const a = settings.alerts || {};
  return {
    enabled: !!a.webhook_url,
    webhook_url: String(a.webhook_url || ''),
    webhook_token: String(a.webhook_token || ''),
    method: String(a.method || 'POST').toUpperCase(),
    body_template: String(a.body_template || ''),
    content_type: String(a.content_type || ''),
    headers: a.headers || null,
    cpu_pct: Number(a.cpu_pct) || 90,
    mem_pct: Number(a.mem_pct) || 90,
    disk_pct: Number(a.disk_pct) || 90,
    load: Number(a.load) || 0,
    cooldown_min: Number(a.cooldown_min) || 30,
    offline_after_s: Number(a.offline_after_s) || 180,
  };
}

// 告警占位符替换：{event} {title} {message} {server_name} {server_id} {details_json} {time} {token}
function renderTemplate(tpl, vars) {
  if (!tpl) return '';
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

// 解析自定义 headers（对象或 JSON 字符串），值支持占位符
function parseHeaders(s, vars) {
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
async function sendWebhook(cfg, payload) {
  if (!cfg.enabled || !cfg.webhook_url) return false;
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
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[cf-panel] webhook error: ${payload.event} → ${url} ${e && e.message ? e.message : e}`);
    return false;
  }
}

// agent 监控上报落库：更新 last_seen（在线判定唯一依据；系统信息变更才写 info_json，探活变更才写 probe_json），
// 时序写入 MetricsDO 热区（供 /api/report 与控制通道复用）。
// 告警冷却/探活去重判定在 MetricsDO 内部完成（见 MetricsDO.checkAlerts / checkProbeAlerts）。
async function handleReport(env, payload) {
  const ts = Math.floor(Date.now() / 1000);
  const minTs = Math.floor(ts / 60);
  const server = await env.DB.prepare('SELECT info_json, probe_json, name FROM servers WHERE id = ?').bind(payload.serverId).first();
  if (!server) return;
  // 写指标前复核服务器仍存在：并发删除场景丢弃在途上报，防孤儿指标重新写入 metrics_custom/热区
  const alive = await env.DB.prepare('SELECT id FROM servers WHERE id = ?').bind(payload.serverId).first();
  if (!alive) return;
  // 探活状态：变更才写 probe_json（告警去重状态在 MetricsDO 顺风车处理）
  if (Array.isArray(payload.probes)) {
    const probeJson = JSON.stringify(payload.probes);
    if (server.probe_json !== probeJson) {
      await env.DB.prepare('UPDATE servers SET probe_json = ? WHERE id = ?').bind(probeJson, payload.serverId).run();
    }
  }
  // 自定义监控项：低频直写 D1（分钟级，无需内存热区）
  if (Array.isArray(payload.custom)) {
    const stmts = payload.custom
      .filter((c) => c && c.name && c.value != null)
      .map((c) => env.DB.prepare(
        'INSERT OR IGNORE INTO metrics_custom (server_id, name, ts, value) VALUES (?,?,?,?)'
      ).bind(payload.serverId, String(c.name), minTs, Number(c.value)));
    if (stmts.length) await env.DB.batch(stmts);
  }
  if (payload.info) {
    const infoJson = JSON.stringify(payload.info);
    if (server.info_json !== infoJson) {
      await env.DB.prepare('UPDATE servers SET last_seen = ?, info_json = ? WHERE id = ?')
        .bind(ts, infoJson, payload.serverId).run();
    } else {
      await env.DB.prepare('UPDATE servers SET last_seen = ? WHERE id = ?').bind(ts, payload.serverId).run();
    }
  } else {
    await env.DB.prepare('UPDATE servers SET last_seen = ? WHERE id = ?').bind(ts, payload.serverId).run();
  }
  // 时序写入 MetricsDO 热区；告警/探活判定也在该调用内顺带完成（零额外请求）
  const mdo = doMetrics(env);
  await mdo.fetch('https://do.internal/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverId: payload.serverId,
      serverName: server.name,
      minTs,
      cpu: payload.cpu ?? null,
      mem_used: payload.mem_used ?? null,
      mem_total: payload.mem_total ?? null,
      net_in: payload.net_in ?? null,   // 网络速率（字节/秒）
      net_out: payload.net_out ?? null,
      extra: payload.extra ?? null,     // 扩展监控项对象 → 序列化存入 extra 列
      probes: payload.probes ?? null,
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
  return { id: payload.uid, username: payload.username || 'admin', role: 1, pat: null };
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

// 按用户权限查询服务器列表（admin 全量；PAT 按白名单+read scope 在 SQL 层过滤，避免查全表再 JS 过滤；member 看自己的）。
// 三处共用：GET /api/servers、PanelDO 实时推送、MCP list_servers。
async function queryServersForUser(env, user) {
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

// 当前是否有面板观看者（决定在线判定用快/慢宽限期；查询失败按无观看者处理）
async function hasPanelViewers(env) {
  try {
    const resp = await doPanel(env).fetch('https://do.internal/viewers');
    return Number((await resp.json()).count || 0) > 0;
  } catch {
    return false;
  }
}

// ---------------- REST API ----------------

// 登录失败限流（应用层纵深防御）。内存窗口按 IP 计数，缓解单 IP 爆破；
// 注意多边缘实例间非全局一致，生产仍建议 Cloudflare Access / Rate Limiting。
const LOGIN_FAIL_LIMIT = 5; // 15 分钟窗口内失败上限
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000; // 超限锁定时长
const loginFails = new Map(); // ip -> { count, firstAt, lockedUntil }

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

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

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
    return json({ id: user.id, username: user.username, role: user.role, is_pat: !!user.pat });
  }

  // GET /api/servers —— 服务器列表（权限过滤由 queryServersForUser 在 SQL 层完成）
  if (method === 'GET' && path === '/api/servers') {
    const rows = await queryServersForUser(env, user);
    let latest = {};
    try {
      const lResp = await doMetrics(env).fetch('https://do.internal/latest');
      latest = await lResp.json();
    } catch { /* 无最新指标 */ }
    const now = Math.floor(Date.now() / 1000);
    const grace = (await hasPanelViewers(env)) ? ONLINE_GRACE_FAST_S : ONLINE_GRACE_SLOW_S;
    const list = rows.results.map((s) => ({
      id: s.id,
      name: s.name,
      group: s.group || '',
      display_index: s.display_index || 0,
      online: now - (s.last_seen || 0) < grace, // 观看者在线时快宽限（30s），否则慢宽限（180s）
      wan_ip: s.wan_ip || '',
      info: safeJson(s.info_json),
      probes: safeJson(s.probe_json),
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
    // 3) 审计日志
    await env.DB.prepare('INSERT INTO audit_logs (user_id, action, target_server_id, detail) VALUES (?,?,?,?)')
      .bind(user.id, 'server.delete', id, server.name).run();
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
    return json({ ok: true });
  }

  // GET /api/audit-logs —— 审计日志（仅管理员，倒序分页，保留 90 天）
  if (method === 'GET' && path === '/api/audit-logs') {
    if (!isAdmin(user)) return err('forbidden', 403);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    const rows = await env.DB.prepare('SELECT id, user_id, action, target_server_id, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT ?').bind(limit).all();
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
    kvClearCache('settings'); // 告警配置立即生效
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
  const rows = await queryServersForUser(env, user);
  let latest = {};
  try {
    const lResp = await doMetrics(env).fetch('https://do.internal/latest');
    latest = await lResp.json();
  } catch { /* 无最新指标 */ }
  const now = Math.floor(Date.now() / 1000);
  const grace = (await hasPanelViewers(env)) ? ONLINE_GRACE_FAST_S : ONLINE_GRACE_SLOW_S;
  const list = [];
  for (const s of rows.results) {
    const m = latest[s.id] || null;
    list.push({
      id: s.id,
      name: s.name,
      group: s.group || '',
      online: now - (s.last_seen || 0) < grace, // 观看者在线时快宽限（30s），否则慢宽限（180s）
      wan_ip: s.wan_ip || '',
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
  const hours = parseRangeHours(range);
  const [system, custom] = await Promise.all([
    queryMonitorRows(env, server.id, hours),
    queryCustomMetrics(env, server.id, hours),
  ]);
  return { server: { id: server.id, name: server.name }, range, count: system.length, points: system, custom };
}

// /mcp 主入口（无状态 Streamable HTTP）
async function handleMcp(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const configError = requireJwtSecret(env);
  if (configError) return configError;

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
        serverInfo: { name: 'cf-panel', version: '0.1.0' },
        instructions: 'cf-panel 面板只读查询。可用工具：list_servers（服务器状态）、get_monitor（监控历史）。认证：Authorization: Bearer <JWT 或 PAT>',
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
  const isPanelSocket = path === '/ws/push' || path.startsWith('/ws/terminal/') || path.startsWith('/ws/file/');
  if (isPanelSocket) {
    const configError = requireJwtSecret(env);
    if (configError) return configError;
  }

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
    this.pendingTerm = new Map(); // streamId -> {tries, timer} open_terminal 确认重发
    this.lastPingAt = new Map(); // serverId -> 上次心跳时间（控制通道保活，防健康连接被 read -t 180 误判半开）
  }

  async fetch(request) {
    this.maybeSweep();
    this.rebuildIndex(); // 休眠唤醒后内存索引可能已丢，先从存活的 WS 附件重建
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

    // 内部 RPC：删除服务器时断开该 agent 的常驻控制通道与相关会话（key 已删，重连会被 401 拒绝）
    if (path === '/rpc/drop_server' && request.method === 'POST') {
      const body = await request.json();
      const serverId = Number(body.serverId) || 0;
      const w = this.agents.get(serverId);
      if (w) {
        try { w.close(); } catch { /* ignore */ }
        this.agents.delete(serverId);
      }
      const sids = [];
      for (const [sid, sess] of this.sessions) {
        if (sess.serverId !== serverId) continue;
        sids.push(sid);
        try { sess.userWs && sess.userWs.close(); } catch { /* ignore */ }
        try { sess.agentWs && sess.agentWs.close(); } catch { /* ignore */ }
        this.sessions.delete(sid);
        this.state.storage.delete('sess:' + sid).catch(() => {}); // 清理持久化会话
      }
      // 清理该服务器的 open_terminal 待确认（定时器停止）
      for (const sid of sids) {
        const r = this.pendingTerm.get(sid);
        if (r && r.timer) clearTimeout(r.timer);
        this.pendingTerm.delete(sid);
      }
      return json({ ok: true });
    }

    // 内部 RPC：worker 创建终端/文件会话时调用
    if (path === '/rpc' && request.method === 'POST') {
      const body = await request.json();
      if (body.op === 'create' || body.op === 'open_file') {
        const isFile = body.op === 'open_file';
        // 先确认 agent 在线，离线时不创建/不落盘（避免失败会话残留）
        const agentWs = this.agents.get(body.serverId);
        if (!agentWs) return json({ error: 'agent offline' }, 502);
        // 每服务器并发会话上限（防批量创建耗尽 PTY/bash/FD/WebSocket）
        let active = 0;
        for (const s of this.sessions.values()) {
          if (s.serverId === body.serverId) active += 1;
        }
        if (active >= MAX_SESSIONS_PER_SERVER) {
          return json({ error: `too many active sessions (max ${MAX_SESSIONS_PER_SERVER})` }, 429);
        }
        const createdAt = Date.now();
        this.sessions.set(body.streamId, {
          streamId: body.streamId,
          serverId: body.serverId,
          creatorUserId: body.creatorUserId,
          createdAt,
          type: isFile ? 'file' : 'terminal',
          userWs: null,
          agentWs: null,
          userBuf: [], // 浏览器鉴权挂接前缓冲 agent 输出（如初始 bash 提示符），鉴权后补发
          agentBuf: [], // agent 数据流挂接前缓冲浏览器输入，挂接后按序补发
        });
        // 会话元数据持久化到 DO Storage：防 DO 休眠后、浏览器/agent WS 挂接前会话丢失
        // （否则前端会先看到"连接断开"，重连才成功）
        try {
          await this.state.storage.put('sess:' + body.streamId, {
            streamId: body.streamId,
            serverId: body.serverId,
            creatorUserId: body.creatorUserId,
            createdAt,
            type: isFile ? 'file' : 'terminal',
          });
        } catch { /* 持久化失败则降级为纯内存会话 */ }
        // 安排 TTL 回收 alarm（两端都无连接时由 maybeSweep 按时回收）
        try {
          const existing = await this.state.storage.getAlarm();
          const next = createdAt + SESSION_TTL_MS + 1000;
          if (existing == null || next < existing) this.state.storage.setAlarm(next);
        } catch { /* 无法安排 alarm 时依赖 fetch 时 maybeSweep */ }
        agentWs.send(JSON.stringify({ type: isFile ? 'open_file' : 'open_terminal', stream_id: body.streamId }));
        // 终端会话：确认重发机制——agent 收到并 spawn 后回 terminal_ready，
        // 未确认则定时重发（最多 3 次），避免控制通道重连窗口丢指令
        if (!isFile) this.scheduleTermAck(agentWs, body.streamId, body.serverId);
        return json({ ok: true });
      }
      return err('bad op');
    }

    // GET /ws/terminal/:id | /ws/file/:id —— 浏览器会话（防 UUID 劫持 §6.1）
    // 鉴权改为首条消息（{type:'auth', token}），token 不进 URL（防访问日志/浏览器历史泄露）；
    // 未鉴权前不挂接 userWs，任何数据都不会流向浏览器，防劫持语义不变
    let m = path.match(/^\/ws\/(terminal|file)\/(.+)$/);
    if (m) {
      const streamId = m[2];
      const sess = await this.hydrateSession(streamId);
      if (!sess) return new Response('session not found', { status: 404 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({
        role: 'user-pending', sid: streamId, serverId: sess.serverId,
        creatorUserId: sess.creatorUserId, type: sess.type, createdAt: sess.createdAt,
      });
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
      // 控制通道（重）连接：说明旧连接已断/网络切换，关闭该服务器旧的终端/文件会话流，
      // 让 agent 侧 websocat 收到 close → 退出 → 触发清理链（kill pty/bash/脚本），防半开残留。
      // 配合服务端心跳后，健康连接不会因 read -t 180 误重连，故此处只会在真正断链时触发。
      this.dropAgentSessions(server.id);
      this.agents.set(server.id, pair[1]);
      // 附件随连接持久化：休眠唤醒后靠它重建 agents 索引（role 区分控制通道与会话流）
      pair[1].serializeAttachment({ role: 'control', serverId: server.id });
      // 记录节点公网出口 IP（CF-Connecting-IP，Cloudflare 注入；本地 dev 回退 X-Forwarded-For）
      try {
        const wanIp = request.headers.get('cf-connecting-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
        if (wanIp && wanIp !== server.wan_ip) {
          await this.env.DB.prepare('UPDATE servers SET wan_ip = ? WHERE id = ?').bind(wanIp, server.id).run();
        }
      } catch { /* 记录失败不影响连接 */ }
      // 连接建立即标记在线（不等首次上报），避免上报延迟/丢帧导致误显示离线
      try {
        const now = Math.floor(Date.now() / 1000);
        await this.env.DB.prepare('UPDATE servers SET last_seen = ? WHERE id = ?').bind(now, server.id).run();
      } catch { /* 标记失败不影响连接 */ }
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
      const sess = await this.hydrateSession(sid);
      if (!sess) return new Response('session not found', { status: 404 });
      const server = await this.env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(sess.serverId).first();
      if (!server) return new Response('unknown agent', { status: 401 });
      const hash = await hashSecret(key, this.env);
      if (hash !== server.agent_key_hash) return new Response('bad key', { status: 401 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      // 挂接 agent 数据流并按序补发缓冲的浏览器输入
      this.attachAgentFlow(sess, pair[1]);
      // 附件随连接持久化：休眠唤醒后靠它重建会话索引
      pair[1].serializeAttachment({
        role: 'agent', sid, serverId: sess.serverId,
        creatorUserId: sess.creatorUserId, type: sess.type, createdAt: sess.createdAt,
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('not found', { status: 404 });
  }

  // 控制通道（重）连接时调用：关闭该服务器旧的终端/文件会话流。
  // agent 侧 websocat 收到 close → 退出 → 触发清理链（kill pty/bash/脚本），防半开残留。
  dropAgentSessions(serverId) {
    for (const [, sess] of this.sessions) {
      if (sess.serverId !== serverId) continue;
      if (sess.agentWs) {
        try { sess.agentWs.close(); } catch { /* ignore */ }
      }
    }
  }

  // 取会话：先查内存，内存丢失（DO 休眠后）则从 DO Storage 水合兜底
  async hydrateSession(streamId) {
    let sess = this.sessions.get(streamId);
    if (sess) return sess;
    try {
      const raw = await this.state.storage.get('sess:' + streamId);
      if (raw) {
        sess = { ...raw, userWs: null, agentWs: null, userBuf: [], agentBuf: [] };
        this.sessions.set(streamId, sess);
      }
    } catch { /* 水合失败按不存在处理 */ }
    return sess;
  }

  // 惰性清理：两端都断开且超过 TTL 的僵尸会话 → 删除；并清理对应 pendingTerm。
  // 若有未到期的僵尸会话，则安排 DO alarm 到最早到期时间——Hibernation 下零流量也会
  // 被 alarm 短暂唤醒执行清理，避免"必须等下一次 fetch 才回收"的滞留（alarm 每次 = 1 次请求，僵尸会话罕见，成本可忽略）。
  maybeSweep() {
    const now = Date.now();
    let next = Infinity;
    for (const [sid, sess] of this.sessions) {
      // 绝对最长会话时长——即使两端有连接，到期也强制回收（防活跃会话长期占用 PTY/FD/WS）
      if (now - sess.createdAt > SESSION_ABS_MS) {
        if (sess.userWs) { try { sess.userWs.close(); } catch { /* ignore */ } }
        if (sess.agentWs) { try { sess.agentWs.close(); } catch { /* ignore */ } }
        this.sessions.delete(sid);
        this.state.storage.delete('sess:' + sid).catch(() => {}); // 清理持久化会话
        continue;
      }
      if (sess.userWs || sess.agentWs) continue; // 任一端有连接即不回收（未超绝对 TTL）
      if (now - sess.createdAt > SESSION_TTL_MS) {
        this.sessions.delete(sid);
        this.state.storage.delete('sess:' + sid).catch(() => {}); // 清理持久化会话
      } else {
        next = Math.min(next, sess.createdAt + SESSION_TTL_MS);
      }
    }
    // 清理已无会话的 open_terminal 待确认（流已回收，停止定时器，防泄漏）
    for (const sid of [...this.pendingTerm.keys()]) {
      if (!this.sessions.has(sid)) {
        const r = this.pendingTerm.get(sid);
        if (r && r.timer) clearTimeout(r.timer);
        this.pendingTerm.delete(sid);
      }
    }
    if (next !== Infinity) {
      try { this.state.storage.setAlarm(next + 1000); } catch { /* ignore */ }
    }
  }

  // Hibernation alarm：零流量时也被唤醒执行清理；无僵尸会话则无需设定 alarm，保持休眠
  async alarm() {
    this.rebuildIndex();
    this.maybeSweep();
  }

  // open_terminal 确认重发：下发后 5s 未收到 agent 的 terminal_ready 则重发，最多 3 次
  // 解决 agent 控制通道重连窗口内指令丢失导致的终端"打不开"
  // 记录 serverId + agentWs 归属：cleanup 断开时只清理关联项，不影响其他服务器/会话
  scheduleTermAck(agentWs, streamId, serverId) {
    if (this.pendingTerm.has(streamId)) return;
    const rec = { tries: 0, timer: null, serverId, agentWs };
    this.pendingTerm.set(streamId, rec);
    const retry = () => {
      const r = this.pendingTerm.get(streamId);
      if (!r) return; // 已确认（terminal_ready）或已清理
      if (agentWs.readyState === 1) {
        try { agentWs.send(JSON.stringify({ type: 'open_terminal', stream_id: streamId })); } catch { /* ignore */ }
      }
      r.tries += 1;
      if (r.tries < 3) r.timer = setTimeout(retry, 5000);
      else this.pendingTerm.delete(streamId); // 3 次后放弃（前端有自愈兜底）
    };
    rec.timer = setTimeout(retry, 5000);
  }

  // Hibernation：DO 实例空闲冻结后，WebSocket 连接由 workerd 托管持久，但本类
  // 实例的 sessions/agents 内存 Map 会随冻结全部丢失。附件（serializeAttachment）
  // 随连接持久化，唤醒后据此惰性重建索引，避免误判 "agent offline" / "session not found"。
  // 活跃态（索引已非空）跳过，避免每次消息 O(N) 遍历。
  rebuildIndex() {
    if (this.sessions.size > 0 || this.agents.size > 0) return;
    const socks = this.state.getWebSockets?.() || [];
    for (const ws of socks) {
      const att = ws.deserializeAttachment();
      if (att === null || att === undefined) continue;
      if (typeof att === 'string') {
        // 兼容旧格式：控制通道附件为 String(server.id)
        const serverId = Number(att);
        if (Number.isInteger(serverId) && serverId > 0) this.agents.set(serverId, ws);
        continue;
      }
      if (typeof att !== 'object') continue;
      if (att.role === 'control') {
        if (Number(att.serverId) > 0) this.agents.set(Number(att.serverId), ws);
      } else if (att.role === 'user' || att.role === 'agent') {
        let sess = this.sessions.get(att.sid);
        if (!sess) {
          sess = {
            streamId: att.sid,
            serverId: att.serverId,
            creatorUserId: att.creatorUserId,
            createdAt: att.createdAt,
            type: att.type,
            userWs: null,
            agentWs: null,
            userBuf: [],
            agentBuf: [],
          };
          this.sessions.set(att.sid, sess);
        }
        if (att.role === 'user') sess.userWs = ws;
        else sess.agentWs = ws;
      }
    }
  }

  // 挂接 agent 数据流：赋值 agentWs + 按序补发挂接前缓冲的浏览器输入（防静默丢弃）
  attachAgentFlow(sess, ws) {
    sess.agentWs = ws;
    if (sess.agentBuf && sess.agentBuf.length) {
      for (const m of sess.agentBuf) {
        try { ws.send(m); } catch { /* ignore */ }
      }
      sess.agentBuf = [];
    }
  }

  // 从连接附件解析 serverId（兼容旧字符串格式与新对象格式）
  wsServerId(ws) {
    const att = ws.deserializeAttachment();
    if (att === null || att === undefined) return 0;
    if (typeof att === 'string') return Number(att) || 0;
    if (typeof att === 'object') return Number(att.serverId) || 0;
    return 0;
  }

  // Hibernation：消息转发（§3.3 双向对拷 + resize 走控制通道）
  async webSocketMessage(ws, message) {
    this.rebuildIndex(); // 休眠唤醒后索引可能已丢，先按附件重建
    // 浏览器侧待鉴权连接（role: user-pending）：首帧必须是 {type:'auth', token}
    const att = ws.deserializeAttachment?.();
    if (att && att.role === 'user-pending') {
      let j = null;
      try { j = JSON.parse(typeof message === 'string' ? message : ''); } catch { /* 非 JSON */ }
      const token = j && j.type === 'auth' ? String(j.token || '') : '';
      // WS 首帧鉴权与 REST 一致（JWT 管理员直接放行；PAT/member 需服务器存在且可执行/为创建者）
      const user = token ? await authUserByToken(token, this.env) : null;
      const sess = await this.hydrateSession(att.sid);
      if (!user || !sess) {
        try { ws.close(1008, 'unauthorized'); } catch { /* ignore */ }
        return;
      }
      let allowed = isAdmin(user);
      if (!allowed) {
        const server = await this.env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(sess.serverId).first();
        if (user.pat) {
          // PAT：必须服务器存在且 canExec（exec scope + server_ids 白名单），不享受 creatorUserId 兜底
          allowed = !!server && canExec(user, server);
        } else {
          // JWT member：会话创建者
          allowed = !!server && user.id === sess.creatorUserId;
        }
      }
      if (!allowed) {
        try { ws.close(1008, 'unauthorized'); } catch { /* ignore */ }
        return;
      }
      // 鉴权通过 → 挂接为会话用户端；附件升级为 user 角色（供休眠唤醒重建索引）
      sess.userWs = ws;
      ws.serializeAttachment({
        role: 'user', sid: att.sid, serverId: sess.serverId,
        creatorUserId: sess.creatorUserId, type: sess.type, createdAt: sess.createdAt,
      });
      // 补发鉴权前缓冲的 agent 输出（如初始 bash 提示符），保证打开即见首屏
      if (sess.userBuf && sess.userBuf.length) {
        for (const m of sess.userBuf) {
          try { ws.send(m); } catch { /* ignore */ }
        }
        sess.userBuf = [];
      }
      return;
    }
    // agent 控制通道（不在任何 session）：处理监控上报 {type:"report"} 与终端确认 {type:"terminal_ready"}
    const sess = [...this.sessions.values()].find((s) => s.userWs === ws || s.agentWs === ws);
    if (!sess) {
      if (typeof message === 'string') {
        try {
          const j = JSON.parse(message);
          if (j && j.type === 'terminal_ready') {
            // agent 已收到 open_terminal 并开始 spawn → 停止确认重发
            const r = this.pendingTerm.get(j.stream_id);
            if (r && r.timer) clearTimeout(r.timer);
            this.pendingTerm.delete(j.stream_id);
            return;
          }
          if (j && j.type === 'report') {
            const serverId = this.wsServerId(ws);
            if (serverId) {
              await handleReport(this.env, {
                serverId,
                cpu: j.cpu,
                mem_used: j.mem_used,
                mem_total: j.mem_total,
                net_in: j.net_in,
                net_out: j.net_out,
                extra: j.extra,
                info: j.info,
                probes: j.probes,
                custom: j.custom,
              });
              await this.syncAgentInterval(ws, serverId);
              // 控制通道保活心跳（30s 限频）：agent 端 read -t 180 需要周期性下行流量，
              // 否则健康但安静（无指令下发）时会被误判半开而每 ~180s 重连
              const nowP = Date.now();
              const lastP = this.lastPingAt.get(serverId) || 0;
              if (nowP - lastP > 30000) {
                this.lastPingAt.set(serverId, nowP);
                try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
              }
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
      else if (sess.agentBuf && sess.agentBuf.length < 128) {
        // agent 数据流尚未挂接 → 缓冲浏览器输入（有上限），挂接后按序补发，避免静默丢弃
        sess.agentBuf.push(message);
      }
    } else if (ws === sess.agentWs) {
      // agent → DO → 浏览器（纯字节透传）
      if (sess.userWs) {
        sess.userWs.send(message);
      } else if (sess.userBuf && sess.userBuf.length < 128) {
        // 浏览器尚未鉴权挂接：缓冲首屏输出（如 bash 初始提示符），避免被丢弃
        sess.userBuf.push(message);
      }
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
    this.rebuildIndex(); // 确保索引完整后再清理，否则休眠唤醒后的断连无法正确解除
    this.cleanup(ws);
  }
  async webSocketError(ws) {
    this.rebuildIndex();
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
        // 会话数据流断开 → 仅清理该会话的 open_terminal 待确认（数据流已不可用）
        const r = this.pendingTerm.get(sid);
        if (r && r.timer) clearTimeout(r.timer);
        this.pendingTerm.delete(sid);
      }
      if (!sess.userWs && !sess.agentWs) {
        this.sessions.delete(sid);
        this.state.storage.delete('sess:' + sid).catch(() => {}); // 清理持久化会话
      }
    }
    for (const [serverId, w] of this.agents) {
      if (w === ws) {
        this.agents.delete(serverId);
        // 控制通道断开 → 仅清理该 agent（serverId）的待确认，不影响其他服务器/会话
        for (const [sid, r] of [...this.pendingTerm]) {
          if (r.serverId === serverId) {
            if (r.timer) clearTimeout(r.timer);
            this.pendingTerm.delete(sid);
          }
        }
      }
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
    // 读缓存：serverId -> Map(minTs -> {cpu, mem_used, ...})。
    // 数据唯一事实源在 DO Storage（行级 KV），实例被 evict/重启后可从 storage 全量恢复，
    // 内存缓存仅加速当前实例生命周期内的读写（原纯内存热区在实例 evict 后即丢）。
    this.data = new Map();
    this.lastPrune = 0; // 上次执行保留期清理的时间
    // 告警去重状态：内存为主，关键变更时持久化到 DO Storage，实例 evict/重启后恢复，避免重复告警
    this.alertLast = new Map(); // `${serverId}:kind` -> 上次触发时间
    this.probeState = new Map(); // `${serverId}:probeName` -> {ok, lastFail}
    this.alertLoaded = false;
    this.probeLoaded = false;
  }

  // 从 DO Storage 惰性恢复告警冷却 / 探活去重状态（实例 evict 后首次使用时加载一次）
  async ensureAlertLoaded() {
    if (this.alertLoaded) return;
    this.alertLoaded = true;
    try {
      const keys = await this.listStorage('alert:');
      for (const k of keys) {
        this.alertLast.set(k.name.slice('alert:'.length), Number(k.value));
      }
    } catch { /* 加载失败按空状态处理 */ }
  }
  async ensureProbeLoaded() {
    if (this.probeLoaded) return;
    this.probeLoaded = true;
    try {
      const keys = await this.listStorage('probe:');
      for (const k of keys) {
        const v = JSON.parse(k.value);
        this.probeState.set(k.name.slice('probe:'.length), { ok: !!v.ok, lastFail: Number(v.lastFail) || 0 });
      }
    } catch { /* 加载失败按空状态处理 */ }
  }

  // ---- DO Storage 行式热区（key: m:{serverId}:{minTs}，value: JSON 字符串）----
  hotKey(serverId, minTs) {
    return `m:${serverId}:${minTs}`;
  }
  hotPrefix(serverId) {
    return `m:${serverId}:`;
  }
  // 兼容 storage.list 返回格式：CF 生产为 {keys:[{name,value}]}，wrangler dev --local 为 Map
  async listStorage(prefix) {
    const res = await this.state.storage.list({ prefix });
    if (res instanceof Map) return [...res.entries()].map(([name, value]) => ({ name, value }));
    if (Array.isArray(res)) return res;
    if (Array.isArray(res && res.keys)) return res.keys;
    return [];
  }
  // 从 storage 加载某服务器热区到内存缓存（实例 evict 后首次访问时恢复）
  async loadHot(serverId) {
    const items = await this.listStorage(this.hotPrefix(serverId));
    const m = new Map();
    for (const k of items) {
      const ts = Number(k.name.slice(this.hotPrefix(serverId).length));
      m.set(ts, JSON.parse(k.value));
    }
    this.data.set(serverId, m);
    return m;
  }
  async ensureHot(serverId) {
    if (!this.data.has(serverId)) await this.loadHot(serverId);
    return this.data.get(serverId);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/report' && request.method === 'POST') {
      const b = await request.json();
      const minTs = Number(b.minTs);
      const v = { cpu: b.cpu, mem_used: b.mem_used, mem_total: b.mem_total, net_in: b.net_in, net_out: b.net_out, extra: b.extra };
      // 内存缓存 + storage 持久（storage 为唯一事实源；写失败降级仅内存，不阻断上报）
      try {
        const m = await this.ensureHot(b.serverId);
        m.set(minTs, v);
        this.trim(m);
        await this.state.storage.put(this.hotKey(b.serverId, minTs), JSON.stringify(v));
      } catch { /* storage 不可用时降级为纯内存（仅当前实例生命周期） */ }
      this.scheduleArchive();
      // 告警/探活去重判定搭本次 /report 调用顺风车（零额外请求）；失败不影响监控存储
      try {
        if (b.serverName) await this.checkAlerts(b);
        if (Array.isArray(b.probes)) await this.checkProbeAlerts(b.serverId, b.serverName, b.probes);
      } catch { /* 告警失败不影响监控存储 */ }
      return json({ ok: true });
    }

    if (url.pathname === '/query' && request.method === 'GET') {
      const serverId = Number(url.searchParams.get('server_id')) || 0;
      const limit = Number(url.searchParams.get('limit')) || METRICS_KEEP_MIN;
      // 从 storage 恢复（实例 evict 后 data 缓存为空），保证热区查询不丢数据
      const m = await this.ensureHot(serverId);
      const arr = [...m.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(-limit)
        .map(([ts, v]) => ({ ts, cpu: v.cpu, mem_used: v.mem_used, mem_total: v.mem_total, net_in: v.net_in, net_out: v.net_out, extra: v.extra }));
      return json(arr);
    }

    // 返回所有服务器的最新一条指标（面板卡片实时指标用）
    if (url.pathname === '/latest' && request.method === 'GET') {
      const out = {};
      const seen = new Set(); // 已从缓存读过的 serverId
      for (const [serverId, m] of this.data) {
        seen.add(serverId);
        if (!m.size) continue;
        let lastTs = -1;
        let lastV = null;
        for (const [ts, v] of m) {
          if (ts > lastTs) { lastTs = ts; lastV = v; }
        }
        if (lastV) {
          out[serverId] = { ts: lastTs, cpu: lastV.cpu, mem_used: lastV.mem_used, mem_total: lastV.mem_total, net_in: lastV.net_in, net_out: lastV.net_out, extra: lastV.extra };
        }
      }
      // 从 storage 补齐缓存外的服务器（实例 evict 后 latest 不丢）
      const keys = await this.listStorage('m:');
      for (const k of keys) {
        const rest = k.name.slice(2); // 去掉 'm:'
        const sep = rest.indexOf(':');
        if (sep <= 0) continue;
        const serverId = Number(rest.slice(0, sep));
        if (seen.has(serverId)) continue;
        const ts = Number(rest.slice(sep + 1));
        const cur = out[serverId];
        if (!cur || ts > cur.ts) {
          const v = JSON.parse(k.value);
          out[serverId] = { ts, cpu: v.cpu, mem_used: v.mem_used, mem_total: v.mem_total, net_in: v.net_in, net_out: v.net_out, extra: v.extra };
        }
      }
      return json(out);
    }

    // 删除服务器时清理 storage 热区与内存缓存（防残留数据被 alarm 重新归档回 D1）
    if (url.pathname === '/drop' && request.method === 'POST') {
      const b = await request.json();
      const serverId = Number(b.server_id) || 0;
      try {
        const keys = await this.listStorage(this.hotPrefix(serverId));
        await Promise.all(keys.map((k) => this.state.storage.delete(k.name)));
      } catch { /* storage 不可用则仅清内存 */ }
      this.data.delete(serverId);
      // 清理该服务器的告警冷却与探活状态（内存 + storage）
      try {
        const ak = await this.listStorage(`alert:${serverId}:`);
        const pk = await this.listStorage(`probe:${serverId}:`);
        await Promise.all([
          ...ak.map((k) => this.state.storage.delete(k.name)),
          ...pk.map((k) => this.state.storage.delete(k.name)),
        ]);
      } catch { /* storage 不可用则仅清内存 */ }
      for (const k of [...this.alertLast.keys()]) {
        if (k.startsWith(`${serverId}:`)) this.alertLast.delete(k);
      }
      for (const k of [...this.probeState.keys()]) {
        if (k.startsWith(`${serverId}:`)) this.probeState.delete(k);
      }
      return json({ ok: true });
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

  // 无条件注册 alarm：alarm 负责 storage 热区过期行清理 + D1 保留期清理（audit_logs 90 天等）+ 离线告警。
  // 归档开关（ARCHIVE_TO_D1）仅控制"过期行是否落 D1"，不控制清理本身——否则归档关闭时
  // storage 热区与 audit_logs 会无限增长。
  // 不后推已存在的 alarm（仅无 alarm 或新时间更早时设置），防高频上报把归档/清理/告警无限推迟。
  async scheduleArchive() {
    const existing = await this.state.storage.getAlarm();
    const next = Date.now() + ARCHIVE_INTERVAL_MS;
    if (existing == null || next < existing) {
      this.state.storage.setAlarm(next);
    }
  }

  // 指标阈值告警（CPU/内存/磁盘/负载），带冷却去抖。
  // 状态在本 DO 实例内存（单实例全局一致，避免多 Worker 隔离实例重复告警）；
  // 由 /report 处理顺带调用，不增加额外 DO 请求。
  async checkAlerts(b) {
    const cfg = await getAlertCfg(this.env);
    if (!cfg.enabled) return;
    await this.ensureAlertLoaded(); // 恢复持久化冷却状态
    const now = Date.now();
    const cooldown = cfg.cooldown_min * 60 * 1000;
    const cooled = async (key) => {
      const last = this.alertLast.get(key);
      if (last && now - last < cooldown) return false;
      this.alertLast.set(key, now);
      // 冷却触发即持久化，实例 evict/重启后不重复告警
      try { await this.state.storage.put('alert:' + key, String(now)); } catch { /* 持久化失败仅内存 */ }
      return true;
    };
    const alerts = [];
    // CPU
    if (b.cpu != null && b.cpu >= cfg.cpu_pct && await cooled(`${b.serverId}:cpu`)) {
      alerts.push(`CPU ${b.cpu.toFixed(1)}% >= ${cfg.cpu_pct}%`);
    }
    // 内存（需要 agent 上报 mem_total）
    if (b.mem_used != null && b.mem_total != null && b.mem_total > 0) {
      const memPct = (b.mem_used / b.mem_total) * 100;
      if (memPct >= cfg.mem_pct && await cooled(`${b.serverId}:mem`)) {
        alerts.push(`内存 ${memPct.toFixed(1)}% >= ${cfg.mem_pct}%`);
      }
    }
    // 磁盘（根分区）
    const rootDisk = b.extra && b.extra.disk && b.extra.disk.find((d) => d.m === '/');
    if (rootDisk && rootDisk.u != null && rootDisk.u >= cfg.disk_pct && await cooled(`${b.serverId}:disk`)) {
      alerts.push(`磁盘 / ${rootDisk.u}% >= ${cfg.disk_pct}%`);
    }
    // 负载（可选，未设置则不启用）
    if (cfg.load > 0 && b.extra && b.extra.load1 != null && b.extra.load1 >= cfg.load && await cooled(`${b.serverId}:load`)) {
      alerts.push(`负载 ${b.extra.load1} >= ${cfg.load}`);
    }
    if (alerts.length) {
      await sendWebhook(cfg, {
        event: 'alert',
        title: `[cf-panel] ${b.serverName} 指标告警`,
        server: { id: b.serverId, name: b.serverName },
        message: `服务器 ${b.serverName}（id=${b.serverId}）指标超阈值：\n` + alerts.join('\n'),
        details: alerts,
        time: new Date().toISOString(),
      });
    }
  }

  // 服务探活告警：失败持续超冷却 → probe_down；恢复 → probe_recovered（状态同在本 DO 实例）
  async checkProbeAlerts(serverId, serverName, probes) {
    const cfg = await getAlertCfg(this.env);
    if (!cfg.enabled || !Array.isArray(probes)) return;
    await this.ensureProbeLoaded(); // 恢复持久化探活状态
    const now = Date.now();
    const cooldown = cfg.cooldown_min * 60 * 1000;
    for (const p of probes) {
      if (!p || !p.name) continue;
      const key = `${serverId}:${p.name}`;
      const st = this.probeState.get(key) || { ok: true, lastFail: 0 };
      if (p.ok) {
        if (!st.ok) {
          this.probeState.set(key, { ok: true, lastFail: 0 });
          try { await this.state.storage.put('probe:' + key, JSON.stringify({ ok: true, lastFail: 0 })); } catch { /* 持久化失败仅内存 */ }
          await sendWebhook(cfg, {
            event: 'probe_recovered',
            title: `[cf-panel] ${serverName} 服务恢复：${p.name}`,
            server: { id: serverId, name: serverName },
            message: `服务器 ${serverName} 的服务「${p.name}」已恢复正常。`,
            time: new Date().toISOString(),
          });
        }
      } else if (st.ok || now - st.lastFail >= cooldown) {
        this.probeState.set(key, { ok: false, lastFail: now });
        try { await this.state.storage.put('probe:' + key, JSON.stringify({ ok: false, lastFail: now })); } catch { /* 持久化失败仅内存 */ }
        await sendWebhook(cfg, {
          event: 'probe_down',
          title: `[cf-panel] ${serverName} 服务异常：${p.name}`,
          server: { id: serverId, name: serverName },
          message: `服务器 ${serverName} 的服务「${p.name}」探测失败${p.code ? `（HTTP ${p.code}）` : ''}。`,
          details: p,
          time: new Date().toISOString(),
        });
      }
    }
  }

  // 离线/恢复告警：状态存 DO Storage（重启不丢，避免重复告警）
  async checkOfflineAlerts() {
    const cfg = await getAlertCfg(this.env);
    if (!cfg.enabled) return;
    const now = Math.floor(Date.now() / 1000);
    const offlineAfter = cfg.offline_after_s;
    const rows = await this.env.DB.prepare('SELECT id, name, last_seen FROM servers').all();
    for (const s of rows.results) {
      const isOnline = (s.last_seen || 0) > now - offlineAfter;
      const key = `alert:offline:${s.id}`;
      const last = (await this.state.storage.get(key)) || 'on';
      if (!isOnline && last !== 'off') {
        await this.state.storage.put(key, 'off');
        await sendWebhook(cfg, {
          event: 'offline',
          title: `[cf-panel] ${s.name} 离线`,
          server: { id: s.id, name: s.name },
          message: `服务器 ${s.name}（id=${s.id}）超过 ${offlineAfter}s 未上报，已判定离线。`,
          time: new Date().toISOString(),
        });
      } else if (isOnline && last === 'off') {
        await this.state.storage.put(key, 'on');
        await sendWebhook(cfg, {
          event: 'recovered',
          title: `[cf-panel] ${s.name} 恢复在线`,
          server: { id: s.id, name: s.name },
          message: `服务器 ${s.name}（id=${s.id}）已恢复上报。`,
          time: new Date().toISOString(),
        });
      }
    }
  }

  // alarm：热区行归档（超 60min 落 D1，热区行保留至 12h 供 ≤12h 查询）+ 删除超 12h 的热区行
  // + 每天 D1 保留期清理 + 离线/恢复告警。归档与删除无条件执行，防 ARCHIVE_TO_D1=0 时
  // storage 热区 / audit_logs 无限增长。
  async alarm() {
    const archiveOn = this.env.ARCHIVE_TO_D1 !== '0';
    const alertOn = (await getAlertCfg(this.env)).enabled;
    if (alertOn) await this.checkOfflineAlerts();
    // 归档线（60min）：此前的数据落 D1；热区上限（METRICS_KEEP_MIN=720min）：此前的热区行删除
    const archiveCutoff = Math.floor(Date.now() / 1000 / 60) - ARCHIVE_AFTER_MIN;
    const keepCutoff = Math.floor(Date.now() / 1000 / 60) - METRICS_KEEP_MIN;
    const stmts = [];
    const keysToDelete = [];
    try {
      const keys = await this.listStorage('m:');
      for (const k of keys) {
        const rest = k.name.slice(2); // 去掉 'm:'
        const sep = rest.indexOf(':');
        if (sep <= 0) continue;
        const serverId = Number(rest.slice(0, sep));
        const ts = Number(rest.slice(sep + 1));
        // 归档线以上：写 D1（OR IGNORE 幂等）；热区行保留（不再删 60min 内的行，≤12h 查询完整）
        if (ts <= archiveCutoff && archiveOn) {
          const v = JSON.parse(k.value);
          stmts.push(
            this.env.DB.prepare(
              'INSERT OR IGNORE INTO metrics_min (server_id, ts, cpu, mem_used, mem_total, net_in, net_out, extra) VALUES (?,?,?,?,?,?,?,?)'
            ).bind(serverId, ts, v.cpu, v.mem_used, v.mem_total, v.net_in, v.net_out, v.extra ? JSON.stringify(v.extra) : null)
          );
        }
        // 超过热区上限（12h）：删除 storage 行（防无限增长；D1 已含归档数据）
        if (ts <= keepCutoff) keysToDelete.push(k.name);
      }
    } catch { /* storage 不可用则跳过本次清理（行保留，下次重试） */ }
    // D1 写入成功后才删除 storage 行（防 D1 失败时两端数据丢失）；
    // D1 batch 单次最多 100 条，分批提交（防归档积压/服务器增多后单次超大 batch 超限）
    for (let i = 0; i < stmts.length; i += 100) {
      await this.env.DB.batch(stmts.slice(i, i + 100));
    }
    await Promise.all(keysToDelete.map((name) => this.state.storage.delete(name)));
    // 同步清理内存缓存中超过热区上限的数据
    for (const [, m] of this.data) {
      for (const ts of [...m.keys()]) {
        if (ts <= keepCutoff) m.delete(ts);
      }
    }
    // 保留期清理（每天一次）：删除超过 METRICS_RETENTION_DAYS 的旧数据，以及超过
    // AUDIT_RETENTION_DAYS 的审计日志（created_at 为 datetime('now') 文本，可直接比较）
    const now = Date.now();
    if (now - this.lastPrune > PRUNE_INTERVAL_MS) {
      this.lastPrune = now;
      const minTs = Math.floor(now / 1000 / 60) - METRICS_RETENTION_DAYS * 1440;
      await this.env.DB.batch([
        this.env.DB.prepare('DELETE FROM metrics_min WHERE ts < ?').bind(minTs),
        this.env.DB.prepare('DELETE FROM metrics_custom WHERE ts < ?').bind(minTs),
        this.env.DB.prepare('DELETE FROM audit_logs WHERE created_at < datetime(\'now\', ?)')
          .bind(`-${AUDIT_RETENTION_DAYS} days`),
      ]);
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
    // 内部 RPC：供 TerminalDO 查询当前已鉴权在线观看者数（省配额上报策略用）
    if (url.pathname === '/viewers') {
      const count = (this.state.getWebSockets?.() || []).filter((w) => w.deserializeAttachment?.()).length;
      return json({ count });
    }
    if (url.pathname !== '/ws/push') return new Response('not found', { status: 404 });
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    // 鉴权延迟到首条消息（{type:'auth', token}）：token 不进 URL（防访问日志/浏览器历史泄露）
    pair[1].serializeAttachment(null);
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

  // 客户端首帧鉴权（{type:'auth', token}）；通过后每 3s 的 sync 消息 → 查库 → 按权限过滤回发
  async webSocketMessage(ws, message) {
    // 未鉴权连接：首条消息必须是鉴权帧
    if (!ws.deserializeAttachment?.()) {
      let j = null;
      try { j = JSON.parse(typeof message === 'string' ? message : ''); } catch { /* 非 JSON 视为无效 */ }
      const token = j && j.type === 'auth' ? String(j.token || '') : '';
      const user = await authUserByToken(token, this.env);
      if (!user) {
        try { ws.close(1008, 'unauthorized'); } catch { /* ignore */ }
        return;
      }
      ws.serializeAttachment(token);
      // 首位已鉴权观看者上线 → 各分片 agent 立即切快采（省配额策略，免等下一次上报）
      const authed = (this.state.getWebSockets?.() || []).filter((w) => w.deserializeAttachment?.());
      if (authed.length === 1) this.wakeupAgents();
      return;
    }
    const token = ws.deserializeAttachment() || '';
    const user = await authUserByToken(token, this.env);
    if (!user) return;
    let rows;
    try {
      rows = await queryServersForUser(this.env, user);
    } catch {
      return; // D1 临时故障，下个周期再试
    }
    // 附带每台机器的最新指标（卡片实时展示）
    let latest = {};
    try {
      const lResp = await doMetrics(this.env).fetch('https://do.internal/latest');
      latest = await lResp.json();
    } catch { /* 无最新指标 */ }
    const now = Math.floor(Date.now() / 1000);
    // 本 DO 内直接统计已鉴权观看者（无需额外 RPC）
    const grace = (this.state.getWebSockets?.() || []).filter((w) => w.deserializeAttachment?.()).length > 0
      ? ONLINE_GRACE_FAST_S : ONLINE_GRACE_SLOW_S;
    const list = [];
    for (const s of rows.results) {
      list.push({
        id: s.id,
        name: s.name,
        group: s.group || '',
        display_index: s.display_index || 0,
        online: now - (s.last_seen || 0) < grace, // 观看者在线时快宽限（30s），否则慢宽限（180s）
        wan_ip: s.wan_ip || '',
        info: safeJson(s.info_json),
        probes: safeJson(s.probe_json),
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

// ============================================================
// 测试辅助导出（不参与线上路由，仅供 test/ 目录单元测试使用）
// ============================================================
export const __internals = {
  parsePanelUsers, json, err, secret,
  b64u, b64uDecode, bytesToHex, hmacSha256,
  signJwt, verifyJwt, randomHex, sha256Hex,
  parseRangeHours, safeJson, sanitizeAlerts, hashSecret,
  renderTemplate, parseHeaders, sendWebhook,
  shardForServerId, makeStreamId, shardFromStreamId,
  isAdmin, canAccessServer, canExec, handleReport,
  // 重置模块级可变状态（设置缓存），保证测试间隔离
  // 注：告警冷却/探活去重状态在 MetricsDO 实例内存，由各测试实例自行隔离
  __reset() {
    SETTINGS_CACHE.clear();
    loginFails.clear();
  },
};
