# cf-panel Agent

被控机端 agent，与面板通过 WebSocket 通信（协议详见 `docs/architecture.md` §3.5）。

## 两种实现

| | **Rust 版（推荐）** `agent/rust/` | Shell 版（已废弃）`agent/shell/agent.sh` |
| --- | --- | --- |
| 内存 | 实测 ~1.9 MB（全静态）/ 1 进程 | 实测 ~11 MB / 3+ 进程 |
| 依赖 | 无外部二进制（全静态可选） | websocat + socat + jq + coreutils |
| 部署 | 单文件，任意 Linux 直跑 | 需逐个安装依赖工具 |
| 维护 | ✅ 活跃 | ⚠️ 不再演进 |

协议与可配置项完全一致，可无缝替换。

## Rust 版：构建

```bash
cd agent/rust
# 动态（依赖系统 glibc，主流发行版可用）
cargo build --release

# 全静态（推荐，任意 Linux 直跑，等同 Go 静态）：
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl
```

也可直接从 GitHub **Releases** 下载已构建的全静态二进制（由 CI 自动发布，仅 Rust 代码变更时触发）。

**构建时自动检查**（与 CI `agent-rust.yml` test job 完全一致，保证编译产物可过 CI）：

```bash
cd agent/rust
bash build.sh  # = check.sh（fmt/clippy/test 全检）+ cargo build --release，可透传参数如 --target x86_64-unknown-linux-musl
```

> 为什么不用 `cargo build` 直接挂检查：build.rs 内调 `cargo clippy`/`cargo test` 会因 target 目录锁死锁（cargo 硬限制），`[alias]` 重定向 `build` 又会波及 CI 自身的 `cargo build`——所以检查与编译的顺序执行放在包装器里。格式门禁（rustfmt --check）仍由 build.rs 在任意编译时自动执行。

**提交前自动检查**（git pre-commit hook，暂存区含 `agent/rust/**` 变更时自动跑 check.sh）：

```bash
git config core.hooksPath .githooks   # 仓库级配置（随仓库分发，克隆后各成员需执行一次）
```

单次手动检查：`bash check.sh`

## Rust 版：使用

```bash
AGENT_WSS_URL=wss://<面板域名>/ws/agent \
AGENT_KEY=<面板添加服务器时生成的 key> \
./cf-panel-agent
```

全部可配置环境变量及默认值：`./cf-panel-agent --help`

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_WSS_URL` | 必填 | 面板 agent WebSocket 地址 |
| `AGENT_KEY` | 必填 | agent 身份 + 凭证 |
| `REPORT_INTERVAL` | 120 | 默认上报间隔秒（有观看者时服务端动态下发 5s） |
| `DISABLE_EXEC` | 0 | =1 禁用终端/文件（仅保留监控） |
| `PROBES` | 空 | 服务探活 `name:http:URL,name:tcp:host:port,...` |
| `CUSTOM_METRICS` | 空 | 自定义指标 JSON `[{"name","cmd"}]` |
| `DISK_FSTYPE_INCLUDE` | 空 | 磁盘统计强制保留的 fstype（逗号分隔）。默认只统计真实磁盘分区（排除 tmpfs/overlay/squashfs/rootfs/drvfs/9p 等虚拟盘与 nfs/cifs/fuse.* 网络盘）；如需统计网络盘（如 rclone 挂载的 OneDrive）配置如 `fuse.rclone` |
| `AGENT_TMPDIR` | `/tmp/cfpanel-<key前8位>` | 临时目录 |
| `AGENT_LOG` | `/tmp/cfpanel-<key前8位>-agent.log` | 日志文件 |
| `AGENT_LOG_MAX` | 262144 | 日志轮转上限字节 |
| `ALLOW_SELF_UPDATE` | 0 | =1 允许管理员经面板更新 Agent；安装目录必须可写，默认关闭 |
| `AGENT_SELF_RESTART` | 0 | =1 在更新并清理会话后主动启动新版本；使用 systemd/launchd/服务包装器时保持 0 |

> 探活暂不支持 `https://`（http/tcp 支持）；wss 连接不受影响。

