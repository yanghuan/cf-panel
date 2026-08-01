# 在 Cloudflare 上实现带终端功能的监控面板 — 架构设计文档

> 版本：v0.1 ｜ 日期：2026-08-02
> 范围：用 Cloudflare Workers / Pages + Durable Objects 实现一个监控面板，并附带 Web 终端功能。
> 参考实现：哪吒探针（nezha / nezhahq）的终端模块，其"中转 + 外部 agent + PTY"思路被平移到 Cloudflare 模型。

---

## 1. 核心结论（先给结论）

**可行，但必须分层执行：**

| 能力 | 能否在 Cloudflare 上运行 | 承载组件 |
| --- | --- | --- |
| 面板前端（静态） | ✅ 可行 | Cloudflare Pages |
| 鉴权 / 路由 / 限流 | ✅ 可行 | Cloudflare Worker |
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
│  │ Pages (静态)  │     │  Worker (鉴权/路由)   │  │
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

把哪吒架构里的 **gRPC IOStream 换成出站 WebSocket** 即可；帧协议（magic + streamID 防串流、首字节 0/1 区分输入/resize）可直接复用。

---

## 3. 组件设计

### 3.1 前端（Cloudflare Pages）
- 托管静态资源（Vue/React/Svelte 均可），全球 CDN、零成本。
- 终端 UI 用成熟组件：`xterm.js` + `xterm-addon-fit`（自适应窗口大小）。
- 流程：点击"打开终端" → `POST /api/terminal {server_id}` 拿到 `session_id` → 用 `session_id` 建立 `WebSocket('/ws/terminal/{id}')` → `xterm` 把按键写入 WS、把收到的字节渲染出来。

### 3.2 鉴权 Worker
- 校验 JWT / PAT，校验当前用户对目标 `server_id` 是否有权限（参考哪吒 `server.HasPermission`）。
- 终端功能需要独立的权限 scope（哪吒用 `nezha:server:exec`），与"只读监控"分离。
- 做限流、审计入口。

### 3.3 Durable Object — WebSocket 中转核心
DO 是整个设计的心脏，对应哪吒 Dashboard 里那两个 `io.Copy` 的活儿：

- **会话注册表**：`streamId -> { creatorUserId, targetServerId, userSocket, agentSocket }`。
- **浏览器端 WS**：`/ws/terminal/{id}` —— 仅允许 `creatorUser` 或 `admin` 连接（**防劫持，见 §6**）。
- **agent 端 WS**：`/ws/agent/terminal?streamId=...` —— agent 作为 WebSocket client 主动连回，首帧发 magic 鉴权（见 §4）。
- **双向对拷**：当两端 socket 都就绪，互相转发字节：
  - 浏览器字节 → agent socket（用户输入）
  - agent 字节 → 浏览器 socket（终端输出）
- **WebSocket Hibernation API**：空闲连接不占 CPU，只在收到消息时唤醒，天然适配"长时间挂着的终端会话"。

> DO 是单实例、有并发上限；多终端会话可按 `streamId` 哈希到不同 DO，避免单点瓶颈。

### 3.4 外部 Agent
部署在每台目标机器上（复用哪吒 agent 思路，实现选型见 3.5）：

- 与 DO 之间维护一条**常驻出站 WebSocket**（用于接收"开终端"等控制指令）。
- 收到"开终端 {streamId}"指令后：
  1. 新建一个 WebSocket 连回 DO 的 `/ws/agent/terminal?streamId=...`；
  2. 首帧发送 **magic + streamId**（`0xff 0x05 0xff 0x05` + streamId）自报家门；
  3. `pty.Start(shell)` 起一个真实 PTY；
  4. 起两个协程：`producePTYOutput`（PTY 输出 → WS 发回 DO）、`receiveInput`（WS 收字节 → 写 PTY stdin）。

### 3.5 外部 Agent 实现选型（2026-08-02 确定：纯 Shell）

采用**纯 Shell 脚本**实现 agent，不依赖 Python / 编译型二进制，方便任意机器直接部署：

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
控制循环:  websocat -b $WSS/control ──> bash + jq 循环
             │  open_terminal {sid} → 拉起终端会话
             │  resize {sid,rows,cols} → stty -F /tmp/cfpanle-$sid
             ▼
终端会话:  websocat -b $WSS/terminal?sid=<id> ⇄ socat ⇄ /tmp/cfpanle-<sid> ⇄ bash (PTY)
```

**控制循环骨架（`agent.sh`）**

```bash
#!/usr/bin/env bash
set -euo pipefail
WSS=${AGENT_WSS_URL:?}; UUID=${AGENT_UUID:?}

spawn_terminal() {
  local sid=$1
  ( websocat -b "$WSS/terminal?sid=$sid" \
      --exec "socat - /tmp/cfpanle-$sid" ) &
}

