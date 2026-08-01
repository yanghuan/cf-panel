# cf-panle

在 Cloudflare 上实现带终端功能的监控面板。

- 前端：Cloudflare Pages（纯静态 + xterm.js，零构建）
- 后端：Cloudflare Workers + Durable Objects（WebSocket 双向中转）+ D1（面板核心数据）+ KV（公开配置）
- Agent：纯 Shell 脚本（`websocat` + `socat` + `jq`），部署在每台目标机器上，与面板通过 WebSocket 通信

架构设计见 [docs/architecture.md](docs/architecture.md)。

## 目录结构

```
cf-panle/
├── wrangler.toml        # Worker/DO/D1/KV/静态资源配置
├── schema.sql           # D1 数据库表
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

# 2. 创建 KV namespace，把返回的 id 填入 wrangler.toml
wrangler kv namespace create CF_PANLE_KV

# 3. 建表（远程库）
wrangler d1 execute cf-panle --remote --file=schema.sql

# 4. 设置密钥（必做，生产安全）
wrangler secret put JWT_SECRET        # JWT 签名密钥
wrangler secret put PANEL_PASSWORD    # 面板登录密码（登录只填这个）

# 5. 部署
wrangler deploy
```

> 已部署过旧版（有 `users` 表/用户名登录）？执行分组迁移：
> `wrangler d1 execute cf-panle --remote --command 'ALTER TABLE servers ADD COLUMN "group" TEXT NOT NULL DEFAULT "";'`

部署完成后访问 `https://cf-panle.<你的子域>.workers.dev`，输入 `PANEL_PASSWORD` 密码即可登录（登录即管理员）。

本地调试：`wrangler dev --local`（本地 SQLite 建表：`wrangler d1 execute cf-panle --local --file=schema.sql`）。

## 二、添加服务器并安装 agent

1. 在面板点「添加服务器」→ 填名称（可选填分组）→ 弹出一次性 agent 配置（WSS 地址 / UUID / KEY），**妥善保存**。
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
   AGENT_UUID=<你的 uuid>
   AGENT_KEY=<你的 key>
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
   echo '* * * * * REPORT_URL=https://<面板域名>/api/report AGENT_UUID=<uuid> AGENT_KEY=<key> /opt/cf-panle-agent/report.sh' | crontab -
   ```

## 三、使用

- **终端**：面板服务器卡片点「终端」→ xterm.js 弹出 → 按键实时到达被控机 shell；窗口拉伸自动 resize（经控制通道 `stty` 下发）。
- **监控**：点「监控」查看近 12 小时 CPU/内存分钟数据。
- **分组**：添加服务器时填分组名，列表按分组展示（未填归入「未分组」）。
- **登录**：单面板密码（`PANEL_PASSWORD`，存 CF secret），登录即管理员。

## 四、API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 用面板密码（PANEL_PASSWORD）登录，返回 JWT |
| GET | `/api/me` | 当前用户 |
| GET | `/api/servers` | 服务器列表（含分组） |
| POST | `/api/servers` | 添加服务器（name + 可选 group），返回 agent 配置 |
| DELETE | `/api/servers/:id` | 删除服务器 |
| POST | `/api/terminal` | 创建终端会话，返回 session_id |
| GET | `/ws/terminal/{id}` | 浏览器终端 WebSocket（校验创建者/admin） |
| GET | `/ws/agent/control` | agent 控制通道（uuid+key 校验） |
| GET | `/ws/agent/terminal` | agent 终端数据流（stream 归属校验） |
| POST | `/api/report` | agent 监控上报（uuid+key 校验） |
| GET | `/api/monitor?server_id=` | 监控历史 |

## 五、安全要点（实现清单已覆盖）

- `/ws/terminal/{id}` 仅允许会话创建者或管理员连接（防 UUID 劫持，GHSA 教训）。
- agent 建连必须提供 `X-Agent-Key`（或 query key），并与 `servers.agent_key_hash` 比对；`/ws/agent/terminal` 额外校验 stream 归属。
- 面板登录密码存 CF secret（`PANEL_PASSWORD`），不进代码库；agent key 只存 HMAC 哈希。
- 审计日志：`terminal.open` / `server.create` 写 `audit_logs`。

## 六、已知限制 / 后续

- DO 会话状态在内存（MVP）：DO 实例迁移/重启会中断活跃终端，可后续迁移到 DO Storage。
- 监控为分钟级聚合，写入量受 D1 免费配额约束（约 10 万行/天）；机器多再上外部时序库。
- 纯 Shell agent 适合个人/小规模；并发大了可无缝换 Go/Rust agent（协议不变）。
- PAT（`api_tokens` 表）已建表预留，未实现创建/校验接口。
- 登录已简化为单密码（环境变量）；如后续需要多用户/用户名登录，可恢复 `users` 表逻辑。
