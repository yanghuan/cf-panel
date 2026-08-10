#!/usr/bin/env bash
# ============================================================
# cf-panel E2E：真实环境联调（wrangler dev --local + Rust agent）
# 验证链路：worker 启动 → D1 建表 → 登录 → 注册服务器 →
#           agent 控制通道上线 → 监控上报落库 → 终端双向透传 →
#           文件上传/下载 → MCP 全量工具（14 个）
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

# 上报包含系统信息与实时指标。注意 /api/servers 有 2s 短 TTL 列表缓存（降 D1 读，#12），
# 上报后立即查询可能命中「仅控制通道建连、首帧未上报」的旧快照（info/metric 为 null）；
# 因此用轮询等待最终一致（≤2s 缓存滞后），而不是一次性断言。
if wait_for "系统信息入库（os/kern）" 15 bash -c \
  "curl -s '$BASE/api/servers' -H 'authorization: Bearer $TOKEN' | jq -e '.[] | select(.name==\"e2e-node\") | .info.os and .info.kern' >/dev/null"; then
  ok "系统信息已入库（os/kern）"
else
  bad "系统信息缺失：$(curl -s "$BASE/api/servers" -H "authorization: Bearer $TOKEN" | jq -c '.[] | select(.name=="e2e-node") | {info, metric}' || true)"
fi
if wait_for "实时指标可见（cpu/mem_used）" 15 bash -c \
  "curl -s '$BASE/api/servers' -H 'authorization: Bearer $TOKEN' | jq -e '.[] | select(.name==\"e2e-node\") | .metric.cpu != null and .metric.mem_used != null' >/dev/null"; then
  ok "实时指标可见（cpu/mem_used）"
else
  bad "实时指标缺失：$(curl -s "$BASE/api/servers" -H "authorization: Bearer $TOKEN" | jq -c '.[] | select(.name=="e2e-node") | {info, metric}' || true)"
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

# 7) 文件上传/下载（10MB，验证文件管理链路：文件会话 → agent 写/读 → 内容一致性）
echo "[7/7] 文件上传/下载（10MB）..."
if command -v node >/dev/null 2>&1; then
  head -c 10485760 /dev/urandom > "$TMP/upload.bin" || true
  if [ ! -s "$TMP/upload.bin" ]; then
    bad "无法生成 10MB 测试文件"
  else
    FILE_OK=0
    for attempt in 1 2; do
      FRES=$(curl -s -X POST "$BASE/api/file/open" \
        -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
        -d '{"server_id":1}' || true)
      FSID=$(jq -r .session_id <<<"$FRES" 2>/dev/null || true)
      if [ -z "$FSID" ] || [ "$FSID" = "null" ]; then
        bad "创建文件会话失败：$FRES"
        break
      fi
      # 等待 agent 数据流挂接（open_file 指令经控制通道下发 + agent 连 /ws/agent/file）
      sleep 2
      # node 客户端：鉴权 → 20 × 512KB write（按 write_result 推进）→ 20 × read → 内容校验
      NODE_RES=$(timeout 120 node "$ROOT/scripts/e2e-file.mjs" "$BASE" "$TOKEN" "$FSID" "$TMP/upload.bin" /tmp/e2e-upload.bin 2>&1 || true)
      if [ -s /tmp/e2e-upload.bin ] && cmp -s "$TMP/upload.bin" /tmp/e2e-upload.bin \
        && [ -s "$TMP/upload.bin.down" ] && cmp -s "$TMP/upload.bin" "$TMP/upload.bin.down"; then
        ok "文件上传/下载 10MB 成功（上传与下载内容均与源一致）"
        FILE_OK=1
        break
      fi
      echo "  文件尝试 $attempt/2 失败：$NODE_RES"
      rm -f /tmp/e2e-upload.bin
    done
    if [ "$FILE_OK" -eq 0 ]; then
      bad "文件上传/下载失败（详见 agent/wrangler 日志）"
      tail -10 "$AGENT_LOG" 2>/dev/null || true
      tail -30 "$WRANGLER_LOG" 2>/dev/null || true
    fi
  fi
else
  echo "  （跳过：未检测到 node，文件用例仅在 CI 运行）"
fi
rm -f /tmp/e2e-upload.bin "$TMP/upload.bin.down"

# 8) MCP 接口测试（14 个工具全覆盖）
echo "[8/8] MCP 接口测试（14 个工具）..."

