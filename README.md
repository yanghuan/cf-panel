# cf-panel

在 Cloudflare 上实现带终端与文件管理功能的监控面板。

- 前端：静态资源由 Worker 的 `[assets]` 提供（纯静态 + xterm.js，零构建）
- 后端：Cloudflare Workers + Durable Objects（WebSocket 双向中转）+ D1（面板核心数据 + kv_json 键值表）
- Agent：Rust 版（单进程、全静态 musl、任意 Linux 发行版直跑，无 websocat/socat/jq 依赖），部署在每台目标机器上，与面板通过 WebSocket 通信

架构设计见 [docs/architecture.md](docs/architecture.md)。

## 目录结构

```
cf-panel/
├── wrangler.toml        # Worker/DO/D1/静态资源配置
├── schema.sql           # D1 数据库表（含 kv_json 键值表；migrations/ 为版本化增量）
├── migrations/          # D1 迁移（版本化管理，部署时自动按序 apply）
├── src/                 # Worker 后端（多模块）
│   ├── index.js         #   入口：路由分发 + WebSocket 接入
│   ├── routes.js        #   REST API 路由
│   ├── auth.js          #   鉴权（JWT / PAT / agent key / 登录限流）
│   ├── config.js        #   环境变量与常量
│   ├── db.js            #   D1 查询
│   ├── do-terminal.js   #   TerminalDO：WS 双端对拷 + 会话注册表
│   ├── do-metrics.js    #   MetricsDO：监控热区 + D1 归档 + 告警
│   ├── do-panel.js      #   PanelDO：实时推送（Hibernation 休眠态）
│   ├── report.js        #   agent 监控上报处理
│   └── utils.js         #   公共工具
├── public/              # 前端（零构建：index.html / app.js / api.js / utils.js / style.css / vendor/）
├── agent/               # 被控机 agent（README / systemd 模板）
│   ├── rust/            # ✅ Rust 版 agent（推荐：内存低、单进程、全静态任意发行版直跑）
│   └── shell/           # ⚠️ Shell 版 agent（已废弃，保留参考/过渡）
└── docs/architecture.md # 架构设计文档
```

## 一、部署面板（Cloudflare）

### 方式一：网页端部署（推荐，无需本地 CLI）

利用 Cloudflare **Workers Builds**（Git 集成）在 Dashboard 直连 GitHub 仓库，push 即自动「迁移建表 + 部署」；`wrangler.toml` 中的 D1 / Durable Objects / assets 绑定由仓库配置驱动，构建时自动生效。

1. **创建 D1 数据库（网页端，只需一次）**：Dashboard → Workers & Pages → **D1** → Create database，名称 `cf-panel`；把 Overview 页的 **database_id** 填入 `wrangler.toml` 的 `[[d1_databases]]`（当前为占位符 `REPLACE_WITH_D1_DATABASE_ID`），提交并推送。
   > D1 数据库本身必须在平台手动创建一次（数据库实例无法脚本化）；**此后的建表/迁移由部署命令自动完成，无需再手动执行 SQL**。
2. **连接 GitHub 自动部署**：Workers & Pages → Create application → **Import a repository** → Get started → 授权 GitHub 并选择仓库。项目名须与 `wrangler.toml` 的 `name = "cf-panel"` **完全一致**，根目录 `/`，Save and Deploy。
3. **配置自动迁移建表**：在该 Worker → **Builds → Build configuration → Deploy command** 配置为：
   ```
   npm run deploy
   ```
   `package.json` 的 `deploy` 脚本 = `wrangler d1 migrations apply cf-panel --remote && wrangler deploy`。之后每次 `git push` 自动「迁移建表 + 部署」，**无需手动执行 SQL**（schema 由 `migrations/` 版本化管理，`apply` 幂等按序执行，见下方迁移说明）。也可本地手动 `npm run deploy` / `npm run migrate`。
4. **配置密钥（网页端，一次）**：该 Worker → Settings → Variables and Secrets → 添加 `JWT_SECRET`（必）、`PANEL_USERS` 或 `PANEL_PASSWORD`（必）、`HASH_SECRET`（推荐，见下方密钥详解）。
   > ⚠️ Cloudflare 规则：Worker 配置过 dashboard secret 后，`wrangler deploy` 会被拒绝，只能走 Builds/CI 部署——因此本方式同时是配密钥后的**唯一部署路径**。
   > 告警配置**不需要环境变量**：登录面板 → 设置弹窗 → 「告警」区直接填 Webhook 地址与阈值（存 D1，见下方告警配置）。
5. 部署完成后访问 `https://cf-panel.<你的子域>.workers.dev`，输入配置的密码即可登录。

### 方式二：CLI 部署（wrangler，备选）

