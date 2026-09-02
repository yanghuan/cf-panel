// cf-panel — 跨模块共享常量与协议定义（无依赖，供各模块导入）。
// 单模块专用的常量就近定义在对应模块顶部（do-terminal/do-metrics/do-panel/routes），
// 便于与使用代码对照；此处仅保留被 ≥2 个模块引用的项。

export const SHARDS = 4; // 终端 DO 分片数（utils 分片路由 / routes 删除广播 / do-panel 观看者广播共用）

export const PAT_PREFIX = 'cfp_'; // PAT token 前缀（auth 鉴权 + routes 创建共用）
export const SCOPE_READ = 'server:read';
export const SCOPE_EXEC = 'server:exec';
export const SCOPE_AGENT_UPDATE = 'agent:update';

// 监控时序：超过 1 小时的旧数据才归档/可淘汰（db 监控查询 + do-metrics 归档共用）
export const ARCHIVE_AFTER_MIN = 60;

// 监控时序降采样粒度（分钟）：**写入桶 / 保留点 / 查询步长三者共用同一常量**。
// 必须同源——老数据只保留 `ts % 降采样 = 0` 的行，若长区间查询的抽样步长与它互质
// （如 step=29 与 downsample=5），`ts % step = 0` 会命中不到行，图表出现空洞。
// 收益：D1 写入 $1.00/百万行、读取 $0.001/百万行（差 1000 倍），自定义指标是
// metrics_custom 的唯一写入源且多为慢变量（温度/业务计数），1 分钟分辨率收益极低。
// 设 METRICS_DOWNSAMPLE_MIN=1 即恢复逐分钟行为（写入桶与保留粒度同时回到 1 分钟）。
export const METRICS_DOWNSAMPLE_MIN = 5;
// 分层保留：细粒度（1 分钟）窗口天数，超出后只保留降采样点，直到 METRICS_RETENTION_DAYS
export const METRICS_FINE_DAYS = 7;

export function metricsDownsampleMin(env) {
  const n = Number(env.METRICS_DOWNSAMPLE_MIN);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : METRICS_DOWNSAMPLE_MIN;
}
export function metricsFineDays(env) {
  const n = Number(env.METRICS_FINE_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : METRICS_FINE_DAYS;
}

// 在线判定宽限期（秒）：按观看者状态动态选择（auth 服务器列表 + do-panel 推送共用）——
// 无观看者：agent 慢采 120s，需约 1.5 倍间隔宽限（与离线告警阈值 offline_after_s=180 对齐）；
// 有观看者：agent 快采 5s，3 次未上报（15s）即判定离线。15s = 3 个快采周期，
// 留足"切快采 ≤5s + 控制通道重连间隙 3~6s + 网络抖动"的余量，又远快于 180s。
export const ONLINE_GRACE_SLOW_S = 180;
export const ONLINE_GRACE_FAST_S = 15;

// ---- 按天统计（流量累计 / 可用率）----
// 天序号 = floor((unix 秒 + 时区偏移) / 86400)。
// 时区偏移来自 STATS_TZ_OFFSET_MINUTES（默认 0 = UTC）：让"月度流量"按本地时区结算。
// 若固定 UTC，则 UTC+8 用户每月 1 号 00:00~08:00 的流量会被算进上个月，月底对不上账。
export const DAY_SECONDS = 86400;
export function statsTzOffsetSec(env) {
  const m = Number(env && env.STATS_TZ_OFFSET_MINUTES);
  return Number.isFinite(m) ? Math.floor(m * 60) : 0;
}
export function dayIndexOf(tsSec, offsetSec = 0) {
  return Math.floor((Number(tsSec) + offsetSec) / DAY_SECONDS);
}
export function dayStartTs(day, offsetSec = 0) {
  return Number(day) * DAY_SECONDS - offsetSec;
}
// 按天累加时"仍视为在线"的最大上报间隔（秒）：慢采 120s × 2.5 倍余量。
// 超过它说明中间存在离线——离线段只补可用率分母（total_min），不补分子，
// 否则"离线 3 天后一帧上报"会把整段离线时间算成在线，可用率永远显示 100%。
export const DAY_ONLINE_GAP_S = 300;

// 解析面板用户：PANEL_USERS="alice:pass1,bob:pass2"；未设置时回退 PANEL_PASSWORD 单管理员
//（routes 登录用；__internals 测试导出用）
// 硬约束：逗号是用户分隔符，密码/用户名均不得含逗号；含逗号会静默拆成多个条目
// （如 alice:pass,1 → 密码被截成 pass、凭空多出无效条目 1），故对无冒号的非空分段
// fail closed 抛错（登录 500 暴露配置错误），优于静默截断。
export function parsePanelUsers(env) {
  const raw = String(env.PANEL_USERS || '').trim();
  if (!raw) {
    return env.PANEL_PASSWORD ? [{ username: 'admin', password: String(env.PANEL_PASSWORD) }] : [];
  }
  return raw.split(',').map((pair) => {
    const idx = pair.indexOf(':');
    if (idx < 0) {
      if (pair.trim()) throw new Error('PANEL_USERS 配置错误：存在无冒号的条目（用户名/密码不得含逗号）');
      return null; // 空分段（连续逗号/尾逗号）容忍
    }
    return { username: pair.slice(0, idx).trim(), password: pair.slice(idx + 1).trim() };
  }).filter((u) => u && u.username && u.password); // 空用户名/空密码（如 ":pass"）仍按旧行为丢弃
}
