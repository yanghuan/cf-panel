#!/usr/bin/env bash
# ============================================================
# cf-panle agent —— 纯 Shell 实现（websocat + socat + jq）
# 对齐 docs/architecture.md §3.5
# 依赖: websocat(必装), socat(resize 需要), jq, pgrep(会话结束清理进程组), bash, stty
# 功能: 常驻控制通道（终端 + resize）+ 内置监控上报（经控制 WS，无需 crontab）
#       上报指标: CPU / 内存 / Swap / 磁盘 / 负载 / 温度 / 进程数 / TCP-UDP 连接数 / 网络速率 / 系统信息
# 用法:
#   AGENT_WSS_URL=wss://panel.example.com/ws/agent \
#   AGENT_KEY=<key> ./agent.sh
# ============================================================
set -euo pipefail

WSS=${AGENT_WSS_URL:?}        # 例: wss://panel.example.com/ws/agent
KEY=${AGENT_KEY:?}            # 唯一身份 + 凭证（uuid 已废弃，仅保留这一个）
TMP_DIR=${AGENT_TMPDIR:-/tmp/cfpanle}
DISABLE_EXEC=${DISABLE_EXEC:-0}         # =1 时全局禁止命令执行（终端/exec 全部忽略）
REPORT_INTERVAL=${REPORT_INTERVAL:-60}  # 监控上报间隔（秒）

mkdir -p "$TMP_DIR"
CTL_IN="$TMP_DIR/control-in"  # 控制通道上行 FIFO（上报 JSON → websocat → WS）

log() { echo "[cf-panle] $*" >&2; }

# 网络速率差分状态（上次累计值 + 采样时间，全局变量在后台子 shell 内持续）
NET_PREV_RX=0
NET_PREV_TX=0
NET_PREV_TS=0

# ---- 系统信息（静态，服务端比对变化才更新 servers.info_json）----
collect_info() {
  local os kern ip4 ip6
  os=$(awk -F= '/^PRETTY_NAME=/{gsub(/["\r]/,"",$2); print $2; exit}' /etc/os-release 2>/dev/null)
  os=${os:-$(uname -s 2>/dev/null)}
  kern=$(uname -r 2>/dev/null)
  ip4=$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^[0-9.]+$/' | grep -v '^127\.' | head -1)
  ip6=$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '/:/' | grep -v '^::1$' | head -1)
  jq -nc --arg os "${os:-}" --arg kern "${kern:-}" --arg ip4 "${ip4:-}" --arg ip6 "${ip6:-}" \
    '{os:$os, kern:$kern, ip4:$ip4, ip6:$ip6}'
}

# ---- 监控采集：输出 JSON（固定列 + extra 扩展项 + 系统信息）----
collect_report() {
  # CPU 使用率（两次采样求差值，抵消瞬时误差）
  read -r _ c0u c0n c0s c0i < <(awk '/^cpu /{print}' /proc/stat)
  sleep 0.2
  read -r _ c1u c1n c1s c1i < <(awk '/^cpu /{print}' /proc/stat)
  local cpu
  cpu=$(awk -v u1="$c1u" -v n1="$c1n" -v s1="$c1s" -v u0="$c0u" -v n0="$c0n" -v s0="$c0s" \
    'BEGIN {
      d = (u1 + n1 + s1) - (u0 + n0 + s0);
      if (d <= 0) { print 0; exit }
      printf "%.2f", 100 * (1 - d / (d + (u1 - u0)))
    }')
  # 内存已用 / Swap 已用（字节）
  local mem swap
  mem=$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END {printf "%.0f", (t-a)*1024}' /proc/meminfo)
  swap=$(awk '/SwapTotal/{t=$2} /SwapFree/{f=$2} END {printf "%.0f", (t-f)*1024}' /proc/meminfo)
  # 负载 load1/5/15 + 进程数（/proc/loadavg 第4字段 running/total 的 total）
  local load1 load5 load15 proc_info procs
  read -r load1 load5 load15 proc_info _ < /proc/loadavg || true
  procs=${proc_info#*/}; procs=${procs:-0}
  # 温度（第一个热区，无传感器则缺省）
  local temp
  temp=$(awk '{print $1/1000; exit}' /sys/class/thermal/thermal_zone*/temp 2>/dev/null) || true
  # TCP/UDP 连接数（行数-1 跳过表头）
  local tcp udp
  tcp=$(( $(wc -l < /proc/net/tcp 2>/dev/null || echo 0) - 1 )); [ "$tcp" -lt 0 ] && tcp=0
  udp=$(( $(wc -l < /proc/net/udp 2>/dev/null || echo 0) - 1 )); [ "$udp" -lt 0 ] && udp=0
  # 磁盘使用率（挂载点 + 百分比），JSON 数组
  local disk
  disk="[$(df -Pk 2>/dev/null | awk 'NR>1 && $6 ~ /^\// { gsub(/%/,"",$5); printf "{\"m\":\"%s\",\"u\":%s},", $6, $5 }' | sed 's/,$//')]"
  # 网络速率（累计差值 / 间隔，字节/秒）
  local rx tx
  read -r rx tx < <(awk 'NR>2 { rx += $2; tx += $10 } END { print rx, tx }' /proc/net/dev) || true
  rx=${rx:-0}; tx=${tx:-0}
  local now_s dt n_in_rate n_out_rate
  now_s=$(date +%s)
  if [ "$NET_PREV_TS" -gt 0 ] && [ "$now_s" -gt "$NET_PREV_TS" ]; then
    dt=$(( now_s - NET_PREV_TS ))
    n_in_rate=$(( (rx - NET_PREV_RX) / dt )); [ "$n_in_rate" -lt 0 ] && n_in_rate=0
    n_out_rate=$(( (tx - NET_PREV_TX) / dt )); [ "$n_out_rate" -lt 0 ] && n_out_rate=0
  else
    n_in_rate=0; n_out_rate=0
  fi
  NET_PREV_RX=$rx; NET_PREV_TX=$tx; NET_PREV_TS=$now_s

  local info
  info=$(collect_info)

  jq -nc \
    --argjson cpu "${cpu:-0}" \
    --argjson mem "${mem:-0}" \
    --argjson swap "${swap:-0}" \
    --argjson load1 "${load1:-0}" \
    --argjson load5 "${load5:-0}" \
    --argjson load15 "${load15:-0}" \
    --argjson temp "${temp:-null}" \
    --argjson procs "${procs:-0}" \
    --argjson tcp "${tcp:-0}" \
    --argjson udp "${udp:-0}" \
    --argjson disk "$disk" \
    --argjson nin "${n_in_rate:-0}" \
    --argjson nout "${n_out_rate:-0}" \
    --argjson info "$info" \
    '{type:"report", cpu:$cpu, mem_used:$mem, net_in:$nin, net_out:$nout,
      extra:{swap:$swap, disk:$disk, load1:$load1, load5:$load5, load15:$load15, temp:$temp, procs:$procs, tcp:$tcp, udp:$udp},
      info:$info}'
}

