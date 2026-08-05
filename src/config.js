// cf-panel — 常量配置与协议定义（无依赖，供各模块导入）

export const SHARDS = 4; // 终端 DO 分片数（改大后旧会话不可达，一般不用动）
export const SESSION_TTL_MS = 10 * 60 * 1000; // 会话两端都断开超过 10 分钟 → 回收
export const MAX_SESSIONS_PER_SERVER = 8; // 每服务器并发会话上限（超限 429，防 PTY/bash/FD 耗尽）
export const SESSION_ABS_MS = 4 * 60 * 60 * 1000; // 会话绝对最长时长（含活跃连接，到期强制回收）
export const LIST_CACHE_TTL_MS = 4500; // PanelDO 服务器列表缓存 TTL：> 前端 3s sync 间隔（错开同频，消除单观看者 miss）
export const LATEST_CACHE_TTL_MS = 4000; // MetricsDO /latest 共享缓存 TTL（多观看者 sync 共享，DO 事件 −50%）
export const SYNC_MIN_INTERVAL_MS = 2000; // PanelDO sync 频率下限（<2s 忽略，防任意消息/高频触发全链路）
export const ARCHIVE_IDLE_INTERVAL_MS = 60 * 60 * 1000; // 闲置（无数据且告警关闭）时 alarm 退避间隔（1h）
export const PAT_CHECK_INTERVAL_MS = 10 * 1000; // PAT 终端连接重校验间隔（每条消息 → 10s 一次，−98%）
export const LATEST_PUSH_INTERVAL_MS = 5000; // 上报驱动聚合推送间隔（有观看者时 ≥5s 推一次全部 latest 给 PanelDO；
// 单机时被 REPORT_FWD_THROTTLE_S=5s 钳制（MetricsDO 每 5s 收帧），多机时聚合多台上报防推送风暴）
export const PUSH_PROBE_INTERVAL_MS = 30 * 1000; // pushOn 自愈反查 /viewers 的间隔（MetricsDO evict 丢失 pushOn 时）
export const PANEL_SWITCH_GRACE_MS = 30 * 1000; // 观看者 0→1 后在线判定用慢宽限的过渡期：Agent 切快采并完成首帧上报前，
// 用 15s 快宽限会把慢采周期中（120s 内无上报）的节点误判离线；30s 后快宽限正常生效
export const PAT_PREFIX = 'cfp_'; // PAT token 前缀
export const SCOPE_READ = 'server:read';
export const SCOPE_EXEC = 'server:exec';
export const ALLOWED_SCOPES = [SCOPE_READ, SCOPE_EXEC]; // PAT 合法 scope 白名单

// 监控时序：内存 DO 热区 + alarm 归档 D1（默认开启，ARCHIVE_TO_D1=0 可关闭）
export const METRICS_KEEP_MIN = 720; // 内存保留最近 12 小时（分钟粒度）
export const ARCHIVE_INTERVAL_MS = 10 * 60 * 1000; // 归档周期
export const ARCHIVE_AFTER_MIN = 60; // 超过 1 小时的旧数据才归档/可淘汰
export const METRICS_RETENTION_DAYS = 30; // D1 历史保留期（天），过期行每日清理
export const AUDIT_RETENTION_DAYS = 90; // 审计日志保留期（天），过期行随每日清理删除
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 保留期清理周期
// 在线判定宽限期（秒）：按观看者状态动态选择——
// 无观看者：agent 慢采 120s，需约 1.5 倍间隔宽限（与离线告警阈值 offline_after_s=180 对齐）；
// 有观看者：agent 快采 5s，3 次未上报（15s）即判定离线。15s = 3 个快采周期，
// 留足"切快采 ≤5s + 控制通道重连间隙 3~6s + 网络抖动"的余量，又远快于 180s。
export const ONLINE_GRACE_SLOW_S = 180;
export const ONLINE_GRACE_FAST_S = 15;

// 省配额上报策略：有前端观看者时 agent 快采，否则低频采样
export const REPORT_FAST_INTERVAL_S = 5;  // 有观看者：5 秒上报（快采 28,800 → 17,280 帧/天/机）
export const REPORT_SLOW_INTERVAL_S = 120; // 无人查看：120 秒上报

// MCP（Model Context Protocol）标准 AI 接入：无状态 Streamable HTTP（2026-07-28 修订版）
// 端点 /mcp 仅接受 POST；每请求独立用 Authorization: Bearer 鉴权（JWT 或 PAT），无会话状态
export const MCP_VERSION = '2025-11-25'; // 服务器声明支持的协议版本（缺失头时客户端按 2025-03-26 兼容）

// 解析面板用户：PANEL_USERS="alice:pass1,bob:pass2"；未设置时回退 PANEL_PASSWORD 单管理员
export function parsePanelUsers(env) {
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

export const MCP_TOOLS = [
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
