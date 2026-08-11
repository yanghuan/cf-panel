-- cf-panel D1 迁移 0007：api_tokens 增加有效期列（NULL = 永久有效）
-- 鉴权路径（auth.js）校验 expires_at（unix 秒）：已过期 → 拒绝
ALTER TABLE api_tokens ADD COLUMN expires_at INTEGER;
