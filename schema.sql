-- cf-panel D1 数据库 Schema（对齐 docs/architecture.md §8.2）
-- 应用：wrangler d1 execute cf-panel --remote --file=schema.sql

-- 服务器（agent 身份归属）
-- 注：多用户当前由环境变量 PANEL_USERS/PANEL_PASSWORD 配置（登录即管理员），
-- 不再维护 users 表；servers.user_id 保留（记录创建者，审计/归属用）
CREATE TABLE IF NOT EXISTS servers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_key_id   TEXT    NOT NULL UNIQUE,   -- agent key 指纹（SHA-256(key)），唯一身份标识
  name           TEXT    NOT NULL,
  "group"        TEXT    NOT NULL DEFAULT '', -- 分组（'' = 未分组）
  user_id        INTEGER NOT NULL,          -- 归属用户（创建者）
  agent_key_hash TEXT    NOT NULL,          -- agent 密钥哈希（HMAC-SHA256）
  display_index  INTEGER NOT NULL DEFAULT 0,
  last_seen      INTEGER,                   -- unix 秒，最近上报时间（在线判定唯一依据：宽限期 ONLINE_GRACE_S 内算在线）
  wan_ip         TEXT,                      -- 节点公网出口 IP（agent 控制 WS 的 CF-Connecting-IP）
  info_json      TEXT,                      -- 系统信息 JSON（OS/内核/IP，变更时更新）
  probe_json     TEXT,                      -- 服务探活结果 JSON（[{name,ok,code,ms}]，变更时更新）
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- API Token（PAT，预留：只存哈希，支持 scopes + server_ids 白名单）
CREATE TABLE IF NOT EXISTS api_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  token_hash TEXT    NOT NULL,
  scopes     TEXT    NOT NULL,               -- JSON 数组，如 ["server:read","server:exec"]
  server_ids TEXT,                           -- NULL=全部，否则 JSON 白名单
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL,
  action           TEXT    NOT NULL,         -- terminal.open / server.create ...
  target_server_id INTEGER,
  detail           TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 监控时序（分钟级聚合：1 行/分钟/机器；默认归档开启，保留 30 天）
CREATE TABLE IF NOT EXISTS metrics_min (
  server_id INTEGER NOT NULL,
  ts        INTEGER NOT NULL,                -- unix 分钟戳
  cpu       REAL,
  mem_used  REAL,
  mem_total REAL,                            -- 当时总内存（历史内存百分比计算用；旧库需 ALTER 补列，见 README 迁移）
  net_in    REAL,                            -- 网络速率（字节/秒，agent 差分）
  net_out   REAL,
  extra     TEXT,                            -- 扩展监控项 JSON（swap/disk/load/temp/procs/tcp/udp，紧凑不压缩）
  PRIMARY KEY (server_id, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_metrics_min_ts ON metrics_min(ts);

-- 自定义监控项（用户定义命令采集，分钟级低频直写 D1，不走内存热区）
CREATE TABLE IF NOT EXISTS metrics_custom (
  server_id INTEGER NOT NULL,
  name      TEXT    NOT NULL,                -- 指标名
  ts        INTEGER NOT NULL,                -- unix 分钟戳
  value     REAL,
  PRIMARY KEY (server_id, name, ts)
) WITHOUT ROWID;

-- 通用键值表（替代 Workers KV，value 直接存 JSON 字符串）
-- 用途：站点设置/公告等低频键值（key = 'settings'）
CREATE TABLE IF NOT EXISTS kv_json (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                  -- JSON 字符串
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