## 面板自更新

官方 Release 同时发布 `agent-manifest.json`（统一 build id、平台资产、大小与 SHA-256）。管理员登录后，只有满足以下条件的在线节点才显示「更新 Agent」按钮：

- Agent 支持 `update_protocol=1`；
- `ALLOW_SELF_UPDATE=1`；
- Release 有当前 OS/架构产物；
- 当前 build id 不是最新版本。

旧版 Agent 不会上报 `update_protocol`，需先手动替换一次为包含本功能的版本；此后的发布才会出现自动更新按钮。

更新包由 Worker 流式中转到控制 WebSocket（48KB 二进制帧，不整包占内存），Agent 在当前可执行文件同目录 staging，严格校验 offset/总大小/SHA-256，并执行候选文件 `--version` 复核 build id；通过后保留 `<当前文件>.bak`，再由 `self-replace` 跨平台替换。更新会关闭现有终端/文件会话。

更新成功后必须有重启方式（二选一）：

1. **推荐**：systemd/launchd/Windows 服务包装器托管，保持 `AGENT_SELF_RESTART=0`，由 supervisor 拉起；
2. 手工/计划任务运行且无 supervisor：设置 `AGENT_SELF_RESTART=1`，旧进程清理会话后主动启动新版本。

安全边界：更新接口仅 JWT 管理员可调用（PAT 即使有 `server:exec` 也拒绝）；Release 仓库默认固定为 `yanghuan/cf-panel`，Worker 按 manifest SHA-256、Agent 再独立校验。SHA-256 提供完整性，不等于离线发布签名；仓库/Release 凭证仍是供应链信任根。

更新失败时正式文件不会替换；已完成替换但新版本无法上线时，可停止服务后把同目录 `<agent文件名>.bak` 复制回正式文件并重启。当前版本保留人工回滚备份，尚未实现独立 watchdog 自动健康回滚。

### 本地自更新演练（不依赖 GitHub/Worker）

```bash
# 1. 准备两个不同 build id 的二进制：当前构建作为"新"，另构建一个旧的作为安装版本
cd agent/rust
cp target/release/cf-panel-agent /tmp/drill-new                      # 新候选
AGENT_BUILD_TS=2026.08.25-0900-drillold cargo build --release        # 旧版本
mkdir -p /tmp/drill && cp target/release/cf-panel-agent /tmp/drill/cf-panel-agent
chmod +x /tmp/drill/cf-panel-agent /tmp/drill-new

# 2. 一键演练：模拟面板下发 37 个分片 → 校验 → 替换 → 自启 → 重连 → 版本确认
node scripts/dev/agent-update-drill.mjs --new /tmp/drill-new --install /tmp/drill/cf-panel-agent
```

脚本内置最小 WebSocket 服务端模拟面板控制通道（`ALLOW_SELF_UPDATE=1`+`AGENT_SELF_RESTART=1` 自动注入），结束自动断言磁盘版本/`.bak`/自启重连并清理进程。单元级验证另有 `cargo test update`（状态机）与 `npm test`（DO 中转）。

## 以 systemd 运行

`cf-panel-agent.service` 为模板：把二进制放到 `/opt/cf-panel-agent/`，按模板注释配置 `/etc/cf-panel-agent.env` 后 `systemctl enable --now cf-panel-agent`。启用面板更新时在 env 文件增加 `ALLOW_SELF_UPDATE=1`，并确保服务用户对 `/opt/cf-panel-agent/` 有写权限；模板的 `Restart=always` 会自动拉起新版本，不要同时启用 `AGENT_SELF_RESTART=1`。

## Shell 版（废弃）

`agent/shell/agent.sh` 为旧实现，保留供参考/过渡：需安装 `websocat`（必装）+ `socat` + `jq`，配置同 Rust 版环境变量。推荐新部署一律使用 Rust 版。
