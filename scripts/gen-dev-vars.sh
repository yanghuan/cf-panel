#!/usr/bin/env bash
# 本地开发环境变量生成：.dev.vars 不存在时自动创建（随机密钥），已存在则跳过不覆盖。
# 生产环境请勿使用本文件：生产密钥（JWT_SECRET/HASH_SECRET/PANEL_PASSWORD）应固定配置
# （dashboard secrets 或 wrangler secret put），随机生成后丢失将无法找回。
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
VARS="$DIR/.dev.vars"
if [ -f "$VARS" ]; then
  echo "[cf-panel] .dev.vars 已存在，跳过生成（如需重置请删除该文件后重试）"
  exit 0
fi
PASS="${PANEL_PASSWORD:-cf-panel-$(openssl rand -hex 4)}"
umask 077
cat > "$VARS" <<EOF
JWT_SECRET=$(openssl rand -hex 32)
HASH_SECRET=$(openssl rand -hex 32)
PANEL_PASSWORD=$PASS
EOF
echo "[cf-panel] 已生成 .dev.vars（登录密码：$PASS）"
echo "  JWT_SECRET / HASH_SECRET 随机生成；PANEL_PASSWORD 可编辑该文件修改"