# MCP 辅助：通用 JSON-RPC 调用
mcp_call() {
  local id=${1:?} method=${2:?} params=${3:-}
  local body
  if [ -z "$params" ]; then
    body="{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"$method\"}"
  else
    body="{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"$method\",\"params\":$params}"
  fi
  curl -s -X POST "$BASE/mcp" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "$body"
}

# MCP 辅助：tools/call 快捷调用，返回原始 JSON
mcp_tool() {
  local id=${1:?} name=${2:?} args=${3:-{}}
  mcp_call "$id" "tools/call" "{\"name\":\"$name\",\"arguments\":$args}"
}

# MCP 辅助：从 tools/call 成功结果中提取 content[0].text 并解析为 JSON
mcp_text() {
  jq -r '.result.content[0].text' 2>/dev/null
}

# ---------- 8.0) initialize ----------
INIT=$(mcp_call 1 initialize '{"protocolVersion":"2025-11-25","capabilities":{}}')
INIT_VER=$(jq -r '.result.protocolVersion' <<<"$INIT" 2>/dev/null || true)
if [ "$INIT_VER" = "2025-11-25" ]; then
  ok "MCP initialize：协议版本 2025-11-25"
else
  bad "MCP initialize 失败：$INIT"
fi

# ---------- 8.1) tools/list ----------
LIST=$(mcp_call 2 tools/list)
TOOL_COUNT=$(jq -r '.result.tools | length' <<<"$LIST" 2>/dev/null || true)
if [ "$TOOL_COUNT" = "14" ]; then
  ok "MCP tools/list：14 个工具全部注册"
else
  bad "MCP tools/list：期望 14 个工具，实际 $TOOL_COUNT"
  jq -r '.result.tools[].name' <<<"$LIST" 2>/dev/null || true
fi

# ---------- 8.2) list_servers ----------
LS=$(mcp_tool 3 list_servers)
LS_TEXT=$(echo "$LS" | mcp_text)
if echo "$LS_TEXT" | jq -e '.[] | select(.name=="e2e-node" and .online==true)' >/dev/null 2>&1; then
  ok "MCP list_servers：e2e-node 在线，含实时指标"
else
  bad "MCP list_servers：e2e-node 未找到或不在线"
fi

# ---------- 8.3) get_monitor ----------
GM=$(mcp_tool 4 get_monitor '{"server_id":1,"range":"1h"}')
GM_TEXT=$(echo "$GM" | mcp_text)
if echo "$GM_TEXT" | jq -e '.system | length >= 1' >/dev/null 2>&1; then
  ok "MCP get_monitor：监控数据存在（system ≥1 条）"
else
  bad "MCP get_monitor：无监控数据"
fi

# ---------- 8.4) exec_command ----------
EXEC=$(mcp_tool 5 exec_command '{"server_id":1,"command":"echo E2E_MCP_EXEC_OK"}')
EXEC_TEXT=$(echo "$EXEC" | mcp_text)
if echo "$EXEC_TEXT" | jq -e '.stdout | test("E2E_MCP_EXEC_OK")' >/dev/null 2>&1; then
  ok "MCP exec_command：agent 真实执行，输出匹配"
else
  bad "MCP exec_command 失败：$EXEC"
fi

# ---------- 8.5) create_upload + Bearer 上传 + 验证 ----------
# 签名 URL 使用 https:// 协议，wrangler dev --local 仅 HTTP，因此工具响应做结构校验，
# 实际上传走 Bearer 鉴权路径（验证全链路流式分片 → agent 原子写）
CU=$(mcp_tool 6 create_upload '{"server_id":1,"path":"/tmp/e2e-mcp-upload.txt"}')
CU_TEXT=$(echo "$CU" | mcp_text)
CU_URL=$(jq -r '.upload_url // ""' <<<"$CU_TEXT" 2>/dev/null || true)
CU_EXP=$(jq -r '.expires_in_seconds // 0' <<<"$CU_TEXT" 2>/dev/null || true)
if [ -n "$CU_URL" ] && [ "$CU_EXP" -gt 0 ] 2>/dev/null && [ "$CU_EXP" -le 600 ]; then
  ok "MCP create_upload：签名 URL 结构正确（expires_in_seconds=$CU_EXP）"
else
  bad "MCP create_upload：响应结构异常：$CU_TEXT"
fi

