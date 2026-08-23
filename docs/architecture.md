# 在 Cloudflare 上实现带终端与文件管理功能的监控面板 — 架构设计文档

> 版本：v0.1 ｜ 日期：2026-08-02
> 范围：用 Cloudflare Workers / Durable Objects 实现一个监控面板，并附带 Web 终端与文件管理功能。
> 参考实现：哪吒探针（nezha / nezhahq）的终端模块，其"中转 + 外部 agent + PTY"思路被平移到 Cloudflare 模型。

---

## 1. 核心结论（先给结论）

**可行，但必须分层执行：**

| 能力 | 能否在 Cloudflare 上运行 | 承载组件 |
| --- | --- | --- |
| 面板前端（静态） | ✅ 可行 | Worker 静态资源（`[assets]`，等价 Pages 能力） |
| 鉴权 / 路由 | ✅ 可行 | Cloudflare Worker |
| WebSocket 长连接中转、双向字节对拷 | ✅ 可行 | Durable Object（WebSocket Hibernation） |
| **终端执行端（fork 进程 / 开 PTY / exec）** | ❌ **不可行** | 必须在外部有 OS 的机器上（VPS / 本地） |

一句话：**Cloudflare 负责"面板 + 安全闸 + 流量中转"，agent + PTY 负责"真执行"，两者用 WebSocket 对接。**

原因：Cloudflare 边缘节点是 **V8 隔离沙箱，没有操作系统**，无法 `fork`/`exec`、无法创建 PTY（master/slave 设备不存在）、没有持久 shell。

---

## 2. 整体架构

```
┌─────────────┐
│   浏览器     │  面板前端（Vue/React 等）
│ Web Terminal │
└──────┬──────┘
       │  HTTPS + WebSocket  /ws/terminal/{id}
       ▼
┌──────────────────────────────────────────────┐
│              Cloudflare 边缘（无 OS）            │
│                                                │
│  ┌──────────────┐     ┌─────────────────────┐  │
│  │ Worker assets│     │  Worker (鉴权/路由)   │  │
│  │  (静态前端)    │     │                     │  │
│  └──────────────┘     └──────────┬──────────┘  │
│                                   ▼             │
│                         ┌─────────────────────┐ │
│                         │  Durable Object      │ │
│                         │  - 会话注册表         │ │
│                         │  - WS 双向对拷        │ │
│                         │  - WebSocket Hibern.  │ │
│                         └─────────┬──────────┘ │
└─────────────────────────────────┬──────────────┘
      出站 WebSocket（agent 主动连回）│  /ws/agent/terminal?streamId=...
                                     ▼
┌──────────────────────────────────────────────┐
│            你的机器（VPS / 本地，有 OS）          │
│   agent ── spawn ──> PTY (zsh / bash / sh)      │
│   (WebSocket client)      (creack/pty)          │
└──────────────────────────────────────────────┘
```

把哪吒架构里的 **gRPC IOStream 换成出站 WebSocket** 即可；帧协议（magic + streamID 防串流、首字节 0/1 区分输入/resize）可直接复用（实际实现采用简化协议：header 鉴权 + 纯字节透传，见 §4）。

---

## 3. 组件设计

### 3.1 前端（静态资源）
- 静态资源由 Worker 的 `[assets]` 提供（等价 Pages 能力：全球 CDN、零成本、零构建；本项目为原生 JS + 本地化 vendor 依赖，无构建步骤）。
- 终端 UI 用成熟组件：`xterm.js` + `xterm-addon-fit`（自适应窗口大小）。
- 流程：点击"打开终端" → `POST /api/terminal {server_id}` 拿到 `session_id` → 用 `session_id` 建立 `WebSocket('/ws/terminal/{id}')` → `xterm` 把按键写入 WS、把收到的字节渲染出来。

### 3.2 鉴权 Worker
- 校验 JWT / PAT，校验当前用户对目标 `server_id` 是否有权限（参考哪吒 `server.HasPermission`）。
- 终端功能需要独立的权限 scope（哪吒用 `nezha:server:exec`），与"只读监控"分离。
- 审计入口；**应用内置登录失败限流**（同一 IP 在 15 分钟窗口内失败 ≥5 次 → 锁定 15 分钟并返回 `429` + `Retry-After`，登录成功自动清零）；生产部署仍建议前置 **Cloudflare Access**（登录密码作为第二层），以覆盖跨边缘实例的限流一致性。

#### 3.2.1 MCP（AI 接入端点）

