# cf-panle

在 Cloudflare 上实现带终端功能的监控面板。

- 前端：Cloudflare Pages（纯静态 + xterm.js，零构建）
- 后端：Cloudflare Workers + Durable Objects（WebSocket 双向中转）+ D1（面板核心数据 + kv_json 键值表）
- Agent：纯 Shell 脚本（`websocat` + `socat` + `jq`），部署在每台目标机器上，与面板通过 WebSocket 通信

架构设计见 [docs/architecture.md](docs/architecture.md)。

## 目录结构

```
cf-panle/
├── wrangler.toml        # Worker/DO/D1/静态资源配置
├── schema.sql           # D1 数据库表（含 kv_json 键值表）
├── src/index.js         # Worker：REST API + 鉴权 + TerminalDO 双端对拷
├── public/              # 前端（index.html / app.js / style.css）
├── agent/               # 被控机 agent（agent.sh / report.sh / systemd 模板）
└── docs/architecture.md # 架构设计文档
```

## 一、部署面板（Cloudflare）

前置：已安装 [wrangler](https://developers.cloudflare.com/workers/wrangler/) 并登录（`wrangler login`）。

```bash
# 1. 创建 D1 数据库，把返回的 database_id 填入 wrangler.toml
wrangler d1 create cf-panle

# 2. 建表（远程库）
wrangler d1 execute cf-panle --remote --file=schema.sql

# 3. 设置密钥（必做，生产安全）
wrangler secret put JWT_SECRET        # JWT 签名密钥
wrangler secret put PANEL_PASSWORD    # 面板登录密码（登录只填这个）

# 4. 部署
wrangler deploy
```

> 已部署过旧版（无 `"group"` 列 / 无 `kv_json` 表）？执行迁移：
> ```
> wrangler d1 execute cf-panle --remote --command 'ALTER TABLE servers ADD COLUMN "group" TEXT NOT NULL DEFAULT "";'
> wrangler d1 execute cf-panle --remote --command 'CREATE TABLE IF NOT EXISTS kv_json (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime("now")));'
> ```
>
> 已按旧版（带 `uuid` 列）添加过服务器？`agent_key_id`（key 指纹）无法从旧数据回填，需要重建 `servers` 表或在面板删除旧服务器后重新添加，agent 端改用新版 `agent.sh`/`report.sh`（只配 `AGENT_KEY`）：
> ```
> wrangler d1 execute cf-panle --remote --command 'DROP TABLE servers;'
> # 再执行 wrangler d1 execute cf-panle --remote --file=schema.sql 重建
> ```

部署完成后访问 `https://cf-panle.<你的子域>.workers.dev`，输入 `PANEL_PASSWORD` 密码即可登录（登录即管理员）。

本地调试：`wrangler dev --local`（本地 SQLite 建表：`wrangler d1 execute cf-panle --local --file=schema.sql`）。

## 二、添加服务器并安装 agent

1. 在面板点「添加服务器」→ 填名称（可选填分组）→ 弹出一次性 agent 配置（WSS 地址 / KEY），**妥善保存**。KEY 是 agent 的唯一身份 + 凭证（uuid 已废弃）。
2. 在目标 Linux 机器上安装依赖：
   ```bash
   # websocat（必装）：https://github.com/vi/websocat/releases 下载静态二进制
   # socat / jq（一般发行版自带）
   apt install -y socat jq   # Debian/Ubuntu
   ```
3. 放置脚本并配置环境：
   ```bash
   mkdir -p /opt/cf-panle-agent
   cp agent/agent.sh agent/report.sh /opt/cf-panle-agent/
   chmod +x /opt/cf-panle-agent/*.sh
  cat > /etc/cf-panle-agent.env <<EOF
  AGENT_WSS_URL=wss://<面板域名>/ws/agent
  AGENT_KEY=<你的 key>
  DISABLE_EXEC=0   # 设为 1 可全局禁止命令执行（终端不可用，仅保留监控）
  EOF
   ```
4. 注册 systemd 服务：
   ```bash
   cp agent/cf-panle-agent.service /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now cf-panle-agent
   journalctl -u cf-panle-agent -f   # 看日志
   ```
5. 可选：监控上报 crontab（每分钟）：
   ```bash
   echo '* * * * * REPORT_URL=https://<面板域名>/api/report AGENT_KEY=<key> /opt/cf-panle-agent/report.sh' | crontab -
   ```

## 三、使用

- **终端**：面板服务器卡片点「终端」→ xterm.js 弹出 → 按键实时到达被控机 shell；窗口拉伸自动 resize（经控制通道 `stty` 下发）；断线自动重连（最多 3 次）。
- **监控**：点「监控」查看近 12 小时 CPU/内存分钟数据（存内存 DO 热区，秒回，不占 D1 配额）。
- **分组与排序**：添加服务器可填「分组」和「序号」，列表按分组展示、组内按序号排序（未填归入「未分组」）。
- **登录**：单面板密码（`PANEL_PASSWORD`，存 CF secret），登录即管理员。
- **公告**：设置里可改站点名/公告（存 D1 `kv_json` 表），公告对所有访客可见。
- **PAT**：设置里可创建访问令牌（scopes + server_ids 白名单），供 API 调用（`Authorization: Bearer cfp_xxx`）。

## 四、API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 用面板密码（PANEL_PASSWORD）登录，返回 JWT |
| GET | `/api/me` | 当前用户（JWT 或 PAT） |
| GET | `/api/public/settings` | 公开配置（站点名/公告，D1 kv_json，无需登录） |
| GET | `/api/servers` | 服务器列表（含分组、序号；按权限过滤） |
| POST | `/api/servers` | 添加服务器（name + 可选 group/sort_order），返回 agent 配置 |
| DELETE | `/api/servers/:id` | 删除服务器（仅管理员） |
| POST | `/api/terminal` | 创建终端会话（exec 权限 + 归属校验），返回 session_id |
| GET | `/ws/terminal/{id}` | 浏览器终端 WebSocket（校验创建者/admin） |
| GET | `/ws/agent/control` | agent 控制通道（key 指纹定位 + 校验，按分片路由） |
| GET | `/ws/agent/terminal` | agent 终端数据流（key 校验 + stream 归属校验） |
| POST | `/api/report` | agent 监控上报（key 指纹定位 + 校验） |
| GET | `/api/monitor?server_id=` | 监控历史 |
| GET | `/api/tokens` | PAT 列表（仅管理员） |
| POST | `/api/tokens` | 创建 PAT（scopes + server_ids 白名单，明文只返回一次） |
| DELETE | `/api/tokens/:id` | 删除 PAT（仅管理员） |
| PUT | `/api/settings` | 更新站点名/公告（D1 kv_json，仅管理员） |

## 五、安全要点（实现清单已覆盖）

- `/ws/terminal/{id}` 仅允许会话创建者或管理员连接（防 stream UUID 劫持，GHSA 教训）。
- agent 建连必须提供 `X-Agent-Key`（或 query key）；服务端先用 key 的 SHA-256 指纹（`servers.agent_key_id`）反查服务器，再与 `servers.agent_key_hash` 比对；`/ws/agent/terminal` 额外校验 stream 归属。
- 面板登录密码存 CF secret（`PANEL_PASSWORD`），不进代码库；agent key 与 PAT 只存哈希（key 指纹用于检索，HMAC 哈希用于校验）。
- 审计日志：`terminal.open` / `server.create` 写 `audit_logs`。
- agent 侧 `DISABLE_EXEC=1` 可全局禁止命令执行（终端任务直接忽略）。
- 终端/监控接口按权限收敛：JWT 管理员全量；PAT 按 scopes + server_ids 白名单收窄。

## 六、架构要点（多 DO 分片等）

- **多 DO 分片**：终端 DO `SHARDS = 4`，streamId 带 `shard-序号` 前缀，浏览器/agent 的 WS 请求按前缀路由到对应 DO 实例，避免单点瓶颈。
- **会话回收**：终端会话两端都断开超过 10 分钟，DO 惰性清理（每 60s 扫描一次）。
- **监控时序存内存 DO（MetricsDO）**：agent 上报直接写内存滚动窗口（保留最近 720 分钟/机），前端查询秒回，**默认不写 D1**。可选 `ARCHIVE_TO_D1=1`（`wrangler secret put ARCHIVE_TO_D1 1`）开启 alarm 定时归档：每 10 分钟把超过 1 小时的旧数据批量写入 `metrics_min` 表后从内存移除（重启不丢历史，写入量 ≈ 60 行/机/小时，配额友好）。
- **已知限制**：
  - 终端 DO 会话状态在内存（TTL 回收兜底，但实例迁移会中断活跃终端；可后续迁 DO Storage）。
  - 监控纯内存模式（默认）下 DO 重启会丢失历史数据；需要历史则开 `ARCHIVE_TO_D1=1`。
  - 监控展示为文本列表（数据齐备，可迭代成图表）。
  - 纯 Shell agent 适合个人/小规模；并发大了可无缝换 Go/Rust agent（协议不变）。
  - 登录为单密码（环境变量）；如需要多用户/用户名登录，可恢复 `users` 表逻辑。
