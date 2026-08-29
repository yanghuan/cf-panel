// cf-panel — Durable Object：面板实时推送（PanelDO）
// 前端登录后建 WS 到 /ws/push，之后发一次 'sync' 拉初始列表，此后由 MetricsDO
// 上报驱动 latest_push 被动接收（见 MetricsDO.processReportFrame）。
// 本 DO 用 WebSocket Hibernation API：空闲时实例休眠（不计时长），
// 只有收到客户端消息或推送才短暂唤醒 → 费用开销趋近普通 Worker。
import {
  ONLINE_GRACE_FAST_S, ONLINE_GRACE_SLOW_S, SHARDS, SCOPE_READ,
} from './config.js';
import { json, doForShard, doMetrics, safeJson } from './utils.js';
import { authIdentityByToken, authUserByIdentity, isAdmin } from './auth.js';

// 本模块专用常量（缓存 TTL / 频率下限 / 切快采过渡期，就近定义便于对照使用代码）
const LIST_CACHE_TTL_MS = 4500; // 服务器列表缓存 TTL：> 前端 3s sync 间隔（错开同频，消除单观看者 miss）
const LATEST_CACHE_TTL_MS = 4000; // MetricsDO /latest 共享缓存 TTL（多观看者 sync 共享，DO 事件 −50%）
const SYNC_MIN_INTERVAL_MS = 2000; // sync 频率下限（<2s 忽略，防任意消息/高频触发全链路）
const WS_AUTH_TIMEOUT_MS = 10 * 1000; // WS 建连后必须在 10s 内发送 auth 首帧
const MAX_PENDING_WS = 128; // 单个 PanelDO 未鉴权连接上限，防耗尽 Hibernation WebSocket 配额
const PANEL_SWITCH_GRACE_MS = 30 * 1000; // 观看者 0→1 后在线判定用慢宽限的过渡期：Agent 切快采并完成首帧上报前，
// 用 15s 快宽限会把慢采周期中（120s 内无上报）的节点误判离线；30s 后快宽限正常生效

function attachmentOf(ws) {
  try { return ws.deserializeAttachment?.(); } catch { return null; }
}
function isViewerAttachment(att) {
  return !!att && ((typeof att === 'object' && att.role === 'viewer') || typeof att === 'string');
}

