// cf-panel — agent 监控上报落库（handleReport）与上报链路状态
import { doMetrics, numOrNull } from './utils.js';
import { metricsDownsampleMin } from './config.js';

// last_seen D1 落盘节流（秒）：快采 5s 上报时，D1 写从 17,280 → ~1,440 行/天/机（−92%）。
// 在线判定主用 MetricsDO 秒级 last_seen_s（零 D1 成本），不受本节流影响；D1 last_seen 仅
// 冷启动兜底 + 离线告警（offline_after_s=180 远大于 60s，不受影响）。
export const LAST_SEEN_THROTTLE_S = 60;
export const lastSeenWrite = new Map(); // serverId -> 上次落盘秒（跨实例 evict 丢失后仅偶发多写一次，无害）
// serverId -> { bucketTs, names: Set }：metrics_custom 降采样桶去重（同桶同指标只写一次 D1；
// 跨实例 evict 丢失后仅偶发多写一次，INSERT OR IGNORE 幂等无害）
export const customWritten = new Map();
// 服务器行缓存（handleReport 每帧 SELECT 1 行 → 60s TTL，快采 −28,800 D1 读/天/机）。
// 按隔离实例分布（Worker HTTP 上报 / TerminalDO 控制通道上报各自一份）；删除路径清 Worker 侧，
// TerminalDO 侧 60s 自动过期，缓存窗口内的孤儿写无害（INSERT OR IGNORE / 条件写）
export const serverRowCache = new Map(); // serverId -> {info_json, probe_json, name, alert_override, ts}
const SERVER_ROW_TTL_MS = 60 * 1000;
async function getServerRow(env, serverId) {
  const c = serverRowCache.get(serverId);
  if (c && Date.now() - c.ts < SERVER_ROW_TTL_MS) return c;
  // alert_override 随行取出并随上报帧下发：告警判定因此不必每帧回查 D1。
  // 改动它会显式清该服务器的行缓存（routes.js），最坏滞后即本 TTL（60s）
  const row = await env.DB.prepare('SELECT info_json, probe_json, name, alert_override FROM servers WHERE id = ?').bind(serverId).first();
  if (row) serverRowCache.set(serverId, { ...row, ts: Date.now() });
  return row;
}
// MetricsDO /report 转发节流（每 5s flush 一次）：
// 同一隔离实例（TerminalDO 分片 / Worker）内把 5s 窗口内多台机器的上报聚合为一次 fetch
//（单机节流升级为队列）：5 机分布 4 分片 fetch 36,000→28,800（−20%），同分片多机 −50%；
// 单机行为与 5s 节流等价。flush 由上报驱动触发（每帧检查距上次 ≥5s），不引入定时器。
// 告警/探活判定搭 /report 顺风车，随之 ~5s 一次（冷却 30min 不受影响，探活判定延迟 ≤5s）；
// 卡片新鲜度 ≤5s，last_seen_s 最旧 ~6s 远低于 15s 快宽限（余量充足）
export const REPORT_FWD_THROTTLE_S = 5;
export const reportBatch = new Map(); // serverId -> 待批量转发的帧（跨实例 evict 丢失后仅偶发丢一帧，无害）
export let reportFlushAt = 0; // 上次 flush 时刻（ms；隔离实例内共享，上报驱动触发）
export function setReportFlushAt(v) { reportFlushAt = v; } // let 原始值无法经属性赋值，测试用 setter 操纵 flush 时刻

// agent 监控上报落库：更新 last_seen（在线判定唯一依据；系统信息变更才写 info_json，探活变更才写 probe_json），
// 时序写入 MetricsDO 热区（供控制通道上报复用；HTTP /api/report 入口已删除，上报统一走 WS）。
// 告警冷却/探活去重判定在 MetricsDO 内部完成（见 MetricsDO.checkAlerts / checkProbeAlerts）。

// ---- 收口：agent 上报视为不可信输入（agent 运行在被控机，可能被入侵/异常）----
// 入口处归一化 + 白名单 + 条数/体积上限，一处收口消除四类后果：
// 注入（extra 键白名单）、告警丢失/归档停摆（数值归一化，杜绝对象/数组混入）、容量放大（条数与体积上限）。
const EXTRA_NUM_KEYS = ['swap', 'swap_total', 'load1', 'load5', 'load15', 'procs', 'tcp', 'udp', 'uptime', 'temp'];
const DISK_IO_NUM_KEYS = ['read_kbs', 'write_kbs', 'r_iops', 'w_iops', 'util_pct']; // 磁盘 IO 嵌套对象白名单
const EXTRA_DISK_MAX = 20;    // 挂载点条数上限（agent 正常 <10）
const DISK_PATH_MAX = 128;    // 挂载点路径长度上限
const CUSTOM_MAX = 50;        // 自定义指标条数上限
const CUSTOM_NAME_MAX = 64;   // 指标名长度上限
const PROBES_MAX = 50;        // 探活条目上限
const EXTRA_JSON_MAX = 8192;  // extra 序列化体积上限
const INFO_JSON_MAX = 8192;   // info 序列化体积上限（自由文本，前端 escapeHtml 渲染）

