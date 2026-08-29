-- 按天汇总（流量累计 + 可用率 + 重启检测）
-- 存在意义：metrics_min 只保留 30 天且 7 天后按 ts%5 降采样（仅剩 1/5 采样点），
-- 无法算月度流量，更无法从"稀疏采样点"反推离线时长（离线期间根本没有行）。
-- 本表 1 行/机/天（365 行/机/年，约为 metrics_min 的 1/118），保留期远长于 30 天。
CREATE TABLE IF NOT EXISTS metrics_day (
  server_id  INTEGER NOT NULL,
  day        INTEGER NOT NULL,                -- 天序号：floor((unix秒 + 时区偏移) / 86400)
  bytes_in   REAL    NOT NULL DEFAULT 0,      -- 当日入站累计字节（速率对时间积分）
  bytes_out  REAL    NOT NULL DEFAULT 0,      -- 当日出站累计字节
  online_min REAL    NOT NULL DEFAULT 0,      -- 当日在线分钟数（可用率分子）
  total_min  REAL    NOT NULL DEFAULT 0,      -- 当日纳入统计分钟数（可用率分母）
  uptime_min REAL,                            -- 当日最后观测到的开机分钟数（重启检测基线）
  restarts   INTEGER NOT NULL DEFAULT 0,      -- 当日检测到的重启次数（uptime 下降沿）
  PRIMARY KEY (server_id, day)
) WITHOUT ROWID;

-- 保留期清理（DELETE ... WHERE day < ?）与按天倒序查询走范围扫描，避免全表扫
CREATE INDEX IF NOT EXISTS idx_metrics_day_day ON metrics_day(day);
