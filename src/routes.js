// cf-panel — 路由层：REST API（handleApi）+ MCP（handleMcp）+ WebSocket 路由（handleWs）
import {
  SCOPE_READ, SCOPE_EXEC, PAT_PREFIX, SHARDS, parsePanelUsers, statsTzOffsetSec,
} from './config.js';

// 本模块专用常量（PAT scope 白名单 / MCP 协议与工具，就近定义便于对照使用代码）
const ALLOWED_SCOPES = [SCOPE_READ, SCOPE_EXEC]; // PAT 合法 scope 白名单
const TOKEN_NAME_UNIQUE_RE = /UNIQUE constraint failed: api_tokens\.name/; // D1 唯一索引（迁移 0010）约束冲突标识
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
  {
    name: 'create_upload',
    description: '创建一次性的文件上传签名 URL（大文件/二进制上传通道，不经过 LLM 上下文）。返回可直接 curl 使用的 POST URL，签名绑定目标服务器、路径与覆盖标志，10 分钟过期。AI 自身无法直接传大文件——把返回的 upload_url 转给用户/程序执行（或指导客户端用 fetch/curl POST 该 URL，body 为原始文件字节，流式分片；默认上限 100MB，可 UPLOAD_MAX_MB 调高）。需 exec 权限。',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'integer', description: '服务器 ID（见 list_servers 返回值中的 id）' },
        server_name: { type: 'string', description: '服务器名称（与 server_id 二选一）' },
        path: { type: 'string', description: '目标绝对路径（如 /opt/app.tar.gz）' },
        overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false（拒绝覆盖）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'add_server',
    description: '注册一台新服务器（面板 D1 记录 + 生成一次性 agent key）。仅管理员。返回 agent_key（明文只返回一次，请妥善保存）与 wss_base 部署信息。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '服务器名称（必填）' },
        group: { type: 'string', description: '分组（可选，默认空=未分组）' },
        sort_order: { type: 'integer', description: '组内排序序号（可选）' },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_server',
    description: '删除一台服务器（清历史监控数据 + 审计 + 断开其 agent 连接）。仅管理员。提供 server_id 或 server_name 之一（重名时须用 server_id）。',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'integer', description: '服务器 ID' },
        server_name: { type: 'string', description: '服务器名称（重名时拒绝，须用 server_id）' },
      },
      required: [],
    },
  },
  {
    name: 'update_server',
    description: '修改服务器名称/分组/排序/告警阈值覆盖。仅管理员。提供 server_id 或 server_name 之一（重名时须用 server_id）；只需传要修改的字段。alert_override 用于逐机覆盖告警阈值（不传=保持不变，传 null=清除覆盖回退全局）。',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'integer', description: '服务器 ID' },
        server_name: { type: 'string', description: '服务器名称（重名时拒绝，须用 server_id）' },
        name: { type: 'string', description: '新名称（可选）' },
        group: { type: 'string', description: '新分组（可选）' },
        sort_order: { type: 'integer', description: '新排序序号（可选）' },
        alert_override: {
          type: 'object',
          description: '逐机告警阈值覆盖（可选）：cpu_pct/mem_pct/disk_pct/offline_after_s 需 >0，load 可设 0 关闭该维度；未出现的键继承全局。传 null 或空对象 = 清除覆盖',
        },
      },
      required: [],
    },
  },
  {
    name: 'rotate_agent_key',
    description: '轮换某台服务器的 agent key（仅管理员）：旧 key 立即失效并断开其现有连接，监控历史与审计记录全部保留——用于 key 泄露或误发后的处置（此前只能删除服务器重建，会清空历史）。返回新 agent_key（明文只返回一次）与 wss_base 部署地址。注意：key 是 agent 侧配置的静态凭据，服务端无法推送，须人工到目标机更新 AGENT_KEY 并重启 agent 后才会重新上线。提供 server_id 或 server_name 之一（重名时须用 server_id）。',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'integer', description: '服务器 ID' },
        server_name: { type: 'string', description: '服务器名称（重名时拒绝，须用 server_id）' },
      },
      required: [],
    },
  },
  {
    name: 'list_tokens',
    description: '列出全部访问令牌（PAT）概要（id/名称/scopes/server_ids/创建时间，不含哈希与明文）。仅管理员。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_token',
    description: '创建访问令牌（PAT）。仅管理员。返回明文 token（只显示一次，请妥善保存）。scopes 合法值：server:read / server:exec（默认 server:read）；server_ids 为空=全部服务器；有效期二选一：expires_in_days（可小数天）或 expires_at（unix 秒，须在未来），均空=永久有效。名称不可与现有令牌重复（同名返回错误）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '令牌名称（必填）' },
        scopes: { type: 'array', items: { type: 'string' }, description: '权限 scope，如 ["server:read"] 或 ["server:read","server:exec"]' },
        server_ids: { type: 'array', items: { type: 'integer' }, description: '服务器白名单（空=全部）' },
        expires_in_days: { type: 'number', description: '有效天数（可小数，0.5=12 小时；可选；缺省=永久有效）' },
        expires_at: { type: 'integer', description: '截止时间 unix 秒（须在未来；与 expires_in_days 二选一，优先）' },
      },
      required: ['name'],
    },
  },
  {
    name: 'revoke_token',
    description: '删除（撤销）访问令牌，立即失效（已建连接 ≤5s 内关闭）。仅管理员。',
    inputSchema: {
      type: 'object',
      properties: { token_id: { type: 'integer', description: '令牌 ID（见 list_tokens）' } },
      required: ['token_id'],
    },
  },
  {
    name: 'get_audit_logs',
    description: '查询审计日志（倒序，保留 90 天）：谁在何时对哪台机器做了什么操作。支持按动作/用户/服务器筛选与分页。仅管理员。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回条数，默认 100，最大 500' },
        offset: { type: 'integer', description: '分页偏移，默认 0' },
        action: { type: 'string', description: '按操作类型精确筛选（如 server.create / exec.command / file.delete）' },
        user: { type: 'string', description: '按用户名模糊筛选' },
        server_id: { type: 'integer', description: '按目标服务器 id 筛选' },
      },
      required: [],
    },
  },
  {
    name: 'get_usage',
    description: '用量观测：近 24h 上报帧 / DO 事件 / D1 写行估算与当日 API 计数（额度评估参考）。仅管理员。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_settings',
    description: '读取面板设置：站点名称/公告/IP 归属地开关/告警 Webhook 配置。仅管理员。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_settings',
    description: '更新面板设置（只传要修改的字段）：site_name（站点名）/notice（公告）/geo_lookup（IP 归属地第三方查询开关）/alerts（告警配置，见 get_settings 当前结构）。仅管理员。',
    inputSchema: {
      type: 'object',
      properties: {
        site_name: { type: 'string', description: '站点名称（留空用默认）' },
        notice: { type: 'string', description: '公告（留空隐藏）' },
        geo_lookup: { type: 'boolean', description: 'IP 归属地查询（将公网 IP 发送到第三方地理服务）' },
        alerts: { type: 'object', description: '告警配置对象（enabled/method/url/token/body/content_type/headers/cpu/mem/disk/load/cooldown_min/offline_after_s/mute_until）。mute_until 为免打扰截止的 unix 秒（计划内重启/割接前设置，到期自动恢复）；阈值类维度还支持逐机覆盖，见 update_server 的 alert_override' },
      },
      required: [],
    },
  },
];
import {
  json, err, requireJwtSecret, signJwt, randomHex, sha256Hex, hashSecret, safeJson,
  kvGet, kvPut, sanitizeAlerts, sanitizeAlertOverride, parseRangeHours, sendWebhookRaw,
  doMetrics, doForShard, doPanel, shardForServerId, makeStreamId, shardFromStreamId,
  signUploadToken, verifyUploadToken,
} from './utils.js';
import { queryMonitorRows, queryCustomMetrics, queryDayStats, kvClearCache } from './db.js';
import { authUser, isAdmin, canAccessServer, canExec, listServersWithState, serverListCache } from './auth.js';
import { serverRowCache, lastSeenWrite, customWritten } from './report.js';

// ---------------- Agent Release / 更新清单 ----------------
const AGENT_MANIFEST_CACHE_MS = 5 * 60 * 1000;
const AGENT_UPDATE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_AGENT_RELEASE_REPO = 'yanghuan/cf-panel';
let agentManifestCache = null; // { at, source, manifest }

export function clearAgentManifestCache() {
  agentManifestCache = null;
}

function agentReleaseRepo(env) {
  const repo = String(env.AGENT_RELEASE_REPO || DEFAULT_AGENT_RELEASE_REPO).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('AGENT_RELEASE_REPO must be owner/repo');
  }
  return repo;
}

async function readJsonLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('agent manifest too large');
  const reader = response.body && response.body.getReader();
  if (!reader) throw new Error('manifest response has no body');
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || !value.length) continue;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error('agent manifest too large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(all));
}