export function sanitizeReportPayload(p) {
  const out = { ...p };
  // 数值字段归一化：字符串数字转 number，对象/数组/NaN → null
  out.cpu = numOrNull(p.cpu);
  out.mem_used = numOrNull(p.mem_used);
  out.mem_total = numOrNull(p.mem_total);
  out.net_in = numOrNull(p.net_in);
  out.net_out = numOrNull(p.net_out);
  // extra：仅保留已知键，数值归一化，超限置 null（丢弃整帧扩展数据，不阻断主指标）
  if (p.extra && typeof p.extra === 'object' && !Array.isArray(p.extra)) {
    const e = {};
    for (const k of EXTRA_NUM_KEYS) {
      const v = numOrNull(p.extra[k]);
      if (v != null) e[k] = v;
    }
    if (Array.isArray(p.extra.disk)) {
      const disk = [];
      for (const d of p.extra.disk.slice(0, EXTRA_DISK_MAX)) {
        if (!d || typeof d !== 'object') continue;
        const m = String(d.m == null ? '' : d.m).slice(0, DISK_PATH_MAX);
        // used/total（字节）：百分比由前端计算；兼容旧 agent 上报的 u（百分比）
        const used = numOrNull(d.used);
        const total = numOrNull(d.total);
        const u = numOrNull(d.u);
        if (m && used != null && total != null && total > 0) disk.push({ m, used, total });
        else if (m && u != null) disk.push({ m, u }); // 旧格式回退
      }
      if (disk.length) e.disk = disk;
    }
    // 磁盘 IO：嵌套对象白名单 + 数值归一化（无有效键时丢弃）
    if (p.extra.disk_io && typeof p.extra.disk_io === 'object' && !Array.isArray(p.extra.disk_io)) {
      const io = {};
      for (const k of DISK_IO_NUM_KEYS) {
        const v = numOrNull(p.extra.disk_io[k]);
        if (v != null) io[k] = v;
      }
      if (Object.keys(io).length) e.disk_io = io;
    }
    try {
      out.extra = JSON.stringify(e).length <= EXTRA_JSON_MAX ? e : null;
    } catch {
      out.extra = null;
    }
  } else {
    out.extra = null;
  }
  // probes：条数上限 + 只保留已知键（name/ok/code/ms，agent 合法上报字段）
  if (Array.isArray(p.probes)) {
    out.probes = [];
    for (const pr of p.probes.slice(0, PROBES_MAX)) {
      if (!pr || typeof pr !== 'object' || pr.name == null) continue;
      const o = { name: String(pr.name).slice(0, 128), ok: !!pr.ok };
      const code = numOrNull(pr.code);
      if (code != null) o.code = code;
      const ms = numOrNull(pr.ms);
      if (ms != null) o.ms = ms;
      out.probes.push(o);
    }
    if (!out.probes.length) out.probes = null;
  } else {
    out.probes = null;
  }
  // custom：条数 + 名称长度 + 数值归一化（后续 INSERT 直接使用，杜绝类型错误）
  if (Array.isArray(p.custom)) {
    out.custom = p.custom
      .filter((c) => c && typeof c === 'object' && c.name && c.value != null)
      .slice(0, CUSTOM_MAX)
      .map((c) => ({ name: String(c.name).slice(0, CUSTOM_NAME_MAX), value: numOrNull(c.value) }))
      .filter((c) => c.value != null);
  } else {
    out.custom = null;
  }
  // info：仅限体积（自由文本字段，前端已 escapeHtml）
  if (p.info && typeof p.info === 'object') {
    try {
      out.info = JSON.stringify(p.info).length <= INFO_JSON_MAX ? p.info : null;
    } catch {
      out.info = null;
    }
  } else {
    out.info = null;
  }
  return out;
}

// last_seen 节流写（在线宽限 15s，60s 节流留余量；在线判定主用 MetricsDO last_seen_s），
// info 变更/未变更/无 info 三分支共用；force=true 时无条件写（系统信息变更必须落）
async function touchLastSeen(env, serverId, ts, force) {
  const last = lastSeenWrite.get(serverId) || 0;
  if (!force && ts - last < LAST_SEEN_THROTTLE_S) return false;
  await env.DB.prepare('UPDATE servers SET last_seen = ? WHERE id = ?').bind(ts, serverId).run();
  lastSeenWrite.set(serverId, ts);
  return true;
}

