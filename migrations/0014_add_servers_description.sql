-- 服务器描述（可选，自由文本）：给人看的运维备注（用途/负责人/机房等），
-- 也随 list_servers 下发给 MCP 客户端，供 AI 判断该机器该不该动。
-- 长度上限由应用层限制（config.js SERVER_DESC_MAX），D1 无法加 CHECK 约束。
ALTER TABLE servers ADD COLUMN description TEXT;
