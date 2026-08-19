-- cf-panel D1 迁移 0008：审计日志筛选索引（W-M3）
-- 场景：/api/audit-logs 与 MCP get_audit_logs 的筛选查询（routes.js）按
--   action = ? / target_server_id = ? 过滤 + ORDER BY id DESC LIMIT/OFFSET，
--   此前仅有 idx_audit_logs_created（created_at），筛选走全表扫——
--   90 天保留 × 操作量增长后，每次筛选请求 ~2×全表行读（rows + COUNT 双查询）。
-- username LIKE '%x%' 为前导通配、无法用索引（维持全表扫，量级可接受）。
-- 当前数据量小影响可忽略，规模化前补齐（IF NOT EXISTS 幂等，与 schema.sql 保持同步）
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_server_id ON audit_logs(target_server_id, id);
