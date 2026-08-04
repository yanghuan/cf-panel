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
| `REPORT_INTERVAL` | 120 | 默认上报间隔秒（有观看者时服务端动态下发 3s） |
| `DISABLE_EXEC` | 0 | =1 禁用终端/文件（仅保留监控） |
| `PROBES` | 空 | 服务探活 `name:http:URL,name:tcp:host:port,...` |
| `CUSTOM_METRICS` | 空 | 自定义指标 JSON `[{"name","cmd"}]` |
| `AGENT_TMPDIR` | `/tmp/cfpanel-<key前8位>` | 临时目录 |
| `AGENT_LOG` | `/tmp/cfpanel-<key前8位>-agent.log` | 日志文件 |
| `AGENT_LOG_MAX` | 262144 | 日志轮转上限字节 |

> 探活暂不支持 `https://`（http/tcp 支持）；wss 连接不受影响。

## 以 systemd 运行

`cf-panel-agent.service` 为模板：把二进制放到 `/opt/cf-panel-agent/`，按模板注释配置 `/etc/cf-panel-agent.env` 后 `systemctl enable --now cf-panel-agent`。

## Shell 版（废弃）

`agent/shell/agent.sh` 为旧实现，保留供参考/过渡：需安装 `websocat`（必装）+ `socat` + `jq`，配置同 Rust 版环境变量。推荐新部署一律使用 Rust 版。