function validateAgentManifest(raw, repo) {
  if (!raw || Number(raw.schema) !== 1 || Number(raw.update_protocol) !== 1) {
    throw new Error('unsupported agent manifest');
  }
  const buildId = String(raw.build_id || '');
  const tag = String(raw.tag || '');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(buildId) || tag !== `cf-panel-agent-${buildId}`) {
    throw new Error('invalid agent manifest version');
  }
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  const assets = {};
  for (const platform of ['linux-x86_64', 'linux-aarch64', 'macos-aarch64', 'windows-x86_64']) {
    const a = raw.assets && raw.assets[platform];
    const name = String(a && a.name || '');
    const size = Number(a && a.size);
    const sha256 = String(a && a.sha256 || '').toLowerCase();
    const url = String(a && a.url || '');
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)
      || !Number.isSafeInteger(size) || size <= 0 || size > AGENT_UPDATE_MAX_BYTES
      || !/^[0-9a-f]{64}$/.test(sha256)
      || url !== `${base}/${encodeURIComponent(name)}`) {
      throw new Error(`invalid agent manifest asset: ${platform}`);
    }
    assets[platform] = { name, size, sha256, url };
  }
  return {
    schema: 1,
    version: String(raw.version || '').slice(0, 64),
    build_id: buildId,
    tag,
    commit: String(raw.commit || '').slice(0, 64),
    update_protocol: 1,
    assets,
  };
}

function isNewerAgentBuild(current, latest) {
  current = String(current || '');
  latest = String(latest || '');
  if (!current || !latest || current === latest) return false;
  const re = /^\d{4}\.\d{2}\.\d{2}-\d{4}/;
  if (re.test(current) && re.test(latest)) return current.slice(0, 16) <= latest.slice(0, 16);
  return true; // Cargo semver/旧格式：允许首次进入统一 build id 体系
}

async function getAgentManifest(env, force = false) {
  const repo = agentReleaseRepo(env);
  const now = Date.now();
  const url = String(env.AGENT_MANIFEST_URL
    || `https://github.com/${repo}/releases/latest/download/agent-manifest.json`);
  if (!force && agentManifestCache && agentManifestCache.source === url
      && now - agentManifestCache.at < AGENT_MANIFEST_CACHE_MS) {
    return agentManifestCache.manifest;
  }
  if (!url.startsWith('https://') && !url.startsWith('http://127.0.0.1')) {
    throw new Error('AGENT_MANIFEST_URL must use https');
  }
  const resp = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'cf-panel-agent-updater' },
    redirect: 'follow',
    cf: { cacheTtl: force ? 0 : 300, cacheEverything: !force }, // 多 isolate/边缘复用；refresh=1 绕过
  });
  if (!resp.ok) throw new Error(`agent manifest fetch failed (${resp.status})`);
  const manifest = validateAgentManifest(await readJsonLimited(resp, 64 * 1024), repo);
  agentManifestCache = { at: now, source: url, manifest };
  return manifest;
}

// ---------------- 登录失败限流 ----------------
// 登录失败限流（应用层纵深防御）。内存窗口按 IP 计数，缓解单 IP 爆破；
// 注意多边缘实例间非全局一致，生产仍建议 Cloudflare Access / Rate Limiting。
const LOGIN_FAIL_LIMIT = 5; // 15 分钟窗口内失败上限
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000; // 超限锁定时长
export const loginFails = new Map(); // ip -> { count, firstAt, lockedUntil }

// 客户端 IP：仅信任 Cloudflare 注入的 cf-connecting-ip。
// 不回退 X-Forwarded-For——本地 wrangler dev/E2E 无 CF 前置时该头可被任意伪造，
// 每请求换 XFF 即绕过登录限流（登录限流/审计 IP 与 do-terminal 的 wan_ip 记录不同，
// 后者仅做展示不影响安全判定，保留 XFF 回退）
function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

// 面板对外基址 / agent 控制通道地址：协议必须跟随当前访问协议。
// 生产（Workers 仅 https）恒为 https/wss；wrangler dev / 本地 http 下是 http/ws——
// 硬编码安全协议会让照抄的 curl / agent 在明文端口上做 TLS 握手而连不上。
// 两者与 host 同源自请求 URL：host 本就取自此处，协议同源派生才不会自相矛盾。
// 注：上传签名载荷只含 serverId|path|overwrite|exp（utils.js signUploadToken），
// 不含 host/协议，故基址协议变化不影响已签发 URL 的验签。
function publicOrigin(url) {
  return `${url.protocol === 'http:' ? 'http' : 'https'}://${url.host}`;
}
function agentWssBase(url) {
  return `${url.protocol === 'http:' ? 'ws' : 'wss'}://${url.host}/ws/agent`;
}

// 通用审计写入（best-effort）：审计是旁路留痕，写入失败绝不得改变主流程结果——
// 否则一次 D1 抖动会让登录/鉴权跟着失败，可用性被旁路系统绑架。
async function auditLog(env, { userId = 0, username = '', ip = '', action, serverId = null, detail = null }) {
  try {
    await env.DB.prepare(
      'INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (?,?,?,?,?,?)'
    ).bind(userId, username, ip, action, serverId, detail).run();
    return true;
  } catch (e) {
    console.error(`audit failed (${action}):`, e);
    return false;
  }
}

// 审计写入节流（按 key，60s 一窗口）：失败路径（密码爆破、无效 token 扫描）由外部
// 反复触发，逐次写一行会把审计表本身变成写放大源——登录接口有限流，但其他鉴权失败
// 入口没有。节流后同一来源同一动作每窗口只留一条，量级足够做安全研判。
const AUDIT_THROTTLE_S = 60;
const auditThrottle = new Map(); // key -> 上次写入秒（实例内存；evict 后仅偶发多写一行）
// 测试隔离：模块级静态状态，跨测试需清空（见 index.js __internals.__reset）
export function __clearAuditThrottle() {
  auditThrottle.clear();
}
async function auditLogThrottled(env, key, fields) {
  const now = Math.floor(Date.now() / 1000);
  const last = auditThrottle.get(key) || 0;
  if (now - last < AUDIT_THROTTLE_S) return false;
  if (auditThrottle.size > 10000) auditThrottle.clear(); // 防 Map 无限增长
  auditThrottle.set(key, now);
  return auditLog(env, fields);
}

// DO 会话创建与 D1 不支持跨资源事务。会话已启动后审计失败时采用 best-effort：
// 记录服务端错误但仍把可用 session 返回客户端，避免"API 500、远端 PTY 已启动"的孤儿会话。
async function auditSessionOpen(env, user, request, action, serverId) {
  try {
    await env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id) VALUES (?,?,?,?,?)')
      .bind(user.id, user.username, clientIp(request), action, serverId)
      .run();
  } catch (e) {
    console.error(`${action} audit failed for server ${serverId}:`, e);
  }
}

// 删除服务器的级联清理（D1 数据 → 上报侧内存状态 → 各 DO 残留）。
// 单删（DELETE /api/servers/:id）与批量删（POST /api/servers/batch op=delete）共用，
// 避免两处级联逻辑漂移——漏掉任何一步都会留下"数据已删但 agent 还连着"的幽灵状态。
// 返回被删服务器名；不存在返回 null（调用方据此区分 404）。
async function deleteServerCascade(env, user, ip, id) {
  const server = await env.DB.prepare('SELECT name FROM servers WHERE id = ?').bind(id).first();
  if (!server) return null;
  // 1) 清历史数据 + 删服务器 + 审计同一事务（D1 batch 原子：任一失败整体回滚，
  // 不再出现"服务器已删但返回 500"或"服务器残留但提示成功"的中间态）
  await env.DB.batch([
    env.DB.prepare('DELETE FROM metrics_min WHERE server_id = ?').bind(id),
    env.DB.prepare('DELETE FROM metrics_custom WHERE server_id = ?').bind(id),
    env.DB.prepare('DELETE FROM metrics_day WHERE server_id = ?').bind(id),
    env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(id),
    env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (?,?,?,?,?,?)')
      .bind(user.id, user.username, ip, 'server.delete', id, server.name),
  ]);
  serverListCacheClear();
  // 2) 清理上报侧残留状态（防内存 Map 随服务器删除无限增长；残留条目本身无害）
  lastSeenWrite.delete(id);
  customWritten.delete(id);
  serverRowCache.delete(id);
  // 3) MetricsDO 清内存热区（避免残留数据被 alarm 重新归档回 D1）
  try {
    await doMetrics(env).fetch('https://do.internal/drop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server_id: id }),
    });
  } catch { /* 热区清理失败不影响删除 */ }
  // 4) 通知各分片 DO 断开该 agent 的常驻控制通道与活跃会话
  for (let i = 0; i < SHARDS; i++) {
    try {
      await doForShard(env, i).fetch('https://do.internal/rpc/drop_server', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serverId: id }),
      });
    } catch { /* 分片暂不可达；agent 重连会因 key 失效被拒 */ }
  }
  // 5) 清 PanelDO 列表缓存（避免已删服务器最多 4.5s 内仍出现在观看者推送列表）
  try {
    await doPanel(env).fetch('https://do.internal/rpc/clear_list_cache', { method: 'POST' });
  } catch { /* 清缓存失败由 listCache TTL 兜底 */ }
  return server.name;
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
// 路径归一化——动态 id/流 id 段替换为占位符，避免 /api/servers/123、/api/tokens/7 等
// 每个实体一条计数（服务器/令牌较多时超 200 条 clear() 全量清零，/api/usage 计数失去趋势意义）
function normalizeApiPath(path) {
  return path
    // 任意层级动态段（/api/servers/123/metrics → /api/servers/:id/metrics）：
    // 旧正则只覆盖单段资源名，嵌套路径会退化为逐实体计数触顶 200 清空（用量失去趋势）
    .replace(/^(\/api\/[a-z-]+(?:\/[a-z-]+)*)\/\d+(?=\/|$)/, '$1/:id')
    .replace(/^(\/ws\/[a-z]+)\/\w+/, '$1/:stream');
}
function countApi(method, path) {
  const key = `${method} ${normalizeApiPath(path)}`;
  apiCounts.set(key, (apiCounts.get(key) || 0) + 1);
  if (apiCounts.size > 200) apiCounts.clear(); // 防 Map 无限增长
}

