-- 逐机告警阈值覆盖（JSON，缺省/空 = 继承全局 settings.alerts）。
-- 形如 {"cpu_pct":95,"mem_pct":null,"disk_pct":90,"load":0,"offline_after_s":300}
-- 键为 null 表示该维度回退全局；仅覆盖显式出现的键（见 db.js resolveAlertCfg）。
ALTER TABLE servers ADD COLUMN alert_override TEXT;
