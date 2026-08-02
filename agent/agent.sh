#!/usr/bin/env bash
# ============================================================
# cf-panle agent —— 纯 Shell 实现（websocat + socat + jq）
# 对齐 docs/architecture.md §3.5
# 依赖: websocat(必装), socat(resize 需要), jq, bash, stty
# 功能: 常驻控制通道（终端 + resize）+ 内置监控上报（经控制 WS，无需 crontab）
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

# ---- 监控采集：输出 JSON {type:"report", cpu, mem_used, net_in, net_out} ----
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
  # 内存已用（字节）
  local mem
  mem=$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END {printf "%.0f", (t-a)*1024}' /proc/meminfo)
  # 网络累计（所有接口 rx/tx 字节）
  local rx tx
  read -r rx tx < <(awk 'NR>2 { rx += $2; tx += $10 } END { print rx, tx }' /proc/net/dev) || true
  jq -nc \
    --argjson cpu "${cpu:-0}" \
    --argjson mem "${mem:-0}" \
    --argjson rx "${rx:-0}" \
    --argjson tx "${tx:-0}" \
    '{type:"report", cpu:$cpu, mem_used:$mem, net_in:$rx, net_out:$tx}'
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
spawn_terminal() {
  local sid=$1
  (
    websocat -b "$WSS/terminal?sid=$sid" -H "X-Agent-Key: $KEY" \
      --exec "socat - $TMP_DIR/$sid"
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
        spawn_terminal "$sid"
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