// ---------------- REST API ----------------

export async function handleApi(request, env) {
  try {
    return await handleApiInner(request, env);
  } catch (e) {
    // 顶层 error boundary：任何未捕获异常（D1 类型错误/约束失败等）返回 JSON 500，
    // 前端可读，不再暴露 CF 裸 500 白屏
    console.error('handleApi unhandled error:', e);
    return err('internal error', 500);
  }
}

async function handleApiInner(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  countApi(method, path);

  // GET /api/healthz —— 存活探针：不鉴权、不查 D1、不碰 DO。
  // 刻意不接触任何依赖：探针的语义是"这个 Worker 是否在正常响应"，
  // 若把 DB/DO 健康度卷进来，一次 D1 抖动会把"面板活着但库慢"误报成"面板挂了"——
  // 后者该由 /api/usage、/api/me 或外部监控分别观测。
  if (method === 'GET' && path === '/api/healthz') {
    return json({ ok: true, ts: Math.floor(Date.now() / 1000) });
  }

  // POST /api/login —— 面板登录（PANEL_USERS 多用户 或 PANEL_PASSWORD 单管理员）
  // 暴力破解防护：应用层按 IP 失败限流（纵深防御，默认生效）；
  // 生产仍强烈建议前置 Cloudflare Access / Rate Limiting（跨边缘实例更一致）。
  if (method === 'POST' && path === '/api/login') {
    const configError = requireJwtSecret(env);
    if (configError) return configError;
    const ip = clientIp(request);
    const lockRemain = loginLockRemaining(ip);
    if (lockRemain != null) {
      // 锁定期间不读请求体（保持既有 DoS 面：超限请求不解析 body），故只留 IP 痕迹
      await auditLogThrottled(env, `login.locked:${ip}`, {
        ip, action: 'login.locked', detail: `retry in ${lockRemain}s`,
      });
      return json({ error: `too many failed logins, retry in ${lockRemain}s` }, 429, { 'retry-after': String(lockRemain) });
    }
    const body = await request.json().catch(() => ({}));
    const inputUsername = String(body.username || '').trim();
    const password = String(body.password || '');
    const users = parsePanelUsers(env);
    if (!users.length) return err('server misconfigured: PANEL_USERS/PANEL_PASSWORD not set', 500);
    // 用户名可选：填写则要求用户名+密码双字段匹配（多用户同密码不再取第一个）；留空仅按密码匹配（单管理员兼容）
    const userIdx = inputUsername
      ? users.findIndex((u) => u.username === inputUsername && u.password === password)
      : users.findIndex((u) => u.password === password);
    if (userIdx < 0) {
      recordLoginFail(ip);
      // 记尝试的用户名（绝不记密码）：区分"撞库特定账号"与"泛扫密码"的关键信号
      await auditLogThrottled(env, `login.failed:${ip}`, {
        username: inputUsername || '(空)', ip, action: 'login.failed',
      });
      return err('bad password', 401);
    }
    loginFails.delete(ip); // 登录成功：清零该 IP 失败计数
    const uid = userIdx + 1;
    const username = users[userIdx].username;
    const token = await signJwt({ uid, username, role: 1, exp: Math.floor(Date.now() / 1000) + 86400 }, env);
    // 成功不节流：登录成功是低频事件，且每次成功都应有完整留痕（谁在何时从哪登录）
    await auditLog(env, { userId: uid, username, ip, action: 'login.success' });
    return json({ token, user: { id: uid, username, role: 1 } });
  }

  // GET /api/public/settings —— 公开配置（D1 kv_json，无需登录）
  if (method === 'GET' && path === '/api/public/settings') {
    const settings = (await kvGet(env, 'settings', {})) || {};
    return json({ site_name: settings.site_name || 'cf-panel', notice: settings.notice || '', geo_lookup: !!settings.geo_lookup });
  }

  // ---- 以下全部需要登录（JWT 或 PAT）----
  // JWT_SECRET 是整个面板鉴权的必需安全边界；缺失时 PAT 也不得绕过配置错误继续访问。
  const configError = requireJwtSecret(env);
  if (configError) return configError;
  const ip = clientIp(request);
  const user = await authUser(request, env);
  if (!user) {
    // 无效/过期/已撤销凭据的探测此前完全无痕。路径经归一化（动态 id → :id），
    // 既保留"在扫哪个接口"的情报，又不把实体 id 写进审计。
    await auditLogThrottled(env, `auth.failed:${ip}`, {
      ip, action: 'auth.failed', detail: `${method} ${normalizeApiPath(path)}`,
    });
    return err('unauthorized', 401);
  }

  // GET /api/me —— 当前用户
  if (method === 'GET' && path === '/api/me') {
    return json({ id: user.id, username: user.username, role: user.role, is_pat: !!user.pat, scopes: user.pat ? user.pat.scopes : null });
  }

  // GET /api/servers —— 服务器列表（权限过滤由 queryServersForUser 在 SQL 层完成；列表短 TTL 缓存降读放大）
  if (method === 'GET' && path === '/api/servers') {
    return json(await listServersWithState(env, user));
  }

  // GET /api/agent/latest —— 最新 Agent 更新清单（仅管理员；5min 模块缓存，避免每卡查 GitHub）
  if (method === 'GET' && path === '/api/agent/latest') {
    if (!isAdmin(user)) return err('forbidden', 403);
    try {
      const manifest = await getAgentManifest(env, url.searchParams.get('refresh') === '1');
      return json({
        version: manifest.version,
        build_id: manifest.build_id,
        commit: manifest.commit,
        update_protocol: manifest.update_protocol,
        platforms: Object.keys(manifest.assets),
      });
    } catch (e) {
      return err(`agent release unavailable: ${e.message}`, 502);
    }
  }

  // POST /api/servers/:id/agent-update —— 管理员触发专用更新协议。
  // Worker 流式中转 Release 资产，不物化整个二进制；Agent 做大小/SHA/版本复核后 self-replace。
  const updateMatch = path.match(/^\/api\/servers\/(\d+)\/agent-update$/);
  if (method === 'POST' && updateMatch) {
    if (!isAdmin(user)) return err('forbidden', 403); // PAT（即使 server:exec）也不得升级 Agent
    const id = Number(updateMatch[1]) || 0;
    const server = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first();
    if (!server) return err('server not found', 404);
    const info = safeJson(server.info_json) || {};
    if (Number(info.update_protocol) < 1 || !info.self_update_enabled) {
      return err('agent does not support self update or ALLOW_SELF_UPDATE is disabled', 409);
    }
    const platform = String(info.agent_platform || '');
    let manifest;
    try {
      manifest = await getAgentManifest(env);
    } catch (e) {
      return err(`agent release unavailable: ${e.message}`, 502);
    }
    const asset = manifest.assets[platform];
    if (!asset) return err(`no release asset for platform ${platform || 'unknown'}`, 409);
    if (String(info.agent_version || '') === manifest.build_id) {
      return json({ ok: true, already_latest: true, build_id: manifest.build_id });
    }
    if (!isNewerAgentBuild(info.agent_version, manifest.build_id)) {
      return err(`current agent ${info.agent_version} is newer than latest release ${manifest.build_id}`, 409);
    }

    // 更新是高权限供应链操作：审计写失败则 fail closed，不执行远端替换。
    await env.DB.prepare(
      'INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (?,?,?,?,?,?)'
    ).bind(user.id, user.username, clientIp(request), 'agent.update.request', id,
      `${info.agent_version || 'unknown'} → ${manifest.build_id} (${platform})`).run();
    const auditUpdateResult = async (action, detail) => {
      try {
        await env.DB.prepare(
          'INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (?,?,?,?,?,?)'
        ).bind(user.id, user.username, clientIp(request), action, id, String(detail).slice(0, 300)).run();
      } catch { /* request 审计已存在，结果审计 best effort */ }
    };

    let assetResp;
    try {
      assetResp = await fetch(asset.url, {
        headers: { accept: 'application/octet-stream', 'user-agent': 'cf-panel-agent-updater' },
        redirect: 'follow',
        cf: { cacheTtl: 86400, cacheEverything: true }, // 同版本多机更新复用边缘缓存
      });
    } catch (e) {
      await auditUpdateResult('agent.update.failed', `asset download: ${e.message}`);
      return err(`agent asset download failed: ${e.message}`, 502);
    }
    if (!assetResp.ok || !assetResp.body) {
      await auditUpdateResult('agent.update.failed', `asset download HTTP ${assetResp.status}`);
      return err(`agent asset download failed (${assetResp.status})`, 502);
    }
    const contentLength = Number(assetResp.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== asset.size) {
      try { await assetResp.body.cancel(); } catch { /* ignore */ }
      await auditUpdateResult('agent.update.failed', 'asset size differs from manifest');
      return err('agent asset size differs from manifest', 502);
    }

    const stub = doForShard(env, shardForServerId(id));
    let result;
    try {
      const resp = await stub.fetch(
        `https://do.internal/rpc/agent_update?server_id=${id}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'x-agent-build-id': manifest.build_id,
            'x-agent-platform': platform,
            'x-agent-size': String(asset.size),
            'x-agent-sha256': asset.sha256,
          },
          body: assetResp.body,
          duplex: 'half', // ReadableStream request body（Node 测试/标准 Fetch 要求；Workers 忽略或支持）
        }
      );
      result = await resp.json().catch(() => ({ error: `update failed (${resp.status})` }));
      if (!resp.ok) {
        await auditUpdateResult('agent.update.failed', result.error || `HTTP ${resp.status}`);
        return json({ error: result.error || 'agent update failed' }, resp.status);
      }
    } catch (e) {
      await auditUpdateResult('agent.update.failed', `relay: ${e.message}`);
      return err(`agent update relay failed: ${e.message}`, 502);
    }
    await auditUpdateResult(
      'agent.update.installed',
      `${info.agent_version || 'unknown'} → ${manifest.build_id}`
    );
    serverListCacheClear();
    return json({ ...result, build_id: manifest.build_id });
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
    // 服务器 + 审计同一事务（D1 batch 原子）：audit 失败时整体回滚，不再"操作已生效但返回 500"
    await env.DB.batch([
      env.DB.prepare('INSERT INTO servers (agent_key_id, name, "group", display_index, user_id, agent_key_hash) VALUES (?,?,?,?,?,?)')
        .bind(keyId, name, group, displayIndex, user.id, hash),
      env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action) VALUES (?,?,?,?)')
        .bind(user.id, user.username, clientIp(request), 'server.create'),
    ]);
    serverListCacheClear();
    return json({
      agent_key: key,
      wss_base: agentWssBase(url),
    });
  }

  // POST /api/servers/batch —— 批量操作（仅管理员）：机器规模上来后的高频运维动作。
  // 支持 update-group（批量归入分组）/ delete（批量下线）。
  // 刻意不收 agent-update：更新是"关会话 + 传二进制 + 远端自替换"的高危串行操作，
  // 前端逐台串行调用单接口更可控（能看到每台进度与失败原因、天然互斥），
  // 塞进批量只会让"部分失败"的语义变模糊。
  // 返回逐项结果而非整体成败：批量天然允许部分失败（某台已被删/不存在），
  // 前端需要知道"哪几台成了"，而不是一个笼统的 500。
  if (method === 'POST' && path === '/api/servers/batch') {
    if (!isAdmin(user)) return err('forbidden', 403);
    const body = await request.json().catch(() => ({}));
    const op = String(body.op || '');
    const ids = Array.isArray(body.ids)
      ? [...new Set(body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];
    if (!['update-group', 'delete'].includes(op)) return err('invalid op (update-group | delete)', 400);
    if (!ids.length) return err('ids required', 400);
    if (ids.length > 100) return err('too many ids (max 100)', 400);

    const results = [];
    if (op === 'update-group') {
      const group = String(body.group || '').trim();
      if (group.length > 100) return err('group too long', 400);
      // 单事务：全成功或全回滚。分组是列表的展示维度，部分生效会让列表呈现撕裂态
      const stmts = ids.map((id) => env.DB.prepare('UPDATE servers SET "group" = ? WHERE id = ?').bind(group, id));
      stmts.push(
        env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, detail) VALUES (?,?,?,?,?)')
          .bind(user.id, user.username, ip, 'server.batch_update_group', `${ids.length} 台 → ${group || '未分组'}（ids=${ids.join(',')}）`),
      );
      await env.DB.batch(stmts);
      serverListCacheClear();
      results.push(...ids.map((id) => ({ id, ok: true })));
    } else if (op === 'delete') {
      // 逐台串行：级联清理含多次 DO 调用，并发会让分片 drop_server 互相踩踏；
      // 删除是低频人工操作，串行开销可忽略，换取清晰的错误归因
      for (const id of ids) {
        try {
          const name = await deleteServerCascade(env, user, ip, id);
          results.push(name === null ? { id, ok: false, error: 'not found' } : { id, ok: true, name });
        } catch (e) {
          results.push({ id, ok: false, error: String((e && e.message) || e).slice(0, 200) });
        }
      }
    }
    const failed = results.filter((r) => !r.ok).length;
    return json({
      ok: failed === 0,
      op,
      results,
      summary: { total: results.length, success: results.length - failed, failed },
    });
  }

  // POST /api/servers/:id/rotate-key —— 轮换 agent key（仅管理员）。
  // 用途：key 泄露/误发后的处置路径。此前唯一手段是删服务器重建，会连带清空
  // metrics_min / metrics_custom 全部监控历史与在线账；轮换只替换身份凭证，
  // 历史数据、分组、序号、审计记录全部保留。
  // 旧 key 立即失效：agent_key_id（key 指纹）变更 → 反查不到服务器 → 401；
  // 已建立的旧控制通道由 drop_server 主动断开（与删除路径同一机制，但不删任何数据）。
  // 注意：轮换后须人工到目标机更新 AGENT_KEY 并重启 agent——key 是 agent 侧配置的静态凭据，
  // 服务端无法推送新 key 给未连接的 agent。
  const rotateMatch = path.match(/^\/api\/servers\/(\d+)\/rotate-key$/);
  if (method === 'POST' && rotateMatch) {
    if (!isAdmin(user)) return err('forbidden', 403);
    const id = Number(rotateMatch[1]) || 0;
    const server = await env.DB.prepare('SELECT id, name FROM servers WHERE id = ?').bind(id).first();
    if (!server) return err('not found', 404);
    const key = randomHex(32);
    const keyId = await sha256Hex(key);
    const hash = await hashSecret(key, env);
    // 更新 + 审计同一事务（D1 batch 原子）：轮换是安全处置动作，
    // 绝不允许出现"key 已换但没有审计留痕"的取证空白
    await env.DB.batch([
      env.DB.prepare('UPDATE servers SET agent_key_id = ?, agent_key_hash = ? WHERE id = ?')
        .bind(keyId, hash, id),
      env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (?,?,?,?,?,?)')
        .bind(user.id, user.username, ip, 'server.rotate_key', id, server.name),
    ]);
    serverListCacheClear();
    serverRowCache.delete(id); // 行缓存不含 key，但节点身份已变，避免陈旧行影响上报路径
    for (let i = 0; i < SHARDS; i++) {
      try {
        await doForShard(env, i).fetch('https://do.internal/rpc/drop_server', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ serverId: id }),
        });
      } catch { /* 分片暂不可达；旧 key 重连会因指纹不存在被 401 拒绝 */ }
    }
    return json({ agent_key: key, wss_base: agentWssBase(url) });
  }

  // PATCH /api/servers/:id —— 仅管理员；修改名称/分组/序号/告警覆盖（不动 agent key，在线状态不受影响）
  if (method === 'PATCH' && path.startsWith('/api/servers/')) {
    if (!isAdmin(user)) return err('forbidden', 403);
    const id = Number(path.split('/')[3]) || 0;
    const server = await env.DB.prepare('SELECT name, "group", display_index, alert_override FROM servers WHERE id = ?').bind(id).first();
    if (!server) return err('not found', 404);
    const body = await request.json().catch(() => ({}));
    const name = body.name !== undefined ? String(body.name).trim() : server.name;
    if (!name) return err('name required');
    const group = body.group !== undefined ? String(body.group).trim() : server.group;
    const displayIndex = body.sort_order !== undefined ? Number(body.sort_order) || 0 : server.display_index;
    // alert_override：传 null/空对象 = 清除覆盖回退全局；不传该字段 = 保持原值不变。
    // 清洗后全非法 → null（不存噪音，按全局阈值判定）
    let overrideJson = server.alert_override;
    if (body.alert_override !== undefined) {
      const cleaned = sanitizeAlertOverride(body.alert_override);
      overrideJson = cleaned ? JSON.stringify(cleaned) : null;
    }
    // 更新 + 审计同一事务（D1 batch 原子）
    await env.DB.batch([
      env.DB.prepare('UPDATE servers SET name = ?, "group" = ?, display_index = ?, alert_override = ? WHERE id = ?')
        .bind(name, group, displayIndex, overrideJson, id),
      env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (?,?,?,?,?,?)')
        .bind(user.id, user.username, clientIp(request), 'server.update', id, `${server.name} → ${name}`),
    ]);
    serverListCacheClear();
    // 覆盖值随上报帧下发（report.js 行缓存），显式清缓存使它立即生效而非等 60s TTL
    serverRowCache.delete(id);
    return json({
      ok: true, id, name, group, display_index: displayIndex, alert_override: safeJson(overrideJson),
    });
  }

  // DELETE /api/servers/:id —— 仅管理员；级联清理（D1 历史数据 + 各 DO 残留 + 审计）
  if (method === 'DELETE' && path.startsWith('/api/servers/')) {
    if (!isAdmin(user)) return err('forbidden', 403);
    const id = Number(path.split('/')[3]) || 0;
    const name = await deleteServerCascade(env, user, ip, id);
    if (name === null) return err('not found', 404);
    return json({ ok: true });
  }

  // GET /api/usage —— 用量观测（仅管理员）：Worker 请求计数 + MetricsDO 上报/查询计数（近 24h 估算参考）
  if (method === 'GET' && path === '/api/usage') {
    if (!isAdmin(user)) return err('forbidden', 403);
    return json(await collectUsageView(env));
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
      body: JSON.stringify({ op: 'create', streamId, serverId: server.id, creatorUserId: user.id, creatorUser: user.username, clientIp: clientIp(request) }),
    });
    if (!resp.ok) return err(`agent not reachable: ${await resp.text()}`, 502);
    await auditSessionOpen(env, user, request, 'terminal.open', server.id);
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
      body: JSON.stringify({ op: 'open_file', streamId, serverId: server.id, creatorUserId: user.id, creatorUser: user.username, clientIp: clientIp(request) }),
    });
    if (!resp.ok) return err(`agent not reachable: ${await resp.text()}`, 502);
    await auditSessionOpen(env, user, request, 'file.open', server.id);
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

  // GET /api/stats?server_id=&days= —— 按天统计（流量累计 / 可用率 / 重启次数）
  // 数据源 metrics_day（1 行/机/天，保留 3 年），与 /api/monitor（分钟级、30 天、7 天后降采样）
  // 是两个量级的账：月度流量与可用率必须查天账——分钟表跨不了月，且离线期间无行。
  // days 默认 30，上限 1095（= 天账保留期 3 年），防超大区间拖慢查询
  if (method === 'GET' && path === '/api/stats') {
    const serverId = Number(url.searchParams.get('server_id')) || 0;
    const days = Math.min(Math.max(Math.floor(Number(url.searchParams.get('days'))) || 30, 1), 1095);
    const s = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(serverId).first();
    if (!s) return err('not found', 404);
    if (!canAccessServer(user, s)) return err('forbidden', 403);
    const offset = statsTzOffsetSec(env);
    const rows = await queryDayStats(env, serverId, days, offset);
    const total = rows.reduce((acc, r) => {
      acc.bytes_in += r.bytes_in || 0;
      acc.bytes_out += r.bytes_out || 0;
      acc.online_min += r.online_min || 0;
      acc.total_min += r.total_min || 0;
      acc.restarts += r.restarts || 0;
      return acc;
    }, { bytes_in: 0, bytes_out: 0, online_min: 0, total_min: 0, restarts: 0 });
    return json({
      server: { id: s.id, name: s.name },
      days,
      tz_offset_s: offset, // 前端据此还原"天"的本地日期边界
      rows,
      summary: {
        ...total,
        availability: total.total_min > 0 ? (total.online_min / total.total_min) * 100 : null,
      },
    });
  }

  // ---- PAT 管理（仅管理员）----
  if (path === '/api/tokens') {
    if (!isAdmin(user)) return err('forbidden', 403);
    if (method === 'GET') {
      const rows = await env.DB.prepare('SELECT id, name, scopes, server_ids, expires_at, last_used_at, created_at FROM api_tokens ORDER BY id').all();
      return json(rows.results);
    }
    if (method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || '').trim();
      if (!name) return err('name required');
      // 同名令牌拒绝：前置查询快速失败 + 唯一索引（迁移 0010）兜底并发竞态；与 MCP create_token 一致
      const dup = await env.DB.prepare('SELECT id FROM api_tokens WHERE name = ?').bind(name).first();
      if (dup) return err('token name already exists', 409);
      // scopes 白名单校验：只允许 server:read / server:exec，非法值直接拒绝
      let scopes;
      if (Array.isArray(body.scopes) && body.scopes.length) {
        scopes = [...new Set(body.scopes.filter((s) => ALLOWED_SCOPES.includes(s)))];
        if (!scopes.length) return err(`invalid scope, allowed: ${ALLOWED_SCOPES.join(', ')}`, 400);
      } else {
        scopes = [SCOPE_READ];
      }
      const serverIDs = Array.isArray(body.server_ids) ? body.server_ids.map(Number).filter((n) => n > 0) : null;
      // 有效期二选一：expires_at（unix 秒绝对截止，须在未来，优先）或 expires_in_days
      // （可小数天，0.5=12 小时）；都缺省/0/非法 → 永久有效。取整放最外层避免整数列落 REAL
      const nowSec = Math.floor(Date.now() / 1000);
      const days = Number(body.expires_in_days);
      let expiresAt = Number.isFinite(days) && days > 0 ? Math.floor(nowSec + days * 86400) : null;
      if (body.expires_at !== undefined && body.expires_at !== null && body.expires_at !== '') {
        const at = Number(body.expires_at);
        if (!Number.isFinite(at) || at <= nowSec) return err('expires_at must be a future unix timestamp', 400);
        expiresAt = Math.floor(at);
      }
      const token = PAT_PREFIX + randomHex(32);
      const hash = await hashSecret(token, env);
      try {
        await env.DB.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scopes, server_ids, expires_at) VALUES (?,?,?,?,?,?)')
          .bind(user.id, name, hash, JSON.stringify(scopes), serverIDs ? JSON.stringify(serverIDs) : null, expiresAt)
          .run();
      } catch (e) {
        // 并发竞态兜底：前置查重通过后被并发请求抢先插入（唯一索引迁移 0010 拒绝）
        if (TOKEN_NAME_UNIQUE_RE.test(String(e && e.message))) return err('token name already exists', 409);
        throw e;
      }
      return json({ token, expires_at: expiresAt }); // 明文只返回一次
    }
    return err('method not allowed', 405);
  }
  if (method === 'DELETE' && path.startsWith('/api/tokens/')) {
    if (!isAdmin(user)) return err('forbidden', 403);
    const id = Number(path.split('/')[3]) || 0;
    const res = await env.DB.prepare('DELETE FROM api_tokens WHERE id = ?').bind(id).run();
    if (!res.meta.changes) return err(`token not found (id=${id})`, 404);
    // PAT 撤销即时生效：清 PanelDO 鉴权缓存，已建观看者连接下个推送（≤5s）内关闭
    try {
      await doPanel(env).fetch('https://do.internal/rpc/clear_auth_cache', { method: 'POST' });
    } catch { /* 清缓存失败由 authCache 30s TTL 兜底 */ }
    return json({ ok: true });
  }

  // GET /api/audit-logs —— 审计日志（仅管理员，倒序分页 + 筛选 + CSV 导出，保留 90 天）
  // 参数：limit（默认 100 最大 500）、offset（分页偏移）、action（精确匹配）、user（用户名模糊）、
  //       server_id（数字）、format=csv（导出，text/csv 附件）
  if (method === 'GET' && path === '/api/audit-logs') {
    if (!isAdmin(user)) return err('forbidden', 403);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const action = String(url.searchParams.get('action') || '').trim();
    const userName = String(url.searchParams.get('user') || '').trim();
    const serverId = Number(url.searchParams.get('server_id')) || 0;
    // WHERE 条件全部参数化（无用户输入拼进 SQL）
    const conds = [];
    const binds = [];
    if (action) { conds.push('action = ?'); binds.push(action); }
    if (userName) { conds.push('username LIKE ?'); binds.push(`%${userName}%`); }
    if (serverId) { conds.push('target_server_id = ?'); binds.push(serverId); }
    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
    if (url.searchParams.get('format') === 'csv') {
      // CSV 导出：全量（不分页，上限 5000 防响应过大）
      const csvRows = await env.DB.prepare(
        `SELECT id, user_id, username, client_ip, action, target_server_id, detail, created_at FROM audit_logs${where} ORDER BY id DESC LIMIT 5000`
      ).bind(...binds).all();
      // CSV 公式注入防护：detail（exec 命令/文件路径/服务器名）等用户可控字段以 = + - @ \t \r
      // 开头时，Excel/WPS 打开会当公式执行——前缀单引号强制按文本解析（RFC 4180 双引号转义仍保留）
      const esc = (v) => {
        let s = String(v == null ? '' : v);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return `"${s.replace(/"/g, '""')}"`;
      };
      const header = 'id,user_id,username,client_ip,action,target_server_id,detail,created_at';
      const lines = csvRows.results.map((r) => [r.id, r.user_id, r.username, r.client_ip, r.action, r.target_server_id, r.detail, r.created_at].map(esc).join(','));
      return new Response([header, ...lines].join('\n'), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="audit-logs.csv"',
        },
      });
    }
    const [rows, totalRow] = await Promise.all([
      env.DB.prepare(`SELECT id, user_id, username, client_ip, action, target_server_id, detail, created_at FROM audit_logs${where} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all(),
      env.DB.prepare(`SELECT COUNT(*) AS c FROM audit_logs${where}`).bind(...binds).first(),
    ]);
    return json({ rows: rows.results, total: Number(totalRow?.c || 0) });
  }

  // POST /api/settings/test_webhook —— 测试 Webhook（仅管理员；传当前弹窗表单值，不保存配置）
  // 回显 HTTP 状态码，供用户验证模板化配置（占位符/Headers/Body）是否正确
  if (method === 'POST' && path === '/api/settings/test_webhook') {
    if (!isAdmin(user)) return err('forbidden', 403);
    const body = await request.json().catch(() => ({}));
    const cfg = sanitizeAlerts(body.alerts || {});
    if (!cfg.webhook_url) return err('webhook_url required（请先填写 Webhook 地址）', 400);
    cfg.enabled = true; // sanitizeAlerts 输出无 enabled（空 url 即禁用）；测试入口显式开启
    const result = await sendWebhookRaw(cfg, {
      event: 'test',
      title: '[cf-panel] Webhook 测试通知',
      message: '这是一条测试通知：告警配置验证成功。',
      time: new Date().toISOString(),
    });
    return json(result);
  }

  // ---- 分组排序（kv_json group_order = 组名数组，下标即顺序） ----
  // 读：所有登录用户（排序影响所有观看者的展示）；写：仅管理员。
  // 未在数组中的组追加在尾部按名称排；「未分组」固定最后（前端 groupList 处理）。
  if (method === 'GET' && path === '/api/group-order') {
    const order = await kvGet(env, 'group_order', []);
    return json({ order: Array.isArray(order) ? order : [] });
  }
  if (method === 'PUT' && path === '/api/group-order') {
    if (!isAdmin(user)) return err('forbidden', 403);
    const body = await request.json().catch(() => ({}));
    if (!Array.isArray(body.order)) return err('order array required');
    const seen = new Set();
    const cleaned = [];
    for (const g of body.order) {
      const name = String(g || '').trim();
      if (!name || name === '未分组' || seen.has(name)) continue; // 去空/去重/未分组固定最后不入表
      seen.add(name);
      cleaned.push(name);
    }
    if (cleaned.length > 200) return err('too many groups');
    // 与现存分组求交（保持提交顺序）：孤儿组名（已改名/组内已空）自动清理
    const rows = await env.DB.prepare('SELECT DISTINCT "group" FROM servers').all();
    const live = new Set((rows.results || []).map((r) => r.group).filter(Boolean));
    const order = cleaned.filter((g) => live.has(g));
    await kvPut(env, 'group_order', order);
    return json({ ok: true, order });
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

// 上传公共转发：流式转发到 TerminalDO（body 保持原始流，DO 内切分片）；query 参数原样传递。
// 两条鉴权路径（Bearer JWT/PAT 与签名 URL）共用同一管道。
function forwardUpload(env, request, serverId) {
  const target = new URL(request.url);
  target.protocol = 'https:';
  target.hostname = 'do.internal';
  target.pathname = '/rpc/upload'; // DO 内部 RPC 路径（/api/file_upload 仅面板入口）
  return doForShard(env, shardForServerId(serverId)).fetch(target.toString(), request);
}

// 签名 URL 直传（MCP create_upload 签发）：HMAC 验签无状态自验证，无需 Bearer。
// 审计已在 create_upload 时记录（file.upload），此处不重复。
async function handleUploadSigned(request, env, u) {
  const serverId = Number(u.searchParams.get('server_id')) || 0;
  const targetPath = u.searchParams.get('path') || '';
  const overwrite = u.searchParams.get('overwrite') === '1';
  if (!serverId) return err('server_id is required', 400);
  if (!targetPath || !targetPath.startsWith('/')) return err('path is required (absolute)', 400);
  const v = await verifyUploadToken(u.searchParams.get('token') || '', serverId, targetPath, overwrite, env);
  if (!v.ok) return err(v.error, 403);
  return forwardUpload(env, request, serverId);
}

// 服务器增删改后清列表缓存（serverListCache 在 auth.js）
function serverListCacheClear() {
  serverListCache.clear(); // 服务器增删改后立即使列表缓存失效
  serverRowCache.clear(); // 行缓存同步失效
}

// 用量观测公共构建（REST /api/usage 与 MCP get_usage 共用，避免两处重复实现漂移）：
// Worker 请求计数（实例级）+ MetricsDO 上报/查询计数（10min alarm 汇总，跨 evict 保留）
async function collectUsageView(env) {
  let doUsage = {};
  try {
    doUsage = await (await doMetrics(env).fetch('https://do.internal/usage')).json();
  } catch { /* 用量读取失败不影响 */ }
  const reportFrames = Number(doUsage.persisted?.report || 0);
  const api = {};
  for (const [k, v] of apiCounts) api[k] = v;
  return {
    note: 'Worker 计数为实例级（evict/重启清零，趋势参考）；MetricsDO 计数每 10 分钟 alarm 汇总到 storage（跨 evict 保留）。',
    api,
    metrics_do: doUsage,
    estimates_per_day: {
      report_frames: reportFrames, // 上报帧：快采 17,280/天/机、慢采 720/天/机
      do_events: reportFrames * 2, // 每帧上报链约 2 个 DO 事件（report + 推送/告警顺风车）
      d1_writes: Math.round(reportFrames * 0.5), // last_seen 60s 节流(~0.08/帧) + custom 去重 + info/probe 变更
    },
  };
}

// ---------------- MCP（Model Context Protocol）----------------
// 无状态 Streamable HTTP：/mcp 仅 POST，每请求独立 Bearer 鉴权（JWT/PAT），复用现有数据查询

function mcpResult(id, result, error, origin) {
  const payload = { jsonrpc: '2.0' };
  if (error) payload.error = error;
  else payload.result = result;
  if (id !== null && id !== undefined) payload.id = id;
  return new Response(JSON.stringify(payload), {
    status: error && !result ? 400 : 200,
    headers: {
      'content-type': 'application/json',
      // 有 Origin 头（浏览器跨域）回显 origin + Vary（缓存正确性）；无 Origin（curl/MCP 客户端）保持 '*' 兼容
      ...(origin
        ? { 'access-control-allow-origin': origin, vary: 'Origin' }
        : { 'access-control-allow-origin': '*' }),
    },
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
      swap_total_bytes: s.metric.extra && s.metric.extra.swap_total,
      temp_c: s.metric.extra && s.metric.extra.temp,
      procs: s.metric.extra && s.metric.extra.procs,
      tcp_conns: s.metric.extra && s.metric.extra.tcp,
      udp_conns: s.metric.extra && s.metric.extra.udp,
    } : null,
  }));
}

// 工具：在 agent 上执行一次性命令（经 TerminalDO 控制通道，等待 exec_result）
// 鉴权：管理员或 PAT 带 server:exec scope 且命中 server_ids 白名单（canExec）
async function mcpExecCommand(user, env, args, ip) {
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
  // exec 是全项目权限最高、最需留痕的写操作（此前是全项目唯一无审计记录的命令执行）。
  // detail 存截断命令（200 字符）+ exit_code；审计失败不影响命令结果
  const commandTrunc = command.length > 200 ? command.slice(0, 200) + '…' : command;
  try {
    await env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (?,?,?,?,?,?)')
      .bind(user.id, user.username, ip, 'exec.command', server.id, `exit=${typeof result.exit_code === 'number' ? result.exit_code : '?'} ${commandTrunc}`)
      .run();
  } catch (e) { /* 审计失败不影响命令结果 */ }
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

// 工具：创建一次性上传签名 URL（大文件上传通道，不经过 LLM 上下文）。
// HMAC 签名无状态自验证（绑定 server_id/path/overwrite/exp，10 分钟过期）；
// AI 把 upload_url 转给用户/程序执行（curl POST body 为原始字节），服务端自动分片写 agent。
async function mcpCreateUpload(user, env, args, url, ip) {
  const serverId = Number(args.server_id) || 0;
  const path = String(args.path || '').trim();
  if (!path || !path.startsWith('/')) throw new Error('path is required (absolute)');
  let server = null;
  if (serverId) {
    server = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(serverId).first();
  } else if (args.server_name) {
    // 写操作：重名时拒绝静默取第一条（防在错误的机器上写入）
    const rows = await env.DB.prepare('SELECT * FROM servers WHERE name = ?').bind(String(args.server_name)).all();
    if (rows.results.length > 1) {
      throw new Error(
        `ambiguous server_name "${args.server_name}": matches ${rows.results.length} servers (ids: ${rows.results.map((r) => r.id).join(', ')}); use server_id to disambiguate`
      );
    }
    server = rows.results[0] || null;
  }
  if (!server) throw new Error('server not found（请先用 list_servers 确认 id 或名称）');
  if (!canExec(user, server)) throw new Error(`no exec permission on server ${server.id} (${server.name})`);
  const overwrite = !!args.overwrite;
  const { token, exp } = await signUploadToken(server.id, path, overwrite, env);
  const q = new URLSearchParams({ server_id: String(server.id), path, overwrite: overwrite ? '1' : '0', token });
  // 上传通道走 /mcp/file_upload（/mcp 前缀为 CF Access 放行区，签名 URL 供 curl 直传不受拦截）
  const uploadUrl = `${publicOrigin(url)}/mcp/file_upload?${q.toString()}`;
  // 审计在签发时记录（实际 curl 上传经签名 URL 直传，不再重复记录）
  await env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (?,?,?,?,?,?)')
    .bind(user.id, user.username, ip, 'file.upload', server.id, path)
    .run();
  return {
    server_id: server.id,
    server_name: server.name,
    path,
    overwrite,
    expires_at: exp, // unix 秒
    expires_in_seconds: Math.max(0, exp - Math.floor(Date.now() / 1000)),
    upload_url: uploadUrl,
    usage: `curl -X POST '${uploadUrl}' --data-binary @<本地文件>  # body 为原始文件字节，流式分片（默认上限 100MB，可 UPLOAD_MAX_MB 调高）`,
  };
}

// ---- 管理类工具（仅管理员：JWT 登录，PAT 一律拒绝；复用 REST API 语义）----

// 按 server_id 或 server_name 定位服务器（重名拒绝，防在错误的机器上操作）。
// 参数缺失前置校验：delete_server 这类破坏性操作上「缺参」与「目标不存在」必须区分，
// 否则 AI 客户端无法自纠（缺参报 not found 会误导去查服务器列表）
async function mcpFindServer(env, args) {
  const serverId = Number(args.server_id) || 0;
  const hasName = !!(args.server_name && String(args.server_name).trim());
  if (!serverId && !hasName) {
    throw new Error('server_id 或 server_name 必须提供其一（destructive 操作建议用 server_id）');
  }
  let server = null;
  if (serverId) {
    server = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(serverId).first();
  } else if (args.server_name) {
    const rows = await env.DB.prepare('SELECT * FROM servers WHERE name = ?').bind(String(args.server_name)).all();
    if (rows.results.length > 1) {
      throw new Error(
        `ambiguous server_name "${args.server_name}": matches ${rows.results.length} servers (ids: ${rows.results.map((r) => r.id).join(', ')}); use server_id to disambiguate`
      );
    }
    server = rows.results[0] || null;
  }
  if (!server) throw new Error('server not found（请先用 list_servers 确认 id 或名称）');
  return server;
}

// 仅管理员守卫（管理类工具 PAT 一律拒绝）
function requireAdmin(user) {
  if (!isAdmin(user)) throw new Error('forbidden: admin only');
}

async function mcpAddServer(user, env, args, ip, url) {
  requireAdmin(user);
  const name = String(args.name || '').trim();
  if (!name) throw new Error('name required');
  const group = String(args.group || '').trim();
  const displayIndex = Number(args.sort_order) || 0;
  const key = randomHex(32);
  const keyId = await sha256Hex(key);
  const hash = await hashSecret(key, env);
  // 服务器 + 审计同一事务（D1 batch 原子）
  await env.DB.batch([
    env.DB.prepare('INSERT INTO servers (agent_key_id, name, "group", display_index, user_id, agent_key_hash) VALUES (?,?,?,?,?,?)')
      .bind(keyId, name, group, displayIndex, user.id, hash),
    env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action) VALUES (?,?,?,?)')
      .bind(user.id, user.username, ip, 'server.create'),
  ]);
  serverListCacheClear();
  // 回查 id（不依赖 batch meta，测试/真实环境一致）
  const created = await env.DB.prepare('SELECT id FROM servers WHERE agent_key_id = ?').bind(keyId).first();
  const id = created ? created.id : 0;
  return {
    server_id: id,
    name,
    agent_key: key, // 明文只返回一次
    wss_base: agentWssBase(url), // agent 部署地址（与 REST 版一致，协议跟随访问协议）
  };
}

