#!/usr/bin/env bash
# ============================================================
# cf-panel E2E：真实环境联调（wrangler dev --local + agent.sh）
# 验证链路：worker 启动 → D1 建表 → 登录 → 注册服务器 →
#           agent 控制通道上线 → 监控上报落库 → 终端双向透传
# 依赖：
#   - node >= 22（含 wrangler，npm i -D wrangler）
#   - curl / jq 在 PATH（CI 用 apt 安装，agent 本身也依赖 jq）
#   - websocat 在 PATH（agent 控制通道必装）
#   - socat 可选：存在时才跑终端透传用例（CI 用 apt 安装）
# 用法：bash test/e2e.sh
# 环境变量：E2E_PORT（默认 8787）、E2E_PASSWORD（默认读 .dev.vars 的 PANEL_PASSWORD）
# ============================================================
set -euo pipefail

PORT="${E2E_PORT:-8787}"
BASE="http://127.0.0.1:$PORT"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
STATE="$TMP/wrangler-state"
WRANGLER_LOG="$TMP/wrangler.log"
AGENT_LOG="$TMP/agent.log"
WRANGLER_PID=""
AGENT_PID=""
PASS=0
FAIL=0

# 密码默认从 .dev.vars 读取（未配置则要求显式传入）
if [ -z "${E2E_PASSWORD:-}" ] && [ -f "$ROOT/.dev.vars" ]; then
  E2E_PASSWORD=$(grep -E '^PANEL_PASSWORD=' "$ROOT/.dev.vars" | cut -d= -f2-)
fi
E2E_PASSWORD="${E2E_PASSWORD:-}"
# agent 启动命令（默认 Rust 版；可用 AGENT_CMD 覆盖为其他实现）
AGENT_CMD="${AGENT_CMD:-$ROOT/agent/rust/target/release/cf-panel-agent}"
# Shell 版 agent 已废弃：Rust 二进制缺失时给出构建提示，不静默回退
if [ ! -x "${AGENT_CMD%% *}" ]; then
  echo "Rust agent 二进制不存在：$AGENT_CMD" >&2
  echo "请先构建：cd agent/rust && cargo build --release（或设置 AGENT_CMD 指向其他实现）" >&2
  exit 1
fi

cleanup() {
  # 只清理本次启动的进程（按进程组 kill，避免全局 pkill 误杀同机其他 wrangler/agent）
  [ -n "${AGENT_KEY:-}" ] && { pkill -f "websocat.*$AGENT_KEY" 2>/dev/null || true; }
  [ -n "${AGENT_KEY:-}" ] && { pkill -f "pty,link=$TMP/agent/" 2>/dev/null || true; }
  [ -n "$AGENT_PID" ] && { kill -- -"$AGENT_PID" 2>/dev/null || true; }
  [ -n "$WRANGLER_PID" ] && { kill -- -"$WRANGLER_PID" 2>/dev/null || true; }
  [ -n "$AGENT_PID" ] && { kill "$AGENT_PID" 2>/dev/null || true; }
  [ -n "$WRANGLER_PID" ] && { kill "$WRANGLER_PID" 2>/dev/null || true; }
  sleep 0.3
  rm -rf "$TMP"
  if [ "$FAIL" -eq 0 ]; then
    echo ""
    echo "E2E PASS：${PASS} 项检查全部通过"
  else
    echo ""
    echo "E2E FAIL：${FAIL} 项失败 / ${PASS} 项通过"
    echo "wrangler 日志尾部：$WRANGLER_LOG"
    tail -20 "$WRANGLER_LOG" 2>/dev/null || true
    exit 1
  fi
}
trap cleanup EXIT INT TERM

ok()  { PASS=$((PASS + 1)); echo "  ✔ $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  ✖ $1"; }