# Bearer 鉴权上传测试文件并验证内容一致性
UP_RES=$(curl -s -X POST "$BASE/api/file_upload?server_id=1&path=/tmp/e2e-mcp-upload.txt" \
  -H "authorization: Bearer $TOKEN" --data-binary "E2E_MCP_UPLOAD_CONTENT" || true)
UP_OK=$(jq -r '.ok // false' <<<"$UP_RES" 2>/dev/null || true)
if [ "$UP_OK" = "true" ]; then
  # 通过 exec_command 验证文件内容
  VERIFY=$(mcp_tool 7 exec_command '{"server_id":1,"command":"cat /tmp/e2e-mcp-upload.txt"}')
  VERIFY_TEXT=$(echo "$VERIFY" | mcp_text)
  if echo "$VERIFY_TEXT" | jq -e '.stdout | test("E2E_MCP_UPLOAD_CONTENT")' >/dev/null 2>&1; then
    ok "MCP 上传：Bearer 上传 + exec_command 验证内容一致"
  else
    bad "MCP 上传：内容验证不匹配：$VERIFY_TEXT"
  fi
else
  bad "MCP 上传：Bearer POST 失败：$UP_RES"
fi
# 清理上传测试文件
mcp_tool 8 exec_command '{"server_id":1,"command":"rm -f /tmp/e2e-mcp-upload.txt"}' >/dev/null 2>&1 || true

# ---------- 8.6) add_server ----------
AS=$(mcp_tool 10 add_server '{"name":"e2e-mcp","group":"e2e-mcp","sort_order":10}')
AS_TEXT=$(echo "$AS" | mcp_text)
AS_KEY=$(jq -r '.agent_key // ""' <<<"$AS_TEXT" 2>/dev/null || true)
AS_ID=$(jq -r '.server_id // 0' <<<"$AS_TEXT" 2>/dev/null || true)
AS_WSS=$(jq -r '.wss_base // ""' <<<"$AS_TEXT" 2>/dev/null || true)
if [ "${#AS_KEY}" -eq 64 ]; then
  ok "MCP add_server：agent_key 64 位，wss_base=$AS_WSS"
else
  bad "MCP add_server 失败：$AS_TEXT"
fi

# ---------- 8.7) update_server ----------
if [ "$AS_ID" -gt 0 ] 2>/dev/null; then
  US=$(mcp_tool 11 update_server "{\"server_id\":$AS_ID,\"name\":\"e2e-mcp-renamed\"}")
  US_TEXT=$(echo "$US" | mcp_text)
  US_NAME=$(jq -r '.name // ""' <<<"$US_TEXT" 2>/dev/null || true)
  if [ "$US_NAME" = "e2e-mcp-renamed" ]; then
    ok "MCP update_server：重命名成功"
  else
    bad "MCP update_server 失败：$US_TEXT"
  fi
else
  bad "MCP update_server：跳过（add_server 未返回有效 ID）"
fi

# ---------- 8.8) delete_server ----------
if [ "$AS_ID" -gt 0 ] 2>/dev/null; then
  DS=$(mcp_tool 12 delete_server "{\"server_id\":$AS_ID}")
  DS_TEXT=$(echo "$DS" | mcp_text)
  DS_OK=$(jq -r '.ok // false' <<<"$DS_TEXT" 2>/dev/null || true)
  if [ "$DS_OK" = "true" ]; then
    ok "MCP delete_server：删除成功"
  else
    bad "MCP delete_server 失败：$DS_TEXT"
  fi
else
  bad "MCP delete_server：跳过（add_server 未返回有效 ID）"
fi

# ---------- 8.9) Token CRUD + PAT 权限 ----------
# create_token → 提取 PAT 明文 → PAT 调管理工具应被拒 → list_tokens 取 ID → revoke_token
CT=$(mcp_tool 13 create_token '{"name":"e2e-mcp-pat","scopes":["server:read"],"server_ids":[1]}')
CT_TEXT=$(echo "$CT" | mcp_text)
PAT_TOKEN=$(jq -r '.token // ""' <<<"$CT_TEXT" 2>/dev/null || true)
if echo "$PAT_TOKEN" | grep -q '^cfp_'; then
  ok "MCP create_token：PAT 创建成功（cfp_ 前缀）"
else
  bad "MCP create_token 失败：$CT_TEXT"
fi