export class PanelDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.listCache = null; // {rows, ts} 服务器列表缓存（TTL 4500ms，多观看者共享，降 D1 读）
    this.latestCache = null; // {data, ts} MetricsDO /latest 共享缓存（TTL 4s，sync 链 DO 事件 −50%）
    this.syncAt = new Map(); // ws -> 上次 sync 时间（频率下限 <2s 忽略，防刷）
    this.authCache = new Map(); // 身份键（PAT HMAC / JWT claims）→ {user, ts}，不缓存 bearer 明文
    // 此前 5s TTL 与 latest_push 5s 节拍精确同频 → 挂机 PAT 连接每拍必 miss api_tokens 点查
    //（17,280 行读/天/连接）；30s TTL 错开节拍（每 6 拍 1 次 miss，−83%），撤销时效靠 RPC 主路径保证秒级）
    this.fastSince = 0; // 最近一次 0→1 切快采时刻（毫秒）；过渡期内在线判定用慢宽限，避免首次显示离线
  }

  authCacheKey(identity) {
    if (!identity || typeof identity !== 'object') return '';
    return identity.kind === 'pat'
      ? `pat:${identity.tokenHash || ''}`
      : `jwt:${identity.id || ''}:${identity.exp || 0}:${identity.username || ''}`;
  }

  cacheIdentity(identity, user) {
    const key = this.authCacheKey(identity);
    if (!key) return;
    if (this.authCache.size > 1000) this.authCache.clear();
    this.authCache.set(key, { user, ts: Date.now() });
  }

  // attachment 只携带不可逆 PAT HMAC 或已验证 JWT claims；PAT 每 30s 重新按 hash 查 D1。
  async authUserCached(identity) {
    const key = this.authCacheKey(identity);
    if (!key) return null;
    const now = Date.now();
    if (identity.kind === 'jwt' && identity.exp && identity.exp * 1000 < now) return null;
    const c = this.authCache.get(key);
    if (c && now - c.ts < 30000) return c.user;
    const user = await authUserByIdentity(identity, this.env);
    if (this.authCache.size > 1000) this.authCache.clear();
    this.authCache.set(key, { user, ts: now });
    return user;
  }

  // 升级前版本可能有字符串 token 附件；首次活动时校验并原地迁移为无明文身份对象。
  async userForSocket(ws, att = attachmentOf(ws)) {
    if (typeof att === 'string') {
      const authenticated = await authIdentityByToken(att, this.env);
      if (!authenticated) return null;
      const safe = { role: 'viewer', auth: authenticated.identity };
      ws.serializeAttachment?.(safe);
      this.cacheIdentity(safe.auth, authenticated.user);
      return authenticated.user;
    }
    if (!att || att.role !== 'viewer') return null;
    return this.authUserCached(att.auth);
  }

  async scheduleAuthAlarm(deadline) {
    try {
      const current = await this.state.storage.getAlarm();
      if (current == null || current <= Date.now() || deadline < current) await this.state.storage.setAlarm(deadline);
    } catch { /* alarm 不可用时仍受 pending 数量硬上限保护 */ }
  }

  // 服务器列表缓存 + 权限过滤（过滤在缓存之上执行，不缓存可越权结论）
  async filterServersCached(user) {
    const now = Date.now();
    let rows;
    if (this.listCache && now - this.listCache.ts < LIST_CACHE_TTL_MS) {
      rows = this.listCache.rows;
    } else {
      const r = await this.env.DB.prepare('SELECT * FROM servers ORDER BY "group", display_index, id').all();
      rows = r.results;
      this.listCache = { rows, ts: now };
    }
    if (isAdmin(user)) return rows;
    if (user.pat) {
      if (!user.pat.scopes.includes(SCOPE_READ)) return [];
      if (user.pat.serverIDs == null) return rows;
      const ids = new Set(user.pat.serverIDs.map(Number).filter((n) => n > 0));
      return rows.filter((s) => ids.has(s.id));
    }
    return rows.filter((s) => s.user_id === user.id);
  }

  async fetch(request) {
    const url = new URL(request.url);
    // 内部 RPC：供 TerminalDO 查询当前已鉴权在线观看者数（省配额上报策略用）；
    // 同时返回 fastSince（0→1 切快采时刻），Worker 侧 REST/MCP 列表据此复用 30s 过渡期
    // 语义——否则首观者上线后 30s 内慢采 agent 会被 15s 快宽限误判离线
    if (url.pathname === '/viewers') {
      const count = (this.state.getWebSockets?.() || []).filter((w) => isViewerAttachment(attachmentOf(w))).length;
      return json({ count, fastSince: count > 0 ? this.fastSince : 0 });
    }
    // 内部 RPC：PAT 撤销后清鉴权缓存（已建观看者连接下个推送即失效关闭；清失败由 30s TTL 兜底）
    if (url.pathname === '/rpc/clear_auth_cache' && request.method === 'POST') {
      this.authCache.clear();
      return json({ ok: true });
    }
    // 内部 RPC：服务器增删改后清列表缓存（否则已删服务器最多 4.5s 内仍出现在推送列表；清失败由 TTL 兜底）
    if (url.pathname === '/rpc/clear_list_cache' && request.method === 'POST') {
      this.listCache = null;
      this.latestCache = null;
      return json({ ok: true });
    }
    // 内部 RPC：MetricsDO 上报驱动推送全部最新指标 → 按观看者权限过滤组装后广播（出站不计费）
    if (url.pathname === '/rpc/latest_push' && request.method === 'POST') {
      const pb = await request.json();
      const latest = pb.latest || {};
      const wss = this.state.getWebSockets?.() || [];
      await Promise.all(wss.map(async (w) => {
        const att = attachmentOf(w);
        if (!isViewerAttachment(att)) return; // 未鉴权连接跳过
        const user = await this.userForSocket(w, att);
        if (!user) {
          // 已撤销/过期：直接关闭连接（前端仅 onopen 发一次 sync，webSocketMessage 的
          // 关闭分支不会再触发——必须在此兜底，否则撤销连接残留计数导致 agent 持续快采）
          try { w.close(1008, 'unauthorized'); } catch { /* ignore */ }
          return;
        }
        const list = await this.buildList(user, latest);
        if (list) { try { w.send(JSON.stringify(list)); } catch { /* ignore */ } }
      }));
      return json({ ok: true });
    }
    if (url.pathname !== '/ws/push') return new Response('not found', { status: 404 });
    const sockets = this.state.getWebSockets?.() || [];
    const pending = sockets.filter((w) => attachmentOf(w)?.role === 'viewer-pending').length;
    if (pending >= MAX_PENDING_WS) return new Response('too many pending connections', { status: 429 });
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    // 鉴权延迟到首条消息；pending 附件不含 token，并由 alarm 在 10s 后强制回收。
    const authDeadline = Date.now() + WS_AUTH_TIMEOUT_MS;
    pair[1].serializeAttachment({ role: 'viewer-pending', authDeadline });
    await this.scheduleAuthAlarm(authDeadline);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // 观看者数变化事件 → 各分片 agent 切快/慢采（省配额：0→1 立即快采，1→0 恢复慢采）。
  // 取代每次上报查询 /viewers（上报链 DO 事件 3→2/帧）。
  async broadcastViewers(count) {
    for (let i = 0; i < SHARDS; i++) {
      try {
        await doForShard(this.env, i).fetch('https://do.internal/rpc/set_viewers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ count }),
        });
      } catch { /* 分片暂不可达，后续上报兜底 */ }
    }
  }

  // 客户端首帧鉴权（{type:'auth', token}）；通过后发一次 sync 拉初始列表，之后被动收推送
  async webSocketMessage(ws, message) {
    const att = attachmentOf(ws);
    // 未鉴权连接：首条消息必须是鉴权帧（null 兼容升级前已建立的 pending 连接）
    if (!att || att.role === 'viewer-pending') {
      if (att?.authDeadline && Date.now() > att.authDeadline) {
        try { ws.close(1008, 'authentication timeout'); } catch { /* ignore */ }
        return;
      }
      let j = null;
      try { j = JSON.parse(typeof message === 'string' ? message : ''); } catch { /* 非 JSON 视为无效 */ }
      const token = j && j.type === 'auth' ? String(j.token || '') : '';
      const authenticated = token ? await authIdentityByToken(token, this.env) : null;
      if (!authenticated) {
        try { ws.close(1008, 'unauthorized'); } catch { /* ignore */ }
        return;
      }
      const safe = { role: 'viewer', auth: authenticated.identity };
      ws.serializeAttachment(safe);
      this.cacheIdentity(safe.auth, authenticated.user);
      // 首位已鉴权观看者上线（0→1）→ 各分片 agent 立即切快采（事件驱动，免每次上报查 /viewers）
      const authed = (this.state.getWebSockets?.() || []).filter((w) => isViewerAttachment(attachmentOf(w)));
      if (authed.length === 1) {
        this.fastSince = Date.now(); // 过渡期内（30s）在线判定用慢宽限，防切快采前短暂误判离线
        this.broadcastViewers(1);
        this.setPush(1); // 开启上报驱动推送
      }
      return;
    }
    // 仅响应 'sync'（任意其他消息不再触发全链路）；频率下限 <2s 忽略（防刷/异常放大）
    if (message !== 'sync') return;
    const syncNow = Date.now();
    const lastSync = this.syncAt.get(ws) || 0;
    if (syncNow - lastSync < SYNC_MIN_INTERVAL_MS) return;
    this.syncAt.set(ws, syncNow);
    if (this.syncAt.size > 500) this.syncAt.clear(); // 防 Map 无限增长
    const user = await this.userForSocket(ws, att);
    if (!user) {
      // PAT/JWT 已失效（撤销/删除）：关闭连接而非静默忽略——撤销后观看者立即下线，
      // 其快采随之恢复慢采（与 webSocketClose 的广播逻辑衔接）
      try { ws.close(1008, 'unauthorized'); } catch { /* ignore */ }
      return;
    }
    // 附带每台机器的最新指标（卡片实时展示；共享缓存 4s；被动接收后 sync 仅首次/兜底触发，
    // 常态数据由 MetricsDO 上报驱动 latest_push 推送）
    let latest = {};
    const lcNow = Date.now();
    if (this.latestCache && lcNow - this.latestCache.ts < LATEST_CACHE_TTL_MS) {
      latest = this.latestCache.data;
    } else {
      try {
        const lResp = await doMetrics(this.env).fetch('https://do.internal/latest');
        latest = await lResp.json();
        this.latestCache = { data: latest, ts: lcNow };
      } catch { /* 无最新指标 */ }
    }
    const list = await this.buildList(user, latest);
    if (list) { try { ws.send(JSON.stringify(list)); } catch { /* ignore */ } }
  }

  // 组装服务器列表（sync 与推送广播共用）。latest 由调用方提供：
  // latest_push 直接使用 MetricsDO 推来的数据（不查 /latest，省 DO 事件）
  async buildList(user, latest) {
    let serverRows;
    try {
      serverRows = await this.filterServersCached(user);
    } catch {
      return null; // D1 临时故障：调用方跳过本次发送
    }
    const now = Math.floor(Date.now() / 1000);
    // 本 DO 内直接统计已鉴权观看者（无需额外 RPC）；切快采过渡期（0→1 后 30s 内）用慢宽限
    const hasViewers = (this.state.getWebSockets?.() || []).some((w) => isViewerAttachment(attachmentOf(w)));
    const grace = (hasViewers && Date.now() - this.fastSince >= PANEL_SWITCH_GRACE_MS)
      ? ONLINE_GRACE_FAST_S : ONLINE_GRACE_SLOW_S;
    return serverRows.map((s) => ({
      id: s.id,
      name: s.name,
      group: s.group || '',
      display_index: s.display_index || 0,
      // 在线判定优先用 MetricsDO 秒级 last_seen_s；D1 last_seen 节流写，仅冷启动兜底
      online: now - (latest[s.id]?.last_seen_s || s.last_seen || 0) < grace,
      wan_ip: s.wan_ip || '',
      info: safeJson(s.info_json),
      probes: safeJson(s.probe_json),
      // 逐机告警阈值覆盖：与 REST /api/servers 同构，前端编辑弹窗据此回填
      alert_override: safeJson(s.alert_override),
      metric: latest[s.id] || null,
    }));
  }

  // 通知 MetricsDO 是否有人观看（仅有人看时才推 latest；0→1 开 / 1→0 关）
  async setPush(on) {
    try {
      await doMetrics(this.env).fetch('https://do.internal/rpc/set_push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on }),
      });
    } catch { /* 通知失败：MetricsDO 保持旧状态（无人看时无上报 → 不推，无碍） */ }
  }

  // Hibernation alarm：关闭超过首帧鉴权期限的匿名连接；尚未到期则续排最早 deadline。
  async alarm() {
    const now = Date.now();
    let next = Infinity;
    for (const ws of this.state.getWebSockets?.() || []) {
      const att = attachmentOf(ws);
      if (!att || att.role !== 'viewer-pending') continue;
      const deadline = Number(att.authDeadline) || 0;
      if (deadline <= now) {
        try { ws.close(1008, 'authentication timeout'); } catch { /* ignore */ }
      } else {
        next = Math.min(next, deadline);
      }
    }
    if (next !== Infinity) await this.scheduleAuthAlarm(next);
  }

  // 观看者断开：最后一个已鉴权观看者下线（1→0）→ 广播慢采 + 关闭上报驱动推送（事件驱动省配额）
  async webSocketClose(ws) {
    if (!isViewerAttachment(attachmentOf(ws))) return; // pending 关闭不影响观看者状态
    const authed = (this.state.getWebSockets?.() || [])
      .filter((w) => w !== ws && isViewerAttachment(attachmentOf(w)));
    if (authed.length === 0) {
      this.fastSince = 0;
      this.broadcastViewers(0);
      this.setPush(0); // 无人观看停止推送
    }
  }

  // 观看者异常断开：错误回调同样执行下线检查（error 后连接即将关闭，close 回调若延迟/缺失则在此兜底，
  // 避免最后一个观看者残留导致 agent 持续快采）；同时记录错误便于诊断
  async webSocketError(ws, error) {
    try { console.error('panel ws error:', error); } catch { /* ignore */ }
    await this.webSocketClose(ws);
  }
}
