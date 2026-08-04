#!/usr/bin/env bash
# 生产 secrets 自动创建（幂等）：缺失的密钥自动生成并写入 Cloudflare Worker secrets，
# 创建后可在 Cloudflare 后台（Worker → Settings → Variables and Secrets）查看明文。
# 仅补缺失项：已存在的密钥绝不覆盖（JWT_SECRET 变更会令已登录 token 失效，
# HASH_SECRET 变更会令 agent key / PAT 哈希全部失效）。
# 前提环境变量：CLOUDFLARE_API_TOKEN（需 Workers Scripts: Edit 权限）、CLOUDFLARE_ACCOUNT_ID。
# 用法：CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy npm run secrets
set -euo pipefail
SCRIPT="${CF_PANEL_SCRIPT:-cf-panel}"
: "${CLOUDFLARE_API_TOKEN:?需要 CLOUDFLARE_API_TOKEN（Workers Scripts: Edit 权限）}"
: "${CLOUDFLARE_ACCOUNT_ID:?需要 CLOUDFLARE_ACCOUNT_ID}"

API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$SCRIPT/secrets"

# 已存在的 secret 名集合
existing=$(
  curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API" \
    | jq -r '.result[].name' 2>/dev/null || true
)

ensure() {
  local name=$1
  if echo "$existing" | grep -qx "$name"; then
    echo "[cf-panel] secret $name 已存在，跳过"
    return
  fi
  local v
  if [ "$name" = "PANEL_PASSWORD" ]; then
    v="${PANEL_PASSWORD:-cf-panel-$(openssl rand -hex 8)}"
  else
    v="$(openssl rand -hex 32)"
  fi
  local resp
  resp=$(curl -s -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'content-type: application/json' "$API" \
    -d "{\"name\":\"$name\",\"text\":\"$v\"}")
  if echo "$resp" | jq -e '.success' >/dev/null 2>&1; then
    echo "[cf-panel] secret $name 已创建（Cloudflare 后台 Variables and Secrets 可查看）"
    [ "$name" = "PANEL_PASSWORD" ] && echo "  → 面板登录密码：$v"
  else
    echo "[cf-panel] 创建 $name 失败：$(echo "$resp" | jq -r '.errors[0].message' 2>/dev/null)" >&2
  fi
}

ensure JWT_SECRET
ensure HASH_SECRET
ensure PANEL_PASSWORD