# 轮询等待某条件成立
wait_for() { # wait_for 描述 秒数 命令...
  local desc=$1 secs=$2
  shift 2
  local waited=0
  while [ "$waited" -lt "$secs" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "  等待超时：$desc" >&2
  return 1
}

echo "== cf-panel E2E（port=$PORT，临时目录 $TMP）=="

# 1) 先应用 D1 migrations（与部署流水线同一路径，避免与 dev 服务器并发打开 SQLite 的竞态）
echo "[1/6] 初始化 D1 migrations ..."
if ! npx wrangler d1 migrations apply cf-panel --local --persist-to "$STATE" >>"$WRANGLER_LOG" 2>&1; then
  bad "D1 migrations 应用失败"
  tail -20 "$WRANGLER_LOG" 2>/dev/null || true
  exit 1
fi
ok "D1 migrations 已应用"

# 2) 启动 wrangler dev --local（独立 persist 目录，不影响仓库 .wrangler）
echo "[2/6] 启动 wrangler dev --local ..."
setsid npx wrangler dev --local --port "$PORT" --persist-to "$STATE" >"$WRANGLER_LOG" 2>&1 &
WRANGLER_PID=$!
if ! wait_for "wrangler dev 就绪" 60 curl -s -o /dev/null "$BASE/api/public/settings"; then
  bad "wrangler dev 未在 60s 内就绪"
  tail -20 "$WRANGLER_LOG" 2>/dev/null || true
  exit 1
fi
ok "wrangler dev 就绪于 $BASE"

# 3) 登录面板获取 JWT
echo "[3/6] 面板登录 ..."
if [ -z "$E2E_PASSWORD" ]; then
  bad "缺少密码：请设置 E2E_PASSWORD 或 .dev.vars 中的 PANEL_PASSWORD"
  exit 1
fi
LOGIN=$(curl -s -X POST "$BASE/api/login" \
  -H 'content-type: application/json' \
  -d "{\"password\":\"$E2E_PASSWORD\"}" || true)
TOKEN=$(jq -r .token <<<"$LOGIN" 2>/dev/null || true)
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  bad "登录失败：$LOGIN"
  exit 1
fi
ok "登录成功，获取 JWT"

# 4) 注册服务器，拿到 agent key
echo "[4/6] 注册服务器 ..."
CREATE=$(curl -s -X POST "$BASE/api/servers" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"e2e-node","group":"e2e","sort_order":1}' || true)
AGENT_KEY=$(jq -r .agent_key <<<"$CREATE" 2>/dev/null || true)
if [ -z "$AGENT_KEY" ] || [ "$AGENT_KEY" = "null" ]; then
  bad "注册服务器失败：$CREATE"
  exit 1
fi
ok "已注册服务器（agent_key=${AGENT_KEY:0:8}...）"

# 5) 启动 agent，等待其控制通道上线并上报监控
echo "[5/6] 启动 agent（${AGENT_CMD%% *}）并等待上线/上报 ..."
setsid env \
AGENT_WSS_URL="ws://127.0.0.1:$PORT/ws/agent" \
AGENT_KEY="$AGENT_KEY" \
AGENT_TMPDIR="$TMP/agent" \
AGENT_LOG="$AGENT_LOG" \
AGENT_LOG_MAX=1048576 \
REPORT_INTERVAL=5 \
$AGENT_CMD &
AGENT_PID=$!

if ! wait_for "agent 上线（servers.online=true）" 60 bash -c \
  "curl -s '$BASE/api/servers' -H 'authorization: Bearer $TOKEN' | jq -e '.[] | select(.name==\"e2e-node\") | .online == true' >/dev/null"; then
  bad "agent 未在 60s 内上线（agent 日志尾部）"
  tail -20 "$AGENT_LOG" 2>/dev/null || true
  exit 1
fi
ok "agent 控制通道上线，面板判定在线"

if ! wait_for "监控数据上报（/api/monitor 有数据）" 60 bash -c \
  "curl -s '$BASE/api/monitor?server_id=1&range=1h' -H 'authorization: Bearer $TOKEN' | jq -e '.system | length >= 1' >/dev/null"; then
  bad "60s 内未收到监控上报"
  tail -20 "$AGENT_LOG" 2>/dev/null || true
  exit 1
fi
ok "监控数据已写入（系统指标 ≥1 条）"

# 上报包含系统信息与探活/自定义等（由 agent 内置采集）
SYSINFO=$(curl -s "$BASE/api/servers" -H "authorization: Bearer $TOKEN" | jq -c '.[] | select(.name=="e2e-node") | {info, metric}' || true)
if jq -e '.info.os and .info.kern' <<<"$SYSINFO" >/dev/null 2>&1; then
  ok "系统信息已入库（os/kern）"
else
  bad "系统信息缺失：$SYSINFO"
fi
if jq -e '.metric.cpu != null and .metric.mem_used != null' <<<"$SYSINFO" >/dev/null 2>&1; then
  ok "实时指标可见（cpu/mem_used）"
else
  bad "实时指标缺失：$SYSINFO"
fi

# 6) 终端双向透传（需 socat；本地无 socat 时跳过）
echo "[6/6] 终端会话 ..."
if command -v socat >/dev/null 2>&1; then
  # 终端用例允许失败重试（最多 3 次）：DO 会话水合 / agent WS 就绪存在时序竞态，
  # CI runner 负载高时偶发首连被拒（websocat 立即退出 → 无回显），重试可自愈
  TERM_OK=0
  for attempt in 1 2 3; do
    TERM_RES=$(curl -s -X POST "$BASE/api/terminal" \
      -H "authorization: Bearer $TOKEN" \
      -H 'content-type: application/json' \
      -d '{"server_id":1}' || true)
    SID=$(jq -r .session_id <<<"$TERM_RES" 2>/dev/null || true)
    if [ -z "$SID" ] || [ "$SID" = "null" ]; then
      bad "创建终端会话失败：$TERM_RES"
      break
    fi
    # 等待 agent 侧 spawn（socat+websocat）就绪，避免首字节被丢弃
    sleep 3
    # agent 数据流可能晚于浏览器 WS 注册，重复发送 echo 覆盖竞态窗口（DO 对未注册前
    # 的浏览器输入会直接丢弃，因此发到 agent 就绪后的那条 echo 必然产生回显）
    # 鉴权走首帧 {type:"auth"}（token 不进 URL）；websocat 提前退出时 printf 静音防 Broken pipe 噪音
    OUT=$(
      {
        printf '{"type":"auth","token":"%s"}\n' "$TOKEN"
        for _ in 1 2 3 4 5 6 7 8 9 10; do printf 'echo E2E_TERM_OK\n' 2>/dev/null || true; sleep 1; done
      } | timeout 30 websocat -t "ws://127.0.0.1:$PORT/ws/terminal/$SID" 2>/dev/null || true
    )
    if grep -q "E2E_TERM_OK" <<<"$OUT"; then
      ok "终端双向透传正常（收到 shell 回显）"
      TERM_OK=1
      break
    fi
    echo "  终端尝试 $attempt/3 未回显，重建会话重试..."
  done
  if [ "$TERM_OK" -eq 0 ]; then
    bad "终端无回显（socat/websocat 可能未安装或 PTY 未就绪）"
    tail -10 "$AGENT_LOG" 2>/dev/null || true
  fi
else
  echo "  （跳过：未检测到 socat，终端用例仅在 CI 运行）"
fi

# 清理由 trap 统一处理
exit 0