async function mcpDeleteServer(user, env, args, ip) {
  requireAdmin(user);
  const server = await mcpFindServer(env, args);
  // 级联清理与 REST 单删共用同一实现：此前是两份会各自漂移的副本
  //（MCP 版就漏过 metrics_day 之类的新增表清理）
  const name = await deleteServerCascade(env, user, ip, server.id);
  if (name === null) throw new Error('server not found'); // mcpFindServer 刚查到，理论不可达
  return { ok: true, server_id: server.id, name };
}

async function mcpUpdateServer(user, env, args, ip) {
  requireAdmin(user);
  const server = await mcpFindServer(env, args);
  const name = args.name !== undefined ? String(args.name).trim() : server.name;
  if (!name) throw new Error('name required');
  const group = args.group !== undefined ? String(args.group).trim() : server.group;
  const displayIndex = args.sort_order !== undefined ? Number(args.sort_order) || 0 : server.display_index;
  // alert_override：null/空对象 = 清除覆盖回退全局；不传 = 保持原值（与 REST PATCH 同语义）
  let overrideJson = server.alert_override;
  if (args.alert_override !== undefined) {
    const cleaned = sanitizeAlertOverride(args.alert_override);
    overrideJson = cleaned ? JSON.stringify(cleaned) : null;
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE servers SET name = ?, "group" = ?, display_index = ?, alert_override = ? WHERE id = ?')
      .bind(name, group, displayIndex, overrideJson, server.id),
    env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (?,?,?,?,?,?)')
      .bind(user.id, user.username, ip, 'server.update', server.id, `${server.name} → ${name}`),
  ]);
  serverListCacheClear();
  serverRowCache.delete(server.id); // 覆盖值随上报帧下发，清缓存立即生效
  return {
    ok: true, server_id: server.id, name, group, display_index: displayIndex, alert_override: safeJson(overrideJson),
  };
}