前置：已安装 [wrangler](https://developers.cloudflare.com/workers/wrangler/) 并登录（`wrangler login`）。

```bash
# 1. 创建 D1 数据库，把返回的 database_id 填入 wrangler.toml
wrangler d1 create cf-panel

# 2. 建表/迁移（远程库，migrations 管理）
wrangler d1 migrations apply cf-panel --remote

# 3. 设置密钥（必做，生产安全）
wrangler secret put JWT_SECRET        # JWT 签名密钥
wrangler secret put HASH_SECRET       # 哈希密钥（agent key / PAT 哈希，推荐独立配置，见下方详解）
wrangler secret put PANEL_USERS       # 多用户（与 PANEL_PASSWORD 二选一，优先级更高）："alice:pass1,bob:pass2"
wrangler secret put PANEL_PASSWORD    # 单管理员密码（未配置 PANEL_USERS 时使用）

# 4. 部署
wrangler deploy
```

> **数据库迁移（migrations）**：schema 由 `migrations/` 目录版本化管理，`wrangler d1 migrations apply cf-panel --remote` 幂等执行全部未应用迁移（新库自动建全表，旧库自动补齐增量）。以下为历史旧库的增量对齐命令（已用 migrations 的库无需手动执行）。
> **旧库曾手动执行过 `ALTER TABLE metrics_min ADD COLUMN mem_total REAL;`（无迁移记录）**：直接 `apply` 会因 `0002` 重复加列失败，先手动标记 0002 已应用：
> ```
> wrangler d1 execute cf-panel --remote --command "INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_add_mem_total.sql');"
> ```
>
> 已部署过旧版（无 `"group"` 列 / 无 `kv_json` 表）？执行迁移：
> ```
> wrangler d1 execute cf-panel --remote --command 'ALTER TABLE servers ADD COLUMN "group" TEXT NOT NULL DEFAULT "";'
> wrangler d1 execute cf-panel --remote --command 'CREATE TABLE IF NOT EXISTS kv_json (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime("now")));'
> ```
>
> 旧库缺 `metrics_min.mem_total` 列（历史内存百分比计算用）？执行：
> ```
> wrangler d1 execute cf-panel --remote --command 'ALTER TABLE metrics_min ADD COLUMN mem_total REAL;'
> ```
>
> 已按旧版（带 `uuid` 列）添加过服务器？`agent_key_id`（key 指纹）无法从旧数据回填，需要重建 `servers` 表或在面板删除旧服务器后重新添加，agent 端改用 Rust 版 `cf-panel-agent`（只配 `AGENT_KEY`，监控上报已内置）：
> ```
> wrangler d1 execute cf-panel --remote --command 'DROP TABLE servers;'
> # 再执行 wrangler d1 execute cf-panel --remote --file=schema.sql 重建
> ```
>
> 已有旧表缺新列/新表？执行增量迁移（可空列，无需回填）：
> ```
> wrangler d1 execute cf-panel --remote --command 'ALTER TABLE servers ADD COLUMN info_json TEXT;'
> wrangler d1 execute cf-panel --remote --command 'ALTER TABLE servers ADD COLUMN probe_json TEXT;'
> wrangler d1 execute cf-panel --remote --command 'ALTER TABLE metrics_min ADD COLUMN extra TEXT;'
> wrangler d1 execute cf-panel --remote --command 'CREATE TABLE IF NOT EXISTS metrics_custom (server_id INTEGER NOT NULL, name TEXT NOT NULL, ts INTEGER NOT NULL, value REAL, PRIMARY KEY (server_id, name, ts)) WITHOUT ROWID;'
> ```

部署完成后访问 `https://cf-panel.<你的子域>.workers.dev`，输入配置的密码即可登录（登录即管理员）。

### 密钥配置详解（Secrets）

**配置方式**：在 Cloudflare 后台 Worker → **Settings → Variables and Secrets** 手动创建一次即可（首次部署时配置，之后无需再动）。`JWT_SECRET`/`HASH_SECRET` 建议用 `openssl rand -hex 32` 生成；`PANEL_PASSWORD` 自定面板登录密码。密钥仅首次部署时配置一次，**已配置的密钥不会被部署流程覆盖**（避免 JWT/HASH 变更使 token/agent 失效）。

| 变量 | 是否必配 | 作用 |
| --- | --- | --- |
| `JWT_SECRET` | ✅ 必 | JWT 签名密钥：签发/验证登录令牌，泄露可伪造任意用户登录 |
| `HASH_SECRET` | 推荐 | agent key / PAT 的 HMAC 哈希密钥（与 JWT 签名密钥隔离；未配置时回退 `JWT_SECRET`） |
| `PANEL_USERS` | ✅（与 PANEL_PASSWORD 二选一） | 多用户列表：`用户名:密码,用户名:密码` |
| `PANEL_PASSWORD` | 二选一 | 单管理员密码（未配置 PANEL_USERS 时使用） |

**`JWT_SECRET`** —— 格式：任意字符串，建议 32 字节以上随机串。

```bash
openssl rand -hex 32   # 例如：xk3f9M2c...（64 位十六进制）
```

- 必须显式配置；未配置或仅包含空白字符时，登录及所有受保护接口会返回 `503`，不存在默认密钥
- 本地调试也必须在 `.dev.vars` 中设置独立的 `JWT_SECRET`
- 修改它会让所有已登录用户 token 失效（需重新登录）

**`HASH_SECRET`** —— 格式：任意字符串，建议 32 字节以上随机串。

```bash
openssl rand -hex 32
```

- 用途：agent key 与 PAT 的 **HMAC 哈希密钥**（`servers.agent_key_hash` / `api_tokens.token_hash`），与 `JWT_SECRET`（签名）**职责隔离**——即使签名密钥泄露也无法伪造 agent key / PAT 哈希，反之亦然
- **未配置时回退 `JWT_SECRET`**（平滑迁移，行为与旧版一致）
- ⚠️ 首次配置或切换 `HASH_SECRET` 是**有损操作**：已存的 agent key 与 PAT 哈希全部失效，需在面板删除服务器后重新添加（生成新 key）并重建 PAT；`agent_key_id`（无盐 SHA-256 检索键）不受影响
- 建议新部署从第一天就配置它，避免后期切换的重建成本

**`PANEL_USERS`** —— 格式：`用户名:密码,用户名:密码`（逗号分隔用户，冒号分隔用户名与密码）。

```
alice:pass1,bob:pass2
```

- 用户名不能含 `:` 和 `,`
- 密码可含 `:`（按第一个冒号分割），建议不含 `,`
- 配置了它则**忽略** `PANEL_PASSWORD`
- 所有用户同权限（登录即管理员）

**`PANEL_PASSWORD`** —— 格式：任意密码字符串（仅在未配置 `PANEL_USERS` 时生效）。

```
MyS3cret!Pass
```

**配置位置（推荐网页端）**：该 Worker → Settings → **Variables and Secrets** → Add → 类型选 **Secret** → Name 填变量名、Value 填值。

或 CLI：

```bash
wrangler secret put JWT_SECRET       # 回车后粘贴值
wrangler secret put HASH_SECRET      # 回车后粘贴值（推荐）
wrangler secret put PANEL_USERS      # 回车后粘贴值，如 alice:pass1,bob:pass2
```

> ⚠️ 配置过 dashboard secret 的 Worker 只能通过 Builds/CI 部署（`wrangler deploy` 会被拒绝），参见方式一第 4 步说明。

### 免费额度与容量估算（部署前评估）

- **D1 存储**：`metrics_min` 每机每日约 `1,440` 行（保留 `METRICS_RETENTION_DAYS` 天，默认 30 → 约 `43,200×S` 行，S=服务器数）；`metrics_custom` 再乘每机自定义指标数 `C`（约 `43,200×S×C` 行）。**5GB 免费档**建议：`S×C` ≤ 约 100（默认 30 天保留）。
- **`METRICS_RETENTION_DAYS`**（可选变量，默认 30）：历史保留天数，缩短可线性降低 D1 容量占用（如 7 天则 `metrics_min` 约 `10,080×S` 行）。Worker → Settings → Variables（非 Secret）配置。
- **自定义指标建议每机 ≤20 个**：面板「自定义指标设置」弹窗已给出容量提示。
- **用量观测**：管理员访问 `GET /api/usage` 可查看近 24h 上报帧 / DO 事件 / D1 写行估算（Worker 请求计数 + MetricsDO 用量，仅管理员）。
- **invocation_logs 额度说明**：`wrangler.toml` 开启了 `invocation_logs`（每个 Worker/DO 调用一条日志）；快采 5s 意味着每机每天约 **17,280** 次上报帧调用（每帧至少 1 次 Worker/DO 调用），日志事件量随机器数线性增长，免费档日志额度约在 **10 台规模触顶**。规模化时建议在 `wrangler.toml` 关闭 `invocation_logs`（仅影响日志，不影响功能）。

**Webhook 告警配置**（可选，**模板化**）：登录面板 → **设置**弹窗 → 「告警」区填写即启用（存 D1 `settings.alerts`，**无需环境变量**）。支持 **GET/POST**、**JSON/纯文本**、**token 放 URL/Header/Body 任意位置**，任意渠道由用户侧对接。

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| 方法 | `POST` | `GET` 或 `POST` |
| Webhook 地址 | 无 | 告警回调地址（留空禁用）；支持占位符 |
| Token | 无 | 仅作为占位符 `{token}`，放哪由你拼 |
| Body 模板 | 留空 | POST 请求体（JSON/文本模板）；留空则发默认结构化 JSON |
| Content-Type | `application/json` | Body 的 Content-Type |
| Headers | 无 | 追加请求头 JSON（如 `{"Authorization":"Bearer {token}"}`），值支持占位符 |
| CPU / 内存 / 磁盘阈值 | `90` | 指标告警阈值（%） |
| 负载阈值 | 不启用 | 负载告警阈值（load1） |
| 冷却（分钟） | `30` | 同类告警冷却间隔 |
| 离线（秒） | `180` | 离线判定秒数（超过未上报） |

**占位符**（用于 地址/Body/Headers）：`{event}` `{title}` `{message}` `{server_name}` `{server_id}` `{details_json}` `{time}` `{token}`

**常见渠道配置示例**：

| 渠道 | 方法 | 地址（含占位符） | Body / 说明 |
| --- | --- | --- | --- |
| Server酱 | GET | `https://sctapi.ftqq.com/{token}.send?title={title}&desp={message}` | 无 |
| 钉钉机器人 | POST | `https://oapi.dingtalk.com/robot/send?access_token={token}` | `{"msgtype":"text","text":{"content":"{message}"}}` |
| 企业微信机器人 | POST | `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={token}` | `{"msgtype":"text","text":{"content":"{message}"}}` |
| Telegram Bot | POST | `https://api.telegram.org/bot{token}/sendMessage` | `{"chat_id":"你的ID","text":"{message}"}` |
| Bark | GET | `https://api.day.app/{token}/{title}/{message}` | 无 |
| Slack | POST | 默认 | 留空 Body 发结构化 JSON，Headers `{"Authorization":"Bearer {token}"}` |

> Webhook 执行出站安全检查：仅允许 HTTP(S)，拒绝 URL 内嵌凭据、常见本地域名、私网/保留 IP 字面量及 HTTP 重定向；域名解析与最终出站限制由 Cloudflare Workers 执行。发送失败日志不会记录完整 URL，避免路径或 query 中的 `{token}` 泄露。

**Webhook payload 结构**（`event` 区分 `alert` / `offline` / `recovered`）：

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

> 告警支持：CPU/内存/磁盘（根分区）/负载超阈值 + 机器离线/恢复通知。内存告警依赖 agent 上报 `mem_total`。

本地调试：`npm run dev`（`predev` 钩子自动生成 `.dev.vars` 随机密钥，若不存在；本地 SQLite 自动应用 migrations）。手动建表：`npm run migrate:local`。
> 本地没有 Cloudflare 注入的 `CF-Connecting-IP` 时，登录限流会统一落入 `unknown` 桶；同一开发实例上的多人调试会共享失败次数。这是避免信任可伪造 `X-Forwarded-For` 的安全取舍。
> ⚠️ 生产环境密钥（`JWT_SECRET`/`HASH_SECRET`/`PANEL_PASSWORD`）**不要**用本地随机生成：请固定配置为 dashboard secrets 或 `wrangler secret put`（随机生成后丢失无法找回）。

## 二、添加服务器并安装 agent

1. 在面板点「添加服务器」→ 填名称（可选填分组）→ 弹出一次性 agent 配置（WSS 地址 / KEY），**妥善保存**。KEY 是 agent 的唯一身份 + 凭证（uuid 已废弃）。
2. 部署 agent（**推荐 Rust 版**：单文件、无依赖、任意 Linux 直跑；可构建或从 GitHub Releases 下载全静态二进制）：
   ```bash
   mkdir -p /opt/cf-panel-agent
   # 方式一：GitHub Releases 下载（CI 自动发布）
   # curl -L -o /opt/cf-panel-agent/cf-panel-agent <Releases 下载地址>
   # 方式二：本地构建（agent/rust）
   #   cd agent/rust && cargo build --release
   #   cp target/release/cf-panel-agent /opt/cf-panel-agent/
   chmod +x /opt/cf-panel-agent/cf-panel-agent
   cat > /etc/cf-panel-agent.env <<EOF
   AGENT_WSS_URL=wss://<面板域名>/ws/agent
   AGENT_KEY=<你的 key>
   DISABLE_EXEC=0   # 设为 1 可全局禁止命令执行（终端不可用，仅保留监控）
   EOF
   ```
   > 全部可配置环境变量及默认值：`/opt/cf-panel-agent/cf-panel-agent --help`
3. 注册 systemd 服务：
   ```bash
   cp agent/cf-panel-agent.service /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now cf-panel-agent
   journalctl -u cf-panel-agent -f   # 看日志
   ```
   > 旧版 Shell agent（`agent/shell/agent.sh`）已废弃：需安装 websocat/socat/jq，环境变量与 Rust 版一致，仅作过渡/参考。
4. 监控上报已内置：agent 经控制通道 WS 上报 CPU / 内存 / Swap / 磁盘 / 负载 / 温度 / 进程数 / TCP-UDP 连接数 / 网络速率 / 系统信息（无需 crontab）。**省配额策略**：有面板观看者时约 5 秒上报（服务端动态下发），无人查看时 120 秒低频采样；`REPORT_INTERVAL` 可设默认值。
5. 可选：服务探活（agent 上配置 `PROBES` 探测本机 HTTP/TCP 服务，结果随上报展示在卡片 + 失败告警）：
   ```bash
   # 追加到 /etc/cf-panel-agent.env
   PROBES="web:http:http://127.0.0.1/,mysql:tcp:127.0.0.1:3306"
   ```
   `PROBES` 格式：`名称:类型:目标,...`；类型 `http`（目标为 URL，检查 2xx/3xx）或 `tcp`（目标为 `host:port`，测连通）。
6. 可选：自定义监控项（agent 上配置 `CUSTOM_METRICS`，执行任意命令采集数值指标，随上报存入 D1 并可看历史曲线）：
   ```bash
   # 追加到 /etc/cf-panel-agent.env
   CUSTOM_METRICS='[{"name":"cpu_temp","cmd":"cat /sys/class/thermal/thermal_zone0/temp"},{"name":"estab_conns","cmd":"ss -t state established | wc -l"}]'
   ```
   `CUSTOM_METRICS` 为 JSON 数组：`name` 指标名、`cmd` 采集命令（输出第一行数值）、`cycle` 采样周期（当前随上报周期）。命令执行带 5 秒超时；非数值输出自动跳过。

### 跨平台部署（Windows / macOS）

Rust 版 agent 三平台产物从 GitHub Releases 下载（`cf-panel-agent-windows.exe` / `cf-panel-agent-macos`），功能矩阵与差异见下方；环境变量与 Linux 版完全一致（`AGENT_WSS_URL` / `AGENT_KEY` 必填，`--help` 可查全部配置）。

**Windows（x86_64，Windows 10+）**

1. 下载 `cf-panel-agent-windows.exe`，放任意目录（如 `C:\cf-panel-agent\`）。
2. 创建环境变量（系统属性 → 环境变量，或 PowerShell 会话内 `$env:AGENT_WSS_URL=...`）：
   ```powershell
   $env:AGENT_WSS_URL = "wss://<面板域名>/ws/agent"
   $env:AGENT_KEY     = "<你的 key>"
   # 可选：DISABLE_EXEC=1 禁用终端/文件/exec；PROBES / CUSTOM_METRICS 同 Linux
   .\cf-panel-agent-windows.exe
   ```
3. 开机自启（管理员 PowerShell）：
   ```powershell
   sc.exe create cf-panel-agent binPath= "C:\cf-panel-agent\cf-panel-agent-windows.exe" start= auto
   sc.exe start cf-panel-agent
   # 停止：sc.exe stop cf-panel-agent
   ```
4. 差异与边界：
   - **终端走 ConPTY**（PowerShell 交互，portable-pty 内置）；exec/自定义指标走 `cmd /C`（命令写法按 Windows 习惯）。
   - **文件管理为盘符路径**（如 `C:\Users\me\app`）；`C:\Users` 可写，`C:\Windows`、`Program Files`、`ProgramData` 等系统目录受保护（写/删/改名拒绝，下载保留）。
   - 指标经 sysinfo 采集：CPU/内存/磁盘/网络为真实数据；**磁盘 IO 图与 TCP/UDP 连接数为空**（无跨平台 API）。
   - 临时目录/日志默认在 `%TEMP%\cfpanel-<key前8位>...`（`AGENT_TMPDIR` / `AGENT_LOG` 可改）。
   - 进程树清理走 Job Object（exec 超时/会话关闭时整树终止）。

**macOS（Apple Silicon，M1/M2/M3…）**

1. 下载 `cf-panel-agent-macos` 并赋予执行权限（`chmod +x`）；终端交互 shell 与 Linux 同逻辑：`$SHELL` 优先（默认 zsh），回退 `/bin/bash` → `/bin/sh`；exec/自定义指标走 `sh -c`。
2. 环境变量 + 启动：
   ```bash
   AGENT_WSS_URL=wss://<面板域名>/ws/agent AGENT_KEY=<你的 key> ./cf-panel-agent-macos
   ```
3. 开机自启（launchd，`~/Library/LaunchAgents/com.cfpanel.agent.plist`）：
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>Label</key><string>com.cfpanel.agent</string>
     <key>ProgramArguments</key><array><string>/path/to/cf-panel-agent-macos</string></array>
     <key>EnvironmentVariables</key><dict>
       <key>AGENT_WSS_URL</key><string>wss://<面板域名>/ws/agent</string>
       <key>AGENT_KEY</key><string><你的 key></string>
     </dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
   </dict></plist>
   ```
   ```bash
   launchctl load ~/Library/LaunchAgents/com.cfpanel.agent.plist
   ```
4. 差异与边界：终端/文件管理/exec/探活/自定义指标可用；指标经 sysinfo（真实 CPU/内存/磁盘/网络；**磁盘 IO 与连接数为空**）；系统信息 IP 为空（卡片展示走服务端 wan_ip，不受影响）；临时目录默认 `/tmp`。

> **平台能力矩阵**（与 Linux 完整版对照）：

| 能力 | Linux | macOS | Windows |
| --- | --- | --- | --- |
| 控制通道 / WS / TLS | ✅ | ✅ | ✅ |
| 终端 PTY | ✅ | ✅ | ✅（ConPTY） |
| exec / 自定义指标 | sh -c | sh -c | cmd /C |
| 文件管理 | ✅（/ 路径） | ✅（/ 路径） | ✅（盘符路径，系统目录受保护） |
| CPU/内存/磁盘/网络指标 | ✅ | ✅ | ✅ |
| 磁盘 IO / TCP-UDP 连接数 | ✅ | 空 | 空 |
| 进程树清理 | 进程组 | 进程组 | Job Object |

## 三、使用

- **概览与实时指标**：顶部概览条显示服务器总数/在线数/平均 CPU/负载/总内存；每张服务器卡片实时显示 CPU / 内存 / 负载（经 `/ws/push` 上报驱动实时推送，PanelDO 从 MetricsDO 取最新值；前端仅首帧 sync，1s 定时器只做本地老化）。
- **服务探活**：agent 配置 `PROBES` 后，卡片显示每个服务的状态徽章（绿=正常/红=异常，悬停显示 HTTP 码）；探测失败持续超冷却会触发 Webhook（`event: probe_down`，恢复发 `probe_recovered`）。
- **自定义监控项**：agent 配置 `CUSTOM_METRICS`（JSON：`name`+`cmd`）后，执行任意命令采集数值指标；监控图中以独立曲线展示（按 ts 对齐系统时间轴，共用右轴看趋势），数据直写 D1 `metrics_custom` 表（30 天保留）。
- **实时列表**：登录后前端与 `/ws/push` 保持 WebSocket，连接建立发一次 sync 拉初始列表，此后由 MetricsDO 上报驱动推送（PanelDO，Hibernation 休眠态，费用趋近普通 Worker）按权限广播服务器列表（在线状态前端本地老化自动更新），无需手动刷新。
- **终端**：面板服务器卡片点「终端」→ xterm.js 弹出 → 按键实时到达被控机 shell；窗口拉伸自动 resize（经控制通道 `stty` 下发）；断线自动重连（最多 3 次）。
- **文件管理**：面板服务器卡片点「文件」→ 弹出文件管理器，可浏览目录（点击进入/上级/路径跳转）、**上传**（本地文件写入 agent）、**下载**（agent 文件回传浏览器）；文件经独立 WS 会话**分段传输**（512KB/段，Binary 混合帧 = JSON 头 + 原始字节，无 base64 膨胀），支持文件名通配符过滤（`*`/`?`，agent 端先过滤再截断），**单文件默认上限 100MB**（`UPLOAD_MAX_MB` 可调高，受 agent 端 500MB 硬上限约束）。每行最右侧 **⋯** 下拉菜单提供：下载（目录自动打包 ZIP 下载，文件名为 `目录名.zip`）、重命名（仅改名，不支持跨目录）、删除（目录递归删除）；**重命名/删除/打包对系统目录（`/proc`、`/sys`、`/etc`、`/usr`、`/var`、`/root` 等）自动拒绝**，防止误操作破坏系统。
- **监控**：点「监控」默认看近 12 小时分钟数据（内存 DO 热区，秒回）；可切 1小时/3天/7天/30天查看 D1 归档历史（分钟粒度，超长区间自动降采样）。指标：CPU / 内存 / Swap / 磁盘（根分区）/ 负载 / 温度 / 进程数；服务器卡片显示 OS / 内核 / IP 系统信息。
- **分组与排序**：添加服务器可填「分组」和「序号」，列表按分组展示、组内按序号排序（未填归入「未分组」）。
- **登录**：`PANEL_USERS` 多用户（`user:pass,user:pass`）或单管理员（`PANEL_PASSWORD`），登录即管理员。**应用内置失败限流**（同一 IP 在 15 分钟窗口内失败 ≥5 次 → 锁定 15 分钟并返回 `429` + `Retry-After`，登录成功自动清零）；生产部署**必须**再前置 **Cloudflare Access**（登录密码作为第二层），以覆盖跨边缘实例的限流一致性。
  > ⚠️ Access 需为非浏览器会话路径放行（使用 `X-Agent-Key` 头 / Bearer 鉴权，非浏览器 SSO，必须配置 Bypass 或 Service Token 策略）：`/ws/agent/*`（agent 控制/终端/文件流，否则 agent 无法连接）与 `/mcp*`（MCP JSON-RPC + `/mcp/file_upload` 签名 URL 直传，否则 MCP 客户端与 curl 上传被拦）。
- **公告**：设置里可改站点名/公告（存 D1 `kv_json` 表），公告对所有访客可见。
- **PAT**：设置里可创建访问令牌（scopes + server_ids 白名单 + 可选有效期天数，留空=永久有效，到期自动拒绝鉴权），供 API 调用（`Authorization: Bearer cfp_xxx`）。
- **审计日志**：右上角菜单「审计日志」可查看（添加/删除服务器、终端/文件会话、文件写操作（上传/打包/重命名/删除）、执行命令均记录），支持按动作/用户/服务器筛选、分页与 CSV 导出，D1 保留 90 天后自动清理。

## 四、API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 用面板密码（PANEL_USERS/PANEL_PASSWORD）登录，返回 JWT |
| GET | `/api/me` | 当前用户（JWT 或 PAT） |
| GET | `/api/public/settings` | 公开配置（站点名/公告，D1 kv_json，无需登录） |
| GET | `/api/servers` | 服务器列表（含分组、序号；按权限过滤） |
| POST | `/api/servers` | 添加服务器（name + 可选 group/sort_order），返回 agent 配置 |
| DELETE | `/api/servers/:id` | 删除服务器（仅管理员） |
| POST | `/api/terminal` | 创建终端会话（exec 权限 + 归属校验），返回 session_id |
| POST | `/api/file/open` | 创建文件管理会话（exec 权限 + 归属校验），返回 session_id |
| GET | `/api/usage` | 用量观测（近 24h 上报帧 / DO 事件 / D1 写行估算，仅管理员） |
| GET | `/ws/terminal/{id}` | 浏览器终端 WebSocket（校验创建者/admin） |
| GET | `/ws/file/{id}` | 浏览器文件管理 WebSocket（JSON 行协议：list/read/write/zip/rename/delete，校验创建者/admin） |
| GET | `/ws/agent/file` | agent 文件数据流（key 校验 + stream 归属校验） |
| GET | `/ws/push` | 面板实时刷新：首帧 sync 后被动接收上报驱动推送，服务端按权限返回服务器列表 |
| GET | `/ws/agent/control` | agent 控制通道（key 指纹定位 + 校验，按分片路由；监控上报也走这里） |
| GET | `/ws/agent/terminal` | agent 终端数据流（key 校验 + stream 归属校验） |
| GET | `/api/monitor?server_id=&range=` | 监控历史（range: 1h/12h/3d/7d/30d，默认 12h 走内存，更早走 D1） |
| GET | `/api/tokens` | PAT 列表（仅管理员） |
| POST | `/api/tokens` | 创建 PAT（scopes + server_ids 白名单 + 可选 `expires_in_days` 有效期，缺省永久；明文只返回一次） |
| DELETE | `/api/tokens/:id` | 删除 PAT（仅管理员） |
| GET | `/api/audit-logs` | 审计日志（仅管理员，倒序分页：`?limit=&offset=&action=&user=&server_id=`，`?format=csv` 导出，保留 90 天） |
| GET | `/api/settings` | 读取全部设置（含告警配置，仅管理员） |
| PUT | `/api/settings` | 更新站点名/公告/告警配置（D1 kv_json，仅管理员） |
| POST | `/api/settings/test_webhook` | 测试 Webhook（仅管理员：传当前表单告警配置，发测试通知并回显 HTTP 状态，不保存） |

### MCP（AI 接入）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/mcp` | MCP 端点（Streamable HTTP，兼容协议版本 2025-11-25；单 POST 端点、无会话、每请求独立鉴权） |
| POST | `/mcp/file_upload?server_id=&path=&overwrite=` | 流式上传文件到 agent（body=原始字节，Worker 自动分片；Bearer 鉴权或签名 URL token 均可。位于 `/mcp` 前缀下以绕过 CF Access 拦截，供 curl 直传） |

`/mcp` 实现标准 [Model Context Protocol](https://modelcontextprotocol.io) **Streamable HTTP**（兼容协议版本 `2025-11-25`）：单 POST 端点、无 `Mcp-Session-Id` 会话、每请求独立鉴权——采用**无状态简化实现**（与 2026-07-28 规范正式确立的无状态模型方向一致，但保留旧版 initialize 握手以兼容 2025-11-25 客户端）。鉴权复用现有 `Authorization: Bearer <JWT 或 PAT>`。

**工具**：

| 工具 | 说明 |
| --- | --- |
| `list_servers` | 服务器列表 + 实时状态（CPU/内存/负载/在线）+ 系统信息 |
| `get_monitor` | 监控历史（`server_id`/`server_name` + `range`：1h/12h/3d/7d/30d） |
| `exec_command` | 在指定服务器上执行一次性 shell 命令并返回输出（`server_id`/`server_name` + `command`，`timeout` 1~25s 默认 25s，stdout 上限约 44KB）；**写操作**，需 exec 权限（管理员或带 `server:exec` scope 的 PAT）；经控制通道直达 agent（`sh -c` 执行，超时 kill 进程组） |
| `create_upload` | 创建一次性文件上传**签名 URL**（大文件/二进制通道，不经过 LLM 上下文）：`path`（绝对路径）+ 可选 `overwrite`；返回 `upload_url` 供 curl/fetch POST（body=原始字节），HMAC 签名绑定 server/path/overwrite、10 分钟过期、无需 Bearer；AI 将 URL 转给用户/程序执行 |
| `add_server` | 注册新服务器（**仅管理员**），返回一次性 `agent_key` 明文与部署地址 |
| `update_server` | 修改服务器名称/分组/排序（仅管理员；`server_id`/`server_name` + 要改的字段） |
| `delete_server` | 删除服务器（仅管理员；清监控历史 + 审计 + 断开 agent） |
| `list_tokens` | 列出 PAT 概要（仅管理员，不含哈希/明文） |
| `create_token` | 创建 PAT（仅管理员；`name` + `scopes`/`server_ids`/`expires_in_days`（缺省永久），明文只返回一次） |
| `revoke_token` | 撤销 PAT（仅管理员，立即失效） |
| `get_audit_logs` | 审计日志（仅管理员，`limit`/`offset`/`action`/`user`/`server_id` 分页筛选，返回 `{rows,total}`，保留 90 天） |
| `get_usage` | 用量观测（仅管理员：上报帧/DO 事件/D1 写行估算） |
| `get_settings` / `update_settings` | 读取/更新面板设置（仅管理员：站点名/公告/IP 归属地开关/告警配置） |

**客户端配置示例**（Claude Desktop / 支持 MCP 的客户端，`claude_desktop_config.json`）：

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

命令行冒烟测试：

```bash
# initialize
curl -X POST https://<面板域名>/mcp -H "Authorization: Bearer <token>" \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# 调工具
curl -X POST https://<面板域名>/mcp -H "Authorization: Bearer <token>" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_servers","arguments":{}}}'
```

> 客户端若带 `MCP-Protocol-Version` 头，需与 body `_meta` 中版本一致；缺失时服务端按 `2025-03-26` 兼容。

## 五、安全要点（实现清单已覆盖）

- `/ws/terminal/{id}` 仅允许会话创建者或管理员连接（防 stream UUID 劫持，GHSA 教训）。
- agent 建连必须通过 `X-Agent-Key` 请求头提供凭证（不接受 URL query，避免边缘日志/代理记录泄露）；服务端先用 key 的 SHA-256 指纹（`servers.agent_key_id`）反查服务器，再用 Web Crypto HMAC verify 校验 `servers.agent_key_hash`；`/ws/agent/terminal` 额外校验 stream 归属。
- 面板登录密码存 CF secret（`PANEL_USERS`/`PANEL_PASSWORD`），不进代码库；agent key 与 PAT 只存哈希（key 指纹用于检索，HMAC 哈希用于校验）。
- 审计日志：`server.create/update/delete`、`terminal.open`、`file.open/upload/write/zip/rename/delete`、`exec.command` 写 `audit_logs`（WS 文件操作在 DO 拦截指令记录；`exec.command` 含命令与 exit_code）。终端/文件会话横跨 DO 与 D1，审计写入为 best-effort：D1 短暂失败时记录 Worker 错误但仍返回已创建的可用会话，避免遗留不可访问的远端会话。
- agent 侧 `DISABLE_EXEC=1` 可全局禁止命令执行（终端任务直接忽略）。
- 终端/监控接口按权限收敛：JWT 管理员全量；PAT 按 scopes + server_ids 白名单收窄。

## 六、架构要点（多 DO 分片等）

- **多 DO 分片**：终端 DO `SHARDS = 4`，streamId 带 `shard-序号` 前缀，浏览器/agent 的 WS 请求按前缀路由到对应 DO 实例，避免单点瓶颈。
- **实时刷新 PanelDO**：单实例 DO，前端 `/ws/push` 连接后**首帧 sync 即订阅**，此后由监控上报驱动实时推送（服务器变化/新数据时回发列表）；DO 用 Hibernation API，空闲即休眠（不计时长），按用户权限过滤（在线状态秒级更新）。
- **会话回收**：终端会话两端都断开超过 10 分钟，DO 惰性清理（每 60s 扫描一次）。
- **监控时序（MetricsDO，默认开启归档）**：agent 上报先写内存滚动窗口（保留最近 720 分钟/机，前端查询秒回）；alarm 每 10 分钟把超过 1 小时的旧数据批量写入 `metrics_min` 表（写入量 ≈ 60 行/机/小时，免费额度内），并按 **30 天保留期**每日清理过期行（重启不丢历史）。`ARCHIVE_TO_D1=0` 可关闭归档（关闭后仅内存 12 小时）。
- **已知限制**：
  - 终端 DO 会话状态在内存（僵尸会话按 10 分钟 TTL 回收，DO alarm 兜底保证零流量时也会清理；实例迁移会中断活跃终端；可后续迁 DO Storage）。
  - D1 归档默认开启（保留 30 天）；若关闭（`ARCHIVE_TO_D1=0`），DO 重启会丢失 12 小时外的历史。
  - 监控图表为 CPU/内存双折线（Chart.js）；磁盘/温度/连接数等扩展项仅在数据层，图表展示可后续迭代。
  - Rust agent 为推荐实现（内存低、全静态单文件、任意发行版直跑）；Shell 版（`agent/shell/`）已废弃仅作参考。
  - 多用户通过 `PANEL_USERS` 环境变量配置（`user:pass,user:pass`），所有用户同权限（管理员）；如需按用户分配服务器归属，可恢复 `users` 表逻辑。