`/mcp` 实现标准 MCP **Streamable HTTP**（兼容协议版本 `2025-11-25`）：单一 POST 端点、无 `Mcp-Session-Id` 会话、每请求独立 `Authorization: Bearer` 鉴权（复用 JWT/PAT），采用**无状态简化实现**（与 2026-07-28 规范正式确立的无状态模型方向一致，但保留旧版 initialize 握手兼容 2025-11-25 客户端）。工具：
- **只读/操作**：`list_servers`（服务器状态 + 系统信息）、`get_monitor`（监控历史，复用内存热区/D1 归档查询与权限过滤）、`exec_command`（一次性 shell 命令执行，经 TerminalDO 控制通道直达 agent，`canExec` 鉴权：管理员或带 `server:exec` scope 的 PAT，超时 kill 进程组）、`create_upload`（签发一次性文件上传**签名 URL**——HMAC 无状态自验证，绑定 server_id/path/overwrite 并 10 分钟过期，AI 将 URL 转给用户/程序用 curl/fetch POST 原始字节上传，服务端流式分片写 agent；大文件/二进制不经过 LLM 上下文）。
- **管理类（仅管理员，JWT 登录；PAT 一律拒绝）**：`add_server`（注册新服务器 + 生成 agent key）、`update_server` / `delete_server`（改名/分组/排序 / 删除含历史清理）、`list_tokens` / `create_token` / `revoke_token`（PAT 生命周期，明文只返回一次）、`get_audit_logs`（审计日志）、`get_usage`（用量观测）、`get_settings` / `update_settings`（站点名/公告/IP 归属地开关/告警配置）。
JSON-RPC 2.0：`initialize` / `tools/list` / `tools/call` / `ping`；通知返回 202；校验 `Origin` 防 DNS rebinding。

#### 3.2.2 告警通知与多用户

- **Webhook 告警**：`handleReport` 每次上报后做阈值检查（CPU/内存/磁盘根分区/负载），同类告警带冷却去抖（内存 Map）；**离线/恢复告警**在 MetricsDO 的 alarm 中扫描 `servers.last_seen`，状态存 DO Storage（重启不重复告警）。触发时 **POST JSON**（结构化 `event/title/server/message/details/time`）到配置的 Webhook 地址，任意渠道（企业微信/钉钉/Telegram/邮件网关等）由用户侧对接。**告警配置存 D1 `settings.alerts`**（网页设置弹窗填写，`getAlertCfg` 带 60s 缓存读取，保存时清缓存即时生效），不使用环境变量。
- **多用户**：`PANEL_USERS="user:pass,user:pass"` 环境变量，登录匹配签发 JWT（`uid`+`username`）；未配置时回退 `PANEL_PASSWORD` 单管理员。所有用户同权限（管理员），按用户分配服务器可后续恢复 `users` 表逻辑。

### 3.3 Durable Object — WebSocket 中转核心
DO 是整个设计的心脏，对应哪吒 Dashboard 里那两个 `io.Copy` 的活儿：

- **会话注册表**：`streamId -> { creatorUserId, targetServerId, userSocket, agentSocket }`。
- **浏览器端 WS**：`/ws/terminal/{id}` —— 仅允许 `creatorUser` 或 `admin` 连接（**防劫持，见 §6**）。
- **agent 端 WS**：`/ws/agent/terminal?streamId=...` —— agent 作为 WebSocket client 主动连回，用 `X-Agent-Key` 请求头鉴权（见 §4）。
- **双向对拷**：当两端 socket 都就绪，互相转发字节：
  - 浏览器字节 → agent socket（用户输入）
  - agent 字节 → 浏览器 socket（终端输出）
- **WebSocket Hibernation API**：空闲连接不占 CPU，只在收到消息时唤醒，天然适配"长时间挂着的终端会话"。

> DO 是单实例、有并发上限；多终端会话可按 `streamId` 哈希到不同 DO，避免单点瓶颈。

#### 3.3.1 面板实时刷新（PanelDO）

服务器列表不需要用户手动刷新：前端登录后建一条 WebSocket 到 `/ws/push`，**首帧 `sync` 即订阅，此后被动接收上报驱动推送**，单实例 **PanelDO** 在服务器数据变化（新上报/在线状态变化）时唤醒查 D1，按该连接的用户权限（admin 全量 / PAT 白名单 / member 归属）过滤后回发服务器列表（在线状态由 `last_seen` 宽限期推导）。

- **Hibernation API + 事件驱动**：DO 空闲即休眠（不计时长），有数据变化才短暂唤醒回发——避免"服务端定时器"造成的实例常驻费用，开销趋近普通 Worker。
- 首帧验证 bearer 后，`serializeAttachment` 只保存安全身份：PAT 的不可逆 HMAC，或 JWT 已验证身份及过期时间；不保存原始 token。休眠唤醒后 PAT 按 hash 反查 D1，JWT 校验附件中的过期时间。
- 未鉴权连接须在 10 秒内发送 auth 首帧，超时由 DO alarm 关闭，并设置 128 条 pending 连接硬上限。
- 单实例 DO（`idFromName('main')`）；D1 临时故障时跳过该周期，下个周期自动恢复。

### 3.4 外部 Agent
部署在每台目标机器上（复用哪吒 agent 思路，实现选型见 3.5）：