// 轮换 agent key（与 REST POST /api/servers/:id/rotate-key 完全一致）：
// 破坏性介于 update 与 delete 之间——不删任何数据，但会让远端 agent 立即掉线，
// 故同样要求 server_id/server_name 显式定位（重名拒绝）。
async function mcpRotateAgentKey(user, env, args, ip, url) {
  requireAdmin(user);
  const server = await mcpFindServer(env, args);
  const key = randomHex(32);
  const keyId = await sha256Hex(key);
  const hash = await hashSecret(key, env);
  await env.DB.batch([
    env.DB.prepare('UPDATE servers SET agent_key_id = ?, agent_key_hash = ? WHERE id = ?')
      .bind(keyId, hash, server.id),
    env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (?,?,?,?,?,?)')
      .bind(user.id, user.username, ip, 'server.rotate_key', server.id, server.name),
  ]);
  serverListCacheClear();
  serverRowCache.delete(server.id);
  for (let i = 0; i < SHARDS; i++) {
    try {
      await doForShard(env, i).fetch('https://do.internal/rpc/drop_server', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serverId: server.id }),
      });
    } catch { /* 分片暂不可达；旧 key 重连会因指纹不存在被 401 拒绝 */ }
  }
  return {
    server_id: server.id,
    server_name: server.name,
    agent_key: key, // 明文只返回一次
    wss_base: agentWssBase(url),
    note: '旧 key 已失效并已断开现有连接；监控历史保留，须人工到目标机更新 AGENT_KEY 并重启 agent 后才会重新上线',
  };
}