# ---- 后台上报循环：JSON 写入 FIFO，控制通道 websocat 会原样发到面板 ----
rm -f "$CTL_IN"
mkfifo "$CTL_IN"
(
  exec 3<>"$CTL_IN"  # 读写方式打开 FIFO，立即成功不阻塞
  while true; do
    sleep "$REPORT_INTERVAL"
    collect_report >&3 2>/dev/null || true
  done
) &

# ---- 拉起一个终端会话：WS 全双工 ⇄ socat ⇄ pty slave ⇄ bash ----
# pty_pid = PTY 端 socat 的 PID。websocat 退出（会话结束）后级联清理：
# bash 通过 setsid 独立成会话（PGID=其 PID），kill 进程组可连其子进程一起清理，不留残留。
spawn_terminal() {
  local sid=$1 pty_pid=$2
  (
    websocat -b "$WSS/terminal?sid=$sid" -H "X-Agent-Key: $KEY" \
      --exec "socat - $TMP_DIR/$sid"
    # 会话结束（浏览器关闭 / WS 断开）→ 清理 PTY 端进程组
    local bash_pid
    bash_pid=$(pgrep -P "$pty_pid" 2>/dev/null | head -1) || true
    if [ -n "$bash_pid" ]; then
      kill -- -"$bash_pid" 2>/dev/null || true  # bash 为 setsid 会话首进程，整组 SIGHUP/TERM
    fi
    kill "$pty_pid" 2>/dev/null || true
    rm -f "$TMP_DIR/$sid"
  ) &
}

# ---- 控制通道常驻循环（断线自动重连；下行=控制指令，上行=监控上报） ----
while true; do
  log "connecting control channel..."
  websocat -b "$WSS/control" -H "X-Agent-Key: $KEY" < "$CTL_IN" 2>/dev/null | while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$(jq -r .type <<<"$line" 2>/dev/null)" in
      open_terminal)
        sid=$(jq -r .stream_id <<<"$line" 2>/dev/null)
        if [ "$DISABLE_EXEC" = "1" ]; then
          log "命令执行已被禁用 (DISABLE_EXEC=1)，忽略 open_terminal sid=$sid"
          continue
        fi
        # 创建 PTY：slave 路径通过 link 暴露，供 stty 改窗口尺寸
        socat -d pty,link="$TMP_DIR/$sid",raw,echo=0 \
              EXEC:'bash -i',pty,stderr,setsid,sigint,sighup 2>/dev/null &
        spawn_terminal "$sid" $!
        ;;
      resize)
        sid=$(jq -r .stream_id <<<"$line" 2>/dev/null)
        rows=$(jq -r .rows <<<"$line" 2>/dev/null)
        cols=$(jq -r .cols <<<"$line" 2>/dev/null)
        stty -F "$TMP_DIR/$sid" rows "$rows" cols "$cols" 2>/dev/null || true
        ;;
    esac
  done
  log "control channel lost, retry in 3s..."
  sleep 3
done
