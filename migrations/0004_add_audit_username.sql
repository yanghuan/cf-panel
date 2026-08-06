-- 审计日志记录用户名（无 users 表，uid 仅为配置序号；显示时用名字而非序号）
ALTER TABLE audit_logs ADD COLUMN username TEXT;