- 与 DO 之间维护一条**常驻出站 WebSocket**（用于接收"开终端"等控制指令）。
- 收到"开终端 {streamId}"指令后：
  1. 新建一个 WebSocket 连回 DO 的 `/ws/agent/terminal?streamId=...`（`X-Agent-Key` 请求头鉴权）；
  2. 起一个真实 PTY（Rust 版 `portable-pty`，Shell 版 `socat`）；
  3. 起两个协程/线程：`producePTYOutput`（PTY 输出 → WS 发回 DO）、`receiveInput`（WS 收字节 → 写 PTY stdin）。

### 3.5 外部 Agent 实现选型

> **现状（2026-08）**：已完成 **Rust 版实现（`agent/rust/`，推荐）**，与协议完全对齐；初版 **Shell 版（`agent/shell/agent.sh`，已废弃）** 保留供参考/过渡。两者环境变量与协议一致，可无缝替换。

**初版（2026-08-02 确定）为纯 Shell**，不依赖 Python / 编译型二进制，方便任意机器直接部署：

**依赖清单**

| 工具 | 职责 | 备注 |
| --- | --- | --- |
| `websocat` | 全双工 WebSocket 客户端 | 唯一必装（单二进制，可静态编译） |
| `socat` | 创建 PTY 并暴露 slave 路径 | resize 能力的来源 |
| `jq` | 解析控制 WS 的 JSON 指令 | 一般发行版自带 |
| `bash` / `stty` | 主循环 / 改窗口尺寸 | 系统自带 |

**协议简化**：每个终端会话一条独立 WS，终端数据流**纯字节透传**（§4 的多路复用帧协议为可选增强，单会话场景不需要输入/输出帧头）；`magic + streamId` 帧仅用于建连时身份鉴别；resize 改由**控制 WS** 单独下发。

**进程拓扑**

```
后台上报:  collect_report() ──FIFO──> websocat(上行) ──> 面板 {type:"report",cpu,mem,...} 每 120s（默认；有观看者时服务端下发 5s）
                                      ▲
控制循环:  websocat -b $WSS/control   │ bash + jq 循环
             │  open_terminal {sid} → 拉起终端会话
             │  resize {sid,rows,cols} → stty -F /tmp/cfpanel-$sid
             ▼
终端会话:  websocat -b $WSS/terminal?sid=<id> ⇄ socat ⇄ /tmp/cfpanel-<sid> ⇄ bash (PTY)
```

> 监控上报复用控制通道 WS：websocat 的 stdin→WS 转发天然是"上行"，后台采集循环把 JSON 写入 FIFO 即完成上报，**无需 crontab / 独立脚本**；服务端在 TerminalDO 中识别 `{type:"report"}` 并写入监控热区。

**控制循环骨架（`agent.sh`）**

```bash
#!/usr/bin/env bash
set -euo pipefail
WSS=${AGENT_WSS_URL:?}; KEY=${AGENT_KEY:?}   # KEY 即唯一身份 + 凭证（uuid 已废弃）
TMP_DIR=/tmp/cfpanel-${KEY:0:8}; REPORT_INTERVAL=${REPORT_INTERVAL:-120}  # TMP_DIR 按 key 隔离，支持同机多 agent
mkdir -p "$TMP_DIR"; CTL_IN="$TMP_DIR/control-in"; rm -f "$CTL_IN"; mkfifo "$CTL_IN"

collect_report() {   # CPU/内存/网络采集 → JSON {type:"report",...}
  # ...（CPU 两次采样、/proc/meminfo、/proc/net/dev 累加）
  jq -nc '{type:"report", cpu:$cpu, mem_used:$mem, net_in:$rx, net_out:$tx}'
}
( exec 3<>"$CTL_IN"; while true; do sleep "$REPORT_INTERVAL"; collect_report >&3; done ) &

spawn_terminal() {
  local sid=$1 pty_pid=$2   # pty_pid = PTY 端 socat PID
  (
    websocat -b "$WSS/terminal?sid=$sid" -H "X-Agent-Key: $KEY" \
      --exec "socat - $TMP_DIR/$sid"
    # WS 断开（会话结束）→ 级联清理 PTY 进程组，防子进程残留
    local bash_pid; bash_pid=$(pgrep -P "$pty_pid" | head -1) || true
    [ -n "$bash_pid" ] && kill -- -"$bash_pid" 2>/dev/null || true
    kill "$pty_pid" 2>/dev/null || true
    rm -f "$TMP_DIR/$sid"
  ) &
}

while true; do
  websocat -b "$WSS/control" -H "X-Agent-Key: $KEY" < "$CTL_IN" 2>/dev/null | while read -r line; do
    case "$(jq -r .type <<<"$line")" in
      open_terminal)
        sid=$(jq -r .stream_id <<<"$line")
        socat -d pty,link=$TMP_DIR/$sid,raw,echo=0 \
              EXEC:'bash -i',pty,stderr,setsid,sigint,sighup &
        spawn_terminal "$sid" $! ;;
      resize)
        sid=$(jq -r .stream_id <<<"$line")
        stty -F "$TMP_DIR/$sid" \
             rows "$(jq -r .rows <<<"$line")" cols "$(jq -r .cols <<<"$line")" ;;
    esac
  done
  sleep 3
done
```

