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
├── public/              # 前端（零构建：index.html / app.js / api.js / utils.js / i18n.js / lang/ / style.css / vendor/ + icon.svg / manifest.webmanifest）
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

Agent 更新相关的普通 Worker 变量（非密钥、可选）：`AGENT_RELEASE_REPO=owner/repo` 指定 Release 仓库（默认 `yanghuan/cf-panel`）；`AGENT_MANIFEST_URL=https://.../agent-manifest.json` 可指定清单镜像，但清单中的资产 URL 仍必须精确匹配 `AGENT_RELEASE_REPO` 对应的 GitHub Release，防任意下载源注入。

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

- **D1 存储**：`metrics_min` 每机每日约 `1,440` 行（保留 `METRICS_RETENTION_DAYS` 天，默认 30 → 约 `43,200×S` 行，S=服务器数）；`metrics_custom` 再乘每机自定义指标数 `C`（约 `43,200×S×C` 行）。新增的按天账 `metrics_day` **每机每日仅 1 行**（保留 3 年 ≈ `1,095×S` 行，约 100B/行 → 100 台机器约 11MB，可忽略）。**5GB 免费档**建议：`S×C` ≤ 约 100（默认 30 天保留）。
- **`METRICS_RETENTION_DAYS`**（可选变量，默认 30）：历史保留天数，缩短可线性降低 D1 容量占用（如 7 天则 `metrics_min` 约 `10,080×S` 行）。Worker → Settings → Variables（非 Secret）配置。
- **`STATS_TZ_OFFSET_MINUTES`**（可选变量，默认 `0` = UTC）：流量/可用率按天统计的**时区偏移分钟数**。按本地时区结算月度流量时设 `480`（UTC+8），否则每月 1 号 00:00~08:00 的流量会归到上一个月，月底对不上账。**改动它只影响之后新产生的天账的日期归属**；历史行按写入时的偏移存储，查询与展示统一按**当前**偏移换算——因此中途切换偏移后，历史日期的显示会整体平移（如 UTC 切 UTC+8 后偏移一天）。要保证账目口径一致，请在开始记录前确定偏移并避免中途更改。
- **`METRICS_DAY_RETENTION_DAYS`**（可选变量，默认 `1095` = 3 年）：按天账（`metrics_day`）保留天数。约 100B/行/机/天，100 台机器满 3 年仅约 11MB，容量压力可忽略。
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
| 免打扰截止 | 无 | unix 秒（面板用日期时间选择器填写）。到期前**暂停全部告警**（阈值/探活/离线），到期自动恢复——计划内重启/割接前设置，避免必然触发的离线告警 |

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

> 告警支持：CPU/内存/磁盘（根分区）/负载超阈值 + 机器离线/恢复通知 + 服务探活异常/恢复。内存告警依赖 agent 上报 `mem_total`。

**逐机阈值覆盖**：全局一套阈值必然在异构机器上顾此失彼——16 核机器 CPU 90% 是真告警，1 核小机可能日常就在 80%。服务器「修改」弹窗的「告警阈值覆盖」区可逐机覆盖 `cpu_pct` / `mem_pct` / `disk_pct` / `load` / `offline_after_s`：**未填写的维度继承全局**，全部留空即等于不覆盖（也用于清除覆盖）。`load` 填 `0` 表示关闭该机器的负载告警。

> 覆盖值随上报帧下发（复用服务器行缓存，零额外查询），改动后最多 60 秒生效。刻意**不支持**逐机覆盖 webhook 渠道与冷却时间：渠道是全局通知基础设施，冷却是防刷保护，逐机化会让告警状态（冷却水位、离线状态机）按机器分裂，收益不抵复杂度。

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
   ALLOW_SELF_UPDATE=1  # 可选：允许管理员从面板更新（systemd Restart=always 托管重启）
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
   `CUSTOM_METRICS` 为 JSON 数组：`name` 指标名、`cmd` 采集命令（输出第一行数值）、`cycle` 采样周期（当前随上报周期）。命令执行带 5 秒总超时；stdout 仅保留前 4KB 并持续排空，防刷屏命令放大内存；非数值输出自动跳过。

### 跨平台部署（Windows / macOS）

