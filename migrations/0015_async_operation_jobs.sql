-- 异步任务事实表（阶段 A 只启用 exec；upload / agent_update 的列先建好，避免二次迁移）
-- 设计要点：任务状态必须落 D1，不能只放 DO —— 轮询 GET /api/jobs/:id 由 Worker 直接查库，
-- 一旦改成读 DO 存储，每次轮询都会激活对象、打断 hibernation，抵消异步化的全部收益。
-- kind / status 不加 CHECK：SQLite 无法 ALTER CHECK，状态机演进会被迫重建表；
-- 取值由 src/jobs.js 统一校验。
CREATE TABLE IF NOT EXISTS operation_jobs (
  id                TEXT PRIMARY KEY,
  kind              TEXT    NOT NULL,
  status            TEXT    NOT NULL,
  user_id           INTEGER NOT NULL,
  username          TEXT    NOT NULL,
  client_ip         TEXT,
  server_id         INTEGER NOT NULL,

  -- exec
  command           TEXT,
  timeout_s         INTEGER,
  idempotency_key   TEXT,
  exit_code         INTEGER,
  stdout            TEXT,
  stderr            TEXT,
  timed_out         INTEGER,

  -- upload（阶段 B）
  target_path       TEXT,
  overwrite         INTEGER NOT NULL DEFAULT 0,
  size_bytes        INTEGER,
  sha256            TEXT,
  r2_key            TEXT,

  -- agent_update（阶段 C）
  build_id          TEXT,
  from_version      TEXT,
  to_version        TEXT,
  platform          TEXT,
  asset_url         TEXT,

  error             TEXT,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  finished_at       INTEGER,
  deadline_at       INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  duration_ms       INTEGER,
  dispatch_attempts INTEGER NOT NULL DEFAULT 0
);

-- 按用户查任务（未来的任务中心 / 排障）
CREATE INDEX IF NOT EXISTS idx_operation_jobs_user_created
  ON operation_jobs(user_id, created_at DESC);

-- 清理：按过期时间扫
CREATE INDEX IF NOT EXISTS idx_operation_jobs_cleanup
  ON operation_jobs(expires_at);

-- 互斥判定：某服务器是否有活动任务
CREATE INDEX IF NOT EXISTS idx_operation_jobs_server_status
  ON operation_jobs(server_id, kind, status);

-- 同一服务器同时只允许一个 upload 任务（阶段 B 生效；提前建好，保持迁移与 schema 一致）
CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_jobs_active_upload
  ON operation_jobs(server_id)
  WHERE kind = 'upload'
    AND status IN ('awaiting_upload', 'staging', 'staged', 'waiting_agent', 'running');

-- 同一服务器同时只允许一个 agent update（更新会重启 Agent，必须串行）
CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_jobs_active_update
  ON operation_jobs(server_id)
  WHERE kind = 'agent_update'
    AND status IN ('queued', 'waiting_agent', 'running');

-- 幂等：同一用户同一 key 只能有一个未过期任务（行被清理后可重用，语义见 jobs.js）
CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_jobs_idempotency
  ON operation_jobs(user_id, kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 审计关联：exec 终态审计需要带 job_id 与耗时
ALTER TABLE audit_logs ADD COLUMN duration_ms INTEGER;
ALTER TABLE audit_logs ADD COLUMN job_id TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_logs_job_id ON audit_logs(job_id);