**关键点**

- 开终端：`socat` 创建 pty slave（`link=/tmp/cfpanel-<sid>` 暴露路径）并挂 `bash -i`；`websocat -b --exec socat` 把 WS 字节流与 slave 对接，全双工。
- **残留清理**：浏览器关闭终端 → DO 关 agent WS → websocat 退出 → 执行清理逻辑：按 PTY 端 socat 的 PID 找到 `bash -i`（setsid 会话首进程），`kill -- -<bash_pid>` 整组清理（bash + `vim`/`top` 等子进程），再杀 PTY socat、删 slave link——避免僵尸进程累计。
- resize：控制 WS 收到 `{type:resize,...}` → `stty -F <slave路径>` 改 winsize → 内核发 `SIGWINCH`，`vim`/`top` 跟着变尺寸。
- 监控上报：后台循环每 `REPORT_INTERVAL`（默认 120s）采集一次，JSON 写入 FIFO；控制通道 websocat 以 FIFO 为 stdin，数据自动经 WS 上行，服务端识别 `{type:"report"}` 落监控热区——**免 crontab、免独立脚本**。
- 上报内容：固定列（CPU/内存/网络速率）+ `extra` JSON（Swap/磁盘/负载/温度/进程数/TCP-UDP 连接数，紧凑短 key 不压缩）+ `info`（OS/内核/IP，服务端比对变化才更新 `servers.info_json`）。网络速率由 agent 对 `/proc/net/dev` 累计值做差分，避免累计值当速率。
- **省配额策略**：PanelDO 暴露 `/viewers` RPC（只统计 attachment 角色为 `viewer` 的已鉴权前端）；TerminalDO 在 agent 控制通道建立与每次上报后查询它，通过 `{type:"set_report_interval", interval}` 下发间隔（仅变化时）：有观看者 5s 快采、无人 120s 低频采样——配额从"时刻满采"降到"只在有人看时满采"。首位观看者上线时 PanelDO 还会向各分片广播 `/rpc/set_viewers`，agent 立即切快采（免等下一次上报）。agent 端把下发的间隔写入 `$TMP_DIR/report-interval`，上报循环每次唤醒后读取。
- **文件管理**：与终端同构的独立会话——面板 `POST /api/file/open` 创建会话并下发 `open_file` 指令，agent 连回 `/ws/agent/file` 处理（**Rust 版内置实现，无独立脚本**）。JSON 行协议：`list`（目录列表，支持通配符过滤）/`read`/`write`（**Binary 混合帧 = JSON 头 + `\n` + 原始字节，无 base64 膨胀**；分块 512KB、`write` 按确认推进、临时文件 + 原子 rename）+ `zip`（**目录打包**：agent 手写 STORED ZIP 到临时文件，返回路径/大小，前端分段拉取完成后发 `delete` 清理）/`rename`/`delete`。写、删、改名受系统路径保护；ZIP 属只读下载，仅拒绝打包文件系统根。所有文件系统预检/遍历/写入统一进入带超时、并发上限和熔断的 `file_blocking`。浏览器经 `/ws/file/{sid}` 透传；前端将列表条目视为不可信输入并白名单化类型/数值，`FileSession.open` 用代际守卫防乱序响应串台。服务端复用 TerminalDO 会话注册表/权限/清理，DO 只做双向透传。
- 权衡：Shell 版零解释器依赖、部署极简；但并发弱、进程多、每终端 +9MB。已实现 **Rust 版（`agent/rust/`）替代**：实测内存 1.9MB（全静态 musl）、单进程、无外部二进制依赖，协议一致可无缝替换；Shell 版废弃保留参考。

#### 3.5.1 内存占用对比（低内存设备选型）

agent 可能运行在低内存设备（OpenWrt 路由器 / 树莓派 Zero 等），实现语言的内存占用是关键选型依据。

**实测（Shell 现状，2026-08）**：

| 状态 | 内存（RSS） | 进程数 |
| --- | --- | --- |
| 空闲（无终端/文件会话） | **~11 MB**（bash 主循环 3.8 + 上报子 shell 3.2 + websocat 控制通道 4.3） | 3 |
| 每开 1 个终端会话 | **+8~9 MB**（pty socat + 数据端 socat + 终端 websocat + 包裹子 shell + sh） | +5~6 |
| 3 个终端同时 | ~28~36 MB | 20+ |

**四方案对比（Shell/Go/Rust 为实测，Python 为估算）**：

| 维度 | Shell（实测） | Go（实测） | Rust（实测） | Python（估算） |
| --- | --- | --- | --- | --- |
| 空闲内存 | ~11 MB / 3 进程 | **~5.7 MB** / 1 进程 | **~3.6 MB** / 1 进程 | 15~25 MB / 1 进程 |
| 每终端增量 | +8~9 MB / +5~6 进程 | +1~2 MB | +0.5~1.5 MB | +1~3 MB |
| 二进制 | websocat 7MB + socat + jq + bash + coreutils | ~4.9 MB（实测，静态 `-s -w`） | ~1.4 MB（实测，动态 glibc） | 解释器 +20MB+ |
| 启动 | 快 | 快 | 最快 | 慢（100~400ms） |
| 低端 CPU（mips/arm） | 各工具需有对应架构包 | 原生编译（一条命令交叉） | 原生编译（需配 target+linker） | 解释器性能差 |
| 进程模型 | 多进程（fork 重） | goroutine | async task | asyncio |
| 部署 | 脚本 + 3 个外部二进制 | 单文件 | 单文件 | 解释器 + pip 依赖 |

