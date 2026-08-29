// cf-panel — D1 数据访问层：设置缓存、告警配置、监控历史查询
import { ARCHIVE_AFTER_MIN, metricsDownsampleMin, dayIndexOf, dayStartTs } from './config.js';
import { kvGet, safeJson, doMetrics } from './utils.js';

// 设置缓存（避免告警检查每次上报读 D1），TTL 300s（> 慢采间隔 120s，慢采每帧不再必 miss），
// 保存设置时清除（Worker 侧）+ MetricsDO RPC 清除（DO 隔离实例侧）
// 注意：告警冷却（ALERT_LAST）与探活去重（PROBE_STATE）状态已移至 MetricsDO 实例内存
// （单实例全局一致，且复用每次上报已有的 /report 调用，零额外请求），见 MetricsDO.checkAlerts/checkProbeAlerts
export const SETTINGS_CACHE = new Map();
const SETTINGS_TTL_MS = 300 * 1000;
export async function kvGetCached(env, key, fallback) {
  const c = SETTINGS_CACHE.get(key);
  if (c && Date.now() - c.ts < SETTINGS_TTL_MS) return c.value;
  const v = await kvGet(env, key, fallback);
  SETTINGS_CACHE.set(key, { value: v, ts: Date.now() });
  return v;
}
export function kvClearCache(key) {
  SETTINGS_CACHE.delete(key);
}

// 告警配置：从 D1 settings.alerts 读取（网页设置弹窗配置，不再用 ALERT_* 环境变量）
export async function getAlertCfg(env) {
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
    // 免打扰：计划内重启/割接前设置，到期自动恢复（不落库清理，判定时按当前时间比较）
    mute_until: Number(a.mute_until) || 0,
    muted: Number(a.mute_until) > 0 && Date.now() / 1000 < Number(a.mute_until),
  };
}

// 最终生效的告警配置：全局 settings.alerts 为基线，逐机 alert_override 覆盖其上。
// 只覆盖「阈值类」维度——webhook 渠道/模板/冷却是全局基础设施与防刷保护，
// 逐机化会让告警状态（冷却水位、离线状态机）按机器分裂，收益不抵复杂度。
// overrideRaw 是 servers.alert_override 原始 JSON 字符串，随上报帧一起送来
// （见 report.js）：告警判定因此无需每帧回查 D1。
export function resolveAlertCfg(base, overrideRaw) {
  const ov = safeJson(overrideRaw);
  if (!ov || typeof ov !== 'object') return base;
  const posNum = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const nonNeg = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  return {
    ...base,
    cpu_pct: posNum(ov.cpu_pct) ?? base.cpu_pct,
    mem_pct: posNum(ov.mem_pct) ?? base.mem_pct,
    disk_pct: posNum(ov.disk_pct) ?? base.disk_pct,
    load: nonNeg(ov.load) ?? base.load, // 显式 0 = 关闭该维度告警
    offline_after_s: posNum(ov.offline_after_s) ?? base.offline_after_s,
  };
}

// 监控历史查询（/api/monitor 与 MCP 共用）：统一合并「MetricsDO 热区（最近 ≤12h）」与
// 「D1 归档（≥1h 前）」后按时间戳去重（热区优先，补齐最近未归档数据），超上限时 JS 降采样。
// 热区不再只保留 1h，≤12h 查询完整；长区间查询不再缺最近 ~1h 数据。
const MONITOR_D1_MAX_ROWS = 1500; // 长区间 SQL 抽样上限，防响应/解析放大
export async function queryMonitorRows(env, serverId, hours) {
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
      // 步长必须对齐降采样粒度：老数据只保留 ts % down = 0 的行，若 step 与 down 互质
      // （如 29 与 5）抽样会命中不到行，长区间图表出现空洞。向上取整到 down 的倍数。
      const down = metricsDownsampleMin(env);
      const step = Math.ceil(Math.ceil(minutes / MONITOR_D1_MAX_ROWS) / down) * down;
      r = await env.DB.prepare(`${q} AND ts % ? = 0 ORDER BY ts`).bind(serverId, sinceMin, archiveSince, step).all();
    } else {
      r = await env.DB.prepare(`${q} ORDER BY ts`).bind(serverId, sinceMin, archiveSince).all();
    }
    rows = r.results.map((x) => ({ ...x, extra: safeJson(x.extra) }));
  }
  // 3) 合并去重：热区优先（同 ts 覆盖 D1，取最近上报值）；
  //    并按 sinceMin 过滤：热区 /query 按"最后 N 条"返回，数据缺口时可能含更早数据
  const merged = new Map();
  for (const x of rows) merged.set(x.ts, x);
  for (const x of hot) {
    if (x.ts >= sinceMin) merged.set(x.ts, x);
  }
  let arr = [...merged.values()].sort((a, b) => a.ts - b.ts);
  // 4) 超上限时均匀降采样
  if (arr.length > MONITOR_D1_MAX_ROWS) {
    const step = Math.ceil(arr.length / MONITOR_D1_MAX_ROWS);
    arr = arr.filter((_, i) => i % step === 0);
  }
  return arr;
}

// 自定义监控项查询：按时间段读 D1（低频直写，无需热区），超长区间 SQL 抽样
export async function queryCustomMetrics(env, serverId, hours) {
  const minutes = hours * 60;
  const sinceMin = Math.floor(Date.now() / 1000 / 60) - minutes;
  const custom = {};
  const MAX = 1500;
  let r;
  if (minutes > MAX) {
    // 同上：custom 写入已按降采样桶对齐，查询步长必须同为降采样粒度的倍数
    const down = metricsDownsampleMin(env);
    const step = Math.ceil(Math.ceil(minutes / MAX) / down) * down;
    r = await env.DB.prepare('SELECT name, ts, value FROM metrics_custom WHERE server_id = ? AND ts >= ? AND ts % ? = 0 ORDER BY ts').bind(serverId, sinceMin, step).all();
  } else {
    r = await env.DB.prepare('SELECT name, ts, value FROM metrics_custom WHERE server_id = ? AND ts >= ? ORDER BY ts').bind(serverId, sinceMin).all();
  }
  for (const row of r.results) {
    (custom[row.name] = custom[row.name] || []).push({ ts: row.ts, value: row.value });
  }
  return custom;
}

// 按天统计查询（流量累计 / 可用率 / 重启）：读 metrics_day（1 行/机/天，保留 3 年）。
// 与 queryMonitorRows（分钟级、30 天、7 天后降采样）是两个量级的账：
// 月度流量和可用率必须查天账——分钟表跨不了月，且离线期间无行、反推不出可用率。
// ts 为当天起始 unix 秒，供前端直接 new Date(ts*1000) 格式化。
export async function queryDayStats(env, serverId, days, offsetSec = 0) {
  const sinceDay = dayIndexOf(Math.floor(Date.now() / 1000), offsetSec) - (days - 1);
  const r = await env.DB.prepare(
    'SELECT day, bytes_in, bytes_out, online_min, total_min, uptime_min, restarts FROM metrics_day WHERE server_id = ? AND day >= ? ORDER BY day'
  ).bind(serverId, sinceDay).all();
  return r.results.map((x) => ({
    ...x,
    ts: dayStartTs(x.day, offsetSec),
    // 可用率 = 在线分钟 / 纳入统计分钟；分母为 0（当天无数据）时返回 null，前端显示 '-'
    availability: x.total_min > 0 ? (x.online_min / x.total_min) * 100 : null,
  }));
}