export async function handleReport(env, payload) {
  payload = sanitizeReportPayload(payload);
  const ts = Math.floor(Date.now() / 1000);
  const minTs = Math.floor(ts / 60);
  // 服务器行读缓存同时承担存在性复核（缓存未命中才查 D1；删除窗口孤儿写无害，
  // 见 getServerRow 注释；热区由 MetricsDO /drop + alarm 清理兜底）。
  const server = await getServerRow(env, payload.serverId);
  if (!server) return;
  // 探活状态：变更才写 probe_json（告警去重状态在 MetricsDO 顺风车处理），写后更新行缓存。
  // 对比剥离 ms——探活耗时 ms 每次探测必然毫秒级抖动，全量 JSON 对比会每帧触发
  // UPDATE（快采 6,240 行写/天/机，「变更才写」对 probes 完全失效）；改用稳定投影
  // [name,ok,code] 对比，仅状态真变时落全量（含当时 ms；前端探活延迟展示随之停更，可接受）
  if (Array.isArray(payload.probes)) {
    const proj = (list) => JSON.stringify(list.map((p) => [p.name, !!p.ok, p.code ?? null]));
    let prevProj = null;
    if (server.probe_json) {
      try { prevProj = proj(JSON.parse(server.probe_json)); } catch { prevProj = null; }
    }
    if (proj(payload.probes) !== prevProj) {
      const probeJson = JSON.stringify(payload.probes);
      await env.DB.prepare('UPDATE servers SET probe_json = ? WHERE id = ?').bind(probeJson, payload.serverId).run();
      serverRowCache.set(payload.serverId, { ...server, probe_json: probeJson, ts: Date.now() });
    }
  }
  // 自定义监控项：按降采样桶（默认 5 分钟）直写 D1；同桶同指标只写一次。
  // 桶边界对齐 unix 纪元（minTs - minTs % N），各机一致——与保留期降采样点、
  // 长区间查询步长同源（config.js metricsDownsampleMin），三者不对齐会让长区间
  // SQL 抽样命中不到行（见 config.js 注释）。快采下 D1 写查询约 −95%（原 −95% × 桶 5 倍）。
  if (Array.isArray(payload.custom)) {
    const items = payload.custom.filter((c) => c && c.name && c.value != null);
    const bucketTs = minTs - (minTs % metricsDownsampleMin(env));
    const rec = customWritten.get(payload.serverId);
    const isNewBucket = !rec || rec.bucketTs !== bucketTs;
    const fresh = isNewBucket ? items : items.filter((c) => !rec.names.has(String(c.name)));
    if (fresh.length) {
      const stmts = fresh.map((c) => env.DB.prepare(
        'INSERT OR IGNORE INTO metrics_custom (server_id, name, ts, value) VALUES (?,?,?,?)'
      ).bind(payload.serverId, String(c.name), bucketTs, Number(c.value)));
      await env.DB.batch(stmts);
      if (isNewBucket) {
        customWritten.set(payload.serverId, { bucketTs, names: new Set(fresh.map((c) => String(c.name))) });
      } else {
        for (const c of fresh) rec.names.add(String(c.name));
      }
    } else if (isNewBucket) {
      customWritten.set(payload.serverId, { bucketTs, names: new Set() }); // 推进桶水位，避免下次视为新桶
    }
  }
  if (payload.info) {
    const infoJson = JSON.stringify(payload.info);
    if (server.info_json !== infoJson) {
      // 系统信息变化：必须写（含 last_seen，force），写后更新行缓存
      await env.DB.prepare('UPDATE servers SET info_json = ? WHERE id = ?')
        .bind(infoJson, payload.serverId).run();
      serverRowCache.set(payload.serverId, { ...server, info_json: infoJson, ts: Date.now() });
      await touchLastSeen(env, payload.serverId, ts, true);
    } else {
      await touchLastSeen(env, payload.serverId, ts);
    }
  } else {
    await touchLastSeen(env, payload.serverId, ts);
  }
  // 时序写入 MetricsDO 热区；告警/探活判定也在该调用内顺带完成（零额外请求）。
  // 批量上报：入队本机最新帧（同机 5s 窗口内保留最后一帧），距上次 flush ≥5s 时
  // 把队列内所有机器聚合一次 fetch（同隔离实例多机合并，见 reportBatch 注释）
  reportBatch.set(payload.serverId, {
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
    // 逐机告警阈值覆盖（servers.alert_override 原始 JSON），随帧下发供 MetricsDO 判定，
    // 免得告警路径每帧多一次 D1 查询（行缓存已承担读取成本）
    alertOverride: server.alert_override ?? null,
  });
  const flushNow = Date.now();
  if (flushNow - reportFlushAt >= REPORT_FWD_THROTTLE_S * 1000) {
    reportFlushAt = flushNow;
    const frames = [...reportBatch.values()];
    reportBatch.clear();
    const mdo = doMetrics(env);
    await mdo.fetch('https://do.internal/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ frames }),
    });
  }
}
