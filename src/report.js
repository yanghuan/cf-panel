// cf-panel — agent 监控上报落库（handleReport）与上报链路状态
import { doMetrics } from './utils.js';

// last_seen D1 落盘节流（秒）：快采 5s 上报时，D1 写从 17,280 → ~1,440 行/天/机（−92%）。
// 在线判定主用 MetricsDO 秒级 last_seen_s（零 D1 成本），不受本节流影响；D1 last_seen 仅
// 冷启动兜底 + 离线告警（offline_after_s=180 远大于 60s，不受影响）。
export const LAST_SEEN_THROTTLE_S = 60;
export const lastSeenWrite = new Map(); // serverId -> 上次落盘秒（跨实例 evict 丢失后仅偶发多写一次，无害）
// serverId -> { minTs, names: Set }：metrics_custom 分钟去重（同分钟同指标只写一次 D1；
// 跨实例 evict 丢失后仅偶发多写一次，INSERT OR IGNORE 幂等无害）
export const customWritten = new Map();
// 服务器行缓存（handleReport 每帧 SELECT 1 行 → 60s TTL，快采 −28,800 D1 读/天/机）。
// 按隔离实例分布（Worker HTTP 上报 / TerminalDO 控制通道上报各自一份）；删除路径清 Worker 侧，
// TerminalDO 侧 60s 自动过期，缓存窗口内的孤儿写无害（INSERT OR IGNORE / 条件写）
export const serverRowCache = new Map(); // serverId -> {info_json, probe_json, name, ts}
const SERVER_ROW_TTL_MS = 60 * 1000;
async function getServerRow(env, serverId) {
  const c = serverRowCache.get(serverId);
  if (c && Date.now() - c.ts < SERVER_ROW_TTL_MS) return c;
  const row = await env.DB.prepare('SELECT info_json, probe_json, name FROM servers WHERE id = ?').bind(serverId).first();
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
// 时序写入 MetricsDO 热区（供 /api/report 与控制通道复用）。
// 告警冷却/探活去重判定在 MetricsDO 内部完成（见 MetricsDO.checkAlerts / checkProbeAlerts）。
export async function handleReport(env, payload) {
  const ts = Math.floor(Date.now() / 1000);
  const minTs = Math.floor(ts / 60);
  // 服务器行读缓存同时承担存在性复核（缓存未命中才查 D1；删除窗口孤儿写无害，
  // 见 getServerRow 注释；热区由 MetricsDO /drop + alarm 清理兜底）。
  const server = await getServerRow(env, payload.serverId);
  if (!server) return;
  // 探活状态：变更才写 probe_json（告警去重状态在 MetricsDO 顺风车处理），写后更新行缓存
  if (Array.isArray(payload.probes)) {
    const probeJson = JSON.stringify(payload.probes);
    if (server.probe_json !== probeJson) {
      await env.DB.prepare('UPDATE servers SET probe_json = ? WHERE id = ?').bind(probeJson, payload.serverId).run();
      serverRowCache.set(payload.serverId, { ...server, probe_json: probeJson, ts: Date.now() });
    }
  }
  // 自定义监控项：分钟粒度直写 D1；同分钟同指标只写一次（快采同分钟重复上报不再执行 INSERT，D1 写查询约 −95%）
  if (Array.isArray(payload.custom)) {
    const items = payload.custom.filter((c) => c && c.name && c.value != null);
    const rec = customWritten.get(payload.serverId);
    const isNewMinute = !rec || rec.minTs !== minTs;
    const fresh = isNewMinute ? items : items.filter((c) => !rec.names.has(String(c.name)));
    if (fresh.length) {
      const stmts = fresh.map((c) => env.DB.prepare(
        'INSERT OR IGNORE INTO metrics_custom (server_id, name, ts, value) VALUES (?,?,?,?)'
      ).bind(payload.serverId, String(c.name), minTs, Number(c.value)));
      await env.DB.batch(stmts);
      if (isNewMinute) {
        customWritten.set(payload.serverId, { minTs, names: new Set(fresh.map((c) => String(c.name))) });
      } else {
        for (const c of fresh) rec.names.add(String(c.name));
      }
    } else if (isNewMinute) {
      customWritten.set(payload.serverId, { minTs, names: new Set() }); // 推进分钟水位，避免下次视为新分钟
    }
  }
  if (payload.info) {
    const infoJson = JSON.stringify(payload.info);
    if (server.info_json !== infoJson) {
      // 系统信息变化：必须写（含 last_seen），写后更新行缓存
      await env.DB.prepare('UPDATE servers SET last_seen = ?, info_json = ? WHERE id = ?')
        .bind(ts, infoJson, payload.serverId).run();
      serverRowCache.set(payload.serverId, { ...server, info_json: infoJson, ts: Date.now() });
      lastSeenWrite.set(payload.serverId, ts);
    } else {
      // info 未变：last_seen 节流写（在线宽限 15s，60s 节流留余量；在线判定主用 last_seen_s）
      const last = lastSeenWrite.get(payload.serverId) || 0;
      if (ts - last >= LAST_SEEN_THROTTLE_S) {
        await env.DB.prepare('UPDATE servers SET last_seen = ? WHERE id = ?').bind(ts, payload.serverId).run();
        lastSeenWrite.set(payload.serverId, ts);
      }
    }
  } else {
    const last = lastSeenWrite.get(payload.serverId) || 0;
    if (ts - last >= LAST_SEEN_THROTTLE_S) {
      await env.DB.prepare('UPDATE servers SET last_seen = ? WHERE id = ?').bind(ts, payload.serverId).run();
      lastSeenWrite.set(payload.serverId, ts);
    }
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
