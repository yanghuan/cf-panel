-- cf-panel D1 迁移 0002：metrics_min 增加 mem_total 列（历史内存百分比计算用）
ALTER TABLE metrics_min ADD COLUMN mem_total REAL;