> 实测说明（2026-08，本机）：
> - **Go**：最小 WS agent（gorilla/websocket，读泵+心跳+上报 goroutine，连本地 `ws://`）warmup 后 RSS ≈ **5.7 MB**（VSZ 1200 MB 为预留虚拟空间，不占实存）；二进制 4.9 MB（静态）。
> - **Rust**：同结构最小 agent（tokio + tokio-tungstenite）RSS ≈ **3.6 MB**，二进制 1.4 MB（动态链接 glibc；静态 musl 版约 2~5 MB，RSS 相近）。无 GC → 内存曲线最平、无 GC 尖峰。
> - 生产用 `wss://` 时 TLS 各 +0.5~2 MB；完整 agent（PTY/文件/多会话）Go/Rust 仍显著低于 Shell 的多进程峰值。

**低内存设备适用性**：

| 设备内存 | Shell | Go | Rust | Python |
| --- | --- | --- | --- | --- |
| 64MB（老路由器） | ⚠️ 空闲 11MB 尚可，多终端脆弱 | ✅ 空闲 5.7MB | ✅ 空闲 3.6MB | ❌ 解释器基线太重 |
| 128MB（树莓派 Zero） | ✅ 合适 | ✅ | ✅ | ⚠️ 勉强 |
| 256MB+ | ✅ 合适（部署零编译） | ✅ | ✅ | ✅ |

**结论**：
- **内存角度 Rust 最省**（实测 3.6 MB < Go 5.7 MB < Shell 11 MB），且无 GC → 无内存尖峰；但开发成本最高（借用检查/async 样板/交叉编译配置）。
- **综合性价比 Go 最优**：内存仅比 Rust 多 ~2 MB（同处几 MB 级），但开发效率、交叉编译（一条命令）、生态成熟度全面占优。
- 多终端场景 Shell 因"每终端 +9MB + 进程爆炸"在 64MB 设备上最脆弱；Go/Rust 单进程是"低内存 + 常开多终端"的正解。
- **保留 Shell 的真正理由不是内存，而是运维/部署**：零编译、脚本即改即用、无需任何工具链、对已有机器直接跑（`apt install socat jq` + 下载 websocat）。
- 决策建议：**Rust 版已实现（`agent/rust/`）为推荐默认**（内存最省、全静态单文件、任意发行版直跑）；Shell 版废弃。若团队 Rust 维护成本高且设备内存 ≥256MB，可用 Go 重写（协议不变，见 §3.5 权衡）。

#### 3.5.2 跨平台实现（2026-08-20，Windows/macOS 支持）

Rust 版以 `#[cfg(unix)]` / `#[cfg(windows)]` 条件编译实现三平台（平台代码互不编译、零运行时分派成本），公共原语收口于 `platform.rs`：

| 原语 | Unix（Linux/macOS） | Windows |
| --- | --- | --- |
| 进程树终止 | 进程组（spawn 时 setsid，`kill(-pgid)`） | **Job Object**（手写 kernel32 FFI：挂入 + `KILL_ON_JOB_CLOSE` 兜底 agent 崩溃整树清理；`detach_job` 正常退出回收；JOBS 上限清理按 `QueryInformationJobObject` ActiveProcesses 只关无存活 job） |
| exec / 自定义指标 shell | `sh -c` | `cmd /C` |
| 终端交互 shell | `$SHELL` → `/bin/bash` → `/bin/sh` | `powershell.exe` → `cmd.exe` |
| 终端 PTY | portable-pty（Unix pty） | **ConPTY**（portable-pty 内置） |
| 临时目录/日志 | `/tmp` | `%TEMP%` |
| 信号 | SIGTERM/SIGINT | `tokio::signal::ctrl_c`（Ctrl+C/Break） |

**系统指标按平台双实现**（`metrics/` 目录，同签名函数集，`collect_report` 零平台分支）：
- `metrics/linux.rs`：原生 `/proc`、`/sys` 读取（与 Shell 版同口径，零额外依赖）；CPU/内存/负载/温度/TCP-UDP 连接数/磁盘(statvfs+挂载过滤)/网络差分/磁盘 IO 差分全量。单挂载点 metadata/statvfs 失败仅跳过该项；全空刷新保留最近一次非空缓存。
- `metrics/other.rs`（Windows/macOS 共用）：**sysinfo crate**（目标特定依赖，不进 Linux 依赖树）；CPU/内存/磁盘/网络为真实数据，`load_average`（macOS 有 / Windows 无→0）、温度（Windows 多数驱动不暴露→None）。
- 自定义指标命令受 5 秒总超时约束，stdout 仅保留前 4KB 并继续排空管道；超时终止完整进程树，避免刷屏输出放大 Agent 内存。
- **平台缺失项（如实上报空值，服务端白名单丢弃）**：磁盘 IO 差分与 TCP-UDP 连接数无跨平台 API（Windows/macOS 均为空）；macOS 系统信息 IP 为空（卡片展示走服务端 `wan_ip` 不受影响）。

