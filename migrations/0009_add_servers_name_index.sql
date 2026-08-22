-- cf-panel D1 迁移 0009：MCP 按名称定位服务器时避免全表扫描
-- 名称允许重复；调用方检测到重名时拒绝操作并要求使用 server_id，因此不能使用唯一索引。
CREATE INDEX IF NOT EXISTS idx_servers_name ON servers(name);
