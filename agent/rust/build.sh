#!/usr/bin/env bash
# 构建包装器：先跑 CI 检查（check.sh：fmt/clippy/test），全部通过后再编译。
# 用法：bash build.sh  （等价于 check.sh + cargo build --release）
# 可透传参数：bash build.sh --target x86_64-unknown-linux-musl
set -euo pipefail
cd "$(dirname "$0")"

echo "== 构建前检查（与 CI agent-rust.yml test job 一致）=="
bash check.sh

echo "== cargo build --release =="
cargo build --release "$@"

echo ""
echo "build.sh：检查 + 编译全部通过 ✔"
