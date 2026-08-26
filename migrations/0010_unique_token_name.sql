-- cf-panel D1 迁移 0010：PAT 名称唯一约束（数据库层兜底，与应用层同名校验配合）
-- 应用层创建前已查重（routes.js），唯一索引兜住并发竞态窗口（两请求同时通过检查后同时 INSERT）。
-- 旧库若已存在同名令牌（历史双击重复提交产物）：保留每组最早创建的一条，其余删除（被删 PAT 立即失效）。
DELETE FROM api_tokens WHERE id NOT IN (SELECT MIN(id) FROM api_tokens GROUP BY name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_name ON api_tokens(name);
