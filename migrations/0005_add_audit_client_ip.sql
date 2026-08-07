-- 审计日志记录操作者来源 IP（审计常规字段；前端用 <cf-ip> 组件显示归属地）
ALTER TABLE audit_logs ADD COLUMN client_ip TEXT;
