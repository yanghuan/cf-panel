#!/usr/bin/env bash
# ============================================================
# cf-panle agent —— 纯 Shell 实现（websocat + socat + jq）
# 对齐 docs/architecture.md §3.5
# 依赖: websocat(必装), socat(resize 需要), jq, pgrep(会话结束清理进程组), bash, stty
#       文件管理另需 GNU coreutils（find -printf / tail -c / base64 -w0，busybox 精简环境不支持）
# 功能: 常驻控制通道（终端 + resize + 文件管理）+ 内置监控上报（经控制 WS，无需 crontab）
#       上报指标: CPU / 内存 / Swap / 磁盘 / 负载 / 温度 / 进程数 / TCP-UDP 连接数 / 网络速率 / 系统信息
#       文件管理: 目录浏览 / 上传 / 下载（独立 WS 会话，JSON 行协议 + base64）
# 省配额: 有面板观看者时 3s 上报（服务端下发 set_report_interval），无人查看时 120s 低频采样
# 用法:
#   AGENT_WSS_URL=wss://panel.example.com/ws/agent \
#   AGENT_KEY=<key> ./agent.sh
# ============================================================
set -euo pipefail

WSS=${AGENT_WSS_URL:?}        # 例: wss://panel.example.com/ws/agent
KEY=${AGENT_KEY:?}            # 唯一身份 + 凭证（uuid 已废弃，仅保留这一个）
TMP_DIR=${AGENT_TMPDIR:-/tmp/cfpanle}
DISABLE_EXEC=${DISABLE_EXEC:-0}         # =1 时全局禁止命令执行（终端/exec 全部忽略）
REPORT_INTERVAL=${REPORT_INTERVAL:-120} # 默认上报间隔（秒）：省配额策略下无人查看用 120s，有观看者由服务端下发 3s

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
  # 注意：grep 无匹配返回 1，set -o pipefail 下会导致整个命令失败，必须 || true 兜底
  ip4=$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^[0-9.]+$/' | grep -v '^127\.' | head -1) || true
  ip6=$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '/:/' | grep -v '^::1$' | head -1) || true
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
  cpu=$(awk -v u1="$c1u" -v n1="$c1n" -v s1="$c1s" -v i1="$c1i" \
          -v u0="$c0u" -v n0="$c0n" -v s0="$c0s" -v i0="$c0i" \
    'BEGIN {
      total = (u1 + n1 + s1 + i1) - (u0 + n0 + s0 + i0);
      idle  = i1 - i0;
      if (total <= 0) { print 0; exit }
      printf "%.2f", 100 * (1 - idle / total)
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
  # 磁盘使用率（挂载点 + 百分比），JSON 数组；df 失败时兜底为 []
  local disk
  disk="[$(df -Pk 2>/dev/null | awk 'NR>1 && $6 ~ /^\// { gsub(/%/,"",$5); printf "{\"m\":\"%s\",\"u\":%s},", $6, $5 }' | sed 's/,$//')]" || true
  disk=${disk:-[]}
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
# 间隔动态可调：服务端下发 set_report_interval 写入 $TMP_DIR/report-interval（有观看者 3s / 无人 120s）
rm -f "$CTL_IN"
mkfifo "$CTL_IN"
(
  exec 3<>"$CTL_IN"  # 读写方式打开 FIFO，立即成功不阻塞
  local_iv=${REPORT_INTERVAL:-120}
  while true; do
    sleep "$local_iv"
    # 读取服务端下发的动态间隔
    if [ -f "$TMP_DIR/report-interval" ]; then
      read -r new_iv < "$TMP_DIR/report-interval" 2>/dev/null || true
      case "$new_iv" in
        ''|*[!0-9]*) ;;
        *) local_iv=$new_iv ;;
      esac
    fi
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

