// cf-panel — Durable Object：监控时序内存热区（MetricsDO）
import { ARCHIVE_AFTER_MIN } from './config.js';
import { json, err, doPanel, sendWebhook, numOrNull } from './utils.js';
import { getAlertCfg, SETTINGS_CACHE } from './db.js';

// 本模块专用常量（热区/归档/家政/推送，就近定义便于对照使用代码）
const METRICS_KEEP_MIN = 720; // 内存保留最近 12 小时（分钟粒度）
const ARCHIVE_INTERVAL_MS = 10 * 60 * 1000; // 归档周期
const METRICS_RETENTION_DAYS = 30; // D1 历史保留期（天），过期行每日清理
const AUDIT_RETENTION_DAYS = 90; // 审计日志保留期（天），过期行随每日清理删除
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 保留期清理周期
const ARCHIVE_IDLE_INTERVAL_MS = 60 * 60 * 1000; // 闲置（无数据且告警关闭）时 alarm 退避间隔（1h）
const LATEST_PUSH_INTERVAL_MS = 5000; // 上报驱动聚合推送间隔（有观看者时 ≥5s 推一次全部 latest 给 PanelDO；
// 单机时被 REPORT_FWD_THROTTLE_S=5s 钳制（MetricsDO 每 5s 收帧），多机时聚合多台上报防推送风暴）
const PUSH_PROBE_INTERVAL_MS = 30 * 1000; // pushOn 自愈反查 /viewers 的间隔（MetricsDO evict 丢失 pushOn 时）
const RETRY_BACKOFF_MS = 60 * 1000; // 告警 webhook 送达失败后的重试退避（失败只退避 1 分钟，而非静默整个冷却期）

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
    this.putMin = new Map(); // serverId -> 已持久化到 storage 的分钟 ts（storage.put 按分钟去重）
    // 告警去重状态：内存为主，关键变更时持久化到 DO Storage，实例 evict/重启后恢复，避免重复告警
    this.alertLast = new Map(); // `${serverId}:kind` -> 上次触发时间
    this.probeState = new Map(); // `${serverId}:probeName` -> {ok, lastFail}
    this.alertLoaded = false;
    this.probeLoaded = false;
    this.arcCache = new Map(); // serverId -> 已归档水位（分钟），实例内缓存，evict 后从 storage 恢复
    this.lastSweepAt = 0; // 上次 fullSweep 时间戳（ms；持久化跨 evict，见 ensureHousekeepLoaded）
    this.lastPruneAt = 0; // 上次保留期清理时间戳（ms；同上，替代易被 evict 重置的内存计数）
    this.housekeepLoaded = false; // 家政状态（fullSweep/prune 时间）是否已从 storage 恢复
    this.lastSeenSec = new Map(); // serverId -> 最后上报秒（内存，/latest 在线判定用；evict 后由 D1 last_seen 兜底）
    this.alarmCached = null; // 实例内已知的下一次 alarm 时间戳；避免每帧上报都 getAlarm（DO Storage 读）
    this.latestByServer = new Map(); // serverId -> 最新指标 {ts, ..., last_seen_s}（/report 热写 O(1) 维护，/latest 直接 O(S) 返回）
    this.offlineLoaded = false; // 离线告警状态是否已从 storage 一次性加载（惰性）
    this.offlineState = new Map(); // serverId -> 'on'|'off'（内存副本，避免每机逐个 getAlarm）
    this.usage = { report: 0, latest: 0, query: 0 }; // 用量观测：本周期（10min）计数，周期末累计到 storage
    this.hotLoaded = new Set(); // serverId 已从 storage 完整加载热区的标记（见 ensureHot）
    this.pushOn = false; // 是否有观看者（PanelDO 0→1/1→0 通知），开启时才推送 latest
    this.lastPushAt = 0; // 上次推送 latest 给 PanelDO 的时刻（ms）；上报驱动节流，不引入定时器
    this.lastPushProbeAt = 0; // 上次反查 /viewers 的时刻（pushOn 因 evict 丢失时的自愈兜底）
    this.pendingArcRetry = new Set(); // serverId：首帧兜底 list 失败后待重试（正确性加固）
  }

  // 家政状态（lastSweepAt/lastPruneAt）从 storage 惰性恢复（持久化跨实例 evict，
  // 避免慢采/空闲下实例频繁 evict 导致 fullSweep 停摆（>12h 热区无限增长）与 prune 每天 144 次全表扫）
  async ensureHousekeepLoaded() {
    if (this.housekeepLoaded) return;
    this.housekeepLoaded = true;
    try {
      const raw = await this.state.storage.get('housekeep');
      if (raw) {
        const h = JSON.parse(raw);
        this.lastSweepAt = Number(h.lastSweepAt) || 0;
        this.lastPruneAt = Number(h.lastPruneAt) || 0;
      }
    } catch { /* 恢复失败按 0 处理（首次/损坏），下次 alarm 正常判定 */ }
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
    this.hotLoaded.add(serverId);
    return m;
  }
  // 仅当该服务器热区已「完整加载」才直接返回内存；热写路径在 evict 后创建的空 Map 不算已加载
  // （否则 /query 会因 data.has() 误判而跳过 storage 恢复，出现最近 ~1h 数据缺口）
  async ensureHot(serverId) {
    if (!this.hotLoaded.has(serverId)) await this.loadHot(serverId);
    return this.data.get(serverId);
  }

  // 增量归档：把该服务器热区中「归档水位之后、归档线之前」的行落 D1。
  // 由 /report 热写路径顺带调用（水位 < 归档线时才执行，正常每 ~10 分钟一次），
  // 取代 alarm 每 10 分钟全量 list + 重复 INSERT（消除 DO Storage 读与 D1 重复写）。
  // 本次上报行本身若已跨过归档线则直接归档（不依赖水位，防回溯/补报漏归档）。
  // fresh：本实例内该机首帧热写标记（evict 后），仅首帧推进水位时做 Storage 兜底（见下方注释）
  async archiveIncrement(serverId, m, minTs, fresh = false) {
    if (this.env.ARCHIVE_TO_D1 === '0') return;
    const arcKey = `arc:${serverId}`;
    let arcTs = this.arcCache.get(serverId);
    if (arcTs == null) {
      try { arcTs = Number(await this.state.storage.get(arcKey)) || 0; } catch { arcTs = 0; }
      this.arcCache.set(serverId, arcTs);
    }
    const archiveCutoff = Math.floor(Date.now() / 1000 / 60) - ARCHIVE_AFTER_MIN;
    // 数值归一化兜底：storage 历史行可能含修复前的坏数据（对象/字符串），
    // 归一化后 D1.bind 不抛类型错误 → 归档水位可推进，杜绝"单条坏数据停摆整机归档"
    const mk = (t, row) => this.env.DB.prepare(
      'INSERT OR IGNORE INTO metrics_min (server_id, ts, cpu, mem_used, mem_total, net_in, net_out, extra) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(
      serverId, t,
      numOrNull(row.cpu), numOrNull(row.mem_used), numOrNull(row.mem_total),
      numOrNull(row.net_in), numOrNull(row.net_out),
      row.extra ? JSON.stringify(row.extra) : null
    );
    const stmts = [];
    // 水位只推进到本次实际归档的最大 ts（maxArchived），不得无条件推进到 cutoff：
    // 热写路径在实例 evict 后是空 Map，若水位仍推进，storage 中 arcTs+1~cutoff 的未归档行会被
    // fullSweep（仅归档 ts>arcTs）永久跳过，12h 后删除 → 3d/7d/30d 历史出现永久空洞。
    // 未归档/未扫到的行由 fullSweep（≈1h 一次）全扫 storage 兜底。
    let maxArchived = -1;
    // 本次上报行已跨过归档线 → 直接归档（防回溯/补报漏归档）
    if (minTs <= archiveCutoff) {
      const row = m.get(minTs);
      if (row) { stmts.push(mk(minTs, row)); maxArchived = minTs; }
    }
    // 水位区间批量归档（水位之后、cutoff 之前；OR IGNORE 幂等，minTs 重复无害）。
    // 起点不含 maxArchived+1：即使本次直接归档了跨线行（minTs>arcTs），区间仍从 arcTs+1 起扫
    // ——否则跨线补报会把水位直接跳到 minTs，而 (arcTs, minTs) 之间已由 /query 载入内存的
    // 历史行会被跳过（即使 hotLoaded 已置位，兜底分支也不会介入）。
    // 防大区间空循环：只扫内存 Map 可覆盖的区间尾部（最近 METRICS_KEEP_MIN 分钟，至多 720 次/帧；
    // 否则新服务器 arcTs=0 会从分钟 1 空循环到当前分钟约 4000 万次触发 CPU 尖峰），
    // 更早/未覆盖的部分由 fullSweep 兜底归档。
    if (arcTs < archiveCutoff) {
      const start = Math.max(arcTs + 1, archiveCutoff - METRICS_KEEP_MIN + 1);
      for (let t = start; t <= archiveCutoff; t++) {
        const row = m.get(t);
        if (row) { stmts.push(mk(t, row)); maxArchived = t; }
      }
    }
    // 兜底滞后区间（窄时序边界）：仅限本实例内该机「首帧热写」（fresh=true，即 evict 后）
    // 且本次推进水位时，从 Storage 补归档 (arcTs, maxArchived] 中仅存在于 Storage 的滞后行——
    // 否则 evict 后首帧跨线行（minTs<=cutoff）会把水位从旧位置直接推进到该行而跳过中间历史行。
    // 此后内存 Map 已覆盖本实例写入区间，滞后行由区间循环或 fullSweep（每 ~1h 可靠执行）
    // 兜底——避免「hotLoaded 仅 /query 置位」导致的每 60 秒一次全量 listStorage 读（~1.04M 行/天/机）。
    // 兜底读取失败（Storage 瞬时不可用）时不得推进水位：否则水位越过未归档行后，
    // fullSweep（仅扫 ts>arcTs）也会永久跳过它们——正确性优先，失败时保持水位。
    // 加固：失败置 pendingArcRetry 标记，后续帧（即使 fresh=false）继续重试兜底，
    // 成功后才清除——避免「首帧兜底失败后第 2 帧起 fresh=false 永不重试」导致 storage-only
    // 滞后行被后续正常推进的水位永久越过（仅时钟回拨 + evict + list 瞬时失败组合才触发）
    let fallbackOk = true;
    const needsFallback = maxArchived > arcTs && (fresh || this.pendingArcRetry.has(serverId));
    if (needsFallback) {
      try {
        const items = await this.listStorage(this.hotPrefix(serverId));
        for (const k of items) {
          const t = Number(k.name.slice(this.hotPrefix(serverId).length));
          if (t > arcTs && t <= maxArchived) {
            stmts.push(mk(t, JSON.parse(k.value)));
          }
        }
        this.pendingArcRetry.delete(serverId); // 兜底成功：清除重试标记
      } catch {
        fallbackOk = false;
        this.pendingArcRetry.add(serverId); // 兜底失败：置重试标记，后续帧继续
      }
    }
    // D1 写入成功后才推进水位（失败保持，下次重试）；首次水位=0 时区间可能很大，分批防超 batch 上限
    for (let i = 0; i < stmts.length; i += 100) {
      await this.env.DB.batch(stmts.slice(i, i + 100));
    }
    if (maxArchived > arcTs && fallbackOk) {
      this.arcCache.set(serverId, maxArchived);
      try { await this.state.storage.put(arcKey, String(maxArchived)); } catch { /* 水位持久化失败不影响 */ }
    }
  }

  // 处理单帧上报（/report 批量接口每帧调用）：热写 + 增量归档 + 告警/探活 + 推送
  async processReportFrame(b) {
    const minTs = Number(b.minTs);
    const v = { cpu: b.cpu, mem_used: b.mem_used, mem_total: b.mem_total, net_in: b.net_in, net_out: b.net_out, extra: b.extra };
    // 内存缓存 + storage 持久（storage 为唯一事实源；写失败降级仅内存，不阻断上报）。
    // 热写不加载历史：evict 后缺省空 Map + 新分钟 key 即可，避免每帧全量 loadHot（~720 行 storage 读）
    try {
      const fresh = !this.data.has(b.serverId); // 本实例内该机首帧热写（归档兜底仅首帧语义，见 archiveIncrement）
      let m = this.data.get(b.serverId);
      if (!m) { m = new Map(); this.data.set(b.serverId, m); }
      m.set(minTs, v);
      // 增量 latest：O(1) 维护每机最新指标，/latest 无需扫描分钟 Map
      this.latestByServer.set(b.serverId, {
        ts: minTs, cpu: v.cpu, mem_used: v.mem_used, mem_total: v.mem_total,
        net_in: v.net_in, net_out: v.net_out, extra: v.extra,
        last_seen_s: Math.floor(Date.now() / 1000),
      });
      this.trim(m);
      // storage.put 按分钟去重——同分钟多帧只写 1 次；put 失败不更新 putMin，下帧自动重试
      if (this.putMin.get(b.serverId) !== minTs) {
        await this.state.storage.put(this.hotKey(b.serverId, minTs), JSON.stringify(v));
        this.putMin.set(b.serverId, minTs);
      }
      // 秒级最后上报时间（内存，/latest 在线判定用，比 D1 last_seen 节流更实时）
      this.lastSeenSec.set(b.serverId, Math.floor(Date.now() / 1000));
      // 增量归档：依赖内存历史行；evict 后空 Map 时水位区间无行可归档，由 fullSweep（≈1h）兜底
      await this.archiveIncrement(b.serverId, m, minTs, fresh);
    } catch { /* storage 不可用时降级为纯内存（仅当前实例生命周期） */ }
    this.scheduleArchive();
    // 告警/探活去重判定搭本次 /report 调用顺风车（零额外请求）；失败不影响监控存储
    try {
      if (b.serverName) await this.checkAlerts(b);
      if (Array.isArray(b.probes)) await this.checkProbeAlerts(b.serverId, b.serverName, b.probes);
    } catch { /* 告警失败不影响监控存储 */ }
    // 上报驱动聚合推送——有观看者且距上次 ≥5s 时，把全部 latest 一次推给 PanelDO 广播。
    // 上报驱动不引入定时器（MetricsDO 休眠不受影响）；PanelDO → 前端为出站消息不计费
    if (this.pushOn) {
      const pushNow = Date.now();
      if (pushNow - this.lastPushAt >= LATEST_PUSH_INTERVAL_MS) {
        this.lastPushAt = pushNow;
        try {
          await doPanel(this.env).fetch('https://do.internal/rpc/latest_push', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ latest: Object.fromEntries(this.latestByServer) }),
          });
        } catch { /* 推送失败下个周期重试 */ }
      }
    } else if (Date.now() - this.lastPushProbeAt >= PUSH_PROBE_INTERVAL_MS) {
      // 自愈：pushOn 是实例内存，MetricsDO 无 WS 可能在 PanelDO set_push(1) 之后被 evict，
      // 新实例不知道有人观看 → 面板数据冻结。低频（30s）反查 /viewers，有人看则恢复推送
      this.lastPushProbeAt = Date.now();
      try {
        const vResp = await doPanel(this.env).fetch('https://do.internal/viewers');
        const v = await vResp.json();
        if ((v.count || 0) > 0) this.pushOn = true;
      } catch { /* 反查失败下次再试 */ }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/report' && request.method === 'POST') {
      // 批量接口：body 为 {frames:[...]}（同隔离实例多机聚合）或单帧字段，循环处理
      const b = await request.json();
      const frames = Array.isArray(b) ? b : (Array.isArray(b.frames) ? b.frames : [b]);
      this.usage.report += frames.length; // 用量观测（按帧数计）
      for (const f of frames) {
        if (!f || !f.serverId) continue;
        try { await this.processReportFrame(f); } catch { /* 单帧失败不影响其他帧 */ }
      }
      return json({ ok: true });
    }

    // 内部 RPC：PanelDO 观看者 0→1/1→0 时通知（仅在有人观看时推送 latest）
    if (url.pathname === '/rpc/set_push' && request.method === 'POST') {
      const pb = await request.json();
      this.pushOn = !!pb.on;
      return json({ ok: true });
    }

    if (url.pathname === '/query' && request.method === 'GET') {
      this.usage.query += 1; // 用量观测
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
      this.usage.latest += 1; // 用量观测
      const out = {};
      // 增量 latest Map：/report 热写 O(1) 维护，此处 O(S) 直接返回（避免对分钟 Map 扫描）
      if (this.latestByServer.size > 0) {
        for (const [serverId, l] of this.latestByServer) {
          if (l) out[serverId] = l;
        }
        return json(out);
      }
      // 仅实例 evict 后（增量 Map 为空）才全量扫 storage 恢复；恢复结果同时回填增量 Map，
      // 避免面板 3s 轮询对 DO Storage 的全量读取放大（机器多时收益明显）
      const keys = await this.listStorage('m:');
      for (const k of keys) {
        const rest = k.name.slice(2); // 去掉 'm:'
        const sep = rest.indexOf(':');
        if (sep <= 0) continue;
        const serverId = Number(rest.slice(0, sep));
        const ts = Number(rest.slice(sep + 1));
        const cur = out[serverId];
        if (!cur || ts > cur.ts) {
          const v = JSON.parse(k.value);
          const l = { ts, cpu: v.cpu, mem_used: v.mem_used, mem_total: v.mem_total, net_in: v.net_in, net_out: v.net_out, extra: v.extra, last_seen_s: this.lastSeenSec.get(serverId) };
          out[serverId] = l;
          this.latestByServer.set(serverId, l);
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
      this.putMin.delete(serverId);
      this.hotLoaded.delete(serverId);
      this.latestByServer.delete(serverId);
      this.lastSeenSec.delete(serverId);
      this.pendingArcRetry.delete(serverId);
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

    // 用量观测：本周期内存计数 + 累计到 storage 的总量（跨实例 evict 保留近似量级）
    if (url.pathname === '/usage' && request.method === 'GET') {
      let persisted = {};
      try { persisted = JSON.parse(await this.state.storage.get('usage:total') || '{}'); } catch { /* ignore */ }
      return json({ counters: this.usage, persisted });
    }

    // 内部 RPC：面板保存设置后清本隔离实例的 SETTINGS_CACHE（告警/探活配置立即生效）
    if (url.pathname === '/rpc/clear_settings_cache' && request.method === 'POST') {
      SETTINGS_CACHE.clear();
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
  // alarmCached 缓存实例内已知的下一次 alarm：仅在无缓存或缓存过期时才 getAlarm（每帧 1 次 → 每周期 1 次）
  async scheduleArchive() {
    const next = Date.now() + ARCHIVE_INTERVAL_MS;
    if (this.alarmCached != null && this.alarmCached <= next) return; // 已有不晚于 next 的 alarm，无需查 storage
    const existing = await this.state.storage.getAlarm();
    if (existing == null || next < existing) {
      try { await this.state.storage.setAlarm(next); } catch (e) { console.error('scheduleArchive setAlarm failed:', e); }
      this.alarmCached = next;
    } else {
      this.alarmCached = existing;
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
    const cooledKeys = []; // 本次判定中置冷却的 key（webhook 失败时缩短冷却，见下）
    const cooled = async (key) => {
      const last = this.alertLast.get(key);
      if (last && now - last < cooldown) return false;
      this.alertLast.set(key, now);
      // 冷却触发即持久化，实例 evict/重启后不重复告警
      try { await this.state.storage.put('alert:' + key, String(now)); } catch { /* 持久化失败仅内存 */ }
      cooledKeys.push(key);
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
    // 磁盘（根分区）：新格式 used/total 计算百分比，旧格式 u 回退
    const rootDisk = b.extra && b.extra.disk && b.extra.disk.find((d) => d.m === '/');
    if (rootDisk) {
      const rootPct = rootDisk.used != null && rootDisk.total > 0
        ? (rootDisk.used / rootDisk.total) * 100
        : rootDisk.u;
      if (rootPct != null && rootPct >= cfg.disk_pct && await cooled(`${b.serverId}:disk`)) {
        alerts.push(`磁盘 / ${rootPct.toFixed(1)}% >= ${cfg.disk_pct}%`);
      }
    }
    // 负载（可选，未设置则不启用）
    if (cfg.load > 0 && b.extra && b.extra.load1 != null && b.extra.load1 >= cfg.load && await cooled(`${b.serverId}:load`)) {
      alerts.push(`负载 ${b.extra.load1} >= ${cfg.load}`);
    }
    if (alerts.length) {
      const ok = await sendWebhook(cfg, {
        event: 'alert',
        title: `[cf-panel] ${b.serverName} 指标告警`,
        server: { id: b.serverId, name: b.serverName },
        message: `服务器 ${b.serverName}（id=${b.serverId}）指标超阈值：\n` + alerts.join('\n'),
        details: alerts,
        time: new Date().toISOString(),
      });
      if (!ok && cooledKeys.length) {
        // webhook 送达失败不得消耗完整冷却（否则指标持续超阈值时告警静默丢失整个冷却期）。
        // 把冷却起点回拨到 cooldown - RETRY_BACKOFF_MS 前 → 剩余冷却恰为退避间隔（1 分钟），
        // 之后每帧（≤5s）重新判定触发重发，直至送达。
        const backoffTs = now - cooldown + RETRY_BACKOFF_MS;
        for (const key of cooledKeys) {
          this.alertLast.set(key, backoffTs);
          try { await this.state.storage.put('alert:' + key, String(backoffTs)); } catch { /* 持久化失败仅内存 */ }
        }
      }
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
          // 成功才落 up 状态；失败回滚为原 down 状态，下帧重发（恢复为瞬时事件，无冷却语义，≤5s 重试）
          const sent = await sendWebhook(cfg, {
            event: 'probe_recovered',
            title: `[cf-panel] ${serverName} 服务恢复：${p.name}`,
            server: { id: serverId, name: serverName },
            message: `服务器 ${serverName} 的服务「${p.name}」已恢复正常。`,
            time: new Date().toISOString(),
          });
          if (!sent) {
            this.probeState.set(key, st);
            try { await this.state.storage.put('probe:' + key, JSON.stringify(st)); } catch { /* 持久化失败仅内存 */ }
          } else {
            this.probeState.set(key, { ok: true, lastFail: 0 });
            try { await this.state.storage.put('probe:' + key, JSON.stringify({ ok: true, lastFail: 0 })); } catch { /* 持久化失败仅内存 */ }
          }
        }
      } else if (st.ok || now - st.lastFail >= cooldown) {
        this.probeState.set(key, { ok: false, lastFail: now });
        try { await this.state.storage.put('probe:' + key, JSON.stringify({ ok: false, lastFail: now })); } catch { /* 持久化失败仅内存 */ }
        const sent = await sendWebhook(cfg, {
          event: 'probe_down',
          title: `[cf-panel] ${serverName} 服务异常：${p.name}`,
          server: { id: serverId, name: serverName },
          message: `服务器 ${serverName} 的服务「${p.name}」探测失败${p.code ? `（HTTP ${p.code}）` : ''}。`,
          details: p,
          time: new Date().toISOString(),
        });
        if (!sent) {
          // down 通知送达失败 → lastFail 回拨到 cooldown - 退避 前，剩余冷却=1 分钟退避后重发
          const backoff = now - cooldown + RETRY_BACKOFF_MS;
          this.probeState.set(key, { ok: false, lastFail: backoff });
          try { await this.state.storage.put('probe:' + key, JSON.stringify({ ok: false, lastFail: backoff })); } catch { /* 持久化失败仅内存 */ }
        }
      }
    }
  }

  // 离线/恢复告警：状态存 DO Storage（重启不丢，避免重复告警）。
  // 降额：未配置 webhook 时无法送达，跳过扫描（零成本）；在线判定复用增量 latest 的秒级 last_seen_s；
  // 状态一次性 list 加载到内存（避免每机逐个 get）。
  async ensureOfflineLoaded() {
    if (this.offlineLoaded) return;
    this.offlineLoaded = true;
    try {
      const keys = await this.listStorage('alert:offline:');
      for (const k of keys) {
        this.offlineState.set(k.name.slice('alert:offline:'.length), k.value);
      }
    } catch { /* 加载失败按全在线处理 */ }
  }
  async checkOfflineAlerts() {
    const cfg = await getAlertCfg(this.env);
    if (!cfg.enabled || !cfg.webhook_url) return; // 未配置 webhook 时离线告警无法送达，跳过扫描
    await this.ensureOfflineLoaded();
    const now = Math.floor(Date.now() / 1000);
    const offlineAfter = cfg.offline_after_s;
    const rows = await this.env.DB.prepare('SELECT id, name, last_seen FROM servers').all();
    for (const s of rows.results) {
      // 在线判定优先用 MetricsDO 秒级 last_seen_s（与列表判定一致）；D1 last_seen 仅冷启动兜底
      const lastSeen = this.latestByServer.get(s.id)?.last_seen_s || s.last_seen || 0;
      const isOnline = lastSeen > now - offlineAfter;
      const key = `alert:offline:${s.id}`;
      const last = this.offlineState.get(s.id) || 'on';
      if (!isOnline && last !== 'off') {
        // 送达成功才落 off 状态（失败不落状态，下轮 alarm（10min）自动重发）
        const sent = await sendWebhook(cfg, {
          event: 'offline',
          title: `[cf-panel] ${s.name} 离线`,
          server: { id: s.id, name: s.name },
          message: `服务器 ${s.name}（id=${s.id}）超过 ${offlineAfter}s 未上报，已判定离线。`,
          time: new Date().toISOString(),
        });
        if (sent) {
          this.offlineState.set(s.id, 'off');
          await this.state.storage.put(key, 'off');
        }
      } else if (isOnline && last === 'off') {
        const sent = await sendWebhook(cfg, {
          event: 'recovered',
          title: `[cf-panel] ${s.name} 恢复在线`,
          server: { id: s.id, name: s.name },
          message: `服务器 ${s.name}（id=${s.id}）已恢复上报。`,
          time: new Date().toISOString(),
        });
        if (sent) {
          this.offlineState.set(s.id, 'on');
          await this.state.storage.put(key, 'on');
        }
      }
    }
  }

  // alarm：热区行归档（超 60min 落 D1，热区行保留至 12h 供 ≤12h 查询）+ 删除超 12h 的热区行
  // + 每天 D1 保留期清理 + 离线/恢复告警。归档与删除无条件执行，防 ARCHIVE_TO_D1=0 时
  // storage 热区 / audit_logs 无限增长。
  async alarm() {
    let alertOn = false; // 提升到函数级：finally 的闲置退避判定需要（try 内 const 不可见）
    try {
    // 用量观测：本周期计数累计到 storage（跨实例 evict 保留近似量级），随后清零内存。
    // 按「本期增量」判断全零才跳过 put（累计值 prev+本期 只要历史有过流量就永远非零，
    // 用累计值判断会使跳过成为死代码）——闲置/无流量 alarm 不再无条件写 storage
    try {
      const prev = JSON.parse(await this.state.storage.get('usage:total') || '{}');
      const report = (prev.report || 0) + this.usage.report;
      const latest = (prev.latest || 0) + this.usage.latest;
      const query = (prev.query || 0) + this.usage.query;
      if (this.usage.report || this.usage.latest || this.usage.query) {
        await this.state.storage.put('usage:total', JSON.stringify({ report, latest, query }));
      }
    } catch { /* 用量汇总失败不影响主流程 */ }
    this.usage = { report: 0, latest: 0, query: 0 };
    await this.ensureHousekeepLoaded();
    const archiveOn = this.env.ARCHIVE_TO_D1 !== '0';
    try {
      alertOn = (await getAlertCfg(this.env)).enabled;
    } catch {
      // 告警配置读取失败（D1 瞬时故障）：按"告警开启"处理（保持 10min 正常周期）——
      // 避免与 data.size===0 组合误判闲置而退避 1h，导致归档/离线告警最长停摆 1h；D1 恢复后由下轮拉回
      alertOn = true;
    }
    if (alertOn) await this.checkOfflineAlerts();
    const now = Date.now();
    let housekeepChanged = false;
    // 全量 sweep：按时间差判定（每 6×10min ≈ 1 小时一次），时间戳持久化跨 evict——
    // 慢采/空闲下 MetricsDO 无 WS、两次 alarm 间实例常被 evict，旧内存计数（sweepCount）
    // 会停在 1 导致 fullSweep 永不执行（>12h 热区无限增长 + 兜底归档停摆）
    if (now - this.lastSweepAt >= 6 * ARCHIVE_INTERVAL_MS) {
      this.lastSweepAt = now;
      housekeepChanged = true;
      await this.fullSweep(archiveOn);
    }
    // 保留期清理（每天一次）：删除超过 METRICS_RETENTION_DAYS 的旧数据，以及超过
    // AUDIT_RETENTION_DAYS 的审计日志（created_at 为 datetime('now') 文本，可直接比较）。
    // METRICS_RETENTION_DAYS 可用环境变量覆盖（默认 30）：缩小保留期可降低 D1 容量占用。
    // 时间戳持久化跨 evict：避免慢采/空闲下 lastPrune 被重置为 0 导致每天 144 次全表扫
    //（metrics_custom 无 ts 索引时最坏 6.2M×S×C 读/天，见迁移 0003 补索引）
    if (now - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
      this.lastPruneAt = now;
      housekeepChanged = true;
      const retention = Number(this.env.METRICS_RETENTION_DAYS) > 0
        ? Number(this.env.METRICS_RETENTION_DAYS) : METRICS_RETENTION_DAYS;
      const minTs = Math.floor(now / 1000 / 60) - retention * 1440;
      await this.env.DB.batch([
        this.env.DB.prepare('DELETE FROM metrics_min WHERE ts < ?').bind(minTs),
        this.env.DB.prepare('DELETE FROM metrics_custom WHERE ts < ?').bind(minTs),
        this.env.DB.prepare('DELETE FROM audit_logs WHERE created_at < datetime(\'now\', ?)')
          .bind(`-${AUDIT_RETENTION_DAYS} days`),
      ]);
    }
    // 家政状态持久化（仅变化时写）
    if (housekeepChanged) {
      try {
        await this.state.storage.put('housekeep', JSON.stringify({ lastSweepAt: this.lastSweepAt, lastPruneAt: this.lastPruneAt }));
      } catch { /* 持久化失败：下次 alarm 按当前值重新判定（可能提前执行，无害） */ }
    }
    } finally {
      // 无论是否异常都续排下一次 alarm：防归档/清理/告警因单次失败永久停摆。
      // 闲置（无热区数据且告警关闭）时退避 +1h（零服务器/无上报面板不再 10min 空转 144 次/天）；
      // 新上报经 scheduleArchive 提前拉回（alarmCached 失效后 getAlarm 发现更早需求重新设置）
      const idle = this.data.size === 0 && !alertOn;
      this.alarmCached = Date.now() + (idle ? ARCHIVE_IDLE_INTERVAL_MS : ARCHIVE_INTERVAL_MS);
      try {
        await this.state.storage.setAlarm(this.alarmCached);
      } catch (e) {
        // 续排失败（storage 不可用）记日志——alarm() 的 finally 续排是归档/清理/告警不停摆的唯一保障
        console.error('alarm reschedule failed:', e);
      }
    }
  }

  // 全量 sweep（降频，≈1 小时一次）：>12h 热区行清理 + 兜底归档（水位之后的行 INSERT OR IGNORE）。
  // 常态归档由 /report 增量完成；此处仅兜底异常（水位滞后/实例 evict 后恢复）与执行 12h 上限清理。
  async fullSweep(archiveOn) {
    const archiveCutoff = Math.floor(Date.now() / 1000 / 60) - ARCHIVE_AFTER_MIN;
    const keepCutoff = Math.floor(Date.now() / 1000 / 60) - METRICS_KEEP_MIN;
    const stmts = [];
    const keysToDelete = [];
    const arcMax = new Map(); // serverId -> 兜底归档到的最大 ts
    try {
      const keys = await this.listStorage('m:');
      for (const k of keys) {
        const rest = k.name.slice(2); // 去掉 'm:'
        const sep = rest.indexOf(':');
        if (sep <= 0) continue;
        const serverId = Number(rest.slice(0, sep));
        const ts = Number(rest.slice(sep + 1));
        // 兜底归档：水位之后、归档线之前的行（正常水位=归档线，此处仅兜底异常）
        if (ts <= archiveCutoff && archiveOn) {
          const arcKey = `arc:${serverId}`;
          let arcTs = this.arcCache.get(serverId);
          if (arcTs == null) {
            try { arcTs = Number(await this.state.storage.get(arcKey)) || 0; } catch { arcTs = 0; }
            this.arcCache.set(serverId, arcTs);
          }
          if (ts > arcTs) {
            const v = JSON.parse(k.value);
            // 数值归一化：历史坏数据（修复前写入）不得让整批归档失败
            stmts.push(
              this.env.DB.prepare(
                'INSERT OR IGNORE INTO metrics_min (server_id, ts, cpu, mem_used, mem_total, net_in, net_out, extra) VALUES (?,?,?,?,?,?,?,?)'
              ).bind(
                serverId, ts,
                numOrNull(v.cpu), numOrNull(v.mem_used), numOrNull(v.mem_total),
                numOrNull(v.net_in), numOrNull(v.net_out),
                v.extra ? JSON.stringify(v.extra) : null
              )
            );
            arcMax.set(serverId, Math.max(arcMax.get(serverId) || 0, ts));
          }
        }
        // 超过热区上限（12h）：删除 storage 行（防无限增长；D1 已含归档数据）
        if (ts <= keepCutoff) keysToDelete.push(k.name);
      }
    } catch { /* storage 不可用则跳过本次清理（行保留，下次重试） */ }
    // D1 写入成功后才删除 storage 行（防 D1 失败时两端数据丢失）；分批提交。
    // 单批失败不得中断后续批次/清理/水位推进（归档失败不再连带跳过 prune 与家政持久化）
    for (let i = 0; i < stmts.length; i += 100) {
      try {
        await this.env.DB.batch(stmts.slice(i, i + 100));
      } catch (e) {
        console.error(`fullSweep batch failed (${stmts.length} rows):`, e);
      }
    }
    await Promise.all(keysToDelete.map((name) => this.state.storage.delete(name)));
    // 同步清理内存缓存中超过热区上限的数据
    for (const [, m] of this.data) {
      for (const ts of [...m.keys()]) {
        if (ts <= keepCutoff) m.delete(ts);
      }
    }
    // 兜底后推进水位（到实际归档的最大 ts）
    for (const [serverId, ts] of arcMax) {
      this.arcCache.set(serverId, ts);
      try { await this.state.storage.put(`arc:${serverId}`, String(ts)); } catch { /* ignore */ }
    }
  }
}
