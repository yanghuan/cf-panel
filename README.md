# cf-panel

在 Cloudflare 上运行的服务器监控面板，自带 Web 终端与文件管理。

| 层 | 技术 |
| --- | --- |
| 前端 | 原生 JS + xterm.js + Monaco（**零构建**，由 Worker `[assets]` 托管） |
| 后端 | Cloudflare Workers + Durable Objects（WebSocket 双向中转）+ D1 |
| Agent | Rust 单进程（全静态二进制，Linux / macOS / Windows 直跑） |

> 架构设计、技术选型与取舍见 [docs/architecture.md](docs/architecture.md)；历次代码审查记录见 [docs/reviews/](docs/reviews/)。

> **快速跳转**：[快速开始](#快速开始) · [配置参考](#配置参考) · [使用指南](#使用指南) · [API 一览](#api-一览) · [容量与配额](#容量与配额) · [安全设计](#安全设计) · [架构要点](#架构要点) · [目录结构](#目录结构)

---

## 特性

**监控**
CPU / 内存 / Swap / 磁盘 / 磁盘 IO（速率 + util）/ IOPS / 网络上下行 / TCP·UDP 连接数 / 进程数 / 负载 / 温度 / 系统信息；服务探活（HTTP/TCP）；自定义指标（任意命令采集）；按天账（流量累计、可用率、重启次数）。

**运维**
Web 终端（多标签、可切渲染器）；文件管理（浏览 / 上传 / 下载 / 在线编辑 / 权限 / 递归搜索 / 目录打包）；Agent 自更新；Agent Key 轮换；批量改分组 / 批量删除。

**告警**
Webhook 模板化（GET/POST、任意渠道、占位符拼接）；CPU / 内存 / 磁盘 / 负载阈值 + 离线 / 恢复 + 探活异常；逐机阈值覆盖；全局免打扰时段。

**接入**
REST API + PAT（scopes + 服务器白名单 + 有效期）；[MCP](https://modelcontextprotocol.io) 端点供 AI 客户端调用。

**工程**
零构建前端；中英文双语（可扩展语言包）；PWA；深浅主题；WebSocket Hibernation（空闲不计费）；按观看者动态调节上报频率省配额。

---

## 快速开始

### 1. 创建 D1 数据库

Dashboard → **Workers & Pages → D1 → Create database**，名称 `cf-panel`；把 Overview 页的 `database_id` 填入 `wrangler.toml` 的 `[[d1_databases]]`。

> 数据库实例必须在平台手动创建一次（无法脚本化）；**建表与后续迁移全部自动完成**，无需手动执行 SQL。

### 2. 部署 Worker

**方式 A：网页端（推荐，无需本地 CLI）**

1. Workers & Pages → **Create application → Import a repository**，授权 GitHub 并选择本仓库。项目名必须与 `wrangler.toml` 的 `name = "cf-panel"` 完全一致，根目录 `/`，Save and Deploy。
2. 在该 Worker → **Builds → Build configuration → Deploy command** 填 `npm run deploy`。
   > `npm run deploy` = `wrangler d1 migrations apply cf-panel --remote && wrangler deploy`，此后每次 `git push` 自动「迁移建表 + 部署」。

**方式 B：CLI（备选）**

```bash
wrangler d1 create cf-panel                                   # 把 database_id 填入 wrangler.toml
wrangler d1 migrations apply cf-panel --remote                # 建表 / 迁移（幂等）
wrangler secret put JWT_SECRET                                # 见下一步的密钥说明
wrangler secret put HASH_SECRET
wrangler secret put PANEL_USERS                               # 或 PANEL_PASSWORD
wrangler deploy
```

### 3. 配置密钥

在 Worker → **Settings → Variables and Secrets** 添加（或 CLI `wrangler secret put <NAME>`）：

| 变量 | 必填 | 作用 |
| --- | --- | --- |
| `JWT_SECRET` | ✅ | JWT 签名密钥（`openssl rand -hex 32`）；泄露可伪造任意用户登录 |
| `PANEL_USERS` | ✅ 二选一 | 多用户：`alice:pass1,bob:pass2`（逗号分隔用户，用户名不含 `:`/`,`；密码按第一个冒号分割） |
| `PANEL_PASSWORD` | ✅ 二选一 | 单管理员密码（未配置 `PANEL_USERS` 时生效） |
| `HASH_SECRET` | 推荐 | agent key / PAT 的 HMAC 哈希密钥，与 `JWT_SECRET` 职责隔离；未配置时回退 `JWT_SECRET` |

- 所有用户**登录即管理员**（同权限）。
- `JWT_SECRET` 未配置时，登录与全部受保护接口返回 `503`（无默认密钥，fail closed）。
- ⚠️ **`HASH_SECRET` 首次配置或切换是有损操作**：已存 agent key 与 PAT 哈希全部失效，需删除服务器后重新添加、重建 PAT。建议新部署第一天就配上。
- ⚠️ Worker 一旦配置过 Dashboard secret，`wrangler deploy` 会被拒绝，只能走 Builds/CI 部署——即方式 A 是配密钥后的唯一部署路径。
- 修改 `JWT_SECRET` 会使所有已登录 token 失效（需重新登录）。

### 4. 添加服务器并安装 Agent

面板点「添加服务器」→ 填名称 → 弹出**一次性** agent 配置（WSS 地址 + KEY），妥善保存（KEY 是 agent 的唯一身份凭证）。

```bash
mkdir -p /opt/cf-panel-agent
# 从 GitHub Releases 下载 cf-panel-agent，或本地构建：cd agent/rust && cargo build --release
chmod +x /opt/cf-panel-agent/cf-panel-agent

cat > /etc/cf-panel-agent.env <<'EOF'
AGENT_WSS_URL=wss://<面板域名>/ws/agent
AGENT_KEY=<你的 key>
DISABLE_EXEC=0          # 设为 1 全局禁止命令执行（保留监控，禁用终端/文件/exec）
ALLOW_SELF_UPDATE=1     # 可选：允许从面板一键更新（需 supervisor 或 AGENT_SELF_RESTART=1）
EOF

cp agent/cf-panel-agent.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now cf-panel-agent
journalctl -u cf-panel-agent -f    # 查看日志
```

全部可配置环境变量见 `cf-panel-agent --help`。

<details>
<summary><b>macOS / Windows 部署</b>（点击展开）</summary>

**macOS（Apple Silicon）**

```bash
chmod +x cf-panel-agent-macos
AGENT_WSS_URL=wss://<面板域名>/ws/agent AGENT_KEY=<你的 key> ./cf-panel-agent-macos
```

开机自启用 launchd（`~/Library/LaunchAgents/com.cfpanel.agent.plist`），关键字段：

```xml
<key>ProgramArguments</key><array><string>/path/to/cf-panel-agent-macos</string></array>
<key>EnvironmentVariables</key><dict>
  <key>AGENT_WSS_URL</key><string>wss://<面板域名>/ws/agent</string>
  <key>AGENT_KEY</key><string><你的 key></string>
  <key>ALLOW_SELF_UPDATE</key><string>1</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
```

**Windows（x86_64，Windows 10+）**

```powershell
$env:AGENT_WSS_URL = "wss://<面板域名>/ws/agent"
$env:AGENT_KEY     = "<你的 key>"
$env:ALLOW_SELF_UPDATE  = "1"
$env:AGENT_SELF_RESTART = "1"   # 无服务包装器时，更新后自启新版本
.\cf-panel-agent-windows.exe
```

- 该 exe 是控制台程序，**不能**用 `sc.exe create` 注册为原生服务（会报 1053）；用 WinSW / NSSM 包装，或用任务计划程序随系统启动。
- 使用 WinSW/NSSM 自动重启时把 `AGENT_SELF_RESTART` 设为 `0`，避免重复拉起。
- 终端走 ConPTY（PowerShell），exec / 自定义指标走 `cmd /C`；文件路径为盘符形式，`C:\Users` 可写，`C:\Windows`、`Program Files`、`ProgramData` 等受保护。

**平台能力矩阵**

| 能力 | Linux | macOS | Windows |
| --- | --- | --- | --- |
| 终端 PTY | ✅ | ✅ | ✅（ConPTY） |
| exec / 自定义指标 | `sh -c` | `sh -c` | `cmd /C` |
| 文件管理 | ✅ | ✅ | ✅（盘符路径，系统目录受保护） |
| CPU / 内存 / 磁盘 / 网络 | ✅ | ✅ | ✅ |
| 磁盘 IO / TCP·UDP 连接数 | ✅ | 空 | 空 |
| 进程树清理 | 进程组 | 进程组 | Job Object |

</details>

### 5. 本地开发

```bash
npm run dev        # predev 自动生成 .dev.vars 随机密钥，本地 SQLite 自动应用 migrations
npm test           # 单元 + API + DO 测试
npm run test:e2e   # 端到端（需 wrangler dev + release agent）
```

> 本地无 Cloudflare 注入的 `CF-Connecting-IP` 时，登录限流统一落入 `unknown` 桶（同一实例多人调试共享失败计数）——这是拒绝信任可伪造 `X-Forwarded-For` 的安全取舍。
> ⚠️ 生产密钥不要用本地随机值：随机生成后丢失无法找回，请固定用 Dashboard secrets 或 `wrangler secret put`。

---

## 配置参考

### Agent 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_WSS_URL` | — | 面板地址，`wss://<面板域名>/ws/agent`（必填） |
| `AGENT_KEY` | — | 面板「添加服务器」生成的一次性 key（必填） |
| `DISABLE_EXEC` | `0` | `1` = 全局禁止命令执行（终端不可用，仅保留监控） |
| `ALLOW_SELF_UPDATE` | `0` | `1` = 允许管理员从面板更新 agent |
| `AGENT_SELF_RESTART` | `0` | `1` = 更新后由旧进程拉起新版本（无 supervisor 时用） |
| `REPORT_INTERVAL` | `120` | 无人观看时的上报间隔（秒）；有观看者时服务端动态下发 5s |
| `PROBES` | — | 服务探活：`名称:类型:目标,...`，类型 `http`（URL，检查 2xx/3xx）或 `tcp`（`host:port`） |
| `CUSTOM_METRICS` | — | 自定义指标 JSON 数组：`[{"name":"cpu_temp","cmd":"cat /sys/class/thermal/thermal_zone0/temp"}]`（命令 5s 超时，stdout 保留前 4KB，非数值自动跳过） |
| `PROBE_INTERVAL` | `15` | 探活采集间隔（秒，钳制 5~3600） |
| `CUSTOM_INTERVAL` | `60` | 自定义指标采集间隔（秒，钳制 5~3600） |
| `DISK_FSTYPE_INCLUDE` | — | 强制计入统计的文件系统类型（逗号分隔），如 `fuse.rclone` |
| `ALLOW_INSECURE_WS` | `0` | `1` = 允许 `ws://` 明文连接（仅本地调试用） |
| `AGENT_TMPDIR` / `AGENT_LOG` / `AGENT_LOG_MAX` | 平台默认 | 临时目录 / 日志文件 / 日志轮转上限 |

### 面板变量（可选，非密钥）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ARCHIVE_TO_D1` | 开启 | `0` = 关闭监控归档（热区保留窗口自动回退到 720 分钟） |
| `METRICS_RETENTION_DAYS` | `30` | `metrics_min` 历史保留天数 |
| `METRICS_DOWNSAMPLE_MIN` | `5` | 降采样粒度（分钟），同时控制写入桶 / 保留点 / 查询步长（设 `1` 回退逐分钟） |
| `METRICS_FINE_DAYS` | `7` | 细粒度窗口天数，超出后仅保留降采样点 |
| `METRICS_DAY_RETENTION_DAYS` | `1095` | 按天账（`metrics_day`）保留天数（约 3 年） |
| `STATS_TZ_OFFSET_MINUTES` | `0`（UTC） | 按天账的时区偏移，UTC+8 填 `480` |
| `AGENT_RELEASE_REPO` | `yanghuan/cf-panel` | Agent 自更新的 Release 仓库（Fork 部署必改） |
| `AGENT_MANIFEST_URL` | — | 指定清单镜像；资产 URL 仍须匹配 `AGENT_RELEASE_REPO` 的 Release |

> `STATS_TZ_OFFSET_MINUTES` 只影响**之后新产生**的天账日期归属；查询与展示统一按**当前**偏移换算，因此中途切换会让历史日期显示整体平移。请在开始记录前确定并避免更改。

---

## 使用指南

### 监控

- **概览与卡片**：顶部概览显示服务器总数 / 在线数 / 平均 CPU / 负载 / 总内存；卡片实时显示各项指标与系统信息，经 `/ws/push` 由上报驱动推送（前端不轮询）。
- **监控曲线**：卡片菜单「监控」默认近 12 小时（读 DO 内存热区，秒回）；可切 1 小时 / 3 天 / 7 天 / 30 天（读 D1，超长区间自动降采样）。共 10 类图：CPU、内存+Swap、负载、磁盘、磁盘 IO（双轴）、IOPS、网络、连接数、进程数、自定义指标。弹窗打开时随推送实时更新末点。
- **服务探活**：配置 `PROBES` 后卡片显示状态徽章（绿=正常 / 红=异常，悬停看 HTTP 码）；持续异常触发 Webhook（`probe_down` / `probe_recovered`）。
- **省配额策略**：有人查看面板时 agent 约 5 秒上报一次，无人时降到 120 秒——由服务端根据观看者数量动态下发间隔。

### 流量与可用率（按天账）

卡片菜单「流量/可用率」按天查看入站 / 出站流量、可用率与重启次数（7 天 / 30 天 / 90 天 / 1 年）。

数据源是独立的 `metrics_day` 表（1 行/机/天，默认保留 3 年），**为什么不复用分钟表**：

- `metrics_min` 只留 30 天、7 天后降采样到 1/5 采样点，跨不了月；
- 更关键的是**离线期间没有行**，而可用率要的正是"离线时长"，事后从稀疏采样点反推不出来。

因此按天账由上报链路实时累加，MetricsDO alarm 每 10 分钟落库（实例 evict 最多丢一个周期 ≤10 分钟的增量，已入账数据不受影响）。

- **可用率** = 在线分钟 ÷ 纳入统计分钟，回答"这台机器多少比例的时间够得着"（网络视角）。
- **重启次数**来自 `uptime` 下降沿检测。
- 与卡片上的"开机 N 天"（机器视角的连续性）互补：每天定时重启的机器可用率仍可能 99.9%，从不重启的机器也可能断过网。

### 告警

登录面板 → 设置 → 「告警」区填写即生效（存 D1，**不需要环境变量**）。

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| 方法 | `POST` | `GET` 或 `POST` |
| Webhook 地址 | — | 留空禁用；支持占位符 |
| Token | — | 仅作为占位符 `{token}`，放哪由你拼 |
| Body 模板 | 留空 | POST 请求体；留空发默认结构化 JSON |
| Content-Type | `application/json` | Body 的类型 |
| Headers | — | 追加请求头 JSON，值支持占位符 |
| CPU / 内存 / 磁盘阈值 | `90` | 百分比阈值 |
| 负载阈值 | 不启用 | `load1` 阈值 |
| 冷却 | `30` 分钟 | 同类告警冷却间隔 |
| 离线判定 | `180` 秒 | 超过该时长未上报即离线 |
| 免打扰截止 | — | 到期前暂停全部告警，到期自动恢复（计划内重启 / 割接前用） |

**占位符**：`{event}` `{title}` `{message}` `{server_name}` `{server_id}` `{details_json}` `{time}` `{token}`

**常见渠道示例**

| 渠道 | 方法 | 地址 | Body |
| --- | --- | --- | --- |
| Server酱 | GET | `https://sctapi.ftqq.com/{token}.send?title={title}&desp={message}` | — |
| 钉钉机器人 | POST | `https://oapi.dingtalk.com/robot/send?access_token={token}` | `{"msgtype":"text","text":{"content":"{message}"}}` |
| 企业微信机器人 | POST | `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={token}` | `{"msgtype":"text","text":{"content":"{message}"}}` |
| Telegram | POST | `https://api.telegram.org/bot{token}/sendMessage` | `{"chat_id":"你的ID","text":"{message}"}` |
| Bark | GET | `https://api.day.app/{token}/{title}/{message}` | — |
| Slack | POST | 默认 | 留空 Body，Headers 填 `{"Authorization":"Bearer {token}"}` |

Payload 结构（`event` 区分 `alert` / `offline` / `recovered`）：

```json
{
  "event": "alert",
  "title": "[cf-panel] my-server 指标告警",
  "server": { "id": 1, "name": "my-server" },
  "message": "服务器 my-server 指标超阈值：\nCPU 92.3% >= 90%",
  "details": ["CPU 92.3% >= 90%"],
  "time": "2026-08-02T08:00:00.000Z"
}
```

**逐机阈值覆盖**：异构机器上全局阈值必然顾此失彼（16 核机器 CPU 90% 是真告警，1 核小机可能日常就在 80%）。服务器「修改」弹窗可逐机覆盖 `cpu_pct` / `mem_pct` / `disk_pct` / `load` / `offline_after_s`——未填写的维度继承全局，全部留空等于不覆盖；`load` 填 `0` 表示关闭该机器的负载告警。改动最多 60 秒生效。

> 刻意**不支持**逐机覆盖 Webhook 渠道与冷却时间：渠道是全局通知基础设施、冷却是防刷保护，逐机化会让告警状态（冷却水位、离线状态机）按机器分裂。

Webhook 出站安全：仅允许 HTTP(S)，拒绝 URL 内嵌凭据、本地域名、私网/保留 IP 字面量与重定向；失败日志不记录完整 URL（避免 query 中的 `{token}` 泄露）。

### 终端

卡片点「终端」→ xterm.js 弹窗 → 按键实时到达被控机 shell；窗口拉伸自动 resize；断线自动重连（最多 3 次）。

- **多标签**：可同时连接多台机器并来回切换，切换只做显隐（滚动缓冲区与 PTY 连接都保留）；同一服务器再次点「终端」会切到已有标签，同机多终端用标题栏「＋」。
- **渲染器可切**：WebGL（高吞吐）/ DOM（兼容），偏好持久化，WebGL 会自动回退 DOM。
- **上限**：前端最多 8 个标签（受浏览器每页 WebGL 上下文数约 8~16 个约束，达到上限时新标签留在 DOM 而不静默丢 GPU 渲染），后端每服务器并发上限 8 个会话。

### 文件管理

卡片点「文件」→ 文件管理器。

- **浏览**：点击进入 / 上级 / 路径跳转；列表显示每项的权限（`rwxr-xr-x (0755)`）。
- **上传**：支持一次选多个、或直接拖到弹窗；逐个串行并显示进度。**单文件默认上限 100MB**（`UPLOAD_MAX_MB` 可调，受 agent 端 500MB 硬上限约束）。
- **下载**：目录自动打包 ZIP（文件名 `目录名.zip`）。
- **搜索**：**过滤**只看当前目录（`*`/`?` 通配符，agent 端先过滤再截断）；**递归搜索**下钻子目录（如 `*.log`，带深度 / 结果数 / 扫描条目三重上限）。递归搜索按**文件名**匹配，不支持内容搜索。
- **行操作（⋯ 菜单）**：下载 / 重命名（仅改名）/ 移动 / 复制（目录递归拷贝，拒绝复制到自身子目录）/ 权限 / 编辑 / 删除（目录递归）。
- **权限**：Unix 支持 POSIX 九宫格与八进制双向联动；**Windows 无 POSIX mode**，填八进制会被拒绝，只能用「只读」开关。
- **在线编辑**：Monaco 懒加载（失败回退 textarea），30+ 语言高亮、`Ctrl/Cmd+S` 保存、全屏、Markdown 预览（marked + DOMPurify，本地 vendor）。上限 1MB，二进制文件双重检测拒绝打开。

> 系统目录（`/proc`、`/sys`、`/etc`、`/usr`、`/var`、`/root` 等；Windows 为 `Windows`、`Program Files` 等）拒绝写操作，ZIP 属只读下载。

### Agent 自更新

管理员登录时读取 GitHub Release 的 `agent-manifest.json`（5 分钟缓存）。节点上报 `update_protocol=1` 且配置 `ALLOW_SELF_UPDATE=1` 时，卡片菜单出现「更新 Agent」：

二进制经 Worker → TerminalDO → 控制 WS 流式中转，Agent 校验大小 / SHA-256 / 候选 `--version`，保留 `.bak` 后用 `self-replace` 原子替换，由 supervisor 或 `AGENT_SELF_RESTART=1` 拉起。

- PAT **不允许**触发更新（仅 JWT 管理员），操作写审计日志。
- Fork 部署请设 `AGENT_RELEASE_REPO=owner/repo`。
- 不支持该协议的旧 Agent 需先手动升级一次。

### 轮换 Agent Key

卡片菜单「轮换 Key」：旧 key 立即失效并断开现有连接，**监控历史（含按天账）与审计记录全部保留**——这是 key 泄露或误发后的正确处置路径（此前只能删服务器重建，会清空全部历史）。

轮换后需人工到目标机更新 `AGENT_KEY` 并重启 agent（key 是 agent 侧静态凭据，服务端无法推送给未连接的 agent）。

### 搜索与批量操作

工具栏搜索框按名称 / IP / 分组即时过滤（纯前端，零请求）。勾选卡片后出现批量操作栏：**批量更新 Agent**（逐台串行，可见每台进度）、**批量修改分组**、**批量删除**（均仅管理员）。批量接口返回逐项结果，部分失败不会让整体变成 500。

### PAT 与 MCP

- **PAT**：设置 → 「访问令牌」创建（scopes + 服务器白名单 + 可选有效期，留空=永久），供 API 调用：`Authorization: Bearer cfp_xxx`。列表显示每个令牌的**最近使用时间**（60 秒节流回写），便于识别僵尸令牌。
- **MCP**：`/mcp` 端点供 AI 客户端接入，见下方 [MCP 工具](#mcp-工具)。

### 界面与其他

- **主题**：顶栏 ☀️/🌙 切换深浅主题（持久化，终端配色与图表同步热更新）。
- **IdleGuard**：长时间无操作会提示并自动暂停推送（省配额），任何操作即恢复。
- **IP 归属地**：开启后卡片与审计日志显示旗帜（第三方地理服务查询，默认关闭；旗帜渲染能力运行时检测，不支持时回退图片）。
- **PWA**：支持「添加到主屏幕」（manifest + SVG 图标，未接入 Service Worker——离线缓存会与实时推送的时效性冲突）。
- **国际化**：界面文案全部走 `t(key)`，语言包在 `public/lang/<语言代码>.js`（内置 `zh-CN`、`en-US`）。☰ 菜单底部可切换语言，即时生效并持久化；未手动选择时跟随浏览器语言。
  > 新增语言 = 加一个 `public/lang/xx.js` + 在 `index.html` 加一行 `<script>`（零构建下无法扫描目录，显式引入是刻意取舍），业务代码零改动。缺失的 key 会**原样显示 key 本身**，开发期一眼看出未翻译项，线上也不会出现界面空白。

### 审计日志

右上角菜单「审计日志」：支持按动作 / 用户 / 服务器筛选、分页与 CSV 导出，D1 保留 90 天。

覆盖范围：**登录与鉴权**（`login.success` / `login.failed` / `login.locked` / `auth.failed`——记来源 IP 与归一化路径，**不记密码**）、**服务器**（增删改、轮换 key、批量改分组）、**终端 / 文件会话**、**文件写操作**、**执行命令**、**Agent 更新**。

> 失败类审计按 IP 做 60 秒节流：否则爆破与无效 token 扫描会让审计表本身变成写放大源；节流后仍保留"谁在试、试什么"的量级信息。

---

## API 一览

### REST

**认证与公开**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 密码登录，返回 JWT |
| GET | `/api/me` | 当前用户（JWT 或 PAT） |
| GET | `/api/public/settings` | 公开配置（站点名 / 公告，无需登录） |
| GET | `/api/healthz` | 存活探针：不鉴权、不查 D1，仅返回 `{ok,ts}` |

**服务器管理**（写操作仅管理员）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/servers` | 服务器列表（含分组、序号，按权限过滤） |
| POST | `/api/servers` | 添加服务器，返回一次性 agent 配置 |
| PATCH | `/api/servers/:id` | 改名称 / 分组 / 序号 / 告警阈值覆盖（`alert_override` 传 `null` 清除） |
| POST | `/api/servers/:id/rotate-key` | 轮换 agent key（旧 key 立即失效并断连，历史保留） |
| POST | `/api/servers/:id/agent-update` | 流式更新 Agent（需节点 `ALLOW_SELF_UPDATE=1`） |
| POST | `/api/servers/batch` | 批量操作：`op=update-group`（单事务）或 `delete`（逐台级联），`ids` 上限 100 |
| DELETE | `/api/servers/:id` | 删除服务器（含历史清理与断连） |
| GET | `/api/agent/latest` | 最新 Agent Release 清单摘要（5 分钟缓存） |

**监控与统计**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/monitor?server_id=&range=` | 监控历史（`1h`/`12h`/`3d`/`7d`/`30d`，默认 12h 走内存热区） |
| GET | `/api/stats?server_id=&days=` | 按天统计（流量 / 可用率 / 重启），`days` 默认 30、上限 1095 |
| GET | `/api/usage` | 用量观测（近 24h 上报帧 / DO 事件 / D1 写行估算） |

**会话**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/terminal` | 创建终端会话（exec 权限 + 归属校验），返回 `session_id` |
| POST | `/api/file/open` | 创建文件管理会话，返回 `session_id` |
| GET | `/ws/terminal/{id}` | 浏览器终端 WebSocket（校验创建者 / admin） |
| GET | `/ws/file/{id}` | 浏览器文件 WebSocket（JSON 行协议：`list`/`read`/`write`/`zip`/`rename`/`delete`/`mkdir`/`touch`/`move`/`copy`/`chmod`/`find`） |
| GET | `/ws/push` | 面板实时刷新（首帧 sync 后由上报驱动推送） |
| GET | `/ws/agent/control` | agent 控制通道（key 校验 + 分片路由，监控上报也走这里） |
| GET | `/ws/agent/terminal` \| `/ws/agent/file` | agent 数据流（key 校验 + stream 归属校验） |

**令牌 / 设置 / 审计**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / POST | `/api/tokens` | PAT 列表（含 `last_used_at`）/ 创建（明文只返回一次） |
| DELETE | `/api/tokens/:id` | 删除 PAT |
| GET / PUT | `/api/settings` | 读取 / 更新站点名、公告、IP 归属地开关、告警配置 |
| POST | `/api/settings/test_webhook` | 测试 Webhook（传当前表单配置，不保存） |
| GET | `/api/audit-logs` | 审计日志（`?limit=&offset=&action=&user=&server_id=`，`?format=csv` 导出） |
| GET / PUT | `/api/group-order` | 分组显示顺序（读：所有用户；写：仅管理员） |

### MCP 工具

`/mcp` 实现标准 [Model Context Protocol](https://modelcontextprotocol.io) **Streamable HTTP**（兼容协议版本 `2025-11-25`）：单 POST 端点、无会话、每请求独立鉴权（复用 JWT / PAT）。

| 工具 | 说明 |
| --- | --- |
| `list_servers` | 服务器列表 + 实时状态 + 系统信息 |
| `get_monitor` | 监控历史（`range`：1h/12h/3d/7d/30d） |
| `exec_command` | 执行一次性 shell 命令（`timeout` 1~25s，stdout 上限约 44KB）；**写操作**，需 exec 权限，超时 kill 进程组 |
| `create_upload` | 签发一次性上传**签名 URL**（HMAC 绑定 server/path/overwrite，10 分钟过期，无需 Bearer）——大文件 / 二进制不经 LLM 上下文 |
| `add_server` / `update_server` / `delete_server` | 服务器增删改（仅管理员） |
| `rotate_agent_key` | 轮换 agent key（仅管理员，历史保留） |
| `list_tokens` / `create_token` / `revoke_token` | PAT 生命周期（仅管理员，明文只返回一次） |
| `get_audit_logs` / `get_usage` | 审计日志 / 用量观测（仅管理员） |
| `get_settings` / `update_settings` | 面板设置（含全局免打扰 `mute_until`） |

**客户端配置**（如 Claude Desktop）：

```json
{
  "mcpServers": {
    "cf-panel": {
      "type": "http",
      "url": "https://<面板域名>/mcp",
      "headers": { "Authorization": "Bearer <JWT 或 PAT>" }
    }
  }
}
```

**命令行冒烟测试**：

```bash
curl -X POST https://<面板域名>/mcp -H "Authorization: Bearer <token>" \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

curl -X POST https://<面板域名>/mcp -H "Authorization: Bearer <token>" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_servers","arguments":{}}}'
```

> 客户端若带 `MCP-Protocol-Version` 头，需与 body `_meta` 中版本一致；缺失时服务端按 `2025-03-26` 兼容。
> `/mcp/file_upload?server_id=&path=&overwrite=` 为流式上传端点（body = 原始字节），位于 `/mcp` 前缀下以绕过 CF Access 拦截，供 curl 直传。

---

## 容量与配额

- **D1 存储**：`metrics_min` 约 `1,440 行/机/天`（保留 30 天 → 约 `43,200×S` 行，S = 服务器数）；`metrics_custom` 再乘每机指标数 `C`（约 `43,200×S×C`）。按天账 `metrics_day` 仅 `1 行/机/天`（3 年约 `1,095×S` 行，约 100B/行 → 100 台约 11MB，可忽略）。
  > 5GB 免费档建议 `S×C ≤ 约 100`（默认 30 天保留）；缩短 `METRICS_RETENTION_DAYS` 可线性降低占用。
- **自定义指标**建议每机 ≤20 个（面板弹窗内亦有容量提示）。
- **日志额度**：`wrangler.toml` 开启了 `invocation_logs`（每次调用一条日志）。快采 5s 意味着每机每天约 **17,280** 次上报帧调用，免费档日志额度约在 **10 台规模触顶**——规模化时建议关闭 `invocation_logs`（仅影响日志，不影响功能）。
- **用量观测**：管理员访问 `GET /api/usage` 查看近 24h 上报帧 / DO 事件 / D1 写行估算。

---

## 安全设计

- **WebSocket 鉴权**：`/ws/terminal/{id}` 仅允许会话创建者或管理员连接（防 stream UUID 劫持）；浏览器 WS 建连后须 10 秒内完成首帧鉴权，超时由 DO alarm 关闭，待鉴权连接硬上限 128 条/实例。
- **Agent 身份**：`X-Agent-Key` 请求头（**不接受 URL query**，避免边缘日志泄露）；服务端先用 key 的 SHA-256 指纹（`servers.agent_key_id`）反查服务器，再用 HMAC verify 校验 `servers.agent_key_hash`；数据流额外校验 stream 归属。
- **凭据存储**：面板密码存 CF secret；agent key 与 PAT 只存哈希。WebSocket Hibernation 附件不保存 bearer 明文（PAT 仅存 HMAC，JWT 仅存已验证身份与过期时间）。
- **权限收敛**：JWT 管理员全量；PAT 按 scopes + `server_ids` 白名单收窄；Agent 更新与全部管理操作拒绝 PAT。
- **审计**：登录、服务器变更、会话开启、文件写操作、命令执行、Agent 更新全部留痕（best-effort：D1 短暂失败不影响已创建的会话，避免遗留不可访问的远端会话）。
- **前端防御**：文件列表按不可信 Agent 输入处理（白名单化类型、数值化大小/时间）；文件会话用代际守卫丢弃关闭后或乱序响应；CSP 仅 `style-src-attr`/`style-src-elem` 放开内联，`script-src` 不允许内联执行。
- **Agent 侧**：`DISABLE_EXEC=1` 全局禁用命令执行；上传、ZIP 预检与文件操作统一走带超时 / 并发上限 / 熔断的 blocking 边界；系统路径词法 + 真实路径双检（防 symlink 写穿）。
- **登录防护**：应用内置失败限流（同 IP 15 分钟内失败 ≥5 次 → 锁定 15 分钟，返回 `429` + `Retry-After`）。
  > ⚠️ 生产部署**必须**再前置 **Cloudflare Access**（密码作为第二层），以覆盖跨边缘实例的限流一致性。Access 需为**非浏览器会话路径**放行：`/ws/agent/*`（agent 连接）与 `/mcp*`（MCP 客户端与 curl 上传），否则会被 SSO 拦掉。

---

## 架构要点

- **多 DO 分片**：终端 DO `SHARDS = 4`，streamId 带 `shard-序号` 前缀，按前缀路由，避免单点瓶颈。
- **PanelDO**：单实例，前端 `/ws/push` 首帧 sync 即订阅，此后由上报驱动推送；使用 Hibernation API，空闲即休眠（不计时长），按权限过滤后广播。
- **会话回收**：终端会话两端断开超过 10 分钟由 alarm 清理；活跃会话另有 4 小时绝对上限。
- **MetricsDO 热区与归档**：上报先写 DO Storage 热区（默认保留最近 **240 分钟/机**，查询秒回）；常态归档由上报路径增量完成，alarm 每 10 分钟兜底把超过 1 小时的旧数据批量写入 `metrics_min`，并按 30 天保留期清理。`ARCHIVE_TO_D1=0` 关闭归档时热区回退 **720 分钟**（此时热区是唯一存储）。
- **按天账**：独立于归档开关，见上文[流量与可用率](#流量与可用率按天账)。

### 已知限制

- 终端 DO 会话状态在内存：僵尸会话按 10 分钟 TTL 回收，实例迁移会中断活跃终端。
- 关闭 D1 归档（`ARCHIVE_TO_D1=0`）后，DO 重启会丢失 12 小时外的历史。
- 终端多标签受并发上限约束：前端 8 个标签，后端每服务器 8 个会话。
- 递归搜索按文件名匹配，结果上限 1000 条、扫描上限 5 万条目，超限时结果不完整（会明确提示）。
- 温度指标展示在卡片 tooltip，监控图表未单独出图。
- 流量与可用率是按天聚合的账，精度受上报间隔限制（无人观看时 120 秒），单次故障检测延迟最多约 3 分钟——不适用于 99.99% 级 SLA 承诺。
- 多用户经 `PANEL_USERS` 配置，所有用户同权限（管理员）；如需按用户分配服务器归属，可恢复 `users` 表逻辑。
- Shell 版 agent（`agent/shell/`）已废弃，仅作参考；推荐 Rust 版。

---

## 目录结构

```
cf-panel/
├── wrangler.toml          # Worker / DO / D1 / 静态资源配置
├── schema.sql             # D1 表结构（migrations/ 为版本化增量，部署自动 apply）
├── migrations/            # D1 迁移（按序幂等执行）
├── src/                   # Worker 后端
│   ├── index.js           #   入口：路由分发 + WebSocket 接入
│   ├── routes.js          #   REST / MCP 路由
│   ├── auth.js            #   鉴权（JWT / PAT / agent key / 登录限流）
│   ├── config.js          #   环境变量与常量
│   ├── db.js              #   D1 查询
│   ├── do-terminal.js     #   TerminalDO：WS 双端对拷 + 会话注册表
│   ├── do-metrics.js      #   MetricsDO：监控热区 + 归档 + 告警 + 按天账
│   ├── do-panel.js        #   PanelDO：实时推送
│   ├── report.js          #   agent 上报处理
│   └── utils.js           #   公共工具
├── public/                # 前端（零构建）
│   ├── index.html / app.js / api.js / utils.js / i18n.js / style.css
│   ├── lang/              #   语言包（zh-CN / en-US）
│   └── vendor/            #   本地化依赖（xterm / Chart.js / marked / DOMPurify 等）
├── agent/                 # 被控机 agent
│   ├── rust/              #   ✅ Rust 版（推荐）
│   ├── shell/             #   ⚠️ Shell 版（已废弃，保留参考）
│   └── cf-panel-agent.service
├── test/                  # 测试（unit / api / do）
├── scripts/               # e2e 测试、开发辅助脚本
└── docs/                  # architecture.md + reviews/（历次审查记录）
```

---

## 升级旧版数据库

<details>
<summary><b>历史版本（无 migrations 记录）的增量对齐命令</b>（点击展开）</summary>

以下仅适用于**在 migrations 机制之前手动建表**的老库；已用 `migrations/` 的库无需任何手动操作（`apply` 幂等）。

**曾手动执行过 `ALTER TABLE metrics_min ADD COLUMN mem_total REAL;`**（无迁移记录）——直接 `apply` 会因 `0002` 重复加列失败，先手动标记：

```bash
wrangler d1 execute cf-panel --remote --command "INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_add_mem_total.sql');"
```

**缺 `"group"` 列 / `kv_json` 表**：

```bash
wrangler d1 execute cf-panel --remote --command 'ALTER TABLE servers ADD COLUMN "group" TEXT NOT NULL DEFAULT "";'
wrangler d1 execute cf-panel --remote --command 'CREATE TABLE IF NOT EXISTS kv_json (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime("now")));'
```

**缺 `metrics_min.mem_total` 列**：

```bash
wrangler d1 execute cf-panel --remote --command 'ALTER TABLE metrics_min ADD COLUMN mem_total REAL;'
```

**缺 `info_json` / `probe_json` / `metrics_min.extra` / `metrics_custom` 表**：

```bash
wrangler d1 execute cf-panel --remote --command 'ALTER TABLE servers ADD COLUMN info_json TEXT;'
wrangler d1 execute cf-panel --remote --command 'ALTER TABLE servers ADD COLUMN probe_json TEXT;'
wrangler d1 execute cf-panel --remote --command 'ALTER TABLE metrics_min ADD COLUMN extra TEXT;'
wrangler d1 execute cf-panel --remote --command 'CREATE TABLE IF NOT EXISTS metrics_custom (server_id INTEGER NOT NULL, name TEXT NOT NULL, ts INTEGER NOT NULL, value REAL, PRIMARY KEY (server_id, name, ts)) WITHOUT ROWID;'
```

**按旧版（带 `uuid` 列）添加过服务器**：`agent_key_id`（key 指纹）无法从旧数据回填，需重建 `servers` 表或在面板删除旧服务器后重新添加：

```bash
wrangler d1 execute cf-panel --remote --command 'DROP TABLE servers;'
wrangler d1 execute cf-panel --remote --file=schema.sql    # 重建
```

</details>

---

## 相关文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 架构设计、技术选型、Cloudflare 能力边界 |
| [docs/reviews/](docs/reviews/) | 历次代码审查记录（含问题与修复决策） |
| [agent/README.md](agent/README.md) | Agent 构建与交叉编译说明 |
