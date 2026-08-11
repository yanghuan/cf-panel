-- cf-panel D1 迁移 0006：缺失索引补齐（PAT 鉴权 / 审计清理全表扫）
-- 场景：
--   1) api_tokens.token_hash —— 每次 PAT 鉴权 `WHERE token_hash = ?` 全表扫（auth.js:11），PAT 高频调用时随表膨胀变慢
--   2) audit_logs.created_at —— 保留期每日清理 `DELETE FROM audit_logs WHERE created_at < ?` 全表扫（只增不减，越跑越慢）
-- 当前数据量小影响可忽略，规模化前补齐（IF NOT EXISTS 幂等，与 schema.sql 保持同步）
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