**路径模型**（文件管理协议从 Unix 绝对路径扩展）：
- Unix：`/` 分隔 + FHS 系统目录黑名单（`/etc` `/usr` `/var` 等，fail closed）。
- Windows：盘符路径（`C:\...`，统一大写盘符 + `\` 分隔，大小写不敏感），驱动器根一级目录黑名单（`Windows` / `Program Files` / `ProgramData` / `$Recycle.Bin` 等，任意盘符生效）；`C:\Users` 放行（等同 `/home`）；UNC、保留字符、ADS、尾随点/空格及 `CON`/`NUL`/`COM1`/`LPT1` 等设备名均 fail closed；`canonicalize` 的 `\\?\` verbatim 前缀剥离（真实路径层防 symlink/junction 写穿）。
- 前端 `utils.js` 的 `fileJoin` / `fileParent` / `fileBase` / `isSystemPath` 与 agent 端同步支持盘符路径（黑名单逐条对账）。

**CI 与产物**：workflow 四 job 流水线（test → build-macos/build-windows → build-release），Release 提供 5 个产物（Linux x86_64 + UPX 压缩版 + aarch64、macOS ARM64、Windows x86_64）。Windows job 先跑 `cargo test`（真机验证：路径模型、NTFS 真实文件系统操作、Job Object FFI 生命周期）。

> **跨平台验证边界（如实标注）**：`cargo check --all-targets` 三平台全绿 + Windows CI 真机测试；macOS 指标（sysinfo 数值/温度）与 ConPTY 交互体验建议发布后真机冒烟。

### 3.6 PTY（伪终端）
- 用 `creack/pty`（Go）或等价的 PTY 库（其它语言）在 slave 端启动 shell，`TERM=xterm`。
- agent 持有 master 文件句柄：
  - 读 master = shell 的输出；
  - 写 master = 当作用户键盘输入发给 shell。
- 窗口 resize：前端 `fit` 事件 → 发 resize 帧 → agent 调 `pty.Setsize` → 内核更新 winsize → 给前台进程发 `SIGWINCH`，`vim`/`top` 等跟着变尺寸。

---

## 4. 通信协议（数据帧格式）

> **实际实现（2026-08，Rust 版）**：采用下述简化协议，以下"magic 帧/多路复用"为初版设计参考（对齐哪吒），当前未使用。
> - **鉴权**：agent 数据流（`/ws/agent/terminal|file`）用 `X-Agent-Key` 请求头（key 指纹 + 哈希校验）；浏览器流（`/ws/terminal|file`）用**首帧** `{type:"auth", token}`（token 不进 URL，防日志/历史泄露）。
> - **控制通道**（agent 常驻 WS，JSON 文本帧）：`open_terminal` / `open_file` / `resize {stream_id,rows,cols}` / `set_report_interval {interval}` / `ping`（心跳）；agent 回执 `terminal_ready` / `file_ready` 停止 DO 的确认重发。
> - **终端数据流**：纯字节透传（输入/输出无帧头，单向直转）；resize 走控制通道（非数据流帧）。
> - **心跳保活**：控制通道 `ping` + DO 侧 30s 限频心跳下行，防健康连接被误判半开。

DO 与 agent 之间的 WebSocket 用二进制帧，结构对齐哪吒实现（初版设计）：

| 帧类型 | 首字节 | 含义 | 处理 |
| --- | --- | --- | --- |
| 建连鉴权帧 | `0xff 0x05 0xff 0x05` + streamId | agent 建流首帧 | DO 校验 magic + stream 归属，登记 agent socket |
| 输入/输出帧 | `0x00` + 数据 | 普通 PTY 字节 | 首字节后的原样字节写入 PTY stdin / 渲染到浏览器 |
| resize 帧 | `0x01` + JSON `{cols,rows}` | 窗口大小变更 | agent 调 `pty.Setsize` |
| keepalive 帧 | 空 payload | 30s 一次保活 | 维持连接活性，忽略 |

> 简单场景：每终端一个独立 WebSocket，magic 仅用于首帧身份鉴别。
> 进阶场景（单 WS 多路复用）：用 `magic + streamId` 作为每路 stream 的路由键，在一条连接上复用多个终端会话（哪吒即此思路）。

---

## 5. 会话生命周期（时序）

```
前端                Worker/DO                  agent(外部机器)
 │  POST /api/terminal {server_id}               │
 │───────────────────>│                          │
 │                   生成 streamId                │
 │                   登记会话(owner, server)      │
 │                   下发"开终端"指令 ────────────>│  (经 agent 常驻 WS)
 │<── CreateTerminalResponse {session_id} ──────│
 │                                                │
 │  WS /ws/terminal/{id}  ──>│                    │
 │  (首帧 {type:"auth"} 鉴权 │                    │
 │   校验 creator/admin)     │                    │
 │                   等待 agent 连回...            │  WS /ws/agent/terminal?streamId=...
 │                         <────────────────────│  请求头 X-Agent-Key 鉴权
 │                   校验归属, 登记 agent socket   │
 │                   两端就绪 → 双向对拷 ──────────│<──>│<──> PTY
 │<═══════ 按键/输出 实时双向流转 ════════════════>│<──>│<──> PTY
 │                                                │
 │  退出/关闭 → CloseStream，回收会话              │