async function mcpListTokens(user, env) {
  requireAdmin(user);
  const rows = await env.DB.prepare('SELECT id, name, scopes, server_ids, expires_at, last_used_at, created_at FROM api_tokens ORDER BY id').all();
  return rows.results.map((t) => ({ ...t, scopes: safeJson(t.scopes) || t.scopes, server_ids: safeJson(t.server_ids) || t.server_ids }));
}

async function mcpCreateToken(user, env, args) {
  requireAdmin(user);
  const name = String(args.name || '').trim();
  if (!name) throw new Error('name required');
  // 同名令牌拒绝：前置查询快速失败 + 唯一索引（迁移 0010）兜底并发竞态；与 REST POST /api/tokens 一致
  const dup = await env.DB.prepare('SELECT id FROM api_tokens WHERE name = ?').bind(name).first();
  if (dup) throw new Error('token name already exists');
  let scopes;
  if (Array.isArray(args.scopes) && args.scopes.length) {
    scopes = [...new Set(args.scopes.filter((s) => ALLOWED_SCOPES.includes(s)))];
    if (!scopes.length) throw new Error(`invalid scope, allowed: ${ALLOWED_SCOPES.join(', ')}`);
  } else {
    scopes = [SCOPE_READ];
  }
  const serverIDs = Array.isArray(args.server_ids) ? args.server_ids.map(Number).filter((n) => n > 0) : null;
  // 与 REST 版同语义：expires_at（unix 秒，须在未来，优先）或 expires_in_days（可小数天）
  const nowSec = Math.floor(Date.now() / 1000);
  const days = Number(args.expires_in_days);
  let expiresAt = Number.isFinite(days) && days > 0 ? Math.floor(nowSec + days * 86400) : null;
  if (args.expires_at !== undefined && args.expires_at !== null && args.expires_at !== '') {
    const at = Number(args.expires_at);
    if (!Number.isFinite(at) || at <= nowSec) throw new Error('expires_at must be a future unix timestamp');
    expiresAt = Math.floor(at);
  }
  const token = PAT_PREFIX + randomHex(32);
  const hash = await hashSecret(token, env);
  try {
    await env.DB.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scopes, server_ids, expires_at) VALUES (?,?,?,?,?,?)')
      .bind(user.id, name, hash, JSON.stringify(scopes), serverIDs ? JSON.stringify(serverIDs) : null, expiresAt)
      .run();
  } catch (e) {
    // 并发竞态兜底：前置查重通过后被并发请求抢先插入（唯一索引迁移 0010 拒绝）
    if (TOKEN_NAME_UNIQUE_RE.test(String(e && e.message))) throw new Error('token name already exists');
    throw e;
  }
  return { token, expires_at: expiresAt }; // 明文只返回一次
}