while true; do
  websocat -b "$WSS/control" 2>/dev/null | while read -r line; do
    case "$(jq -r .type <<<"$line")" in
      open_terminal)
        sid=$(jq -r .stream_id <<<"$line")
        socat -d pty,link=/tmp/cfpanle-$sid,raw,echo=0 \
              EXEC:'bash -i',pty,stderr,setsid,sigint,sighup &
        spawn_terminal "$sid" ;;
      resize)
        sid=$(jq -r .stream_id <<<"$line")
        stty -F "/tmp/cfpanle-$sid" \
             rows "$(jq -r .rows <<<"$line")" cols "$(jq -r .cols <<<"$line")" ;;
    esac
  done
  sleep 3
done
```

**关键点**

- 开终端：`socat` 创建 pty slave（`link=/tmp/cfpanle-<sid>` 暴露路径）并挂 `bash -i`；`websocat -b --exec socat` 把 WS 字节流与 slave 对接，全双工。
- resize：控制 WS 收到 `{type:resize,...}` → `stty -F <slave路径>` 改 winsize → 内核发 `SIGWINCH`，`vim`/`top` 跟着变尺寸。
- 权衡：零解释器依赖、部署极简；并发能力弱于编译型 agent，适合个人/小规模；协议不变，后续可无缝迁移 Go/Rust agent。

### 3.6 PTY（伪终端）
- 用 `creack/pty`（Go）或等价的 PTY 库（其它语言）在 slave 端启动 shell，`TERM=xterm`。
- agent 持有 master 文件句柄：
  - 读 master = shell 的输出；
  - 写 master = 当作用户键盘输入发给 shell。
- 窗口 resize：前端 `fit` 事件 → 发 resize 帧 → agent 调 `pty.Setsize` → 内核更新 winsize → 给前台进程发 `SIGWINCH`，`vim`/`top` 等跟着变尺寸。

---

## 4. 通信协议（数据帧格式）

DO 与 agent 之间的 WebSocket 用二进制帧，结构对齐哪吒实现：

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
 │  (校验 creator/admin)    │                    │
 │                   等待 agent 连回...            │  WS /ws/agent/terminal?streamId=...
 │                         <────────────────────│  首帧: magic + streamId
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
   - 背景：哪吒曾有一个 GHSA 漏洞——任何人只要拿到 stream UUID（经 Referer 泄露、日志、浏览器历史），就能接管一个活跃终端、直接拿到目标机器的 shell。UUID 不可作为保密凭据。
2. **agent 侧 stream 归属校验**
   - DO 收到 agent 的 magic 帧后，校验该 `streamId` 确实属于这个 agent 对应的 `server`，防止 A 机器的 agent 往 B 机器的 stream 注入 IO。
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
| 监控时序（CPU / 内存 历史） | **D1 + 分钟级聚合** | D1 免费写入约 10 万行/天；量大再上外部 TSDB |

### 8.2 D1 初版 Schema（草稿）

```sql
-- 服务器（agent 上报身份的归属）
CREATE TABLE servers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid           TEXT    NOT NULL UNIQUE,   -- agent 身份标识
  name           TEXT    NOT NULL,
  user_id        INTEGER NOT NULL,          -- 归属用户
  hide_for_guest INTEGER NOT NULL DEFAULT 0,
  display_index  INTEGER NOT NULL DEFAULT 0,
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

-- 监控时序（分钟级聚合，控制写入量 ≈ 43 行/天/机器）
CREATE TABLE metrics_min (
  server_id INTEGER NOT NULL,
  ts        INTEGER NOT NULL,                -- unix 分钟戳
  cpu       REAL,
  mem_used  REAL,
  net_in    REAL,
  net_out   REAL,
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

**阶段 0 — 最小闭环（MVP）**
- [ ] Pages 部署前端 + `xterm.js` 终端 UI。
- [ ] DO 实现 `WebSocket Hibernation` 的双向对拷骨架。
- [ ] 一台机器上跑一个最简 agent：`pty.Start` + 单 WS 对拷。
- [ ] 浏览器 → DO → agent → PTY 跑通一个 `echo` / `ls`。

**阶段 1 — 鉴权与会话**
- [ ] Worker 鉴权 + 权限 scope（exec）。
- [ ] `POST /api/terminal` 生成 `streamId` 并下发指令给 agent。
- [ ] DO 会话注册表（owner / server / 双 socket）。

**阶段 2 — 安全加固**
- [ ] `/ws/terminal/{id}` 校验 creator/admin（防 UUID 劫持）。
- [ ] agent magic 帧 + stream 归属校验。
- [ ] 全局命令执行开关。
- [ ] resize 帧（窗口自适应）。
- [ ] 审计日志。

**阶段 3 — 生产化**
- [ ] 多终端会话按 streamId 分片到不同 DO。
- [ ] 心跳 / 超时回收（keepalive + `CloseStream`）。
- [ ] 断线重连、PTY 进程组清理（关终端不残留子进程）。
- [ ] 监控数据的采集与展示（对齐"面板"主业）。

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
