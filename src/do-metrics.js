// cf-panel — Durable Object：监控时序内存热区（MetricsDO）
import {
  ARCHIVE_AFTER_MIN, metricsDownsampleMin, metricsFineDays,
  statsTzOffsetSec, dayIndexOf, dayStartTs, DAY_ONLINE_GAP_S,
} from './config.js';
import { json, err, doPanel, sendWebhook, numOrNull } from './utils.js';
import { getAlertCfg, resolveAlertCfg, SETTINGS_CACHE } from './db.js';

// 本模块专用常量（热区/归档/家政/推送，就近定义便于对照使用代码）
// 内存热区保留分钟数（默认 240 = 4 小时）。
// 依据：ARCHIVE_AFTER_MIN(60) 之后行即落 D1，且 db.js queryMonitorRows 对 >1h 的查询
// 必然读 D1——热区超出归档线的部分对查询结果零贡献，只是同一批数据的第二份副本。
// 原 720（12h）是 6 倍冗余，直接放大 DO storage 行数、fullSweep 全扫量与每帧 trim 成本。
// 240 = 归档线 4 倍余量（覆盖增量归档滞后 + fullSweep 1h 兜底周期）。
// ARCHIVE_TO_D1=0 时热区是唯一存储，回退 720 才能保住 12h 可查历史（既有行为不变）。
const METRICS_KEEP_MIN = 240;
const METRICS_KEEP_MIN_NO_ARCHIVE = 720;
const ARCHIVE_INTERVAL_MS = 10 * 60 * 1000; // 归档周期
// 归档水位（arc:<id>）持久化降频：每跨一分钟写一次 = 1,440 写/台/天（与热行同量）。
// 改为每推进 10 分钟写一次（−90%）：evict 后最多重放 10 行，INSERT OR IGNORE 幂等，
// 不丢历史也不重复计数；内存水位仍逐分钟推进，查询与归档判定不受影响。
const ARC_PERSIST_MIN = 10;
// fullSweep 每页读取的热区行数。旧实现一次 list 全量载入（240×N 行，500 台 ≈ 12 万行），
// 分页后峰值内存 ≈ 一页 + 当前机器的窗口。SQLite 后端的 list 支持 limit/startAfter。
const SWEEP_PAGE_ROWS = 500;
// 探活状态兜底对账间隔：list('probe:') 会把全部探针键连同 value 载入内存
//（500 台 × 10 探针 ≈ 5,000 键），按 10 分钟 alarm 扫就是 72 万键读/天。
// 改为每小时一次（且仅告警开启时），代价是「删掉探针后残留冷却」最多多留 1 小时。
const PROBE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const METRICS_RETENTION_DAYS = 30; // D1 历史保留期（天），过期行每日清理
const AUDIT_RETENTION_DAYS = 90; // 审计日志保留期（天），过期行随每日清理删除
// 按天账保留期（天，默认 3 年 = 1095）。
// 3 年足以覆盖月度/年度流量与可用率的对账需求（合规留存通常要求 1~7 年）；
// 容量上更无压力——约 100B/行/机/天，100 台机器满 3 年仅约 11MB。
// 保留上限而非永久：数据只增不减时缺少回收出口。需要更长/更短用
// METRICS_DAY_RETENTION_DAYS 覆盖（正数=天数，未配置/非法=本默认值）。
const METRICS_DAY_RETENTION_DAYS = 1095;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 保留期清理周期
const ARCHIVE_IDLE_INTERVAL_MS = 60 * 60 * 1000; // 闲置（无数据且告警关闭）时 alarm 退避间隔（1h）
// latest 冷启动快照行（`l:<id>`）的写入间隔（分钟）：1 行/机，实例常驻时 ≈ +288 写/台/天。
// 它把 /latest 冷启动从「全量扫热区（240×N 行 + 逐行 JSON.parse）」降成「读 N 行」。
// 注意：每次冷启动的首帧必写一次（否则 evict 后快照会一直停在旧值），因此「慢采 120s +
// 每帧都落在新实例」的最坏情况是 720 写/台/天——仍低于热行 1,440，且换来冷启动 O(N)。
const LATEST_KEY_EVERY_MIN = 5;
// /latest 冷启动为「缺 l: 快照」的机器补扫时的单轮上限：升级首轮可能 500 台全缺，
// 串行补扫会让面板首连多等数秒；缺的部分由下一轮冷启动或该机首帧上报补齐。
const LATEST_BACKFILL_MAX = 100;
const LATEST_PUSH_INTERVAL_MS = 5000; // 上报驱动聚合推送间隔（有观看者时 ≥5s 推一次全部 latest 给 PanelDO；
// 单机时被 REPORT_FWD_THROTTLE_S=5s 钳制（MetricsDO 每 5s 收帧），多机时聚合多台上报防推送风暴）
// pushOn 自愈反查 /viewers 的间隔（MetricsDO evict 丢失 pushOn 时）。
// 300s：无观看者时该项最多 288 请求/天（原 30s 是 2,880）。代价只是「evict 后恢复推送」
// 的延迟从 ≤30s 变成 ≤5min——期间界面靠前端兜底刷新，采样与告警不受影响。
const PUSH_PROBE_INTERVAL_MS = 300 * 1000;
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
    this.alertLoadedFor = new Set(); // serverId：本实例已恢复该机告警冷却状态
    this.probeLoadedFor = new Set(); // serverId：本实例已恢复该机探活去重状态
    this.arcCache = new Map(); // serverId -> 已归档水位（分钟），实例内缓存，evict 后从 storage 恢复
    this.arcPersisted = new Map(); // serverId -> 已写进 storage 的水位（降频持久化用，见 ARC_PERSIST_MIN）
    this.lastSweepAt = 0; // 上次 fullSweep 时间戳（ms；持久化跨 evict，见 ensureHousekeepLoaded）
    this.lastPruneAt = 0; // 上次保留期清理时间戳（ms；同上，替代易被 evict 重置的内存计数）
    this.lastProbePruneAt = 0; // 上次探活状态兜底对账时间戳（ms；同上，见 PROBE_PRUNE_INTERVAL_MS）
    this.housekeepLoaded = false; // 家政状态（fullSweep/prune 时间）是否已从 storage 恢复
    this.lastSeenSec = new Map(); // serverId -> 最后上报秒（内存，/latest 在线判定用；evict 后由 D1 last_seen 兜底）
    this.alarmCached = null; // 实例内已知的下一次 alarm 时间戳；避免每帧上报都 getAlarm（DO Storage 读）
    this.latestByServer = new Map(); // serverId -> 最新指标 {ts, ..., last_seen_s}（/report 热写 O(1) 维护，/latest 直接 O(S) 返回）
    this.latestAt = new Map(); // serverId -> 上次写 `l:` 快照的分钟（降频，见 LATEST_KEY_EVERY_MIN）
    this.offlineLoaded = false; // 离线告警状态是否已从 storage 一次性加载（惰性）
    this.offlineState = new Map(); // serverId -> 'on'|'off'（内存副本，避免每机逐个 getAlarm）
    this.usage = { report: 0, latest: 0, query: 0 }; // 用量观测：本周期（10min）计数，周期末累计到 storage
    this.hotLoaded = new Set(); // serverId 已从 storage 完整加载热区的标记（见 ensureHot）
    this.pushOn = false; // 是否有观看者（PanelDO 0→1/1→0 通知），开启时才推送 latest
    this.lastPushAt = 0; // 上次推送 latest 给 PanelDO 的时刻（ms）；上报驱动节流，不引入定时器
    this.lastPushProbeAt = 0; // 上次反查 /viewers 的时刻（pushOn 因 evict 丢失时的自愈兜底）
    this.pendingArcRetry = new Set(); // serverId：首帧兜底 list 失败后待重试（正确性加固）
    this.trimMin = new Map(); // serverId -> 上次裁剪所在的分钟（分钟滚动才 trim，见 processReportFrame）
    // 按天统计（流量累计 / 可用率 / 重启检测）：
    // dayPending = 待落 D1 的增量（flush 后清空，D1 侧用 UPSERT 累加，故幂等）；
    // dayAccum = 每机的累加游标（lastSec 上次累加时刻、uptimeMin 上次开机时长）。
    // 游标**必须跨实例存活**：本 DO 无 WS 时两次 alarm 之间常被 evict，慢采（120s）下
    // 几乎每帧都落在新实例上——纯内存游标会让首帧 dt 恒为 0，流量与可用率分母静默停止增长
    //（功能存在但给出错误数字）。故游标随 alarm 每 10 分钟持久化到 Storage（daycur:<id>），
    // 冷启动优先从 Storage 恢复，缺失时用 D1 servers.last_seen 播种（见 ensureDayCursor）。
    this.dayPending = new Map(); // `${serverId}:${day}` -> { serverId, day, bytesIn, bytesOut, onlineMin, totalMin, uptimeMin, restarts }
    this.dayAccum = new Map(); // serverId -> { lastSec, uptimeMin }
    this.dayCurLoaded = new Set(); // serverId：本实例已尝试恢复游标（Storage → D1 播种）
    this.dayCurDirty = new Set(); // serverId：游标有变化，待下次 alarm 持久化
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
        this.lastProbePruneAt = Number(h.lastProbePruneAt) || 0;
      }
    } catch { /* 恢复失败按 0 处理（首次/损坏），下次 alarm 正常判定 */ }
  }

  // 从 DO Storage 惰性恢复告警冷却 / 探活去重状态。
  // **按机加载**（每实例每机一次），不再 `list('alert:')` 全量：
  // 无观看者时 120s 一帧几乎每帧都是新实例，全量 list 会把所有机器的冷却状态（50 台 × 4 维
  // ≈ 200 行）在每帧重新载入；而绝大多数帧一个指标都没越界（见 checkAlerts 的阈值前置判定），
  // 根本用不到这些状态。探活同理（只在 probe 列表非空且告警开启时才会用到）。
  async ensureAlertLoadedFor(serverId) {
    if (this.alertLoadedFor.has(serverId)) return;
    this.alertLoadedFor.add(serverId);
    try {
      const keys = await this.listStorage(`alert:${serverId}:`);
      for (const k of keys) {
        this.alertLast.set(k.name.slice('alert:'.length), Number(k.value));
      }
    } catch { /* 加载失败按空状态处理（最坏多告警一次，不丢告警） */ }
  }
  async ensureProbeLoadedFor(serverId) {
    if (this.probeLoadedFor.has(serverId)) return;
    this.probeLoadedFor.add(serverId);
    try {
      const keys = await this.listStorage(`probe:${serverId}:`);
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
  // 兼容 storage.list 返回格式：CF 生产为 {keys:[{name,value}]}，wrangler dev --local 为 Map。
  // opts 透传 {limit, startAfter} 供 fullSweep 分页（SQLite 后端全量 list 会把所有 value 载入内存）。
  async listStorage(prefix, opts = {}) {
    const res = await this.state.storage.list({ prefix, ...opts });
    if (res instanceof Map) return [...res.entries()].map(([name, value]) => ({ name, value }));
    if (Array.isArray(res)) return res;
    if (Array.isArray(res && res.keys)) return res.keys;
    return [];
  }
  // 从 storage 加载某服务器热区到内存缓存（实例 evict 后首次访问时恢复）。
  // 合并而不是替换：热写路径每分钟只把首帧落 storage（同分钟后续帧只在内存），
  // 直接 set 会把内存中更新的一帧覆盖回 storage 的旧值——首次 /query 读到分钟内首帧，
  // 且该分钟跨过归档线时会把陈旧值写进 D1（只读查询污染后续写入）。
  // 内存里已有的分钟一律以内存为准（同实例内热写路径是唯一写入者，内存值必然更新）。
  async loadHot(serverId) {
    const prefix = this.hotPrefix(serverId);
    const items = await this.listStorage(prefix);
    let m = this.data.get(serverId);
    if (!m) { m = new Map(); this.data.set(serverId, m); }
    for (const k of items) {
      const ts = Number(k.name.slice(prefix.length));
      if (m.has(ts)) continue;
      m.set(ts, JSON.parse(k.value));
    }
    this.hotLoaded.add(serverId);
    return m;
  }
  // 仅当该服务器热区已「完整加载」才直接返回内存；热写路径在 evict 后创建的空 Map 不算已加载
  // （否则 /query 会因 data.has() 误判而跳过 storage 恢复，出现最近 ~1h 数据缺口）
  async ensureHot(serverId) {
    if (!this.hotLoaded.has(serverId)) await this.loadHot(serverId);
    return this.data.get(serverId);
  }

  // 按机补扫热区（`m:<id>:` 前缀）取最新一行，写进 out 与增量 Map。
  // 供 /latest 冷启动给「缺 l: 快照」的机器兜底（升级首轮、该机快照写失败）。
  // 按机读的峰值内存是一台机器的窗口，不会退化成全量热区。
  async loadLatestFromHot(serverId, out) {
    const prefix = `m:${serverId}:`;
    let keys;
    try { keys = await this.listStorage(prefix); } catch { return; }
    let best = null;
    for (const k of keys) {
      const ts = Number(k.name.slice(prefix.length));
      if (!Number.isFinite(ts) || (best && ts <= best.ts)) continue;
      try { best = { ts, v: JSON.parse(k.value) }; } catch { /* 单行损坏跳过 */ }
    }
    if (!best) return;
    const l = {
      ts: best.ts, cpu: best.v.cpu, mem_used: best.v.mem_used, mem_total: best.v.mem_total,
      net_in: best.v.net_in, net_out: best.v.net_out, extra: best.v.extra,
      last_seen_s: this.lastSeenSec.get(serverId),
    };
    out[serverId] = l;
    this.latestByServer.set(serverId, l);
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
      // 冷启动也要记「已落盘水位」= 刚读到的值，否则每个新实例的首次归档都会立即写一次
      //（慢采/频繁 evict 下 1,440 写/台/天，降频白做）。期间不落盘的代价只是 evict 后重放
      // 已归档区间，INSERT OR IGNORE 幂等。
      this.arcPersisted.set(serverId, arcTs);
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
    // 防大区间空循环：只扫内存 Map 可覆盖的区间尾部（最近 keepMin() 分钟，即窗口跨度；
    // 否则新服务器 arcTs=0 会从分钟 1 空循环到当前分钟约 4000 万次触发 CPU 尖峰），
    // 更早/未覆盖的部分由 fullSweep 兜底归档。
    if (arcTs < archiveCutoff) {
      const start = Math.max(arcTs + 1, archiveCutoff - this.keepMin() + 1);
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
      // 降频持久化：只在推进 ≥ARC_PERSIST_MIN 分钟时落盘（见常量注释）。
      // 失败时不更新 arcPersisted，下一帧继续尝试——内存水位仍然前进，不影响本次归档。
      const persisted = this.arcPersisted.get(serverId);
      if (persisted == null || maxArchived - persisted >= ARC_PERSIST_MIN) {
        try {
          await this.state.storage.put(arcKey, String(maxArchived));
          this.arcPersisted.set(serverId, maxArchived);
        } catch { /* 水位持久化失败不影响 */ }
      }
    }
  }

  // ---------------- 按天统计（流量累计 / 可用率 / 重启检测）----------------
  // 为何必须实时累加、不能事后查 metrics_min：
  //   1) metrics_min 只保留 30 天，且 7 天后按 ts%5 降采样只剩 1/5 采样点；
  //   2) 更关键——"离线时长"在 metrics_min 里根本没有行，离线期间无上报，事后无从反推。
  // 因此每个观测区间在发生的当下就结算进 metrics_day（1 行/机/天，保留期远长于 30 天）。

  // 恢复某机的天账累加游标（每实例每机一次）。
  // 为什么单独一个 async 方法：accumulateDay 在每帧热路径上且是同步的，恢复要读 Storage/D1。
  // 为什么必须恢复：慢采/无观看者时 MetricsDO 几乎每帧都在新实例上，纯内存游标会让首帧
  // dt 恒为 0 —— 流量与可用率分母静默停止增长（不是崩溃，是给出错误数字）。
  // 优先级：Storage 游标（= 已记账边界，最准）→ D1 last_seen（60s 节流写，粒度够 120s 慢采）。
  async ensureDayCursor(serverId) {
    if (this.dayCurLoaded.has(serverId)) return;
    this.dayCurLoaded.add(serverId);
    if (this.dayAccum.has(serverId)) return; // 本实例已累加过，内存游标最新
    let lastSec = 0;
    let uptimeMin = null;
    try {
      const raw = await this.state.storage.get(`daycur:${serverId}`);
      if (raw) {
        const cur = JSON.parse(raw);
        lastSec = Number(cur.lastSec) || 0;
        uptimeMin = cur.uptimeMin == null ? null : Number(cur.uptimeMin);
      }
    } catch { /* 恢复失败退回 D1 播种 */ }
    if (!(lastSec > 0)) {
      try {
        const row = await this.env.DB.prepare('SELECT last_seen FROM servers WHERE id = ?').bind(serverId).first();
        lastSec = Number(row && row.last_seen) || 0;
      } catch { /* D1 不可用：按首帧语义处理（少记一段，但不会多记） */ }
    }
    if (!(lastSec > 0)) return;
    // 时钟回拨时游标不得落在未来：dt 为负会被 accumulateDay 忽略，导致该机天账永久停滞
    const nowSec = Math.floor(Date.now() / 1000);
    if (lastSec > nowSec) lastSec = nowSec;
    this.dayAccum.set(serverId, { lastSec, uptimeMin });
  }

  // 游标持久化（alarm 内、D1 写之前执行）。
  // 顺序不能反：若先写 D1 再写游标，evict 会造成「数据已入库、游标还停在更早时刻」，
  // 下次冷启动把这区间再记一遍（多记）；反过来只会少记一个周期，符合本模块
  // 「宁可少记，不可多记」的既有取舍（与 flushDayPending 先清空再写同理）。
  async persistDayCursors() {
    const failed = new Set();
    if (!this.dayCurDirty.size) return failed;
    for (const serverId of [...this.dayCurDirty]) {
      const st = this.dayAccum.get(serverId);
      try {
        // 逐键写（不用 put(entries) 对象形式）：写入量按 key 计费，与批量同价；
        // 逐键失败只影响该机（下次 alarm 重试），不会让整批一起丢。
        if (st) {
          await this.state.storage.put(
            `daycur:${serverId}`,
            JSON.stringify({ lastSec: st.lastSec, uptimeMin: st.uptimeMin }),
          );
        }
        this.dayCurDirty.delete(serverId);
      } catch {
        failed.add(serverId); // 保留 dirty，且本轮不写该机的 D1 增量（见 flushDayPending）
      }
    }
    return failed;
  }

  // 取（或创建）某机某天的待落库增量记录（统一入口，避免多处重复拼 key）
  dayRec(serverId, day) {
    const key = `${serverId}:${day}`;
    let rec = this.dayPending.get(key);
    if (!rec) {
      rec = {
        serverId, day, bytesIn: 0, bytesOut: 0, onlineMin: 0, totalMin: 0, uptimeMin: null, restarts: 0,
      };
      this.dayPending.set(key, rec);
    }
    return rec;
  }

  // 把一段时间区间记入天账，跨天时按天拆分。
  // online=true：记入可用率分子+分母并累计流量；false：只记分母（离线时间，无流量）。
  addDaySpan(serverId, startSec, spanSec, online, netIn, netOut) {
    if (!(spanSec > 0)) return;
    const offset = statsTzOffsetSec(this.env);
    let cursor = startSec;
    let left = spanSec;
    // 跨天循环：每次只推进到当天末尾，保证一天的账不会被整体记到相邻天。
    // guard 上限：极端时钟回拨或异常 span 时最多切 400 段（约 400 天），防死循环拖垮 alarm。
    for (let guard = 0; guard < 400 && left > 0; guard++) {
      const day = dayIndexOf(cursor, offset);
      const seg = Math.min(left, dayStartTs(day + 1, offset) - cursor);
      const rec = this.dayRec(serverId, day);
      const minutes = seg / 60;
      rec.totalMin += minutes;
      if (online) {
        rec.onlineMin += minutes;
        // 流量 = 速率 × 时长（后向矩形法：用本次上报的瞬时速率代表该区间）。
        // 快采 5s 精度很高；慢采 120s 是区间均值近似，误差取决于速率波动，量级判断足够。
        if (netIn != null) rec.bytesIn += Math.max(0, Number(netIn) || 0) * seg;
        if (netOut != null) rec.bytesOut += Math.max(0, Number(netOut) || 0) * seg;
      }
      cursor += seg;
      left -= seg;
    }
  }

  // 单帧上报的按天结算：把「上次累加 → 本次上报」这段区间记入天账。
  // 区间内超出 DAY_ONLINE_GAP_S 的部分判为离线（只补分母、不补分子），
  // 否则"离线 3 天后恢复上报"的那一帧会把整段离线时间算成在线，可用率恒显示 100%。
  accumulateDay(serverId, nowSec, netIn, netOut, uptimeSec) {
    // 兜底分支只在「从未有游标」（首帧 / Storage 与 D1 都无记录）时命中：
    // 调用方已用 ensureDayCursor 恢复，正常路径不会走这里
    const st = this.dayAccum.get(serverId) || { lastSec: nowSec, uptimeMin: null };
    const dt = nowSec - st.lastSec;
    if (dt > 0) {
      const onlineSec = Math.min(dt, DAY_ONLINE_GAP_S);
      const offlineSec = dt - onlineSec;
      if (offlineSec > 0) this.addDaySpan(serverId, st.lastSec, offlineSec, false, 0, 0);
      if (onlineSec > 0) this.addDaySpan(serverId, st.lastSec + offlineSec, onlineSec, true, netIn, netOut);
    }
    st.lastSec = nowSec;
    // 重启检测：开机时长出现下降沿即判为重启（容差 1 分钟，吸收上报抖动与取整误差）。
    // uptime 是"机器视角的连续性"，与可用率（"网络视角的可达性"）互补——
    // 每天定时重启的机器可用率仍可能 99.9%；反之从不重启的机器也可能断过网。
    const uptimeMin = Number.isFinite(Number(uptimeSec)) ? Number(uptimeSec) / 60 : null;
    if (uptimeMin != null) {
      const rec = this.dayRec(serverId, dayIndexOf(nowSec, statsTzOffsetSec(this.env)));
      if (st.uptimeMin != null && uptimeMin < st.uptimeMin - 1) rec.restarts += 1;
      rec.uptimeMin = uptimeMin; // 当天最后观测到的开机时长
      st.uptimeMin = uptimeMin;
    }
    this.dayAccum.set(serverId, st);
    this.dayCurDirty.add(serverId);
  }

  // 离线补账（alarm 调用）：彻底掉线的机器不再上报 → accumulateDay 不触发 →
  // 可用率分母停止增长，长时间离线反而显示 100%（分子分母同时不涨）。
  // 此处为每台已知机器补记「上次累加 → 离线确认点」的离线时长（只补分母）。
  //
  // 必须查 D1 而不是遍历内存 lastSeenSec：慢采/无观看者时实例在两次 alarm 之间常被 evict，
  // 冷实例的 lastSeenSec 是空的——那样「整段时间都在别的实例上报」的机器会被完全跳过
  //（与天账游标丢失同源，见 ensureDayCursor）。
  async sweepOfflineDaySpans(nowSec) {
    let rows = [];
    try {
      rows = (await this.env.DB.prepare('SELECT id, last_seen FROM servers').all()).results || [];
    } catch { return; } // D1 不可用：本轮不补账（只影响分母），下次 alarm 重试
    for (const s of rows) {
      const serverId = Number(s.id) || 0;
      if (!serverId) continue;
      const lastSeen = Math.max(Number(s.last_seen) || 0, this.lastSeenSec.get(serverId) || 0);
      // 从未上报过的机器不补：否则会把「建站至今」整段记成离线，一次写几百天分行
      if (!(lastSeen > 0)) continue;
      let st = this.dayAccum.get(serverId);
      if (!st) {
        // 只为「疑似已离线」的机器恢复游标：在线机器（last_seen 新鲜）直接跳过，
        // 避免冷实例每次 alarm 对全部机器各做一次 Storage 读
        if (nowSec - lastSeen <= DAY_ONLINE_GAP_S) continue;
        await this.ensureDayCursor(serverId);
        st = this.dayAccum.get(serverId);
      }
      const since = st ? st.lastSec : lastSeen;
      const dt = nowSec - since;
      if (dt <= DAY_ONLINE_GAP_S) continue;
      // 尾部 DAY_ONLINE_GAP_S 仍可能是正常上报间隙（慢采 120s + 抖动），不判离线
      const offlineSec = dt - DAY_ONLINE_GAP_S;
      this.addDaySpan(serverId, since, offlineSec, false, 0, 0);
      if (st) st.lastSec = since + offlineSec;
      this.dayCurDirty.add(serverId);
    }
  }

  // 把内存增量落 D1（UPSERT 累加），alarm 每 10 分钟一次。
  // 先持久化游标、再清空 pending 并写：即使写入失败/中途 evict 也不重复累加
  //（宁可少记，不可多记）。代价是实例 evict 会丢失最多一个 flush 周期（≤10 分钟）的增量。
  // 游标写失败的那台机器本轮不写 D1：否则「D1 有增量、游标停在更早」会在下次冷启动
  // 按旧游标把同一区间再记一遍——这正是上面想避免的「多记」。
  async flushDayPending() {
    const cursorFailed = await this.persistDayCursors();
    if (!this.dayPending.size) return;
    const rows = [...this.dayPending.values()].filter((r) => !cursorFailed.has(r.serverId));
    for (const r of rows) this.dayPending.delete(`${r.serverId}:${r.day}`);
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100).map((r) => this.env.DB.prepare(
        `INSERT INTO metrics_day (server_id, day, bytes_in, bytes_out, online_min, total_min, uptime_min, restarts)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(server_id, day) DO UPDATE SET
           bytes_in = bytes_in + excluded.bytes_in,
           bytes_out = bytes_out + excluded.bytes_out,
           online_min = online_min + excluded.online_min,
           total_min = total_min + excluded.total_min,
           uptime_min = COALESCE(excluded.uptime_min, uptime_min),
           restarts = restarts + excluded.restarts`
      ).bind(r.serverId, r.day, r.bytesIn, r.bytesOut, r.onlineMin, r.totalMin, r.uptimeMin, r.restarts));
      try {
        await this.env.DB.batch(batch);
      } catch (e) {
        console.error('metrics_day flush failed:', e);
      }
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
      // 分钟滚动时才裁剪：窗口边界每帧最多移动 1 分钟，逐帧全扫是纯浪费
      //（快采 5s → 每机 12 帧/分钟 × O(窗口) 次迭代，其中 11 次必然无键可删）
      if (this.trimMin.get(b.serverId) !== minTs) {
        this.trimMin.set(b.serverId, minTs);
        this.trim(m);
      }
      // storage.put 按分钟去重——同分钟多帧只写 1 次；put 失败不更新 putMin，下帧自动重试。
      // 同时按 LATEST_KEY_EVERY_MIN 维护一份 `l:<id>` 快照行：/latest 冷启动据此 O(N) 恢复，
      // 不再全量扫热区（240×N 行）。批量 put 计费按 key 不变，只少一次 round trip。
      if (this.putMin.get(b.serverId) !== minTs) {
        // 用「距上次写快照 ≥5 分钟」而不是「minTs % 5 === 0」：后者依赖上报恰好落在 5 的倍数
        // 分钟上，120s 慢采若长期落在同一组分钟（如奇数分钟）就永远不会写，优化静默失效。
        // 首帧（含 evict 后）必写一次，保证冷启动快照总是新鲜的。
        // 已知取舍：快照与热行共用同一个 v（= 写入那一刻的最新帧，即该分钟首帧，不额外算），
        // 并且受 LATEST_KEY_EVERY_MIN 节流——写完之后直到下一次重写都不再刷新。因此冷启动
        // 读到的快照最多落后「一个节流窗口 + 当前分钟偏移」（分钟级），同分钟后续帧压根不在
        // 快照里。
        // 若改为每帧都写快照：快照写量从 288/台/天升到 17,280（快采）/ 720（慢采），只为冷
        // 启动首查不值得；「下一分钟首帧写上一帧的值」虽零额外写，却恒落后一个上报周期起步，
        // 同样解决不了节流窗口——维持现状。
        const lastL = this.latestAt.get(b.serverId);
        const wantLatest = lastL == null || minTs - lastL >= LATEST_KEY_EVERY_MIN;
        const entries = { [this.hotKey(b.serverId, minTs)]: JSON.stringify(v) };
        if (wantLatest) {
          entries[`l:${b.serverId}`] = JSON.stringify({
            ts: minTs, cpu: v.cpu, mem_used: v.mem_used, mem_total: v.mem_total,
            net_in: v.net_in, net_out: v.net_out, extra: v.extra,
          });
        }
        await this.state.storage.put(entries);
        this.putMin.set(b.serverId, minTs);
        if (wantLatest) this.latestAt.set(b.serverId, minTs); // put 成功才推进
      }
      // 秒级最后上报时间（内存，/latest 在线判定用，比 D1 last_seen 节流更实时）
      const nowSec = Math.floor(Date.now() / 1000);
      this.lastSeenSec.set(b.serverId, nowSec);
      // 按天统计（流量累计 / 可用率）：单独 try——它只是旁路账本，
      // 任何失败都不得影响监控存储主链路（热写/归档）
      try {
        // 先恢复游标（冷实例首帧必需）：否则 dt 恒为 0，流量/可用率静默为 0
        await this.ensureDayCursor(b.serverId);
        this.accumulateDay(b.serverId, nowSec, b.net_in, b.net_out, b.extra && b.extra.uptime);
      } catch (e) {
        console.error('accumulateDay failed:', e);
      }
      // 增量归档：依赖内存历史行；evict 后空 Map 时水位区间无行可归档，由 fullSweep（≈1h）兜底
      await this.archiveIncrement(b.serverId, m, minTs, fresh);
    } catch { /* storage 不可用时降级为纯内存（仅当前实例生命周期） */ }
    this.scheduleArchive();
    // 告警/探活去重判定搭本次 /report 调用顺风车（零额外请求）；失败不影响监控存储
    try {
      if (b.serverName) await this.checkAlerts(b);
      if (Array.isArray(b.probes) && b.probes.length) {
        await this.checkProbeAlerts(b.serverId, b.serverName, b.probes, b.alertOverride);
      } else if (b.probesCleared) {
        // agent 明确上报「本机已无探针」：清掉去重状态（与库中 probe_json 一起失效）
        await this.clearProbeState(b.serverId);
      }
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
      const limit = Number(url.searchParams.get('limit')) || this.keepMin();
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
      // 仅实例 evict 后（增量 Map 为空）才从 storage 恢复；恢复结果回填增量 Map。
      // 优先读 `l:<id>` 快照行（每机 1 行）：旧实现扫全量 `m:`（240×N 行 + 逐行 parse），
      // 500 台 ≈ 12 万行，面板首连/evict 后首帧会形成一次 CPU 与内存尖峰。
      let lKeys = null;
      try { lKeys = await this.listStorage('l:'); } catch { lKeys = null; }
      if (lKeys === null) return json(out); // Storage 不可用：返回空，等下一帧上报重建
      if (lKeys.length) {
        for (const k of lKeys) {
          const serverId = Number(k.name.slice(2));
          if (!serverId) continue;
          let v;
          try { v = JSON.parse(k.value); } catch { continue; } // 单行损坏不得拖垮整个 /latest
          const l = {
            ts: v.ts, cpu: v.cpu, mem_used: v.mem_used, mem_total: v.mem_total,
            net_in: v.net_in, net_out: v.net_out, extra: v.extra,
            last_seen_s: this.lastSeenSec.get(serverId),
          };
          out[serverId] = l;
          this.latestByServer.set(serverId, l);
        }
        // 快照是「按机」的：某台缺 l:（升级首轮 / 该机快照写失败）不能因为别的机器有快照就
        // 跳过它——否则冷启动首查会缺这台机器的指标（面板显示 '-' 直到下一帧上报）。
        // 只为缺快照的机器按前缀补扫（峰值内存 ≈ 一台机器的窗口），已有快照的机器零 Storage 读；
        // 代价是多一条 D1 读（拿服务器清单），冷启动 + 低频，可接受。
        // 补扫按机器串行、每轮最多 LATEST_BACKFILL_MAX 台：升级首轮 500 台全缺快照时，
        // 避免面板首连卡住数秒（缺的那部分下一轮冷启动或首帧上报即补齐）。
        let ids = [];
        try {
          // ORDER BY id：SQLite 可能走覆盖索引扫描（顺序变成 agent_key_id 的字典序），
        // 加显式排序让「每轮补哪 100 台」可预期且稳定
        ids = ((await this.env.DB.prepare('SELECT id FROM servers ORDER BY id').all()).results || [])
            .map((s) => Number(s.id) || 0);
        } catch { /* D1 不可用：本次只返回已有快照，下一帧上报即补齐 */ }
        let filled = 0;
        for (const sid of ids) {
          if (!sid || out[sid]) continue;
          if (filled >= LATEST_BACKFILL_MAX) break;
          filled += 1;
          await this.loadLatestFromHot(sid, out);
        }
        return json(out);
      }

      // 升级兼容：部署前写入的热区还没有 `l:` 快照行 → 退回原全量扫描（此后随上报补齐）
      const hotKeys = await this.listStorage('m:');
      for (const k of hotKeys) {
        const rest = k.name.slice(2); // 去掉 'm:'
        const sep = rest.indexOf(':');
        if (sep <= 0) continue;
        const serverId = Number(rest.slice(0, sep));
        const ts = Number(rest.slice(sep + 1));
        const cur = out[serverId];
        if (!cur || ts > cur.ts) {
          // 单行损坏容错与 l: 路径、loadLatestFromHot 一致：一行坏数据不得让升级首查 500
          let v;
          try { v = JSON.parse(k.value); } catch { continue; }
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
      this.latestAt.delete(serverId);
      this.lastSeenSec.delete(serverId);
      this.pendingArcRetry.delete(serverId);
      this.trimMin.delete(serverId);
      // 天账：游标与待落库增量一并清理（否则删掉的机器在 alarm 里继续记账/补分母）
      this.dayAccum.delete(serverId);
      this.dayCurLoaded.delete(serverId);
      this.dayCurDirty.delete(serverId);
      for (const k of [...this.dayPending.keys()]) {
        if (k.startsWith(`${serverId}:`)) this.dayPending.delete(k);
      }
      // 清理该服务器的告警冷却、探活、离线状态、归档水位与天账游标（内存 + storage）。
      // 两类前缀 list 互相隔离；即使某次 list 失败，也仍尝试删除可精确定位的状态键。
      const stateKeys = [`alert:offline:${serverId}`, `arc:${serverId}`, `daycur:${serverId}`, `l:${serverId}`];
      try { stateKeys.push(...(await this.listStorage(`alert:${serverId}:`)).map((k) => k.name)); } catch { /* ignore */ }
      try { stateKeys.push(...(await this.listStorage(`probe:${serverId}:`)).map((k) => k.name)); } catch { /* ignore */ }
      await Promise.allSettled([...new Set(stateKeys)].map((name) => this.state.storage.delete(name)));
      this.offlineState.delete(serverId);
      this.arcCache.delete(serverId);
      this.arcPersisted.delete(serverId);
      this.alertLoadedFor.delete(serverId); // 加载标记同步失效（id 不复用，但避免标记集无界增长）
      this.probeLoadedFor.delete(serverId);
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

  // 热区保留分钟数：每次调用读 env（属性读取，开销可忽略），支持不重启调参。
  keepMin() {
    if (this.env.ARCHIVE_TO_D1 === '0') return METRICS_KEEP_MIN_NO_ARCHIVE;
    const n = Number(this.env.METRICS_KEEP_MIN);
    // 下限锚在归档线：低于归档线的热区会让增量归档扫不到「已上报但尚未归档」的行
    return Number.isFinite(n) && n >= ARCHIVE_AFTER_MIN ? Math.floor(n) : METRICS_KEEP_MIN;
  }

  // 内存滚动窗口：只保留最近 keepMin() 分钟。
  // 早退：m 的键为分钟时间戳且按升序插入——minTs 由服务端按接收时刻计算（单调递增），
  // loadHot 从 storage 恢复时按 key 字典序（同机同位数 ⇒ 等价数值序）也是升序，
  // 故遇到第一个未过期键即可停止：常态 O(1) 而非 O(720)。
  trim(m) {
    const keep = this.keepMin();
    const cutoff = Math.floor(Date.now() / 1000 / 60) - keep;
    for (const ts of m.keys()) {
      if (ts >= cutoff) break;
      m.delete(ts);
    }
    // 不变式兜底：若将来出现乱序插入（早退漏删），条目数会超出窗口跨度；
    // 仅在此时退回全扫（O(1) 判定 + 病态才付代价），避免 Map 无界增长。
    if (m.size > keep + 1) {
      for (const ts of m.keys()) {
        if (ts < cutoff) m.delete(ts);
      }
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
    // 逐机阈值覆盖：16 核与 1 核小机用同一阈值必然误报或漏报，故允许按机覆盖
    const cfg = resolveAlertCfg(await getAlertCfg(this.env), b.alertOverride);
    if (!cfg.enabled || cfg.muted) return; // 免打扰期内不做阈值判定
    // 先做纯阈值判定（零 Storage 读）：一个指标都没越界就直接返回。
    // 冷实例下每帧都可能是一个新实例，旧实现每次都 list('alert:') 全量恢复所有机器的冷却
    // 状态，而越界才是少数——这一步把绝大多数帧的这次读省掉（越界时才按机恢复，见下）。
    const breaches = [];
    // CPU
    if (b.cpu != null && b.cpu >= cfg.cpu_pct) {
      breaches.push({ key: `${b.serverId}:cpu`, text: `CPU ${b.cpu.toFixed(1)}% >= ${cfg.cpu_pct}%` });
    }
    // 内存（需要 agent 上报 mem_total）
    if (b.mem_used != null && b.mem_total != null && b.mem_total > 0) {
      const memPct = (b.mem_used / b.mem_total) * 100;
      if (memPct >= cfg.mem_pct) {
        breaches.push({ key: `${b.serverId}:mem`, text: `内存 ${memPct.toFixed(1)}% >= ${cfg.mem_pct}%` });
      }
    }
    // 磁盘（根分区）：新格式 used/total 计算百分比，旧格式 u 回退
    const rootDisk = b.extra && b.extra.disk && b.extra.disk.find((d) => d.m === '/');
    if (rootDisk) {
      const rootPct = rootDisk.used != null && rootDisk.total > 0
        ? (rootDisk.used / rootDisk.total) * 100
        : rootDisk.u;
      if (rootPct != null && rootPct >= cfg.disk_pct) {
        breaches.push({ key: `${b.serverId}:disk`, text: `磁盘 / ${rootPct.toFixed(1)}% >= ${cfg.disk_pct}%` });
      }
    }
    // 负载（可选，未设置则不启用）
    if (cfg.load > 0 && b.extra && b.extra.load1 != null && b.extra.load1 >= cfg.load) {
      breaches.push({ key: `${b.serverId}:load`, text: `负载 ${b.extra.load1} >= ${cfg.load}` });
    }
    if (!breaches.length) return;

    await this.ensureAlertLoadedFor(b.serverId); // 确实越界才恢复该机冷却状态
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
    for (const x of breaches) {
      if (await cooled(x.key)) alerts.push(x.text);
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
  async checkProbeAlerts(serverId, serverName, probes, override) {
    const cfg = resolveAlertCfg(await getAlertCfg(this.env), override);
    if (!cfg.enabled || cfg.muted || !Array.isArray(probes)) return;
    await this.ensureProbeLoadedFor(serverId); // 恢复该机持久化探活状态（按机，见方法注释）
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

  // agent 明确上报「本机已无探针」（PROBES 被删除）时清理去重状态。
  // 只清内存不够：实例 evict 后 ensureProbeLoaded 会把 Storage 里的旧键读回来，
  // 同名探针重新启用时会沿用旧冷却，或把「上次遗留的 down」误判为已告警而不发 probe_down。
  // 由 handleReport 的 probesCleared 帧触发（仅「有 → 无」变更时一次，非常态路径）。
  // 注意：这个信号可能丢（同机 5s 批内被覆盖、flush 前 evict），故 alarm 里另有
  // pruneStaleProbeStates 以 D1 probe_json 为准做兜底对账。
  async clearProbeState(serverId) {
    for (const k of [...this.probeState.keys()]) {
      if (k.startsWith(`${serverId}:`)) this.probeState.delete(k);
    }
    try {
      const keys = await this.listStorage(`probe:${serverId}:`);
      await Promise.all(keys.map((k) => this.state.storage.delete(k.name)));
    } catch { /* Storage 不可用：内存已清；旧键最多让重新启用的同名探针多重置一次冷却 */ }
  }

  // 探活状态兜底对账（alarm 调用，≈10 分钟一次）：以 D1 的 `servers.probe_json`（当前配置的
  // 探针列表）为准，删掉已不存在的探针冷却状态。两件事只能靠它收口：
  //   1) 「有 → 无」的清理帧可能丢（probesCleared 只挂在那一次变更帧上，同机 5s 批内被覆盖
  //      或 flush 前 evict 就没了）——库里 probe_json 已在 handleReport 里清空，但 Storage 键还在；
  //   2) 只删掉其中一个探针（其余保留）时没有任何信号——那个名字的冷却会一直留到下次启用。
  // 频率极低（alarm + 每小时门控），一次 list + 一次 D1 读；evict 无关（状态可从 D1 重新推导）。
  // 返回 true = 本轮完成（调用方据此推进时间戳）；false = 有失败（Storage/D1 不可用或删除失败），
  // 调用方**不推进**时间戳，下轮 alarm（10 分钟）重试——避免抖动一次就白等一小时。
  async pruneStaleProbeStates() {
    let keys;
    try { keys = await this.listStorage('probe:'); } catch { return false; } // Storage 不可用：下轮再对账
    if (!keys.length) return true; // 本实例没有任何探活状态，本轮无事可做
    let rows;
    try {
      rows = (await this.env.DB.prepare('SELECT id, probe_json FROM servers').all()).results || [];
    } catch { return false; } // D1 不可用：不做任何删除（宁留不误删）
    const alive = new Map(); // serverId -> Set(当前配置里的探针名)
    const unknown = new Set(); // probe_json 解析失败/格式未知的机器：跳过，避免误删
    for (const s of rows) {
      const sid = Number(s.id) || 0;
      if (!sid) continue;
      if (!s.probe_json) { alive.set(sid, new Set()); continue; } // 明确「无探针」
      try {
        const list = JSON.parse(s.probe_json);
        if (!Array.isArray(list)) { unknown.add(sid); continue; }
        alive.set(sid, new Set(list.map((p) => String((p && p.name) || ''))));
      } catch { unknown.add(sid); }
    }
    let ok = true;
    for (const k of keys) {
      const suffix = k.name.slice('probe:'.length); // `${serverId}:${name}`
      const sep = suffix.indexOf(':');
      const sid = sep > 0 ? Number(suffix.slice(0, sep)) : 0;
      if (!sid) { // 畸形键：无人认领，直接删
        this.probeState.delete(suffix);
        try { await this.state.storage.delete(k.name); } catch { ok = false; }
        continue;
      }
      if (unknown.has(sid)) continue; // 配置解析失败：不删（宁可留着，也不能误删正在生效的冷却）
      const name = suffix.slice(sep + 1);
      const names = alive.get(sid); // 服务器行已删除时 undefined → 下面一并清掉
      if (names && names.has(name)) continue;
      this.probeState.delete(suffix);
      try { await this.state.storage.delete(k.name); } catch { ok = false; }
    }
    return ok;
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
        // 键归一为 number：读写侧用 s.id（D1 返回 number）——Map 按 SameValueZero 比较，
        // 字符串 "12" 与数字 12 不相等，不归一会导致 evict 恢复后首轮对已离线机器重复告警
        this.offlineState.set(Number(k.name.slice('alert:offline:'.length)), k.value);
      }
    } catch { /* 加载失败按全在线处理 */ }
  }
  async checkOfflineAlerts() {
    const cfg = await getAlertCfg(this.env);
    if (!cfg.enabled || !cfg.webhook_url) return; // 未配置 webhook 时离线告警无法送达，跳过扫描
    await this.ensureOfflineLoaded();
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.env.DB.prepare('SELECT id, name, last_seen, alert_override FROM servers').all();
    for (const s of rows.results) {
      // 离线阈值支持逐机覆盖（弱网/长心跳节点可放宽）；免打扰期内整机跳过（计划内重启的场景）
      const scfg = resolveAlertCfg(cfg, s.alert_override);
      if (scfg.muted) continue;
      const offlineAfter = scfg.offline_after_s;
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
    // 探活状态兜底对账：清理「配置里已不存在」的探针冷却（单帧清理信号可能丢，且覆盖不到
    // 「只删掉其中一个探针」）。两道门控压住读放大（一次 list('probe:') 会把全部探针键连
    // value 载入内存，见 PROBE_PRUNE_INTERVAL_MS）：
    //   1) 只在告警开启（= 配了 webhook，alertOn）时做——没有 webhook 时冷却状态不产生任何
    //      通知，配置好之后的首轮 alarm 再对账即可（与探活告警自身的开关口径一致）；
    //   2) 每小时最多一次（时间戳落 housekeep 跨 evict），而不是每个 10 分钟 alarm 都扫。
    if (alertOn && now - this.lastProbePruneAt >= PROBE_PRUNE_INTERVAL_MS) {
      try {
        // 只有本轮真的完成（false = Storage/D1 抖动或有键删除失败）才推进时间戳，
        // 否则要白等一小时才重试
        if (await this.pruneStaleProbeStates()) {
          this.lastProbePruneAt = now;
          housekeepChanged = true;
        } else {
          console.error('probe state prune incomplete; retry next alarm');
        }
      } catch (e) {
        console.error('probe state prune failed:', e);
      }
    }
    // 按天统计结算（流量/可用率）：先补记离线机器的可用率分母，再把内存增量落 D1。
    // 独立于归档开关（ARCHIVE_TO_D1）：天账是长期账本，不应因关闭分钟归档而停摆。
    try {
      await this.sweepOfflineDaySpans(Math.floor(now / 1000));
      await this.flushDayPending();
    } catch (e) {
      console.error('metrics_day settlement failed:', e);
    }
    // 全量 sweep：按时间差判定（每 6×10min ≈ 1 小时一次），时间戳持久化跨 evict——
    // 慢采/空闲下 MetricsDO 无 WS、两次 alarm 间实例常被 evict，旧内存计数（sweepCount）
    // 会停在 1 导致 fullSweep 永不执行（>12h 热区无限增长 + 兜底归档停摆）
    if (now - this.lastSweepAt >= 6 * ARCHIVE_INTERVAL_MS) {
      try {
        const complete = await this.fullSweep(archiveOn);
        // 只有归档、删源与水位持久化全部成功才记本轮完成；部分失败在下个 alarm 重试。
        if (complete) {
          this.lastSweepAt = now;
          housekeepChanged = true;
        }
      } catch (e) {
        console.error('fullSweep failed:', e);
      }
    }
    // 保留期清理（每天一次）：删除超过 METRICS_RETENTION_DAYS 的旧数据，以及超过
    // AUDIT_RETENTION_DAYS 的审计日志（created_at 为 datetime('now') 文本，可直接比较）。
    // METRICS_RETENTION_DAYS 可用环境变量覆盖（默认 30）：缩小保留期可降低 D1 容量占用。
    // 时间戳持久化跨 evict：避免慢采/空闲下 lastPrune 被重置为 0 导致每天 144 次全表扫
    //（metrics_custom 无 ts 索引时最坏 6.2M×S×C 读/天，见迁移 0003 补索引）
    if (now - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
      const retention = Number(this.env.METRICS_RETENTION_DAYS) > 0
        ? Number(this.env.METRICS_RETENTION_DAYS) : METRICS_RETENTION_DAYS;
      const minTs = Math.floor(now / 1000 / 60) - retention * 1440;
      const stmts = [];
      // 分层保留：细粒度窗口（默认 7 天）之后只保留降采样点（ts % down = 0）。
      // 只删「非采样点」而非重写数据——无写放大，且采样点与查询步长同源
      //（config.js metricsDownsampleMin），保证长区间 SQL 抽样仍能命中。
      // 省的是 D1 存储与长区间读取：老数据行数约为 1/down（默认 −80%）。
      const fineDays = metricsFineDays(this.env);
      const down = metricsDownsampleMin(this.env);
      if (retention > fineDays && down > 1) {
        const fineMinTs = Math.floor(now / 1000 / 60) - fineDays * 1440;
        stmts.push(
          this.env.DB.prepare('DELETE FROM metrics_min WHERE ts < ? AND ts >= ? AND ts % ? != 0')
            .bind(fineMinTs, minTs, down),
        );
      }
      // 按天账保留期清理（默认 3 年）：与 metrics_min 的 30 天解耦——
      // 月度/年度流量与可用率账必须跨月可查，这正是 metrics_day 存在的理由
      const dayRetention = Number(this.env.METRICS_DAY_RETENTION_DAYS) > 0
        ? Number(this.env.METRICS_DAY_RETENTION_DAYS) : METRICS_DAY_RETENTION_DAYS;
      stmts.push(
        this.env.DB.prepare('DELETE FROM metrics_min WHERE ts < ?').bind(minTs),
        this.env.DB.prepare('DELETE FROM metrics_custom WHERE ts < ?').bind(minTs),
        this.env.DB.prepare('DELETE FROM metrics_day WHERE day < ?')
          .bind(dayIndexOf(Math.floor(now / 1000), statsTzOffsetSec(this.env)) - dayRetention),
        this.env.DB.prepare('DELETE FROM audit_logs WHERE created_at < datetime(\'now\', ?)')
          .bind(`-${AUDIT_RETENTION_DAYS} days`),
      );
      try {
        await this.env.DB.batch(stmts);
        // 与归档一致：成功后才推进时间戳，失败由下个 alarm 重试而不是静默等待 24h。
        this.lastPruneAt = now;
        housekeepChanged = true;
      } catch (e) {
        console.error('metrics prune failed:', e);
      }
    }
    // 家政状态持久化（仅变化时写）
    if (housekeepChanged) {
      try {
        await this.state.storage.put('housekeep', JSON.stringify({ lastSweepAt: this.lastSweepAt, lastPruneAt: this.lastPruneAt, lastProbePruneAt: this.lastProbePruneAt }));
      } catch { /* 持久化失败：下次 alarm 按当前值重新判定（可能提前执行，无害） */ }
    }
    } finally {
      // 无论是否异常都续排下一次 alarm：防归档/清理/告警因单次失败永久停摆。
      // 闲置（无热区数据且告警关闭）时退避 +1h（零服务器/无上报面板不再 10min 空转 144 次/天）；
      // 新上报经 scheduleArchive 提前拉回（alarmCached 失效后 getAlarm 发现更早需求重新设置）
      //
      // 判据不能只看 this.data.size：冷实例（evict 后）内存热区本来就是空的，而 Storage 里
      // 可能有几十台机器的待归档数据——旧实现会把「有数据但刚好被 evict」误判为闲置，把下一轮
      // alarm 推到 1 小时后，归档与清理最长停摆 1 小时。data 空时补一条 D1 探测（只在冷路径
      // 触发，热实例直接按内存判定，不增加常态开销）；D1 不可用时保守按非闲置处理。
      let idle = false;
      if (!alertOn) {
        if (this.data.size > 0) {
          idle = false;
        } else {
          try {
            idle = !(await this.env.DB.prepare('SELECT 1 AS x FROM servers LIMIT 1').first());
          } catch { idle = false; }
        }
      }
      this.alarmCached = Date.now() + (idle ? ARCHIVE_IDLE_INTERVAL_MS : ARCHIVE_INTERVAL_MS);
      try {
        await this.state.storage.setAlarm(this.alarmCached);
      } catch (e) {
        // 续排失败（storage 不可用）记日志——alarm() 的 finally 续排是归档/清理/告警不停摆的唯一保障
        console.error('alarm reschedule failed:', e);
      }
    }
  }

  // 全量 sweep（降频，≈1 小时一次）：>keepMin 热区行清理 + 兜底归档（水位之后的行 INSERT OR IGNORE）。
  // 常态归档由 /report 增量完成；此处仅兜底异常（水位滞后/实例 evict 后恢复）与执行窗口上限清理。
  //
  // 分页 + 按服务器缓冲：旧实现一次 list('m:') 把整个热区读进内存（240×N 行，500 台 ≈ 12 万行、
  // 50–100MB，叠加 rowsByServer 结构逼近 128MB 上限）。键按字典序返回、同机行必然连续，
  // 因此按页读取、只保留「当前服务器」的窗口（≤keepMin 行）即可，内存与单轮耗时都收敛。
  async fullSweep(archiveOn) {
    const archiveCutoff = Math.floor(Date.now() / 1000 / 60) - ARCHIVE_AFTER_MIN;
    const keepCutoff = Math.floor(Date.now() / 1000 / 60) - this.keepMin();
    const PAGE = SWEEP_PAGE_ROWS;
    let complete = true;
    let startAfter = null;
    let buf = null; // { serverId, rows }
    for (;;) {
      let page;
      try {
        page = await this.listStorage('m:', startAfter ? { limit: PAGE, startAfter } : { limit: PAGE });
      } catch (e) {
        console.error('fullSweep storage list failed:', e);
        return false;
      }
      if (!page.length) break; // 没有更多行
      for (const k of page) {
        const rest = k.name.slice(2); // 去掉 'm:'
        const sep = rest.indexOf(':');
        if (sep <= 0) continue;
        const serverId = Number(rest.slice(0, sep));
        const ts = Number(rest.slice(sep + 1));
        if (!Number.isInteger(serverId) || !Number.isFinite(ts)) continue;
        if (!buf || buf.serverId !== serverId) {
          // 切换服务器：上一台已完整读完，立即处理并释放
          if (buf) complete = (await this.sweepServerRows(buf, archiveOn, archiveCutoff, keepCutoff)) && complete;
          buf = { serverId, rows: [] };
        }
        buf.rows.push({ name: k.name, ts, value: k.value });
      }
      // 以「返回空页」为终止条件，而不是「本页不满 limit」：后者依赖后端严格按 limit 返回，
      // 一旦实现侧把单页压得更小就会提前结束（漏扫后面的机器）。多一次空页读取 ≈ 1 次/小时。
      const lastKey = page[page.length - 1].name;
      if (startAfter && lastKey <= startAfter) break; // 防御：游标没有前进（后端/桩未按 startAfter 返回）
      startAfter = lastKey;
    }
    if (buf) complete = (await this.sweepServerRows(buf, archiveOn, archiveCutoff, keepCutoff)) && complete;
    return complete;
  }

  // fullSweep 的单机单元：把该机热区中已跨归档线的行落 D1，再删掉已被持久水位覆盖的源行。
  // 返回 false 表示本轮有失败（下次 sweep 重试；INSERT OR IGNORE / 条件删除都幂等）。
  async sweepServerRows({ serverId, rows }, archiveOn, archiveCutoff, keepCutoff) {
    let complete = true;
    let effectiveArcTs = archiveOn ? this.arcCache.get(serverId) : Number.POSITIVE_INFINITY;
    if (archiveOn && effectiveArcTs == null) {
      try {
        effectiveArcTs = Number(await this.state.storage.get(`arc:${serverId}`)) || 0;
        this.arcCache.set(serverId, effectiveArcTs);
        this.arcPersisted.set(serverId, effectiveArcTs);
      } catch (e) {
        // 水位读不到：本轮跳过该机（不归档也不删源），下轮重试
        console.error(`fullSweep watermark read failed (server=${serverId}):`, e);
        return false;
      }
    }

    const candidates = archiveOn
      ? rows.filter((row) => row.ts <= archiveCutoff && row.ts > effectiveArcTs)
      : [];
    if (candidates.length) {
      const stmts = [];
      try {
        for (const row of candidates) {
          const v = JSON.parse(row.value);
          // 数值归一化：历史坏数值不得让整批归档失败。
          stmts.push(
            this.env.DB.prepare(
              'INSERT OR IGNORE INTO metrics_min (server_id, ts, cpu, mem_used, mem_total, net_in, net_out, extra) VALUES (?,?,?,?,?,?,?,?)'
            ).bind(
              serverId, row.ts,
              numOrNull(v.cpu), numOrNull(v.mem_used), numOrNull(v.mem_total),
              numOrNull(v.net_in), numOrNull(v.net_out),
              v.extra ? JSON.stringify(v.extra) : null
            )
          );
        }
      } catch (e) {
        // 无法解析的源行必须保留，不能越过它推进同服务器水位（也跳过本机删除）
        console.error(`fullSweep row decode failed (server=${serverId}):`, e);
        return false;
      }

      let archived = true;
      // 每台服务器独立提交；任一批失败时不删该服务器任何新源行、不推进水位。
      // 已成功批次下轮由 INSERT OR IGNORE 安全重放，避免跨批次水位越过失败区间。
      for (let i = 0; i < stmts.length; i += 100) {
        try {
          await this.env.DB.batch(stmts.slice(i, i + 100));
        } catch (e) {
          console.error(`fullSweep batch failed (server=${serverId}, rows=${stmts.length}):`, e);
          archived = false;
          complete = false;
          break;
        }
      }
      if (archived) {
        const nextArcTs = candidates.reduce((max, row) => Math.max(max, row.ts), effectiveArcTs);
        try {
          // 先持久化水位再删源；失败时保留源行，下轮幂等重放。
          await this.state.storage.put(`arc:${serverId}`, String(nextArcTs));
          this.arcCache.set(serverId, nextArcTs);
          this.arcPersisted.set(serverId, nextArcTs); // fullSweep 直接落盘，同步降频游标
          effectiveArcTs = nextArcTs;
        } catch (e) {
          console.error(`fullSweep watermark write failed (server=${serverId}):`, e);
          complete = false;
        }
      }
    }

    // 仅删除已被持久水位覆盖的源行；归档关闭时按热区窗口直接清理。
    // 批量删（生产 API 上限 128 键/次）：500 台每小时约 3 万行 → ~235 次 await，原来是 3 万次，
    // 单轮 duration 因此大幅下降。
    const doomed = rows.filter((row) => !(row.ts > keepCutoff || (archiveOn && row.ts > effectiveArcTs)));
    for (let i = 0; i < doomed.length; i += 128) {
      const chunk = doomed.slice(i, i + 128);
      try {
        await this.state.storage.delete(chunk.map((r) => r.name));
      } catch (e) {
        console.error(`fullSweep source delete failed (server=${serverId}, rows=${chunk.length}):`, e);
        complete = false;
        continue; // 剩下的源行仍在，下轮重试
      }
      const memory = this.data.get(serverId);
      if (memory) {
        for (const row of chunk) memory.delete(row.ts);
        if (memory.size === 0) this.data.delete(serverId);
      }
    }
    return complete;
  }
}