# ---- 文件管理会话：JSON 行协议（list/read/write，base64 传文件内容）----
# WS 断开即结束，无需额外清理
spawn_file() {
  local sid=$1
  # 生成文件服务脚本（stdin 收指令 JSON，stdout 回结果 JSON，均由 websocat 透传 WS）
  # 用 sid 区分脚本文件，避免多个文件会话互相覆盖
  local fs="$TMP_DIR/file-server-$sid.sh"
  cat > "$fs" <<'SERVEREOF'
#!/usr/bin/env bash
# 文件服务（需 GNU coreutils：find -printf / tail -c / base64 -w0）
set -euo pipefail

ls_entries() {
  local path=$1
  [ -d "$path" ] || { echo '[]'; return 0; }
  find "$path" -maxdepth 1 -mindepth 1 -printf '%f|%y|%s|%T@\n' 2>/dev/null | while IFS='|' read -r name typ size mt; do
    jq -nc --arg n "$name" --arg t "$typ" --argjson s "${size:-0}" --argjson m "${mt:-0}" \
      '{name:$n, type:($t=="d"?"dir":"file"), size:$s, mtime:$m}'
  done | jq -s '.'
}

while IFS= read -r line; do
  [ -z "$line" ] && continue
  t=$(jq -r .type <<<"$line" 2>/dev/null)
  case "$t" in
    list)
      path=$(jq -r .path <<<"$line")
      entries=$(ls_entries "$path" 2>/dev/null) || entries='[]'
      jq -nc --arg p "$path" --argjson e "$entries" '{type:"list_result", ok:true, path:$p, entries:$e}'
      ;;
    read)
      path=$(jq -r .path <<<"$line")
      offset=$(jq -r '.offset // 0' <<<"$line")
      limit=$(jq -r '.limit // 0' <<<"$line")
      if [ -f "$path" ]; then
        size=$(wc -c < "$path" 2>/dev/null || echo 0)
        if [ "$size" -gt 524288000 ]; then   # 500MB 上限
          jq -nc --arg p "$path" '{type:"error", ok:false, message:"file exceeds 500MB limit"}'
          continue
        fi
        [ "${limit:-0}" -le 0 ] && limit=$size
        data=$(tail -c +$((offset + 1)) "$path" 2>/dev/null | head -c "$limit" | base64 -w0 2>/dev/null) || data=''
        got=$(printf '%s' "$data" | base64 -d 2>/dev/null | wc -c) || got=0
        jq -nc --arg p "$path" --arg d "$data" --argjson o "$offset" --argjson g "$got" --argjson s "$size" \
          '{type:"read_result", ok:true, path:$p, offset:$o, data:$d, got:$g, size:$s}'
      else
        jq -nc --arg p "$path" '{type:"error", ok:false, message:"not a file or unreadable"}'
      fi
      ;;
    write)
      path=$(jq -r .path <<<"$line")
      data=$(jq -r .data <<<"$line")
      offset=$(jq -r '.offset // 0' <<<"$line")
      if ! mkdir -p "$(dirname "$path" 2>/dev/null)" 2>/dev/null; then
        jq -nc --arg p "$path" '{type:"error", ok:false, message:"mkdir failed"}'
        continue
      fi
      if [ "$offset" -eq 0 ]; then
        printf '%s' "$data" | base64 -d > "$path" 2>/dev/null || { jq -nc '{type:"error", ok:false, message:"write failed"}'; continue; }
      else
        printf '%s' "$data" | base64 -d >> "$path" 2>/dev/null || { jq -nc '{type:"error", ok:false, message:"write failed"}'; continue; }
      fi
      cur=$(wc -c < "$path" 2>/dev/null || echo 0)
      if [ "$cur" -gt 524288000 ]; then   # 500MB 上限，超限删除
        rm -f "$path" 2>/dev/null
        jq -nc '{type:"error", ok:false, message:"file exceeds 500MB limit, aborted"}'
        continue
      fi
      jq -nc --arg p "$path" --argjson o "$offset" '{type:"write_result", ok:true, path:$p, offset:$o}'
      ;;
  esac
done
SERVEREOF
  (
    websocat -b "$WSS/file?sid=$sid" -H "X-Agent-Key: $KEY" \
      --exec "bash $fs"
    rm -f "$fs"
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
      open_file)
        sid=$(jq -r .stream_id <<<"$line" 2>/dev/null)
        if [ "$DISABLE_EXEC" = "1" ]; then
          log "命令执行已被禁用 (DISABLE_EXEC=1)，忽略 open_file sid=$sid"
          continue
        fi
        spawn_file "$sid"
        ;;
      resize)
        sid=$(jq -r .stream_id <<<"$line" 2>/dev/null)
        rows=$(jq -r .rows <<<"$line" 2>/dev/null)
        cols=$(jq -r .cols <<<"$line" 2>/dev/null)
        stty -F "$TMP_DIR/$sid" rows "$rows" cols "$cols" 2>/dev/null || true
        ;;
      set_report_interval)
        iv=$(jq -r .interval <<<"$line" 2>/dev/null)
        case "$iv" in
          ''|*[!0-9]*) ;;  # 非数字忽略
          *) echo "$iv" > "$TMP_DIR/report-interval" ;;
        esac
        ;;
    esac
  done
  log "control channel lost, retry in 3s..."
  sleep 3
done
