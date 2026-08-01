#!/usr/bin/env bash
# ============================================================
# cf-panle 监控上报 —— 用 curl 定时把 CPU/内存发给面板
# 建议 crontab：* * * * * /path/to/report.sh（每分钟）
# 对齐 docs/architecture.md §8（metrics_min 分钟级聚合）
# ============================================================
set -euo pipefail

REPORT_URL=${REPORT_URL:?}    # 例: https://panel.example.com/api/report
UUID=${AGENT_UUID:?}
KEY=${AGENT_KEY:?}

# ---- CPU 使用率（两次采样求差值，抵消瞬时误差） ----
read -r _ cpu0_u cpu0_n cpu0_s cpu0_i < <(awk '/^cpu /{print}' /proc/stat)
sleep 0.2
read -r _ cpu1_u cpu1_n cpu1_s cpu1_i < <(awk '/^cpu /{print}' /proc/stat)
cpu=$(
  awk -v u1="$cpu1_u" -v n1="$cpu1_n" -v s1="$cpu1_s" \
      -v u0="$cpu0_u" -v n0="$cpu0_n" -v s0="$cpu0_s" \
      'BEGIN {
        idle0 = u0 + n0 + s0; idle1 = u1 + n1 + s1;
        d = idle1 - idle0;
        if (d <= 0) { print 0; exit }
        printf "%.2f", 100 * (1 - d / (d + (u1 - u0)))  # 简化的空闲占比
      }'
)

# ---- 内存（已用字节） ----
mem=$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END {printf "%.0f", (t-a)*1024}' /proc/meminfo)

# ---- 上报 ----
curl -s -X POST "$REPORT_URL" \
  -H 'Content-Type: application/json' \
  -d "{\"uuid\":\"$UUID\",\"key\":\"$KEY\",\"cpu\":$cpu,\"mem_used\":$mem}" \
  -o /dev/null -w '%{http_code}\n'
