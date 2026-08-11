-- 为 metrics_custom 增加 ts 索引（二次降额复核）。
-- 保留期清理（alarm 中 DELETE FROM metrics_custom WHERE ts < ?）当前无索引会全表扫
-- 43,200×S×C 行 × 每天 144 次（最坏 6.2M×S×C 读/天）；加索引后走 ts 范围扫描。
-- 对照 metrics_min 已有 idx_metrics_min_ts（schema.sql:56）。
CREATE INDEX IF NOT EXISTS idx_metrics_custom_ts ON metrics_custom(ts);