```

---

## 6. 安全要点（重点，务必实现）

1. **WebSocket 连接者校验（防劫持）**
   - `/ws/terminal/{id}` 只允许会话**创建者或 admin** 连接。
   - 鉴权 token **不放 URL**（避免进访问日志/浏览器历史），改为连接后**首帧发送** `{type:"auth", token}`，未通过前不挂接数据流。
   - 背景：哪吒曾有一个 GHSA 漏洞——任何人只要拿到 stream UUID（经 Referer 泄露、日志、浏览器历史），就能接管一个活跃终端、直接拿到目标机器的 shell。UUID 不可作为保密凭据。
2. **agent 侧 stream 归属校验**
   - DO 收到 agent 数据流（`X-Agent-Key` 请求头）后，先按 key 指纹/哈希校验 agent 身份，再校验该 `streamId` 确实属于这个 agent 对应的 `server`，防止 A 机器的 agent 往 B 机器的 stream 注入 IO。
3. **鉴权与最小权限**
   - 终端需要独立 scope（`exec`），与只读监控分离；PAT 按 `server_ids` 白名单收窄。
4. **全局命令执行开关**
   - agent 侧提供 `disableCommandExecute` 总开关（哪吒同款），可一键禁用所有命令执行。
5. **审计日志**
   - 记录谁、在何时、对哪台机器开了终端；敏感操作建议留痕。

---

## 7. Cloudflare 能力边界与约束

| 能力 / 约束 | 说明 |
| --- | --- |
| 无 OS | 不能 `exec` / 开 PTY，执行端必须在外部机器 |
| HTTP/2 / gRPC | Worker 对 gRPC 支持不友好，建议直接用 WebSocket |
| 出站连接 | Worker/DO **允许出站 WebSocket**，agent 主动连回没问题 |
| CPU 时间 | 普通请求有 CPU time 上限；用 **WebSocket Hibernation** 走事件驱动，不累积 CPU |
| Durable Object | 单实例、有并发/存储上限；多会话按 streamId 分片到不同 DO |
| 数据驻留 | shell 流量全经 Cloudflare，敏感命令的隐私需评估 |
| Cloudflare Containers（实验） | 可在 CF 上跑真实 Linux 容器（能 fork + PTY），理论上把执行端也搬上 CF；但偏早期，对"管理多台自己机器"的面板，agent 模式更自然 |

---

## 8. 存储选型（2026-08-02 确定）

### 8.1 结论

| 数据分类 | 存储方案 | 理由 |
| --- | --- | --- |
| 面板核心数据（server / 用户 / PAT / 审计） | **D1 (SQLite)** | 关系查询、内置备份与时间点恢复、免费额度足够 |
| 终端会话状态（streamId / 双 WS / resize） | **DO Storage（或 DO 内存）** | 瞬态、就近存放、断开即清，不入主库 |
| 公开配置（站点设置 / 公告） | **D1 `kv_json` 表** | 2026-08-02 由 Workers KV 改为 D1 键值表（key/value，value 存 JSON），少一个依赖 |
| 监控时序（CPU / 内存 历史） | **内存 DO 热区 + D1 归档（默认开启）** | 内存滚动窗口（720 分钟/机，秒回）+ alarm 批量归档 D1（默认开启，`ARCHIVE_TO_D1=0` 关闭），保留 30 天、每日清理 |

### 8.2 D1 初版 Schema（草稿）

> ⚠️ 以下为初版设计草稿，**实际建表以 `schema.sql` / `migrations/` 为准**（版本化管理，部署自动 apply）。与草稿的关键差异：`users` 表已移除（多用户改由环境变量 `PANEL_USERS`/`PANEL_PASSWORD` 配置，登录即管理员）；`servers` 新增 `group`（分组）、`agent_key_hash`（HMAC 密钥哈希）、`wan_ip`（出口 IP）、`probe_json`（服务探活结果）；`audit_logs` 新增 `username`/`client_ip`；`metrics_min` 新增 `mem_total`；另有自定义指标表 `metrics_custom`。

```sql
-- 服务器（agent 上报身份的归属）
CREATE TABLE servers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_key_id   TEXT    NOT NULL UNIQUE,   -- agent key 指纹（SHA-256(key)），唯一身份标识
  name           TEXT    NOT NULL,
  user_id        INTEGER NOT NULL,          -- 归属用户
  hide_for_guest INTEGER NOT NULL DEFAULT 0,
  display_index  INTEGER NOT NULL DEFAULT 0,
  last_seen      INTEGER,                   -- unix 秒，最近上报时间（在线判定唯一依据）
  info_json      TEXT,                      -- 系统信息 JSON（OS/内核/IP，变更时才更新）
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 用户
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,            -- bcrypt / argon2
  role          INTEGER NOT NULL DEFAULT 0,  -- 0=member 1=admin
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- API Token（PAT，只存哈希）
CREATE TABLE api_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  token_hash TEXT    NOT NULL,
  scopes     TEXT    NOT NULL,               -- JSON 数组，如 ["server:read","server:exec"]
  server_ids TEXT,                           -- NULL=全部，否则 JSON 白名单
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 审计日志
CREATE TABLE audit_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL,
  action           TEXT    NOT NULL,         -- terminal.open / server.update ...
  target_server_id INTEGER,
  detail           TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 监控时序（分钟级聚合：1 行/分钟/机器；默认归档开启，保留 30 天）
