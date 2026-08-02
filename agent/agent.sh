#!/usr/bin/env bash
# ============================================================
# cf-panle agent —— 纯 Shell 实现（websocat + socat + jq）
# 对齐 docs/architecture.md §3.5
# 依赖: websocat(必装), socat(resize 需要), jq, bash, stty
# 用法:
#   AGENT_WSS_URL=wss://panel.example.com/ws/agent \
#   AGENT_KEY=<key> ./agent.sh
# ============================================================
set -euo pipefail

WSS=${AGENT_WSS_URL:?}        # 例: wss://panel.example.com/ws/agent
KEY=${AGENT_KEY:?}            # 唯一身份 + 凭证（uuid 已废弃，仅保留这一个）
TMP_DIR=${AGENT_TMPDIR:-/tmp/cfpanle}
DISABLE_EXEC=${DISABLE_EXEC:-0}   # =1 时全局禁止命令执行（终端/exec 全部忽略）

mkdir -p "$TMP_DIR"

# 拉起一个终端会话：WS 全双工 ⇄ socat ⇄ pty slave ⇄ bash
spawn_terminal() {
  local sid=$1
  (
    websocat -b "$WSS/terminal?sid=$sid" -H "X-Agent-Key: $KEY" \
      --exec "socat - $TMP_DIR/$sid"
  ) &
}

log() { echo "[cf-panle] $*" >&2; }

# 控制通道常驻循环（断线自动重连）
while true; do
  log "connecting control channel..."
  websocat -b "$WSS/control" -H "X-Agent-Key: $KEY" 2>/dev/null | while IFS= read -r line; do
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
