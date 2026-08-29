-- PAT 最后使用时间（unix 秒）：令牌列表可展示"最近使用"，识别长期不用的僵尸令牌。
-- 由鉴权热路径按节流间隔回写（见 auth.js touchTokenUsed），非每请求写。
ALTER TABLE api_tokens ADD COLUMN last_used_at INTEGER;