async function mcpRevokeToken(user, env, args) {
  requireAdmin(user);
  const id = Number(args.token_id) || 0;
  if (!id) throw new Error('token_id is required');
  const res = await env.DB.prepare('DELETE FROM api_tokens WHERE id = ?').bind(id).run();
  if (!res.meta.changes) throw new Error(`token not found (id=${id})`);
  // PAT 撤销即时生效：清 PanelDO 鉴权缓存
  try {
    await doPanel(env).fetch('https://do.internal/rpc/clear_auth_cache', { method: 'POST' });
  } catch { /* 清缓存失败由 authCache 30s TTL 兜底 */ }
  return { ok: true, token_id: id };
}

async function mcpGetAuditLogs(user, env, args) {
  requireAdmin(user);
  const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500);
  const offset = Math.max(Number(args.offset) || 0, 0);
  const action = String(args.action || '').trim();
  const userName = String(args.user || '').trim();
  const serverId = Number(args.server_id) || 0;
  const conds = [];
  const binds = [];
  if (action) { conds.push('action = ?'); binds.push(action); }
  if (userName) { conds.push('username LIKE ?'); binds.push(`%${userName}%`); }
  if (serverId) { conds.push('target_server_id = ?'); binds.push(serverId); }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const rows = await env.DB.prepare(`SELECT id, user_id, username, client_ip, action, target_server_id, detail, created_at FROM audit_logs${where} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all();
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM audit_logs${where}`).bind(...binds).first();
  return { rows: rows.results, total: Number(totalRow?.c || 0) };
}

