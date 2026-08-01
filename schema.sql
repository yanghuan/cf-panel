-- cf-panle D1 数据库 Schema（对齐 docs/architecture.md §8.2）
-- 应用：wrangler d1 execute cf-panle --remote --file=schema.sql

-- 用户
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,            -- PBKDF2-SHA256
  password_salt TEXT    NOT NULL,
  role          INTEGER NOT NULL DEFAULT 0,  -- 0=member 1=admin
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 服务器（agent 身份归属）
CREATE TABLE IF NOT EXISTS servers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid           TEXT    NOT NULL UNIQUE,   -- agent 身份标识
  name           TEXT    NOT NULL,
  "group"        TEXT    NOT NULL DEFAULT '', -- 分组（'' = 未分组）
  user_id        INTEGER NOT NULL,          -- 归属用户
  agent_key_hash TEXT    NOT NULL,          -- agent 密钥哈希（HMAC-SHA256）
  hide_for_guest INTEGER NOT NULL DEFAULT 0,
  display_index  INTEGER NOT NULL DEFAULT 0,
  last_seen      INTEGER,                   -- unix 秒，最近上报时间
  online         INTEGER NOT NULL DEFAULT 0,
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

-- 监控时序（分钟级聚合，控制写入量 ≈ 43 行/天/机器）
CREATE TABLE IF NOT EXISTS metrics_min (
  server_id INTEGER NOT NULL,
  ts        INTEGER NOT NULL,                -- unix 分钟戳
  cpu       REAL,
  mem_used  REAL,
  net_in    REAL,
  net_out   REAL,
  PRIMARY KEY (server_id, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_metrics_min_ts ON metrics_min(ts);
