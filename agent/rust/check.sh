#!/usr/bin/env bash
# 本地 CI 检查：与 .github/workflows/agent-rust.yml test job 完全一致
# 提交前运行（bash check.sh），全部通过后再提交，保证 CI 不红。
# 依赖：rustup component add rustfmt clippy
set -euo pipefail
cd "$(dirname "$0")"

echo "== [1/3] cargo fmt --check =="
cargo fmt --check

echo "== [2/3] cargo clippy --all-targets -- -D warnings =="
cargo clippy --all-targets -- -D warnings

echo "== [3/3] cargo test =="
cargo test

echo ""
echo "check.sh：全部通过 ✔（格式 / 静态检查 / 单元测试）"