CREATE TABLE metrics_min (
  server_id INTEGER NOT NULL,
  ts        INTEGER NOT NULL,                -- unix 分钟戳
  cpu       REAL,
  mem_used  REAL,
  net_in    REAL,                            -- 网络速率（字节/秒，agent 差分）
  net_out   REAL,
  extra     TEXT,                            -- 扩展监控项 JSON（swap/disk/load/temp/procs/tcp/udp，紧凑不压缩）
  PRIMARY KEY (server_id, ts)
) WITHOUT ROWID;

CREATE INDEX idx_metrics_min_ts ON metrics_min(ts);

-- 通用键值表（2026-08-02 起替代 Workers KV，value 直接存 JSON）
CREATE TABLE kv_json (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                -- JSON 字符串
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 8.3 设计要点

- 密码与 PAT 一律**只存哈希**（token 本体只在创建时返回一次，对齐哪吒）。
- PAT 支持 `scopes` + `server_ids` 白名单，实现最小权限（终端需 `server:exec`）。
- 监控数据分钟级聚合：30 台机器 ≈ 1,300 行/天，远低于 D1 免费写入配额；机器多了再评估外部时序库（Timescale / ClickHouse）或 KV 滚动窗口。

---

## 9. 实现清单（分阶段）

> 状态：全部完成（2026-08 复查）；各能力对应实现见 §3–§8 对应章节。

**阶段 0 — 最小闭环（MVP）**
- [x] Pages 部署前端 + `xterm.js` 终端 UI。
- [x] DO 实现 `WebSocket Hibernation` 的双向对拷骨架。
- [x] 一台机器上跑一个最简 agent：`pty.Start` + 单 WS 对拷。
- [x] 浏览器 → DO → agent → PTY 跑通一个 `echo` / `ls`。

**阶段 1 — 鉴权与会话**
- [x] Worker 鉴权 + 权限 scope（exec）。
- [x] `POST /api/terminal` 生成 `streamId` 并下发指令给 agent。
- [x] DO 会话注册表（owner / server / 双 socket）。

**阶段 2 — 安全加固**
- [x] `/ws/terminal/{id}` 校验 creator/admin（防 UUID 劫持）。
- [x] agent 身份（`X-Agent-Key` header）+ stream 归属校验。
- [x] 全局命令执行开关。
- [x] resize 帧（窗口自适应）。
- [x] 审计日志。

**阶段 3 — 生产化**
- [x] 多终端会话按 streamId 分片到不同 DO。
- [x] 心跳 / 超时回收（keepalive + `CloseStream`）。
- [x] 断线重连、PTY 进程组清理（关终端不残留子进程）。
- [x] 监控数据的采集与展示（对齐"面板"主业）。

---

## 10. 参考（哪吒源码关键文件）

| 仓库 | 文件 | 作用 |
| --- | --- | --- |
| nezhahq/nezha | `cmd/dashboard/controller/terminal.go` | `createTerminal` / `terminalStream` |
| nezhahq/nezha | `service/rpc/io_stream_rpc.go` | gRPC IOStream 服务端 |
| nezhahq/nezha | `service/rpc/io_stream.go` | `startStreamContext` 双向 `io.Copy` |
| nezhahq/nezha | `service/rpc/io_stream_registry.go` | `UserConnected` / `agentConnected` 注入 |
| nezhahq/agent | `cmd/agent/terminal_session.go` | `terminalHandler.run` / `producePTYOutput` / `receiveInput` / `terminalAttachFrame` |
| nezhahq/agent | `pkg/pty/pty.go` | `pty.Start` 起 zsh/bash/xterm |

> 平移到 Cloudflare 时：`service/rpc/*`（Go 中转）⇒ Durable Object（WS 中转）；`cmd/agent/*`（Go agent）⇒ 你的外部 agent（语言任选）；gRPC ⇒ WebSocket。
