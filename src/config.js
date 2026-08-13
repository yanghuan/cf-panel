// cf-panel — 跨模块共享常量与协议定义（无依赖，供各模块导入）。
// 单模块专用的常量就近定义在对应模块顶部（do-terminal/do-metrics/do-panel/routes），
// 便于与使用代码对照；此处仅保留被 ≥2 个模块引用的项。

export const SHARDS = 4; // 终端 DO 分片数（utils 分片路由 / routes 删除广播 / do-panel 观看者广播共用）

export const PAT_PREFIX = 'cfp_'; // PAT token 前缀（auth 鉴权 + routes 创建共用）
export const SCOPE_READ = 'server:read';
export const SCOPE_EXEC = 'server:exec';

// 监控时序：超过 1 小时的旧数据才归档/可淘汰（db 监控查询 + do-metrics 归档共用）
export const ARCHIVE_AFTER_MIN = 60;

// 在线判定宽限期（秒）：按观看者状态动态选择（auth 服务器列表 + do-panel 推送共用）——
// 无观看者：agent 慢采 120s，需约 1.5 倍间隔宽限（与离线告警阈值 offline_after_s=180 对齐）；
// 有观看者：agent 快采 5s，3 次未上报（15s）即判定离线。15s = 3 个快采周期，
// 留足"切快采 ≤5s + 控制通道重连间隙 3~6s + 网络抖动"的余量，又远快于 180s。
export const ONLINE_GRACE_SLOW_S = 180;
export const ONLINE_GRACE_FAST_S = 15;

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