async function mcpGetUsage(user, env) {
  requireAdmin(user);
  return collectUsageView(env);
}

async function mcpGetSettings(user, env) {
  requireAdmin(user);
  return (await kvGet(env, 'settings', {})) || {};
}

async function mcpUpdateSettings(user, env, args) {
  requireAdmin(user);
  const current = (await kvGet(env, 'settings', {})) || {};
  const next = {
    site_name: args.site_name !== undefined ? String(args.site_name).trim() : current.site_name,
    notice: args.notice !== undefined ? String(args.notice).trim() : current.notice,
    alerts: args.alerts !== undefined ? sanitizeAlerts(args.alerts) : current.alerts,
    geo_lookup: args.geo_lookup !== undefined ? !!args.geo_lookup : !!current.geo_lookup,
  };
  await kvPut(env, 'settings', next);
  kvClearCache('settings');
  try {
    await doMetrics(env).fetch('https://do.internal/rpc/clear_settings_cache', { method: 'POST' });
  } catch { /* 清缓存失败：MetricsDO 侧按 300s TTL 自然过期 */ }
  return next;
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
  try {
    return await handleMcpInner(request, env);
  } catch (e) {
    // 顶层 error boundary：工具级 try/catch 之外的异常（鉴权/解析/DB 层）返回 JSON-RPC 内部错误
    console.error('handleMcp unhandled error:', e);
    const origin = request.headers.get('origin');
    return mcpResult(null, null, { code: -32603, message: 'Internal error' }, origin);
  }
}

async function handleMcpInner(request, env) {
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
  // 响应 CORS 回显同源 origin（见 mcpResult；无 Origin 的 curl/MCP 客户端自动 '*'）
  const reply = (id, result, error) => mcpResult(id, result, error, origin);

  // POST /mcp/file_upload —— 上传通道（签名 URL 直传 / Bearer 鉴权），非 JSON-RPC
  // 签名 URL 直传（MCP create_upload 签发，无状态 HMAC 验签，无需 Bearer）：
  // 签名绑定 server_id/path/overwrite/exp；验证失败 403。审计在 create_upload 时已记录，此处不重复。
  // JWT_SECRET 仍是必需安全边界（验签密钥回退依赖它）：缺失时签名上传同样 503，防止绕过配置错误。
  if (request.method === 'POST' && url.pathname === '/mcp/file_upload' && url.searchParams.get('token')) {
    const configError = requireJwtSecret(env);
    if (configError) return configError;
    return handleUploadSigned(request, env, url);
  }

  // 每请求独立鉴权（与现有 API 一致：Bearer JWT 或 PAT）
  const user = await authUser(request, env);
  if (!user) return reply(null, null, { code: -32001, message: 'unauthorized' });

  // POST /mcp/file_upload?server_id=&path=&overwrite= —— Bearer 流式上传文件到 agent（body = 原始字节）
  // 小文件（配置/脚本）与大文件（备份/包）统一入口：Worker 流式读 body → 自动分片 →
  // 控制通道 Binary 混合帧 → agent 原子写。需 exec 权限（管理员或带 server:exec 的 PAT）。
  if (request.method === 'POST' && url.pathname === '/mcp/file_upload') {
    const serverId = Number(url.searchParams.get('server_id')) || 0;
    const targetPath = url.searchParams.get('path') || '';
    if (!serverId) return json({ error: 'server_id is required' }, 400);
    if (!targetPath || !targetPath.startsWith('/')) return json({ error: 'path is required (absolute)' }, 400);
    const server = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(serverId).first();
    if (!server) return json({ error: 'server not found' }, 404);
    if (!canExec(user, server)) return json({ error: 'forbidden' }, 403);
    await env.DB.prepare('INSERT INTO audit_logs (user_id, username, client_ip, action, target_server_id, detail) VALUES (?,?,?,?,?,?)')
      .bind(user.id, user.username, clientIp(request), 'file.upload', server.id, targetPath)
      .run();
    return forwardUpload(env, request, serverId);
  }

  let body;
  try { body = await request.json(); } catch {
    return reply(null, null, { code: -32700, message: 'Parse error' });
  }
  const id = body.id;

  // 协议版本协商：MCP-Protocol-Version 头须与 body _meta 一致（缺失头时按 2025-03-26 兼容）
  const headerVersion = request.headers.get('mcp-protocol-version') || '2025-03-26';
  const metaVersion = body._meta && body._meta['io.modelcontextprotocol/protocolVersion'];
  if (metaVersion && metaVersion !== headerVersion) {
    return reply(id, null, { code: -32020, message: 'HeaderMismatch: MCP-Protocol-Version 与 body _meta 不一致' });
  }

  switch (body.method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: MCP_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'cf-panel', version: '0.1.0' },
        instructions: 'cf-panel 面板。工具：list_servers（服务器状态）、get_monitor（监控历史）、exec_command（执行命令，需 exec 权限）、create_upload（签发上传签名 URL）、管理类（仅管理员）：add_server/delete_server/update_server/list_tokens/create_token/revoke_token/get_audit_logs/get_usage/get_settings/update_settings。认证：Authorization: Bearer <JWT 或 PAT>',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return new Response(null, { status: 202 }); // 通知：接受无 body
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const params = body.params || {};
      const tool = MCP_TOOLS.find((t) => t.name === params.name);
      if (!tool) return reply(id, null, { code: -32602, message: `Unknown tool: ${params.name}` });
      try {
        let content;
        if (params.name === 'list_servers') content = await mcpListServers(user, env);
        else if (params.name === 'get_monitor') content = await mcpGetMonitor(user, env, params.arguments || {});
        else if (params.name === 'exec_command') content = await mcpExecCommand(user, env, params.arguments || {}, clientIp(request));
        else if (params.name === 'create_upload') content = await mcpCreateUpload(user, env, params.arguments || {}, url, clientIp(request));
        else if (params.name === 'add_server') content = await mcpAddServer(user, env, params.arguments || {}, clientIp(request), url);
        else if (params.name === 'delete_server') content = await mcpDeleteServer(user, env, params.arguments || {}, clientIp(request));
        else if (params.name === 'update_server') content = await mcpUpdateServer(user, env, params.arguments || {}, clientIp(request));
        else if (params.name === 'rotate_agent_key') content = await mcpRotateAgentKey(user, env, params.arguments || {}, clientIp(request), url);
        else if (params.name === 'list_tokens') content = await mcpListTokens(user, env);
        else if (params.name === 'create_token') content = await mcpCreateToken(user, env, params.arguments || {});
        else if (params.name === 'revoke_token') content = await mcpRevokeToken(user, env, params.arguments || {});
        else if (params.name === 'get_audit_logs') content = await mcpGetAuditLogs(user, env, params.arguments || {});
        else if (params.name === 'get_usage') content = await mcpGetUsage(user, env);
        else if (params.name === 'get_settings') content = await mcpGetSettings(user, env);
        else if (params.name === 'update_settings') content = await mcpUpdateSettings(user, env, params.arguments || {});
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(content) }], isError: false });
      } catch (e) {
        // 工具执行错误作为 isError 结果返回（MCP 客户端可读）
        return reply(id, { content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      }
    }
    default:
      return reply(id, null, { code: -32601, message: `Method not found: ${body.method}` });
  }
}

// ---------------- WebSocket 路由（按分片转发 DO） ----------------

export async function handleWs(request, env) {
  try {
    return await handleWsInner(request, env);
  } catch (e) {
    // 顶层 error boundary：路由/反查阶段异常返回 500（此时尚未 upgrade，可安全返回普通响应）
    console.error('handleWs unhandled error:', e);
    return new Response('internal error', { status: 500 });
  }
}

async function handleWsInner(request, env) {
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
    // 用 header key 指纹反查服务器定位分片；凭证禁止出现在 URL，避免边缘日志/代理记录泄露
    const key = request.headers.get('x-agent-key') || '';
    if (!key) return new Response('missing agent key', { status: 401 });
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