Rust 版 agent 三平台产物从 GitHub Releases 下载（`cf-panel-agent-windows.exe` / `cf-panel-agent-macos`），功能矩阵与差异见下方；环境变量与 Linux 版完全一致（`AGENT_WSS_URL` / `AGENT_KEY` 必填，`--help` 可查全部配置）。

**Windows（x86_64，Windows 10+）**

1. 下载 `cf-panel-agent-windows.exe`，放任意目录（如 `C:\cf-panel-agent\`）。
2. 创建环境变量（系统属性 → 环境变量，或 PowerShell 会话内 `$env:AGENT_WSS_URL=...`）：
   ```powershell
   $env:AGENT_WSS_URL = "wss://<面板域名>/ws/agent"
   $env:AGENT_KEY     = "<你的 key>"
   # 可选：DISABLE_EXEC=1 禁用终端/文件/exec；PROBES / CUSTOM_METRICS 同 Linux
   $env:ALLOW_SELF_UPDATE = "1"
   $env:AGENT_SELF_RESTART = "1"  # 未使用服务包装器时，更新后主动启动新版本
   .\cf-panel-agent-windows.exe
   ```
3. 开机自启：该 exe 是控制台程序，不可直接用 `sc.exe create` 注册为原生 Windows Service（会因未实现 ServiceMain 报 1053）。可用 WinSW/NSSM 包装为服务；仅需随系统启动时也可使用任务计划程序。无服务包装器时保留上面的 `AGENT_SELF_RESTART=1`，面板更新后由 Agent 自启新版本；使用 WinSW/NSSM 自动重启时改为 0，避免重复拉起。
4. 差异与边界：
   - **终端走 ConPTY**（PowerShell 交互，portable-pty 内置）；exec/自定义指标走 `cmd /C`（命令写法按 Windows 习惯）。
   - **文件管理为盘符路径**（如 `C:\Users\me\app`）；`C:\Users` 可写，`C:\Windows`、`Program Files`、`ProgramData` 等系统目录受保护（写/删/改名拒绝，下载保留）；`CON`、`NUL`、`COM1`、`LPT1` 等 Win32 保留设备名及 ADS 路径同样拒绝。
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
       <key>ALLOW_SELF_UPDATE</key><string>1</string>
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
- **Agent 自更新**：管理员登录时读取 GitHub Release `agent-manifest.json`（5 分钟缓存）；节点上报 `update_protocol=1` 且配置 `ALLOW_SELF_UPDATE=1` 时，卡片菜单按版本显示「更新 Agent」（不支持该协议的旧 Agent 需先手动升级一次）。二进制经 Worker→TerminalDO→控制 WS 流式中转，Agent 校验大小/SHA-256/候选 `--version`，保留 `.bak` 后用 `self-replace` 原子替换并由 supervisor 或 `AGENT_SELF_RESTART=1` 拉起。PAT 不允许触发更新，操作写入审计日志。Fork 部署请设置 Worker 变量 `AGENT_RELEASE_REPO=owner/repo`（默认 `yanghuan/cf-panel`）；也可用 `AGENT_MANIFEST_URL` 指向 HTTPS 镜像清单，资产 URL 仍须匹配该仓库 Release。
- **终端**：面板服务器卡片点「终端」→ xterm.js 弹出 → 按键实时到达被控机 shell；窗口拉伸自动 resize（经控制通道 `stty` 下发）；断线自动重连（最多 3 次）。支持**多标签**：可同时连多台机器并来回切换（切换只做显隐，不销毁会话——滚动缓冲区与 PTY 连接都保留）；同一服务器再次点「终端」会切到既有标签，需要同机多终端用标题栏「＋」新建。标题栏可切**渲染器**（WebGL 高吞吐 / DOM 兼容），偏好持久化；WebGL 会自动回退 DOM。
  > 前端最多 8 个标签：后端每服务器并发上限 8 个会话，前端上限则受浏览器**每页 WebGL 上下文数（约 8~16 个）**约束——超过后新标签会静默丢掉 GPU 渲染（不报错，只是不加速），故在达到上限时直接留在 DOM 而不尝试 WebGL。关闭标签会显式释放其 WebGL 上下文。
- **文件管理**：面板服务器卡片点「文件」→ 弹出文件管理器，可浏览目录（点击进入/上级/路径跳转）、**上传**（本地文件写入 agent，支持**一次选多个**或**直接拖到弹窗里**，逐个串行上传并显示进度）、**下载**（agent 文件回传浏览器）；文件经独立 WS 会话**分段传输**（512KB/段，Binary 混合帧 = JSON 头 + 原始字节，无 base64 膨胀）。搜索分两种：**过滤**只看当前目录（`*`/`?` 通配符，agent 端先过滤再截断），**递归搜索**下钻子目录（如 `*.log`，带深度/结果数/扫描条目三重上限，防超大目录树卡住会话）。**单文件默认上限 100MB**（`UPLOAD_MAX_MB` 可调高，受 agent 端 500MB 硬上限约束）。每行最右侧 **⋯** 下拉菜单提供：**下载**（目录自动打包 ZIP 下载，文件名为 `目录名.zip`）、**重命名**（仅改名，不支持跨目录）、**移动**与**复制**（共用内置目录选择器选目标目录与目标名；移动跨分区自动回退 copy+delete，复制是目录递归拷贝、带体积上限且**拒绝复制到自身子目录**）、**权限**、**编辑**（在线编辑器）、**删除**（目录递归删除）；工具栏另有**新建目录**、**新建文件**。双击可编辑文件直接进入编辑器。列表显示每个条目的**权限**（`rwxr-xr-x (0755)`）。
  > **权限**：Unix 为 POSIX 九宫格与八进制双向联动（如 `755`）；**Windows 无 POSIX mode**，填八进制会被明确拒绝，只能用「只读」开关——不提供假的 POSIX 等价物。改配置忘记 `chmod +x` 时无需再开终端。系统目录（`/proc`、`/sys`、`/etc`、`/usr`、`/var`、`/root` 等，Windows 为 `Windows`/`Program Files` 等）拒绝上传/重命名/删除等写操作，ZIP 属只读下载，仅拒绝打包文件系统根。
- **在线编辑器**：点「编辑」或双击文件打开（Monaco 从 CDN 懒加载，失败自动回退 textarea）。支持 30+ 种语法高亮、`Ctrl/Cmd+S` 保存、全屏展开、**Markdown 预览**（marked 渲染 + DOMPurify 消毒，本地 vendor 不依赖 CDN）、未保存改动关闭时二次确认。二进制文件按扩展名黑名单 + UTF-8 替换字符占比双重检测拒绝打开（保存会永久损坏内容）。编辑上限 1MB，全文分段拉取。
- **监控**：点「监控」默认看近 12 小时分钟数据（内存 DO 热区，秒回）；可切 1小时/3天/7天/30天查看 D1 归档历史（分钟粒度，超长区间自动降采样）。每张指标独立一图，共 10 类：**CPU / 内存+Swap / 负载(1-5-15) / 磁盘 / 磁盘IO(读写速率+util 双轴) / 磁盘IOPS / 网络(上下行) / TCP·UDP 连接数 / 进程数 / 自定义指标**；服务器卡片显示 OS / 内核 / IP 系统信息。监控弹窗打开时会随推送实时更新末点。
- **流量与可用率**：卡片菜单点「流量/可用率」，按**天**查看入站/出站流量、可用率与重启次数（7 天 / 30 天 / 90 天 / 1 年）。数据源是独立的按天账（`metrics_day`，1 行/机/天，默认保留 **3 年**），与「监控」的分钟级曲线是两个量级的账：
  - **为什么单列一张表**：`metrics_min` 只留 30 天，且 7 天后按 `ts % 5` 降采样只剩 1/5 采样点；更要紧的是**离线期间根本没有行**——可用率要的是"离线时长"，事后从稀疏采样点反推不出来。故按天账由上报链路实时累加。
  - **可用率** = 在线分钟 ÷ 纳入统计分钟，回答"这台机器有多少比例的时间够得着"（网络视角）；与卡片上的"开机 N 天"（`uptime`，机器视角的连续性）互补——每天定时重启的机器可用率仍可能 99.9%，反之从不重启的机器也可能断过网。
  - **重启次数**来自 `uptime` 的下降沿检测，可用率给不了这个信息。
  - 按天账由 MetricsDO 的 alarm 每 10 分钟落库；实例 evict 最多丢一个周期（≤10 分钟）的增量，已入账数据不受影响。
  - 时区：`STATS_TZ_OFFSET_MINUTES`（默认 0 = UTC）。若按本地时区结算月度流量，国内建议设 `480`（UTC+8），否则每月 1 号 00:00~08:00 的流量会归到上个月。保留期用 `METRICS_DAY_RETENTION_DAYS` 覆盖（默认 1095 天）。
- **分组与排序**：添加服务器可填「分组」和「序号」，列表按分组展示、组内按序号排序（未填归入「未分组」）；管理员可用组标题的 ↑↓ 调整组顺序（存 D1 `kv_json`，PUT `/api/group-order`）。
- **搜索与批量操作**：工具栏搜索框按名称 / IP / 分组即时过滤（纯前端，列表已全量推送到客户端，零请求）；勾选卡片后出现批量操作栏，支持**批量更新 Agent**（逐台串行，可见每台进度）、**批量修改分组**、**批量删除**（均仅管理员）。批量接口返回逐项结果，部分失败不会让整体变成 500。
- **登录**：`PANEL_USERS` 多用户（`user:pass,user:pass`）或单管理员（`PANEL_PASSWORD`），登录即管理员。**应用内置失败限流**（同一 IP 在 15 分钟窗口内失败 ≥5 次 → 锁定 15 分钟并返回 `429` + `Retry-After`，登录成功自动清零）；生产部署**必须**再前置 **Cloudflare Access**（登录密码作为第二层），以覆盖跨边缘实例的限流一致性。
  > ⚠️ Access 需为非浏览器会话路径放行（使用 `X-Agent-Key` 头 / Bearer 鉴权，非浏览器 SSO，必须配置 Bypass 或 Service Token 策略）：`/ws/agent/*`（agent 控制/终端/文件流，否则 agent 无法连接）与 `/mcp*`（MCP JSON-RPC + `/mcp/file_upload` 签名 URL 直传，否则 MCP 客户端与 curl 上传被拦）。
  > 另：面板若配了 Web Analytics（JS 片段方式），使用统计类浏览器扩展（uBlock 等）会拦截 `cloudflareinsights.com` 导致本机浏览不计入（ERR_BLOCKED_BY_CLIENT）——属访客侧拦截，不影响其他访客。PWA 的 `/manifest.webmanifest` 也会被 Access 认证重定向，若在意「添加到主屏幕」可为其配置 Bypass。
- **公告**：设置里可改站点名/公告（存 D1 `kv_json` 表），公告对所有访客可见。
- **PAT**：设置里可创建访问令牌（scopes + server_ids 白名单 + 可选有效期，留空=永久有效，到期自动拒绝鉴权），供 API 调用（`Authorization: Bearer cfp_xxx`）。有效期可填天数（如 `30`）或截止日期（如 `2026/9/5 14:00`，可用 📅 按钮选），输入时右侧实时预览换算结果。令牌列表显示每个令牌的**最近使用时间**（60 秒节流回写，不增加请求级写放大），便于识别长期不用的僵尸令牌。
- **审计日志**：右上角菜单「审计日志」可查看，支持按动作/用户/服务器筛选、分页与 CSV 导出，D1 保留 90 天后自动清理。覆盖：**登录与鉴权**（`login.success` 成功 / `login.failed` 密码错误 / `login.locked` 触发限流锁定 / `auth.failed` 无效或过期凭据探测——记来源 IP 与归一化路径，**不记密码**）、**服务器**（增删改、轮换 key、批量改分组）、**终端/文件会话**、**文件写操作**（上传/写入/打包/重命名/移动/删除）、**执行命令**、**Agent 更新**。
  > 失败类审计按 IP 做 60 秒节流：爆破与无效 token 扫描会让审计表本身变成写放大源，节流后仍保留"谁在试、试什么"的量级信息。
- **轮换 Agent Key**：卡片菜单点「轮换 Key」，旧 key 立即失效并断开现有连接，**监控历史（含按天账）与审计记录全部保留**。这是 key 泄露或误发后的正确处置路径——此前只能删服务器重建，会连带清空全部历史。轮换后需人工到目标机更新 `AGENT_KEY` 并重启 agent（key 是 agent 侧配置的静态凭据，服务端无法推送给未连接的 agent）。
- **界面细节**：顶栏 ☀️/🌙 切换**深浅主题**（持久化，终端配色与监控图表同步热更新）；长时间无操作会提示并**自动暂停推送**（IdleGuard，省配额，任何操作即恢复）；开启 `geo_lookup` 后卡片与审计日志的 IP 会显示**归属地旗帜**（旗帜渲染能力运行时检测，不支持时回退图片）；支持 PWA「添加到主屏幕」（含 manifest 与 SVG 图标）。
- **国际化**：界面文案全部走 `t(key)`，语言包在 **`public/lang/<语言代码>.js`**（当前内置 `zh-CN` 简体中文与 `en-US` English）。☰ 菜单底部有**语言切换**，切换即时生效：静态文本与服务器卡片等动态内容立即重渲染，选择持久化（下次访问沿用）；未手动选择时跟随浏览器语言。新增语言 = 在 `public/lang/` 加一个语言包文件 + 在 `index.html` 加一行 `<script>`（零构建下无法扫描目录，显式引入是刻意取舍），业务代码零改动。
  > 语言选择优先级为「手动选择 > 浏览器语言 > 默认」，只有已加载（已注册）的语言会出现在菜单里，不会落到"半翻译"状态。缺失的 key 会**原样显示 key 本身**而不是空白——开发期一眼看出未翻译项，线上也不会出现"界面大片空白"这种更糟的失败形态。`index.html` 里保留中文文本作为 zh-CN 兜底（避免语言包加载前闪烁），切到其他语言时由 `applyDom()` 覆盖。

## 四、API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 用面板密码（PANEL_USERS/PANEL_PASSWORD）登录，返回 JWT |
| GET | `/api/me` | 当前用户（JWT 或 PAT） |
| GET | `/api/public/settings` | 公开配置（站点名/公告，D1 kv_json，无需登录） |
| GET | `/api/servers` | 服务器列表（含分组、序号；按权限过滤） |
| GET | `/api/healthz` | 存活探针：**不鉴权、不查 D1**，仅返回 `{ok,ts}`；刻意不接触任何依赖，DB 抖动不会被误报成面板不可用 |
| POST | `/api/servers` | 添加服务器（name + 可选 group/sort_order），返回 agent 配置 |
| PATCH | `/api/servers/:id` | 修改名称/分组/序号/**告警阈值覆盖**（仅管理员；不动 agent key，在线状态不受影响）。`alert_override` 传 `null` 清除覆盖回退全局，不传则保持原值 |
| POST | `/api/servers/:id/rotate-key` | 轮换 agent key（仅管理员）：旧 key 立即失效并断开现有连接，**保留监控历史与审计记录**；返回新 key 明文（仅此一次） |
| POST | `/api/servers/batch` | 批量操作（仅管理员）：`op` 为 `update-group`（单事务，全成功或全回滚）或 `delete`（逐台级联），`ids` 去重后上限 100；返回逐项 `results` 与 `summary`，部分失败不会让整体变成 500 |
| DELETE | `/api/servers/:id` | 删除服务器（仅管理员） |
| GET | `/api/agent/latest` | 最新 Agent Release 清单摘要（仅管理员，5 分钟缓存） |
| POST | `/api/servers/:id/agent-update` | 流式更新指定 Agent（仅管理员；需节点启用 `ALLOW_SELF_UPDATE=1`） |
| POST | `/api/terminal` | 创建终端会话（exec 权限 + 归属校验），返回 session_id |
| POST | `/api/file/open` | 创建文件管理会话（exec 权限 + 归属校验），返回 session_id |
| GET | `/api/usage` | 用量观测（近 24h 上报帧 / DO 事件 / D1 写行估算，仅管理员） |
| GET | `/ws/terminal/{id}` | 浏览器终端 WebSocket（校验创建者/admin） |
| GET | `/ws/file/{id}` | 浏览器文件管理 WebSocket（JSON 行协议：list/read/write/zip/rename/delete/**mkdir**/**touch**/**move**/**copy**/**chmod**/**find**，校验创建者/admin） |
| GET | `/ws/agent/file` | agent 文件数据流（key 校验 + stream 归属校验） |
| GET | `/ws/push` | 面板实时刷新：首帧 sync 后被动接收上报驱动推送，服务端按权限返回服务器列表 |
| GET | `/ws/agent/control` | agent 控制通道（key 指纹定位 + 校验，按分片路由；监控上报也走这里） |
| GET | `/ws/agent/terminal` | agent 终端数据流（key 校验 + stream 归属校验） |
| GET | `/api/monitor?server_id=&range=` | 监控历史（range: 1h/12h/3d/7d/30d，默认 12h 走内存，更早走 D1） |
| GET | `/api/stats?server_id=&days=` | 按天统计（流量累计 / 可用率 / 重启次数）：`days` 默认 30、上限 1095（= 天账保留期）。返回逐日 `rows`（含 `ts` 当天起始 unix 秒与 `availability`）与区间 `summary`；无数据时 `availability` 为 `null` |
| GET | `/api/group-order` | 分组显示顺序（组名数组）；读：所有登录用户，写（PUT）：仅管理员，自动与现存分组求交清理孤儿组名 |
| GET | `/api/tokens` | PAT 列表（仅管理员，含 `last_used_at` 最近使用时间，未使用过为 `null`） |
| POST | `/api/tokens` | 创建 PAT（scopes + server_ids 白名单 + 可选 `expires_in_days` 有效期，缺省永久；明文只返回一次） |
| DELETE | `/api/tokens/:id` | 删除 PAT（仅管理员；不存在的 id 返回 404） |
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
| `update_server` | 修改服务器名称/分组/排序/**告警阈值覆盖**（仅管理员；`server_id`/`server_name` + 要改的字段；`alert_override` 传 `null` 清除覆盖，不传保持原值） |
| `rotate_agent_key` | 轮换 agent key（仅管理员）：旧 key 立即失效并断开连接，**监控历史与审计记录保留**；返回明文 `agent_key`（仅一次）与 `wss_base` |
| `delete_server` | 删除服务器（仅管理员；清监控历史 + 审计 + 断开 agent） |
| `list_tokens` | 列出 PAT 概要（仅管理员，不含哈希/明文） |
| `create_token` | 创建 PAT（仅管理员；`name` + `scopes`/`server_ids`/`expires_in_days`（缺省永久），明文只返回一次） |
| `revoke_token` | 撤销 PAT（仅管理员，立即失效） |
| `get_audit_logs` | 审计日志（仅管理员，`limit`/`offset`/`action`/`user`/`server_id` 分页筛选，返回 `{rows,total}`，保留 90 天） |
| `get_usage` | 用量观测（仅管理员：上报帧/DO 事件/D1 写行估算） |
| `get_settings` / `update_settings` | 读取/更新面板设置（仅管理员：站点名/公告/IP 归属地开关/告警配置，含全局免打扰 `mute_until`） |

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
- 面板登录密码存 CF secret（`PANEL_USERS`/`PANEL_PASSWORD`），不进代码库；agent key 与 PAT 只存哈希（key 指纹用于检索，HMAC 哈希用于校验）。WebSocket Hibernation 附件同样不保存 bearer 明文：PAT 仅保存 HMAC，JWT 仅保存已验证身份及过期时间。
- 浏览器 WebSocket 建连后须在 10 秒内完成首帧鉴权；PanelDO 与每个 TerminalDO 分片最多保留 128 条待鉴权连接，超时由 DO alarm 主动关闭。
- 审计日志：`server.create/update/delete`、`terminal.open`、`file.open/upload/write/zip/rename/delete`、`exec.command` 写 `audit_logs`（WS 文件操作在 DO 拦截指令记录；`exec.command` 含命令与 exit_code）。终端/文件会话横跨 DO 与 D1，审计写入为 best-effort：D1 短暂失败时记录 Worker 错误但仍返回已创建的可用会话，避免遗留不可访问的远端会话。审计用户名与客户端 IP 随会话元数据和安全附件跨休眠恢复。
- agent 侧 `DISABLE_EXEC=1` 可全局禁止命令执行（终端任务直接忽略）；上传、ZIP 预检及文件操作统一进入带超时、并发上限和熔断的 blocking 边界，避免异常挂载冻结 async 控制循环。
- 文件列表按不可信 Agent 输入处理：前端白名单化条目类型并数值化大小/时间；文件会话使用代际守卫丢弃关闭后或乱序的创建响应，防止跨服务器串台。
- 静态资源 CSP 将 `'unsafe-inline'` 仅限于 `style-src-attr`，脚本和 style 元素均不允许内联执行。
- 终端/监控接口按权限收敛：JWT 管理员全量；PAT 按 scopes + server_ids 白名单收窄。

## 六、架构要点（多 DO 分片等）

- **多 DO 分片**：终端 DO `SHARDS = 4`，streamId 带 `shard-序号` 前缀，浏览器/agent 的 WS 请求按前缀路由到对应 DO 实例，避免单点瓶颈。
- **实时刷新 PanelDO**：单实例 DO，前端 `/ws/push` 连接后**首帧 sync 即订阅**，此后由监控上报驱动实时推送（服务器变化/新数据时回发列表）；DO 用 Hibernation API，空闲即休眠（不计时长），按用户权限过滤（在线状态秒级更新）。
- **会话回收**：终端会话两端都断开超过 10 分钟，DO alarm 清理；活跃会话也受 4 小时绝对上限约束。
- **监控时序（MetricsDO，默认开启归档）**：agent 上报先写 DO Storage 热区（默认保留最近 **240** 分钟/机，前端查询秒回；`ARCHIVE_TO_D1=0` 关闭归档时回退 **720** 分钟以保住 12h 可查历史——此时热区是唯一存储）。常态归档由上报路径增量完成，alarm 每 10 分钟兜底把超过 1 小时的旧数据批量写入 `metrics_min` 表（写入量 ≈ 60 行/机/小时，免费额度内），并按 **30 天保留期**每日清理过期行（重启不丢历史）。兜底归档按服务器隔离批次，只有 D1 全批次与持久水位成功后才删除对应热区源行；失败会在下个 alarm 幂等重试。`ARCHIVE_TO_D1=0` 可关闭归档（关闭后仅内存 12 小时）。
- **按天账（MetricsDO，独立于归档开关）**：上报路径同时把每个观测区间**实时累加**进 `metrics_day`（1 行/机/天：流量累计、在线分钟、纳入统计分钟、重启次数），alarm 每 10 分钟落库并补记离线机器的可用率分母。它**不受 30 天保留期与降采样影响**（默认保留 3 年），是月度流量与可用率的唯一数据源——`metrics_min` 跨不了月，且离线期间没有行、事后反推不出可用率。实例 evict 最多丢一个 flush 周期（≤10 分钟）的增量，已入账数据不受影响。
- **已知限制**：
  - 终端 DO 会话状态在内存（僵尸会话按 10 分钟 TTL 回收，DO alarm 兜底保证零流量时也会清理；实例迁移会中断活跃终端；可后续迁 DO Storage）。
  - D1 归档默认开启（保留 30 天）；若关闭（`ARCHIVE_TO_D1=0`），DO 重启会丢失 12 小时外的历史。
  - 终端为多标签但受并发上限约束：前端最多 8 个标签（浏览器 WebGL 上下文限制），后端每服务器 8 个并发会话。
  - 递归搜索按**文件名**匹配（不支持按内容搜索）；结果上限 1000 条、扫描上限 5 万条目，超限时结果不完整（会明确提示）。
  - 温度指标由 agent 上报且展示在卡片 tooltip，但监控图表未单独出图。
  - 界面为全中文硬编码，未做 i18n。PWA 仅提供 manifest（可"添加到主屏幕"），未接入 Service Worker——离线缓存会与实时推送的时效性语义冲突。
  - 流量与可用率是**按天聚合的账**：精度受上报间隔限制（无人观看时慢采 120 秒），单次故障的检测延迟最多约 3 分钟，不适用于 99.99% 级别的 SLA 承诺。
  - Rust agent 为推荐实现（内存低、全静态单文件、任意发行版直跑）；Shell 版（`agent/shell/`）已废弃仅作参考。
  - 多用户通过 `PANEL_USERS` 环境变量配置（`user:pass,user:pass`），所有用户同权限（管理员）；如需按用户分配服务器归属，可恢复 `users` 表逻辑。