# PAT 被拒管理工具：用 PAT 调 add_server → expect "admin only"
if [ -n "$PAT_TOKEN" ] && echo "$PAT_TOKEN" | grep -q '^cfp_'; then
  PAT_DENIED=$(curl -s -X POST "$BASE/mcp" \
    -H "authorization: Bearer $PAT_TOKEN" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":30,"method":"tools/call","params":{"name":"add_server","arguments":{"name":"evil"}}}' || true)
  PAT_ERR=$(echo "$PAT_DENIED" | jq -r '.result.content[0].text // ""' 2>/dev/null || true)
  if echo "$PAT_ERR" | grep -q 'admin only'; then
    ok "MCP 权限：PAT 被拒管理工具（admin only）"
  else
    bad "MCP 权限：PAT 未正确拒绝：$PAT_DENIED"
  fi
else
  bad "MCP 权限测试跳过（无有效 PAT）"
fi

# list_tokens → 按名称找到 e2e-mcp-pat 的 id，用于 revoke
LT=$(mcp_tool 14 list_tokens)
LT_TEXT=$(echo "$LT" | mcp_text)
LT_COUNT=$(jq -r 'length' <<<"$LT_TEXT" 2>/dev/null || true)
if [ "$LT_COUNT" -ge 1 ] 2>/dev/null; then
  ok "MCP list_tokens：至少 1 个 token"
else
  bad "MCP list_tokens：无 token"
fi

PAT_TID=$(jq -r '.[] | select(.name=="e2e-mcp-pat") | .id' <<<"$LT_TEXT" 2>/dev/null || true)
if [ -n "$PAT_TID" ] && [ "$PAT_TID" -gt 0 ] 2>/dev/null; then
  RV=$(mcp_tool 15 revoke_token "{\"token_id\":$PAT_TID}")
  RV_TEXT=$(echo "$RV" | mcp_text)
  RV_OK=$(jq -r '.ok // false' <<<"$RV_TEXT" 2>/dev/null || true)
  if [ "$RV_OK" = "true" ]; then
    ok "MCP revoke_token：撤销成功"
  else
    bad "MCP revoke_token 失败：$RV_TEXT"
  fi
else
  bad "MCP revoke_token：跳过（list_tokens 未返回 e2e-mcp-pat 的 ID）"
fi

# ---------- 8.10) get_audit_logs ----------
AL=$(mcp_tool 16 get_audit_logs '{"limit":5}')
AL_TEXT=$(echo "$AL" | mcp_text)
AL_COUNT=$(jq -r 'length' <<<"$AL_TEXT" 2>/dev/null || true)
if [ "$AL_COUNT" -ge 1 ] 2>/dev/null; then
  ok "MCP get_audit_logs：有审计记录（≥1 条）"
else
  bad "MCP get_audit_logs：无审计记录"
fi

# ---------- 8.11) get_usage ----------
GU=$(mcp_tool 17 get_usage)
GU_TEXT=$(echo "$GU" | mcp_text)
if echo "$GU_TEXT" | jq -e '.estimates_per_day' >/dev/null 2>&1; then
  ok "MCP get_usage：用量数据存在"
else
  bad "MCP get_usage 失败：$GU_TEXT"
fi

# ---------- 8.12) get_settings / update_settings ----------
GS=$(mcp_tool 18 get_settings)
GS_TEXT=$(echo "$GS" | mcp_text)
GS_NAME=$(jq -r '.site_name // ""' <<<"$GS_TEXT" 2>/dev/null || true)
if [ -n "$GS_TEXT" ] && [ "$GS_TEXT" != "null" ]; then
  ok "MCP get_settings：读取成功"
else
  bad "MCP get_settings 失败：$GS_TEXT"
fi

# update_settings 改 site_name 后验证并恢复
UPS=$(mcp_tool 19 update_settings '{"site_name":"E2E MCP Test"}')
UPS_TEXT=$(echo "$UPS" | mcp_text)
UPS_NAME=$(jq -r '.site_name // ""' <<<"$UPS_TEXT" 2>/dev/null || true)
if [ "$UPS_NAME" = "E2E MCP Test" ]; then
  ok "MCP update_settings：更新 site_name 成功"
  # 恢复原始值
  mcp_tool 20 update_settings "{\"site_name\":$(jq -R . <<<"$GS_NAME")}" >/dev/null 2>&1 || true
else
  bad "MCP update_settings 失败：$UPS_TEXT"
fi

# 清理由 trap 统一处理
exit 0
