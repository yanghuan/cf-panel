# Exec / Upload / Agent Update 异步化开发文档

> 状态：阶段 A / B / C / D 全部已实现；旧同步路径已于 2026-10-28 删除（阶段 E）  
> 基线提交：`832dff7`  
> 日期：2026-10-28  
> 目标读者：实现 Agent、Review/验收人员

**实现进度**

- [x] 阶段 A：`operation_jobs`（迁移 0015）+ `src/jobs.js` + `POST /api/exec-jobs` / `GET /api/jobs/:id`
      + DO `/rpc/exec/submit` 与 `exec_result` 落库回调 + MCP `get_operation`
- [x] 阶段 B：R2 staging / Agent `upload_fetch`
- [x] 阶段 C：agent update 异步 / Worker 资产代理
- [x] 阶段 D：cron 清理与观测（旧同步路径**保留**，见下方偏差 5）
- [x] 阶段 E：旧同步路径删除（2026-10-28，fleet 全量新版后：`/rpc/exec`、`/rpc/upload`、`/rpc/agent_update`、`/mcp/file_upload`、`pendingExec`/`pendingUpload`/`pendingUpdate`、`doUpload`/`doAgentUpdate`、`signUploadToken`/`verifyUploadToken`；探活测试已迁移到 `/rpc/exec/submit`）

**实现偏差（已评审接受）**

1. `kind` / `status` 均不加 `CHECK`：SQLite 无法 `ALTER CHECK`，状态机演进会被迫重建表；取值由 `src/jobs.js` 校验。
2. cron 清理未接线（属阶段 D）。为防 D1 无限增长，`createExecJob` 每次顺手删除 `expires_at < now` 的行。
3. 过期收敛放在 `GET /api/jobs/:id` 内顺手完成（`deadline_at` 已过 → `expired`），不依赖 cron 与 DO timer。
4. 互斥只针对 `agent_update`：exec 之间、exec 与 upload 之间保持既有并发语义（见下方 §9.3）。
5. **旧同步路径未删除**（`/rpc/exec`、`/rpc/upload`、`/rpc/agent_update` 与 LEGACY_SYNC_UPDATE）：
   保留以便线上出问题时用环境变量回退。代价是两条链路长期共存、需一并维护；
   待新路径稳定一段时间后再单独提交删除。
   → 2026-10-28 已删除（fleet 全量升级到 2026.10.27 后，Worker 侧 LEGACY 门先删、DO 侧同步中继后删，分两批提交部署）。
6. Agent 侧不引入 reqwest：新增 `agent/rust/src/fetch.rs` 手写 HTTPS GET（复用现有
   rustls/DNS），同时支持 `Content-Length` 与 `chunked` 两种响应。零新增依赖。
7. **断连语义按 kind 区分**（见 §9.1）：只有 `upload` 实现"重连后自动重发"，因为重下同一份
   字节是幂等的；`exec` 重发可能重复执行已生效的命令，`agent_update` 重发可能二次替换二进制，
   两者都只快速失败。三种语义不同是刻意的，不是遗漏。
8. **cron 清理已接线**（`src/index.js` 的 `scheduled`），偏差 2 描述的"机会式清理"降级为兜底。

**复核中修复的实现缺陷（记录以免重犯）**

| 问题 | 后果 |
| --- | --- |
| `self_replace` 后未 `notify_waiters()` | 进程继续跑旧映像，版本号永不更新，任务却已 `succeeded` |
| `updating` 只在 send 抛错时清 | 一次更新后该机器在本 DO 实例存活期内永久 409 |
| 异步上传漏 `is_system_path` / `overwrite` 检查 | 安全净回退：可写 `/etc/cron.d/`，且静默覆盖同名文件 |
| 上传下载传 `expect_size=None` | 截断响应被判成功，目标位置留下短文件 |
| `failJob` 只覆盖 `queued/running` | upload 下发失败停在 `staged`，客户端一直显示"等待 Agent" |
| 过期判定不删 R2 对象 | 废弃的 100MB 暂存件白躺 24 小时，几十次顶满免费额度 |
| `AGENT_UPGRADE_REQUIRED` 判定在写审计之后 | 被拒绝的请求留下"已请求更新"审计，排查时误判为下发失败 |
| `streamToR2` 先攒后写 | 100MB 上传驻留 100MB 内存，并发即 OOM（上限 128MB） |

## 1. 结论先行

当前 `exec_command`、MCP 文件上传和 Agent 自更新都是**在 Durable Object 的 fetch 请求内同步等待 Agent 回执**：

- exec：最长 `25s + 5s`，一次请求让 shard DO 保持活跃约 30 秒。
- upload：最长 `120s`，请求体经过 Worker → DO → Agent，DO 在整个传输和落盘期间保持活跃。
- agent update：最长 `180s`，Worker 下载 Release 资产后经 DO 分片中继给 Agent，DO 在传输、校验和替换期间保持活跃。

DO 的 duration 按**对象活跃墙钟时间 × 128MB**计费，等待 pending I/O 同样计入。`setTimeout` 也会阻止 Hibernation。因此这不是“5 秒改 10 秒”或“升 Paid”能根治的问题，必须把长等待从 DO 请求上下文中移走。

本次改造的目标：

1. DO 只做短控制面：下发指令、处理结果回调，**不在请求内等执行完成**。
2. exec 任务状态和结果落 D1，客户端/MCP 通过 Worker 轮询 D1，不再访问 DO。
3. upload 数据面移出 DO：客户端先写 R2，Agent 再从短期签名 URL 拉取；DO 只下发元数据。
4. agent update 数据面移出 DO：Agent 从 Worker 提供的短期签名资产 URL 下载，DO 只下发更新元数据。
5. 全程不使用长 `setTimeout` 维持任务，不依赖 DO 内存 `Map`，DO Hibernation/evict 后任务仍可恢复。
6. 保持权限、路径保护、审计、大小限制和现有交互语义不降级。

## 2. 现状与问题

### 2.1 exec 链路

```text
MCP tools/call
  -> Worker mcpExecCommand
  -> Worker -> TerminalDO /rpc/exec
  -> Agent 执行命令
  -> Agent 回 exec_result
  -> TerminalDO resolve Promise
  -> Worker 返回 MCP 结果并写审计
```

关键代码：`src/routes.js` 的 `mcpExecCommand`、`src/do-terminal.js` 的 `/rpc/exec`。

问题：

- DO 请求从下发一直挂到 `exec_result` 或 30 秒兜底超时。
- `pendingExec` 存在 DO 内存，DO evict 后无法恢复；目前只是靠请求本身保持活跃才没暴露。
- 兜底使用 `setTimeout(30s)`，即使请求提前返回，残留 timer 也会阻止 Hibernation。
- MCP 客户端、Worker 请求、DO 请求都被命令执行时间绑定。

### 2.2 MCP upload 链路

```text
MCP create_upload
  -> Worker 签发签名 URL
  -> 客户端 POST /mcp/file_upload
  -> Worker 读取 body
  -> Worker -> TerminalDO /rpc/upload
  -> DO 分片转发 Agent control WS
  -> Agent 写入临时文件、fsync、rename
  -> Agent 回 upload_result(commit=true)
  -> DO resolve Promise
```

关键代码：`src/routes.js` 的 `forwardUpload` / `handleUploadSigned`，`src/do-terminal.js` 的 `/rpc/upload` 和 `doUpload`。

问题：

- 文件字节和等待回执都在 DO 请求内，最大 120 秒 duration。
- `pendingUpload` 与 `uploading` 均在 DO 内存，evict 后不可恢复。
- `create_upload` 当前在“签发 URL”时写 `file.upload` 审计，只代表签发，不代表文件真正上传；同一个签名 URL 在有效期内还可重复使用。
- 只把“提交接口”改成返回 202 而仍让 DO 读 body，**不会降低 duration**，因为数据面仍在 DO。

### 2.3 agent_update 链路

```text
REST /api/servers/:id/agent-update 或 MCP update_agent
  -> Worker 查 Release manifest
  -> Worker 从 GitHub 下载资产
  -> Worker -> TerminalDO /rpc/agent_update（body 为资产流）
  -> DO 逐 48KB 帧经 control WS 转发 Agent
  -> Agent staging/SHA-256/版本校验/self-replace
  -> Agent 回 agent_update_result
  -> DO resolve Promise（最长 180s）
  -> Worker 写结果审计
```

关键代码：`src/routes.js` 的 `agentUpdateCore`，`src/do-terminal.js` 的 `/rpc/agent_update` / `doAgentUpdate`，`agent/rust/src/update.rs`。

问题：

- Worker 的资产流经 DO，DO 在下载、帧转发、Agent 校验/替换的全程保持活跃，最长 180 秒。
- `pendingUpdate` 与 180 秒 `setTimeout` 都在 DO 内存。
- 资产已经通过 Worker 的 GitHub 缓存下载，但 Agent 仍需从 DO 接收完整二进制，无法利用“Agent 自己拉取”的天然解耦。
- 更新是供应链高危操作，不能为了异步化绕过 SHA/版本校验和审计。

### 2.4 为什么不能只做调优

- 把快采 5 秒改成 10 秒：降低唤醒频率，是有效的止血，但不改变长等待结构。
- 升 Paid：只是取消每日硬停并转为按量账单，不改变单次长请求的 duration。
- 真正要修的是：DO 请求不再承载执行/传输的全程。

## 3. 设计原则

1. **D1 是任务事实源**：状态、结果、期限均落 D1；DO 内存只做最多几秒的瞬时回调状态。
2. **Worker 轮询不经过 DO**：`GET /api/jobs/:id` 只鉴权 + 查 D1。
3. **DO 回调必须短**：下发后立即返回；Agent 结果通过 WebSocket 唤醒 DO，写 D1 后结束。
4. **不使用长 `setTimeout` / `setInterval` 维持任务**：超时由 `deadline_at` + Worker/Cron 判定。
5. **upload 数据面走 R2**：DO 只传任务元数据，不转发文件字节。
6. **agent update 数据面走 Worker 资产代理**：Agent 主动下载，DO 只传任务元数据和结果。
7. **权限在提交和查询时都校验**：PAT 撤销/降权后不再能读取结果；已下发的命令不能撤回，这一点必须在文档中明示。
8. **新旧兼容分阶段**：旧同步 upload / update 端点保留一个过渡期，旧 Agent 必须能完成自举更新；新流程默认不降级到同步模式。

## 4. 总体架构

```text
exec:

MCP/HTTP submit
  -> Worker 鉴权，创建 D1 job(queued)
  -> Worker -> TerminalDO /rpc/exec/submit（短请求）
  -> DO 下发 WS exec 帧，更新 D1 running，返回 accepted
  -> Agent exec_result
  -> DO WebSocket 回调更新 D1 -> 写审计
  -> 客户端/ MCP 轮询 Worker GET /api/jobs/:id -> D1

upload:

MCP create_upload / POST /api/upload-jobs
  -> Worker 创建 D1 job(awaiting_upload)
  -> 返回短期签名 upload_url
  -> 客户端 POST 字节到 Worker
  -> Worker 流式写 R2 staging，更新 D1(staged)
  -> Worker -> DO /rpc/upload/submit（短请求）
  -> DO 下发 upload_fetch 元数据，更新 D1(running)
  -> Agent 从短期签名 URL 拉取 R2 对象
  -> Agent 写临时文件、校验、fsync、rename
  -> Agent upload_result
  -> DO 回调更新 D1，删除 R2 对象
  -> 客户端轮询 D1

agent update:

POST /api/servers/:id/agent-update / MCP update_agent
  -> Worker 校验 Release manifest 和 canUpdateAgent
  -> 创建 D1 job(queued)，返回 job_id
  -> Worker -> DO /rpc/agent_update/submit（短请求）
  -> DO 下发 agent_update_fetch(元数据 + 短期资产 URL)
  -> Agent 从 Worker 资产代理下载 Release 资产
  -> Agent staging/SHA-256/版本校验/self-replace
  -> Agent agent_update_result
  -> DO 回调更新 D1/审计
  -> 客户端/MCP 轮询 D1
```

关键边界：

- 客户端上传字节：Worker ↔ R2，不经过 DO。
- Agent 下载字节：Agent ↔ Worker/R2，不经过 DO。
- Agent 更新资产：Agent ↔ Worker 资产代理，不经过 DO；Worker 可复用 Release 边缘缓存。
- DO 的 HTTP 请求只承载控制帧和结果回调。

## 5. 数据模型

新增迁移 `migrations/0015_async_operation_jobs.sql`，并同步 `schema.sql`（测试库以 `schema.sql` 建表）。

### 5.1 任务表

```sql
CREATE TABLE IF NOT EXISTS operation_jobs (
  id              TEXT PRIMARY KEY,
  -- kind / status 刻意**不加 CHECK**（见顶部"实现偏差 1"）：SQLite 无法 ALTER CHECK，
  -- 状态机演进会被迫重建表。取值由 src/jobs.js 校验。
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,
  user_id         INTEGER NOT NULL,
  username        TEXT NOT NULL,
  client_ip       TEXT,
  server_id       INTEGER NOT NULL,

  -- exec
  command         TEXT,
  timeout_s       INTEGER,
  idempotency_key TEXT,
  exit_code       INTEGER,
  stdout          TEXT,
  stderr          TEXT,
  timed_out       INTEGER,

  -- upload
  target_path     TEXT,
  overwrite       INTEGER NOT NULL DEFAULT 0,
  size_bytes      INTEGER,
  sha256          TEXT,
  r2_key          TEXT,

  -- agent_update
  build_id        TEXT,
  from_version    TEXT,
  to_version      TEXT,
  platform        TEXT,
  asset_url       TEXT,                    -- 经 manifest 校验后的 GitHub asset URL

  error           TEXT,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER,
  deadline_at     INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  duration_ms     INTEGER,
  dispatch_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_operation_jobs_user_created
  ON operation_jobs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operation_jobs_cleanup
  ON operation_jobs(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_operation_jobs_server_status
  ON operation_jobs(server_id, kind, status);

-- 同一服务器同时只允许一个 upload 任务，保持当前 uploading 串行语义
CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_jobs_active_upload
  ON operation_jobs(server_id)
  WHERE kind = 'upload'
    AND status IN ('awaiting_upload', 'staging', 'staged', 'waiting_agent', 'running');

-- 同一服务器同时只允许一个 agent update；更新会重启 Agent，必须串行
CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_jobs_active_update
  ON operation_jobs(server_id)
  WHERE kind = 'agent_update'
    AND status IN ('queued', 'waiting_agent', 'running');

-- 可选但建议：客户端可通过 idempotency_key 安全重试创建 exec 任务
CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_jobs_idempotency
  ON operation_jobs(user_id, kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

说明：

- `id` 使用 `job_` + 128-bit 随机 hex，足够不可枚举，且符合 Agent 上传临时文件 ID 的字符白名单。
- `created_at` / `started_at` / `finished_at` / `deadline_at` / `expires_at` 全部使用 unix 秒。
- `stdout` / `stderr` 上限沿用 Agent 现有 48KB / 16KB，D1 单行容量足够。
- `command` 只在 exec 任务存在；上传/更新任务不得写命令字段。
- `r2_key` 只在 upload 任务存在。
- `target_path` / `overwrite` 只在 upload 任务存在。
- `build_id` / `asset_url` / `from_version` / `to_version` / `platform` 只在 agent_update 任务存在；`size_bytes` / `sha256` 复用为更新资产的期望值。
- 不使用 `CHECK` 约束绑定 kind 与字段，D1/SQLite 迁移兼容性较差；由应用层保证。

### 5.2 状态机

exec：

```text
queued -> running -> succeeded
                  -> failed
                  -> timed_out
queued -> failed（提交时 Agent 离线/更新中）
queued/running -> expired（超过 deadline 且无回执）
```

upload：

```text
awaiting_upload -> staging -> staged -> waiting_agent -> running -> succeeded
                                                          -> failed
                                                          -> timed_out
awaiting_upload/staging/staged/waiting_agent/running -> expired
```

agent_update：

```text
queued -> running -> succeeded
                  -> failed
                  -> timed_out
queued -> failed（Agent 离线/当前版本不支持异步更新）
queued/running -> expired（超过 180s + grace 无回执）
```

语义：

- `succeeded`：任务执行/传输流程完成。exec 的非零退出码仍为 `succeeded`，以 `exit_code` 区分；上传只有 Agent `commit=true && ok=true` 才是 `succeeded`；agent_update 只有 Agent 校验并完成 self-replace/重启回执才是 `succeeded`。
- `failed`：基础设施/协议失败（Agent 离线、下载失败、哈希/版本不符、self-replace 失败等）。
- `timed_out`：命令/传输/更新实际执行超时。
- `expired`：超过 deadline 未收到终态，通常意味着 Agent 失联或回执丢失。
- 所有状态更新使用条件更新，例如 `WHERE id=? AND status='running'`，以 `meta.changes` 判断是否真正命中；**真正的终态（`succeeded`/`failed`/`timed_out`）不得被重复回执覆盖**。
- **例外：`expired` 是"软终态"，允许被迟到的回执纠正**。服务端窗口必然窄于 Agent 兜底超时（这是刻意的：让 Agent 有更长的容错），所以"服务端先判过期、Agent 随后真的完成"这个窗口永远存在，只能缩小不能消除。
  - 若丢弃这种回执：用户永远看到 `expired`，而文件/命令实际已经生效（状态与磁盘不一致）；且这次操作在审计里完全消失（不写审计）。
  - 因此 `finishExecJob` / `finishUploadJob` / `finishUpdateJob` 的条件更新都包含 `expired`，并在 `error` 里保留 `late result after expiry (...)`、审计 detail 加 `[late]` 标记。
  - 关键区别：`expired → succeeded` 是**纠正**（让状态与事实一致），`succeeded → failed` 才是**覆盖**（必须禁止）。

### 5.3 审计扩展

在 `0015` 中同时增加：

```sql
ALTER TABLE audit_logs ADD COLUMN duration_ms INTEGER;
ALTER TABLE audit_logs ADD COLUMN job_id TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_logs_job_id ON audit_logs(job_id);
```

- `exec.command` 在任务进入终态时写审计，detail 保留 `exit=...` + 截断命令，`duration_ms = finished_at - started_at`。
- `file.upload` 改为“Agent 成功 commit 后”写审计，不再在 `create_upload` 签发时写。
- 若需要保留“请求上传”的痕迹，可另写 `file.upload.request`，但不要把它计入 `file.upload`，避免再次把签发/实际完成混为一谈。

## 6. 通用任务接口

### 6.0 接口总览

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| POST | `/api/exec-jobs` | Bearer + `canExec` | 创建异步 exec |
| GET | `/api/jobs/:id` | Bearer + 按 kind 重新授权 | 轮询 exec/upload/update 任务，只查 D1 |
| POST | `/api/servers/:id/agent-update` | Bearer + `canUpdateAgent` | 创建异步 Agent 更新 |
| POST | `/api/upload-jobs` | Bearer + `canExec` | 创建 upload 任务，返回签名上传 URL |
| POST | `/mcp/upload-jobs/:id/content` | 签名 token | 客户端上传文件字节到 Worker→R2 |
| GET | `/mcp/upload-jobs/download?id=&server_id=&size=&token=` | 签名 token | Agent 从 R2 拉取 staged 文件（**query 形式**，与 content 的路径参数不同） |
| GET | `/mcp/agent-update-asset` | 签名 token | Agent 从 Worker 资产代理拉取 Release |
| POST | `/mcp/file_upload` | 旧 Bearer/签名 token | 旧同步上传，过渡期兼容 |
| POST | `/mcp` | Bearer + JSON-RPC | MCP `exec_command` / `create_upload` / `update_agent` / `get_operation` 等 |

### 6.1 `GET /api/jobs/:id`

任意已登录用户；只读 D1，不访问 DO。

鉴权：

- 当前请求必须通过 `authUser`。
- 读取 job 对应 `servers` 行，按 kind 重新鉴权：
  - `exec` / `upload`：`canExec(user, server)`。
  - `agent_update`：`canUpdateAgent(user, server)`。
  - 管理员/`panel:admin` 走对应判定中的 `isAdmin` 短路。
- 只允许 job 所有者或管理员读取。建议 job 保存 `username`，PAT 之间不要把结果完全按 `user_id` 共享；当前所有 PAT 可能共用同一个 `user_id`。
- 不满足条件返回 `404`，避免任务 ID 枚举。

响应示例：

```json
{
  "id": "job_...",
  "kind": "exec",
  "status": "running",
  "server_id": 17,
  "created_at": 1761600000,
  "started_at": 1761600001,
  "deadline_at": 1761600031,
  "poll_after_ms": 1000
}
```

终态可附加：

```json
{
  "status": "succeeded",
  "finished_at": 1761600007,
  "duration_ms": 6000,
  "result": {
    "exit_code": 0,
    "stdout": "...",
    "stderr": "",
    "timed_out": false,
    "error": null
  }
}
```

- `Cache-Control: no-store`。
- 未终态不返回 `stdout`/`stderr`。
- 过期任务先按 `deadline_at` 判定 `timed_out`/`expired` 再返回；是幂等更新，失败只记录日志。
- 轮询频率建议 500ms–2s；返回 `poll_after_ms`。

### 6.2 MCP 工具

新增 `get_operation`：

```json
{
  "name": "get_operation",
  "description": "查询 exec_command/create_upload/update_agent 创建的异步任务状态和结果",
  "inputSchema": {
    "type": "object",
    "properties": { "job_id": { "type": "string" } },
    "required": ["job_id"]
  }
}
```

- 权限按 job kind 动态检查：exec/upload 需要 `server:exec`，agent_update 需要 `agent:update`；管理员或 `panel:admin` 可访问全部。
- `MCP_TOOL_SCOPE` 当前是单个 scope 的映射；`get_operation` 需要支持“任一操作 scope 可见”。建议把值扩展为数组或增加 `MCP_TOOL_ANY_SCOPES`，不要把它错误地只绑定到 `SCOPE_EXEC`。
- `initialize.instructions` 和 README 必须明确：`exec_command` / `update_agent` 只返回 accepted，必须轮询 `get_operation`；`create_upload` 返回的 URL 上传完成后也要轮询。
- 更新 `test/api.test.js` 中工具列表断言和 PAT 可见性组合。

## 7. Exec 异步接口

### 7.1 创建任务

`POST /api/exec-jobs`

请求：

```json
{
  "server_id": 17,
  "command": "systemctl status nginx",
  "timeout": 25
}
```

约束：

- `command` 为空 → 400。
- 继续复用 `execCommandBytes` / `EXEC_CMD_MAX_BYTES` 限制。
- `timeout` 限定 1–25 秒。
- 鉴权：`canExec`。
- 可选 `idempotency_key`：同一用户 + key 在未过期任务中唯一；防止 MCP/HTTP 自动重试重复执行。没有该字段时使用随机 job id。

流程：

1. 插入 `operation_jobs`：`kind='exec'`、`status='queued'`、`deadline_at=now + timeout + 30`、`expires_at=now + 24h`。
2. 调用 shard DO `POST /rpc/exec/submit`，只等“是否成功发出”，不等命令完成。
3. DO 返回成功：更新为 `running`，返回 HTTP 202：

```json
{
  "job_id": "job_...",
  "status": "running",
  "server_id": 17,
  "poll_tool": "get_operation",
  "poll_after_ms": 1000
}
```

4. Agent 离线/更新中：任务标 `failed`，HTTP 503/409，返回可读错误；不进入“等待 30 秒”。
5. 已下发但后续无回执：只靠 `deadline_at`，由轮询/清理标 `timed_out`，**不建 DO timer**。

### 7.2 MCP `exec_command`

保留工具名，改变返回语义：

- 成功下发后返回 `{ job_id, status, server_id, server_name, poll_tool, poll_after_ms }`。
- 不再在 `tools/call` 内返回最终 stdout/stderr/exit_code。
- 参数、权限、命令长度限制不变。
- 客户端/模型必须轮询 `get_operation`。

建议保留 `timeout` 参数（1–25 秒），只影响 Agent 内实际命令超时，不影响 DO 请求时长。

### 7.3 DO `/rpc/exec/submit`

请求：

```json
{
  "jobId": "job_...",
  "serverId": 17,
  "command": "...",
  "timeoutMs": 25000
}
```

行为：

1. 校验命令长度、serverId、job 仍然合法。
2. 检查 `updating`、旧同步 `pendingExec`，以及 D1 中该服务器是否正在 agent update。
3. 可保留现有 1 秒探活（`pendingProbe` 只短暂存在）；探活失败返回错误，不创建长等待。
4. 更新 D1 `status='running', started_at=...`（条件 `status='queued'`）。
5. 发送 Agent 帧：

```json
{
  "type": "exec",
  "exec_id": "job_...",
  "command": "...",
  "timeout_s": 25
}
```

发送失败（连接已失效）时把 D1 job 标为 `failed` 并返回错误，不能留下“running 但命令未发出”。

6. 立即返回 202；**不创建 pendingExec Promise、不设置 30 秒 setTimeout**。

### 7.4 exec 结果回调

Agent 仍回现有协议：

```json
{
  "type": "exec_result",
  "exec_id": "job_...",
  "exit_code": 0,
  "stdout": "...",
  "stderr": "",
  "timed_out": false
}
```

DO 的 `webSocketMessage`：

1. 更新 D1：

```text
status = timed_out ? 'timed_out'
                   : (error ? 'failed' : 'succeeded')
exit_code, stdout, stderr, timed_out, error,
finished_at, duration_ms
WHERE id=? AND status IN ('queued','running','expired')
```

2. 条件更新未命中时说明是重复回执（真正的终态已写入），记录 debug 日志并忽略。
   `expired` 是刻意包含的：允许迟到回执把"曾判过期"纠正为真实结果（见 §5.2 的软终态说明），否则命令可能已经执行、调用方却永远看到 expired。
3. 写 `exec.command` 审计（`duration_ms`、`job_id`）；审计失败不回滚任务结果。
4. 更新 `lastRoundTripAt`，保留现有探活缓存语义。

DO evict 后内存 Map 全空，但 Agent 的 `exec_result` 到达会唤醒 DO；因状态在 D1，任务仍可完成。这正是本方案的核心验收点。

## 8. Upload / Agent Update 异步接口

### 8.1 前置条件：R2 staging

新增 `wrangler.toml`：

```toml
[[r2_buckets]]
binding = "UPLOADS"
bucket_name = "cf-panel-upload-staging"
```

部署前执行：

```bash
wrangler r2 bucket create cf-panel-upload-staging
```

- 对象 key：`upload-jobs/<job_id>`。
- 不公开 bucket，不配置公开域名。
- 建议给 `upload-jobs/` 前缀配置 24 小时生命周期删除规则，作为代码清理失败时的兜底。
- 测试环境必须在 `test/helpers.js` 提供内存 R2 mock（`put/get/delete/list/head`），不要连接真实 R2。

> 如果部署环境不允许新增 R2，就无法只靠 D1/轮询把 upload 真正异步化：客户端字节仍要经过 DO，或 Agent 仍需从 DO 拉取。必须另行提供 Agent 可拉取的暂存对象存储；否则只能做超时/并发调优，不能作为本次设计交付。

### 8.2 创建上传任务

`POST /api/upload-jobs`

请求：

```json
{
  "server_id": 17,
  "path": "/opt/app/app.tar.gz",
  "overwrite": false
}
```

约束：

- `canExec`。
- 路径必须绝对路径；系统路径保护仍由 Agent 的 `write_bytes` 最终执行。
- 同一服务器只允许一个非终态 upload job（依赖部分唯一索引；冲突返回 409 `UPLOAD_BUSY`）。
- 默认最大 100MB，继续受 `UPLOAD_MAX_MB` / 500MB 硬上限约束。
- 创建 `status='awaiting_upload'`，`deadline_at=now+600`，`expires_at=now+24h`。

返回：

```json
{
  "job_id": "job_...",
  "status": "awaiting_upload",
  "upload_url": "https://panel.example/mcp/upload-jobs/job_.../content?token=...",
  "expires_at": 1761600600,
  "poll_tool": "get_operation"
}
```

签名 URL：

- 使用现有 HMAC secret，建议新增 `signJobUploadToken(jobId, serverId, exp)` / `verifyJobUploadToken`，不要直接复用旧的四元组签名格式。
- token 绑定 job_id + server_id + 过期时间；path/overwrite 从 D1 job 读取，避免 query 参数被替换。
- 有效期 10 分钟；只能用于 `awaiting_upload` 状态。
- 上传完成后再次使用返回 409，避免旧 URL 重放。

MCP `create_upload`：

- 参数保持 `server_id`/`server_name`、`path`、`overwrite`。
- 内部创建 upload job，返回 `job_id`、`upload_url`、`poll_tool`、有效期。
- 工具描述必须说明：`upload_url` 只是上传入口；上传完成后文件尚未落到目标机，必须轮询 `get_operation`。
- 不再在创建时写 `file.upload` 成功审计。

### 8.3 接收文件内容

`POST /mcp/upload-jobs/:id/content?token=...`

- 无需 Bearer，签名 URL 自验证；仍要求 `JWT_SECRET` 存在，防止配置错误绕过。
- `Content-Type: application/octet-stream`。
- 必须带 `Content-Length`；缺失返回 411，避免无界流。
- 校验 token、job 状态、server_id、`Content-Length <= maxBytes`。
- 用 D1 条件更新抢占 `status='staging'`，防止同一 job 被并发上传。
- 将 `request.body` 流式写入 R2，不整体缓冲；写入过程中累计字节数超过上限立即中断，写入完成后再次校验实际 `R2Object.size`。不能只信任 `Content-Length`。
- 计算/记录 SHA-256（如果实现成本高，可作为可选字段；至少必须保证 size 与传输完整，Agent 侧仍校验 size）。若记录 sha，Agent 下载时必须复核。
- 成功：

```text
status='staged',
r2_key='upload-jobs/<job_id>',
size_bytes=实际大小,
-- 进入等待 Agent 阶段：留出重连/重试窗口，而不是沿用已消耗的上传窗口
deadline_at=now+600
```

- 然后调用对应 shard DO `POST /rpc/upload/submit`。该调用只负责下发元数据/通知，不读取文件、不等待 Agent 落盘。
- DO 真正下发 `upload_fetch` 时，将 `deadline_at` 更新为 `now + UPLOAD_JOB_AGENT_WINDOW_S + UPLOAD_JOB_GRACE_S`（实现为 300 + 30 = 330s，不是旧同步路径的 120s——现在由 Agent 自己拉取，慢链路下 100MB @0.6MB/s 就需约 170s）；Agent 离线则保持 `waiting_agent`，deadline 不超过创建时约定的上传任务总上限。**该窗口必须窄于 Agent 侧下载超时**（见 §8.4）。
- 返回 HTTP 202：

```json
{
  "job_id": "job_...",
  "status": "staged",
  "size_bytes": 12345678,
  "poll_tool": "get_operation"
}
```

- 失败：删除 R2 临时对象，D1 标记 `failed`；不要把半截对象留给 Agent。

### 8.4 Agent 拉取与回执

Worker 提供：

`GET /mcp/upload-jobs/download?id=<job_id>&server_id=<id>&size=<bytes>&token=...`

> 注意：`content` 用**路径参数**（`/mcp/upload-jobs/:id/content`），`download` 用 **query**（`/mcp/upload-jobs/download?id=`）。两者形式不同是既有实现，集成时请按实际 URL 拼，不要互相套用。`size` 参与签名（`signJobToken` 的 extra），防篡改。

- 以 `/mcp` 前缀提供，沿用现有 Cloudflare Access 放行策略；不要新增公开 R2 域名。
- token 绑定 job_id / server_id / size / 过期时间；有效期建议 10 分钟。
- Worker 从 `env.UPLOADS.get(r2_key)` 流式返回 body，不经过 DO。
- 校验 job 状态必须是 `running`，key 必须匹配，禁止任意对象读取。
- 返回 `Content-Length`、`Content-Type: application/octet-stream`；响应头 `Cache-Control: no-store`。

路由实现注意：

- 当前 `handleMcpInner` 在解析 body 前就拒绝所有非 POST 请求；`GET /mcp/upload-jobs/download` 必须先于该检查，并在 `authUser` 前用签名 token 验证。
- `POST /mcp/upload-jobs/:id/content` 同理，必须在普通 Bearer/JSON-RPC 分支前处理；只验证签名 token 和 job 状态，不解析 JSON body。
- 两条分支仍要先执行 `requireJwtSecret`，并复用现有 Origin 校验策略；Agent 的 GET 无 Origin，不能让 Origin 逻辑误拒绝。
- `src/index.js` 继续按 `/mcp` 前缀路由到 `handleMcp`，不需要新开顶层前缀；若将下载端点放到其他路径，必须同步 CF Access 放行配置。

DO 向 Agent 下发：

```json
{
  "type": "upload_fetch",
  "job_id": "job_...",
  "url": "https://panel.example/mcp/upload-jobs/download?id=job_...&server_id=17&size=12345678&token=...",
  "path": "/opt/app/app.tar.gz",
  "overwrite": false,
  "size": 12345678
}
```

> 帧里**没有 `sha256`**：§8.3 已把摘要列为可选，实际完整性由 `size`（Agent 侧传
> `expect_size`，下载器据此校验实际字节）加事后 `head()` 复核兜住。不要按早期草案去实现 sha 校验。

Agent 的网络实现：**不引入 `reqwest`**。仓库已有 `tokio-rustls` + 自建 DNS（`dns.rs`）+
手写 HTTP 的能力（`lenient_ws_handshake`），故新增 `fetch.rs` 实现最小 HTTPS GET：
零新增依赖，也不会重演 `aws-lc-rs` / CryptoProvider 冲突（2026-08-25 事故）。
必须同时支持 `Content-Length` 与 `chunked` 两种响应——只处理一种会偶发解析错位。

Agent 要求：

- `dispatch()` 收到 `upload_fetch` 后必须 `spawn` 独立下载任务并立即返回，不能阻塞控制读循环；否则下载期间 Agent 的 report/ping/其它指令全部停摆。
- **必须有总超时**（DNS + TCP + TLS + 读 body 全程，实现取 360s）：裸 `await` 在 TCP 半开或对端不响应时会永久挂住，残留任务 + 半截临时文件不断累积（同类问题曾造成 2026-09-09 的"连接静默 3 天"事故）。超时后删除临时文件。
  - **该超时必须严宽于服务端任务窗口**（upload 330s / update 210s），否则会出现"服务端已判 `expired`、Agent 仍在下载"：此时终态回执的条件更新必然落空（status 已不是 `running`），于是 R2 暂存对象不回收、审计也不写，而文件随后又真的落盘——用户看到的状态与磁盘实际不一致。
  - 这个关系由 `test/unit.test.js` 的 `下载超时与服务端任务窗口的时序关系` 锁定（两侧常量分处 Rust/JS，只能跨文件解析校验）。改任一侧都要先过那条测试。
- URL 必须与 `AGENT_WSS_URL` 的 host 一致（`fetch::validate_panel_url`），且 path 必须以 `/mcp/` 开头；仅允许 `https`（本地开发可显式允许 `http`）。这是文档 §10.5 的分层防御——即便 DO 被攻破或 `panel_origin` 被污染，Agent 也不会带着有效 token 去请求任意地址。
- 不允许把 URL 当成任意代理地址；拒绝其他 host/path。
- 复用 `write_bytes` 的路径保护（`is_system_path`）、`overwrite=false` 已存在检查、临时文件命名和原子 rename 语义。
- 临时文件必须登记到连接级清理表（`created`），控制连接退出时统一删除——否则下载中途重启会把 `{path}.cfp-upload-{job_id}` 永久留在业务目录。
- 流式下载到 `{path}.cfp-upload-{job_id}`，不整体载入内存。
- 校验 HTTP 状态、`Content-Length`/实际字节数、可选 SHA-256。
- 下载任务需要独立超时和取消路径；控制通道断开时不能留下长时间挂起的 HTTP 下载任务。
- 成功后发送单次终态回执：

```json
{
  "type": "upload_result",
  "job_id": "job_...",
  "upload_id": "job_...",
  "path": "/opt/app/app.tar.gz",
  "ok": true,
  "size": 12345678,
  "commit": true
}
```

失败时 `ok:false` + `error`。新路径只发一个终态回执，不再逐块回传；旧同步路径的逐块 `upload_result` 在过渡期继续兼容。

DO 收到带 `job_id` 的 `upload_result`：

1. **先校验回执**：`size` 必须等于 staged 时的 `size_bytes`，否则判 `failed`（下载被截断时 Agent 可能仍报 `ok`，文件已在目标位置留下短副本）。校验通过后条件更新 D1：`running -> succeeded/failed/timed_out`。
2. 成功或失败都删除 `r2_key` 对应的 R2 对象。
3. 成功时写 `file.upload` 审计，包含 size、path、duration_ms、job_id；失败写 `file.upload.failed`。
4. 不依赖 `pendingUpload` Map；即使 DO 此前 evict、任务重新唤醒也能更新。

**R2 对象的删除时机（全部主动删除，不等定时器）**：

| 场景 | 触发点 |
| --- | --- |
| 上传失败（超限/读错）、并发抢占、DO 下发失败 | Worker 侧 `finishUploadJob` 后立即删 |
| Agent 回执成功 / 失败 | `settleUploadJob` 立即删 |
| **Agent 一直不拉，deadline 过期** | `settleExpired` / `settleExpiredAll` 判过期时立即删 |
| 行已删但对象残留（Worker 崩溃等） | cron 的 `list` 扫描 + R2 lifecycle 兜底 |

> 过期路径必须主动删：`expires_at` 是 24 小时，若只等 cron 的 TTL，一次 Agent 掉线的 100MB 上传会在额度里白躺一天，几十次就能顶满 10GB 免费额度。注意 `settleExpiredAll` 必须**先 SELECT 再逐条 UPDATE**——纯批量 UPDATE 拿不到受影响行的 `r2_key`。

### 8.5 Agent 能力协商

Agent 的 report `info` 增加：

```json
{ "upload_fetch_proto": 1 }
```

DO 在下发 upload_fetch 前检查能力：

- 支持 `upload_fetch_proto >= 1`：走新异步路径。
- 不支持：返回明确 `AGENT_UPGRADE_REQUIRED`，不要把新任务静默降级成同步 `/rpc/upload`。
- 旧 Agent 兼容：**没有 `LEGACY_SYNC_UPLOAD` 开关**（早期草案设想过，未实现）。旧 Agent 调用异步上传接口会得到 `AGENT_UPGRADE_REQUIRED`；如需继续用旧方式，走保留的 `/mcp/file_upload` + Bearer 同步路径（一个版本周期后删除）。
- 旧 `/mcp/file_upload` + `/rpc/upload` 保留一个版本周期，确认 Agent 全量升级后再删除。

### 8.6 Agent update 异步接口

#### 8.6.1 提交任务

保留现有 REST 入口：

`POST /api/servers/:id/agent-update`

MCP `update_agent` 复用同一服务。

流程：

1. `canUpdateAgent` 鉴权。
2. 读取 `server.info_json`，要求 `update_protocol >= 1` 且 `self_update_enabled=true`。
3. 判断 `info.update_fetch_proto`：旧 Agent 且 `LEGACY_SYNC_UPDATE=1` 时直接走旧同步路径并返回旧响应，不创建 async job；旧 Agent 且未开启 legacy 时立即失败 `AGENT_UPGRADE_REQUIRED`。
4. 新 Agent：`getAgentManifest()`；按 `agent_platform` 选 asset；保持现有 build 版本比较。
5. 已最新：保持同步返回 `{ already_latest:true, build_id }`，不创建任务。
6. 可更新：创建 `operation_jobs`：

```text
kind='agent_update'
status='queued'
build_id=manifest.build_id
from_version=当前 agent_version
to_version=manifest.build_id
platform=agent_platform
size_bytes=asset.size
sha256=asset.sha256
asset_url=asset.url            -- 已经过 manifest 校验
deadline_at=now+180+grace
expires_at=now+24h
```

7. 写 `agent.update.request` 审计（fail closed，保持现有安全语义）；审计失败时把已插入的 job 标为 `failed`，不得下发。
8. 调用 shard DO `POST /rpc/agent_update/submit`。这里**不再下载 Release 资产**，只传元数据和短期资产 URL。
9. DO 接受：返回 HTTP 202：

```json
{
  "job_id": "job_...",
  "status": "running",
  "server_id": 17,
  "build_id": "2026.10.28-...",
  "poll_tool": "get_operation"
}
```

10. DO 拒绝（Agent 离线、已被其它任务占用等）：将 job 标为 `failed`，返回 409/503；已写入的 request 审计保留。

#### 8.6.2 Worker 资产代理

新增：

`GET /mcp/agent-update-asset?token=...`

- 与 upload 下载端点一样，在 `handleMcpInner` 的非 POST 早退之前处理，先校验 `requireJwtSecret`，再验 HMAC token，不要求 Bearer。
- token 绑定 `job_id + server_id + build_id + platform + size + sha256 + exp`；建议 10 分钟有效。
- 读取 job，要求 kind=`agent_update`、status=`running`、`asset_url` 与 manifest 校验结果一致，避免任意 URL 代理。
- Worker 从已校验的 `asset.url` 获取 Release 资产，沿用当前的 `accept: application/octet-stream`、`user-agent: cf-panel-agent-updater`、`redirect: follow` 和 `cf: { cacheTtl: 86400, cacheEverything: true }`；流式返回 body，不经过 DO。
- 校验 GitHub 返回的 `Content-Length` 与 job `size_bytes`（如果提供）；不匹配则拒绝，Agent 仍会做最终 SHA/大小校验。
- 不能把 `asset_url` 放在 query 里由调用方指定，必须从 D1 job 读取；否则会形成开放代理。
- 该请求会占用 Worker 请求时间，但不再占用 DO duration。
- 这里选择 Worker 资产代理而不是 R2 staging：Release 资产只有几 MB，GitHub/Worker 边缘缓存已存在，避免给更新再增加一套对象生命周期；如果未来需要跨网络缓存，再迁移到 R2，不影响任务模型。

#### 8.6.3 DO 下发与 Agent 下载

`POST /rpc/agent_update/submit`

```json
{
  "jobId": "job_...",
  "serverId": 17,
  "buildId": "2026.10.28-...",
  "platform": "linux-x86_64",
  "size": 1234567,
  "sha256": "...",
  "downloadUrl": "https://panel.example/mcp/agent-update-asset?token=..."
}
```

DO 行为：

1. 查 Agent 控制连接与该服务器的互斥状态。
2. 检查 Agent 能力：`info.update_fetch_proto >= 1`。
3. 更新 D1 `queued -> running`（条件更新）。
4. 下发：

```json
{
  "type": "agent_update_fetch",
  "job_id": "job_...",
  "url": "https://panel.example/mcp/agent-update-asset?token=...",
  "build_id": "2026.10.28-...",
  "platform": "linux-x86_64",
  "size": 1234567,
  "sha256": "..."
}
```

5. 立即返回 accepted；不设置 180 秒 timer。

Agent：

- `dispatch()` 收到 `agent_update_fetch` 后必须 `spawn` 独立更新任务，不能阻塞控制读循环。
- 校验 URL host 与面板同源、https（本地开发例外）、build/platform、size ≤ 32MB。
- 流式下载到同目录 staging 文件；沿用 `update.rs` 的 `UPDATE_MAX_BYTES`、SHA-256、版本/平台校验、backup、`self_replace` 和 `RESTART_AFTER_UPDATE` 语义。
- 新增 `update_fetch_proto: 1` 到 report info；旧 `update_protocol` 不变。
- 总超时 180 秒；失败清理 staging。
- 成功/失败都回：

```json
{
  "type": "agent_update_result",
  "job_id": "job_...",
  "update_id": "job_...",
  "build_id": "...",
  "ok": true,
  "size": 1234567,
  "restarting": true,
  "backup": "..."
}
```

- 先入队并 flush 终态回执，再通知进程退出；保持现有“回执发送失败也必须升级退出”的约束。

**实现采用「排空屏障」而非 `agent_update_ack`（与本文档早期草案不同，此处以实现为准）**：

Agent 侧先 `tx.send(OutMsg::Frame(回执))`（阻塞式，拿到"已入队"的确定信号），再发一个
`OutMsg::Barrier`，等写任务回 ack（≤2 秒）——屏障按排队序处理，因此屏障回执即代表
前面的回执**已经 flush 到 socket**。之后无条件 `shutdown.notify_waiters()` 退出。

为什么不用 DO 回的 ack：

- Barrier 是**本地**证据，比等远端 ack 更强（ack 只证明 DO 收到，不证明已到达）；
- 若等 DO 的 ack，DO 不可达时升级会卡死——而"替换成功就必须跑新版本"是硬约束，不能被网络状况否决。

所以本文档不再要求 `agent_update_ack`。

DO 收到结果：

- 校验 `build_id`、`size`、`restarting` 与 job/manifest 一致；不一致按 `agent.update.failed` 处理，不能把错误资产标成功。
- 条件更新 D1 `running -> succeeded/failed/timed_out`。
- 写 `agent.update.installed` 或 `agent.update.failed` 审计，带 `job_id`、`duration_ms`。
- 不需要 `pendingUpdate` Map；DO evict 后由 D1 恢复。
- 成功更新后清理该服务器旧会话的行为保持现状，避免旧 Agent 进程残留。
- 成功回执后清理 Worker/Panel 的服务器列表缓存（或通知 PanelDO 清列表缓存），使新版本信息尽快可见；随后仍以 Agent 上报的 `agent_version` 为准。

#### 8.6.4 旧 Agent 自举与兼容

更新接口有一个无法回避的循环依赖：**旧 Agent 不支持异步下载，但升级旧 Agent 又需要更新能力**。因此：

- `update_fetch_proto >= 1`：走新异步路径。
- 旧 Agent：只在显式 `LEGACY_SYNC_UPDATE=1` 时保留现有同步中继，标记为升级过渡路径；新 Agent 永远优先走异步路径。迁移期可临时开启该开关用于旧节点自举，完成后关闭。
- 若旧 Agent 不支持且未开启 legacy：任务失败 `AGENT_UPGRADE_REQUIRED`，提示运维先通过手工/旧版本路径升级。
- legacy 分支可以保留旧同步 API 的最终响应语义（因为它仍要等 180 秒），只作为迁移桥，不声称异步；新 Agent 永远不进入 legacy。
- 完成全量 Agent 升级后，删除 legacy 分支和 `pendingUpdate` 长等待。
- 发布新 Agent 的批次本身仍可能走旧同步路径，必须逐台/分批，不能把 fleet 一次性打爆；这是迁移期已知成本，不是最终架构。

#### 8.6.5 前端影响

`public/app.js` 现有的 `updateAgent` / 批量更新必须适配：

- REST `POST /api/servers/:id/agent-update` 正常更新返回 `{job_id,status,build_id}`（HTTP 202）；`already_latest` 仍同步返回。
- 继续保留现有“轮询 `/api/servers` 等版本号回报”的 UI 行为，但失败判断应优先读取 `GET /api/jobs/:id`：
  - `succeeded` 后再等版本号；
  - `failed`/`timed_out` 立即停止并显示错误。
- 现有前端 90 秒版本轮询窗口不足以覆盖 180 秒更新 + 重启上报；先轮询 job 到终态，再以合理的重启宽限等待新版本上报。
- 批量更新串行逻辑不变；每台记录 job_id，失败原因可见。
- MCP `update_agent` 返回 job accepted，提示调用 `get_operation`；不再返回“已送达/已安装”的最终结论。
- 新增的“更新排队/执行中/失败/超时”等用户可见文案必须同时加入 `public/lang/zh-CN.js` 与 `en-US.js`，并由现有 i18n 静态测试检查；不要在 `app.js` 留中文字面量。

## 9. DO 协议与状态恢复

新增内部 RPC：

### `POST /rpc/exec/submit`

请求如上。返回：

```json
{ "ok": true, "job_id": "job_...", "status": "running" }
```

不得返回 Promise 等待终态。

### `POST /rpc/upload/submit`

请求：

```json
{
  "jobId": "job_...",
  "serverId": 17,
  "path": "/opt/app/app.tar.gz",
  "overwrite": false,
  "size": 12345678,
  "sha256": "...",
  "downloadUrl": "https://panel.example/mcp/upload-jobs/job_.../download?token=..."
}
```

行为：

1. 查 Agent 控制连接，并检查旧 `uploading`/`updating` 内存状态，避免过渡期新异步任务与旧同步上传/更新交错。
2. 在线：D1 条件更新 `staged -> running`，发 `upload_fetch`，立即返回 accepted；发送失败则回退 `waiting_agent`/`failed`，不能留下 running 但未发出的状态。
3. 离线：D1 置 `waiting_agent`，返回 accepted；不占用 DO 请求。
4. Agent 控制 WS 重新连上时，DO 查询该 server 的 `waiting_agent` upload jobs（限制数量，避免批量异常）并重新下发；每次下发重新生成短期 download URL。
5. DO 不保存 `pendingUpload`，不需要长 timer。

### `POST /rpc/agent_update/submit`

请求：

```json
{
  "jobId": "job_...",
  "serverId": 17,
  "buildId": "2026.10.28-...",
  "platform": "linux-x86_64",
  "size": 1234567,
  "sha256": "...",
  "downloadUrl": "https://panel.example/mcp/agent-update-asset?token=..."
}
```

行为：

1. 检查 `this.updating`、旧 `pendingUpdate`、D1 中该 server 的活动任务，以及 Agent 是否在线。
2. Agent 不支持 `update_fetch_proto >= 1` 时按 8.6.4 处理，不要默认进入同步中继。
3. D1 条件更新 `queued -> running`，下发 `agent_update_fetch`。
4. 发送失败时把 D1 job 标为 `failed` 并返回错误，不能留下 running 但未发出的状态。
5. 立即返回 accepted；不创建 `pendingUpdate` Promise，不设置 180 秒 timer。
6. 更新期间保持现有互斥：不再允许新的 exec/upload/update；已有终端/文件流按现状清理。

### 9.1 Agent 断连

**三种 kind 的断连语义刻意不同**，原因写在每一条后面——它们不是同一件事：

| kind | 断连后 | 是否自动重发 | 原因 |
| --- | --- | --- | --- |
| `exec` | 标 `failed`（error=`agent_disconnected`） | ❌ | 命令可能**已执行**、只是回执丢失。自动重发会造成重复执行（`rm`/`systemctl restart` 都不能重放），只能由调用方显式重试 |
| `upload` | 未过 deadline → `waiting_agent`；已过 → `timed_out` | ✅ | 重下同一份字节是**幂等**的（agent 侧临时文件 + 原子 rename），可安全重发 |
| `agent_update` | 不自动重试；等 deadline 判 `timed_out`，且**不得覆盖**已写入的 `succeeded` | ❌ | 更新可能已替换磁盘文件但回执丢失，自动重试会造成二次替换 |

实现状态（与上表一一对应）：

- `exec`：断连立即收敛（不是等 deadline）——`cleanup()` 对在途 `pendingExec` 直接 resolve `agent disconnected`，并把该 server 处于 `queued`/`running` 的 exec 任务标 `failed` 并写 `exec.command.failed` 审计（见 `settleJobsOnDisconnect`）。被判 `expired` 的情况只在 deadline 超时且没有断连事件时出现。
- `upload`：**已实现重连重发**。控制 WS 建立时调用 `resendWaitingUploads()`：
  1. 先把该 server 处于 `running` 的 upload 退回 `waiting_agent`（过 deadline 的直接判 `timed_out`）——否则断开期间的那次重连什么都不会做；
  2. 再捞 `waiting_agent` 的任务（限 20 条）逐条**重新签发** download URL 后下发。**必须重签**：建任务时的短期 URL（10 分钟）早已过期；
  3. 下发前用条件更新抢 `running`，未命中说明已被其它路径收敛，跳过。
- `agent_update`：不重试。`cleanup()` 释放 `updating` 内存互斥，D1 侧等 deadline 收敛。

其他约束：

- 更新成功时 Agent 会主动退出并触发 control WS close，必须保证“结果先落 D1、再关闭/退出”的语义：Agent 发送终态结果后先经**排空屏障**（最多 2 秒）确认已 flush 到 socket，再 `notify_waiters()` 让主循环退出、由 supervisor 或 `RESTART_AFTER_UPDATE` 拉起新版本。若只 `self_replace` 而不触发退出，进程会继续跑旧映像、版本号永远不变。
- 清理 Agent 临时文件由 Agent 自身会话结束逻辑负责，Worker 不删除远端半成品。

### 9.2 超时与过期

- 不在 DO 中为任务设置 `setTimeout`。
- Worker `GET /api/jobs/:id` 发现：
  - `now > deadline_at` 且状态非终态：条件更新为 `expired`（与 §5.2 一致；exec 同时写 `exec.command.failed` 审计）。
- 新增 Worker scheduled（建议每小时）：
  - 非终态且超 deadline → `timed_out/expired`。
  - `expires_at < now` 的任务删除 D1 行。
  - 清理 R2 `upload-jobs/` 下超过 24 小时的孤儿对象；R2 lifecycle 规则作为兜底。
  - 每轮设置批次上限（例如 D1 500 行 / R2 1000 对象），避免 cron 单次超时；未清完下次继续。

`wrangler.toml` 增加（时间可调整）：

```toml
[triggers]
crons = ["17 * * * *"]
```

同时给 `src/index.js` 的默认导出增加 `scheduled(event, env, ctx)`；如不希望本地/测试环境触发 cron，可只配置生产环境，但清理逻辑必须保留。

- 删除任务前不得删除仍在 `running`/`waiting_agent` 的任务。

### 9.3 与 Agent 更新的互斥

**实际实现的互斥矩阵**（比初稿收窄，初稿把 exec 也串行化了，与「连续多个 sleep 5 全部可查回」的验收标准冲突）：

| 组合 | 是否互斥 | 机制 |
| --- | --- | --- |
| `agent_update` × 任意 | ✅ 独占 | D1 部分唯一索引 `idx_operation_jobs_active_update` + DO 内存 `updating` |
| `upload` × `upload`（同机） | ✅ 串行 | 部分唯一索引 `idx_operation_jobs_active_upload` |
| `exec` × `exec` | ❌ 允许并发 | 保持旧语义（旧同步路径同样允许并发） |
| `exec` × `upload` | ❌ 允许并发 | 同上 |

判定只用一条查询（`hasActiveAgentUpdate`）：

```sql
SELECT 1 FROM operation_jobs
 WHERE server_id = ? AND kind = 'agent_update'
   AND status IN ('queued','waiting_agent','running')
 LIMIT 1
```

- 提交 exec/upload/update 前都查它；命中返回 409 `AGENT_UPDATE_BUSY`。**只判 update**，不判 exec/upload——否则同机第二个 exec 会被拒，与并发验收项矛盾。
- 跨实例/evict 的正确性由部分唯一索引保证（`INSERT` 撞索引即 `UPDATE_BUSY`）；DO 内存里的 `updating` 只覆盖本实例窗口，且必须在**回执落库后**（`settleUpdateJob`）和**连接断开时**（`cleanup`）释放，否则本实例存活期内该机器永久 409。
- 在 update 开始前关闭该 server 的终端/文件会话的行为保持现状，避免升级过程中旧 PTY 干扰。

## 10. 安全要求

1. 所有任务查询重新鉴权，不能凭 job_id 直接读取结果。
2. job_id 使用 128-bit 随机值；错误统一 404，避免区分“无权限”和“不存在”。
3. 上传 content URL 只接受 `awaiting_upload`，上传成功后失效；签名绑定 job/server，不允许改 path/server。
4. 下载 URL 短期有效、绑定 job/server/size，R2 bucket 不公开。
5. Agent 下载 URL 必须校验 host 与面板同源，防止任意 URL 拉取（SSRF）。
6. Agent update 资产代理的 `asset_url` 只能来自 Worker 已校验的 manifest，不能让 Agent/客户端在 query 中任意指定 URL；更新资产 URL 仍需 host/HTTPS 校验。
7. 继续沿用 Agent 侧系统路径保护、overwrite 检查、临时文件 + 原子 rename。
8. 不在 D1 存 PAT/JWT 明文；job 只存 user_id/username/client_ip。
9. stdout/stderr 可能含敏感内容：不写日志全文，轮询响应 `no-store`，任务结果按 TTL 删除。
10. 任务被提交后即使 PAT 被撤销，也无法撤回已经发出的命令/更新；轮询/结果读取会立即失效。
11. upload 失败/超时后必须删除 R2 staging 对象，避免存储泄漏。
12. Agent update 的 build/platform/SHA/backup/self-replace 校验不得因异步化削弱；旧同步路径只能是显式过渡开关。
13. upload download / agent update asset 的签名 URL 不写审计、不写普通日志；错误日志必须脱敏。

## 11. 兼容性与发布顺序

1. **迁移先行**：新增 `0015`，D1 与 `schema.sql` 同步；旧代码看到新列/表不受影响。
2. **Worker/DO 双轨**：先部署新任务服务和无等待 dispatch；旧 `/rpc/exec`、`/rpc/upload`、`/rpc/agent_update` 暂时保留。
3. **Agent 0.4.0**：增加 `upload_fetch_proto`、`update_fetch_proto`、下载实现和更新任务；发布并逐台升级。
4. **切换 MCP/UI**：
   - `exec_command` 默认返回 job；
   - `create_upload` 默认返回 staged job URL；
   - `update_agent` 默认返回 job；
   - 增加 `get_operation`，更新前端 agent update 状态处理；
   - README、initialize instructions、工具描述同步更新。
5. **观察期**：确认新任务成功率、R2 清理、Agent 下载/更新失败率。
6. **移除旧同步路径**（2026-10-28 已完成）：删除 `/rpc/exec` 的 Promise 等待、`pendingExec`、`pendingUpload`、`pendingUpdate`，以及旧 `/mcp/file_upload`。回滚需恢复代码（不再有环境变量开关）。
7. **旧 Agent 过渡**：仅 `LEGACY_SYNC_UPDATE=1` 保留更新自举的同步路径（它会产生长 DO duration，必须监控使用次数并计划关闭）。上传侧没有对应的 legacy 开关：旧 Agent 走保留的 `/mcp/file_upload` Bearer 路径，异步 `/api/upload-jobs` 对旧 Agent 明确返回 `AGENT_UPGRADE_REQUIRED`。

注意：执行 `exec_command` / `update_agent` 语义从“同步返回最终结果”变为“异步 job”是 API 行为变更，必须在 README、MCP instructions、客户端示例中明确，不能只改实现。

## 12. 可观测性与审计

### 12.1 D1 字段

每个任务记录：

- 创建、开始、完成时间。
- `duration_ms`：`finished_at - started_at`。
- `dispatch_attempts`。
- `error` / `exit_code` / `size_bytes`。

### 12.2 审计

- exec 终态写 `exec.command`，包含 `job_id`、`duration_ms`、exit、截断命令。
- upload 成功写 `file.upload`，包含 `job_id`、target path、size、duration。
- agent_update 成功写 `agent.update.installed`，失败写 `agent.update.failed`，均带 `job_id`、`duration_ms`、from/to build；`agent.update.request` 仍在提交时写且 fail closed。
- 失败任务不要写成功的 `exec.command` / `file.upload` / `agent.update.installed`；如需失败留痕，用 `*.failed`，避免审计与真实完成混淆。
- 审计 detail 不存 stdout/stderr 全文、不存签名 URL、不存 PAT。

### 12.3 上线后的三项观测

1. `operation_jobs` 各状态数量、`duration_ms` P50/P95、超时率。
2. Cloudflare DO duration 与 `/rpc/exec`、`/rpc/upload`、`/rpc/agent_update` 请求数是否显著下降。
3. R2 staging 对象数量是否在任务终态后归零（允许 cron 清理延迟）。

## 13. 测试与验收

### 13.1 单元 / API 测试

必须新增：

- `exec` 提交在 Agent 不回报结果时也立即返回 accepted；DO 不持有等待 Promise。
- D1 任务从 `queued -> running -> succeeded` 全链路。
- 模拟 DO evict：新实例收到 `exec_result`，仅凭 job_id 更新 D1，任务完成。
- 轮询 `GET /api/jobs/:id` 不调用 TerminalDO stub（断言调用数不变）。
- exec 超时/非零退出码/Agent 离线/权限撤销。
- upload job 创建、签名 URL、大小限制、Content-Length 缺失、重复上传、过期 token。
- Worker 流式写 R2（mock）后 D1 状态 `staged`，不经过 `/rpc/upload`。
- Agent 下载 mock URL，成功后 DO 更新 D1，R2 删除。
- Agent 离线时 `waiting_agent`，重连后重新下发。
- 同一服务器第二个 upload / agent_update 返回 409；不同服务器可并行。
- agent_update：manifest/平台/build 校验、资产代理 URL 签名、DO 下发后立即返回、Agent 结果更新 D1、成功/失败审计。
- 旧 Agent 无 `update_fetch_proto` 时按 `LEGACY_SYNC_UPDATE` 走过渡路径或明确 `AGENT_UPGRADE_REQUIRED`。
- 新路径不创建 `pendingUpload` / `pendingUpdate`，不使用长 `setTimeout`。
- 审计只在终态写，`file.upload` 不再按签发计数；`agent.update.request` 仍 fail closed；`duration_ms/job_id` 正确。

### 13.2 Agent / Rust 测试

- 新增 `upload_fetch` / `agent_update_fetch` 帧解析与参数校验。
- 下载 URL host/path/scheme 校验；更新资产 URL 不允许任意 host。
- 大小不符、SHA 不符、HTTP 非 200、目标已存在且 overwrite=false、系统路径拒绝。
- 更新 build/platform 不符、`ALLOW_SELF_UPDATE` 关闭、self-replace 失败、backup 失败。
- 临时文件在失败/取消/超时后清理。
- 成功路径 fsync + rename，目标内容与大小正确。
- 保留旧 `handle_upload_frame` / `handle_update_frame` 回归测试（过渡期）。
- 旧 Agent 不含 `update_fetch_proto` 时走 legacy 分支或明确拒绝。

### 13.3 静态/契约检查

- `tools/list` 包含 `get_operation`，exec/agent update 的 PAT 可见性组合正确。
- `exec_command`、`update_agent` 工具描述明确“异步 job + 轮询”。
- `create_upload` 工具描述明确“上传完成不代表已落盘 + 轮询”。
- README 不再把 `exec_command`/`update_agent` 描述为同步返回最终结果。
- `wrangler.toml` 有 R2 binding；部署文档有 bucket 创建/lifecycle 说明。
- `schema.sql` 与 `0015` 终态一致；迁移测试能在空库与已有 0014 库通过。
- 不新增明文 token/PAT 到 D1、日志、URL query（签名 token 除外，且短期）。

### 13.4 必过验收标准

> 实现 Agent 自测不能只看“测试通过”，下面每条都要有对应测试或手工证据。

- [ ] 提交 `sleep 5`：正常运行下 MCP 快速返回 job accepted，不随命令时长等待；5 秒后轮询得到 stdout/exit_code；DO 请求本身不等待 5 秒。
- [ ] 连续 10 个 `sleep 5`：wall-clock 期间 DO 不因每个任务各挂 5 秒；任务结果可全部从 D1 取回。
- [ ] 50MB upload：客户端上传完成后，DO 没有 `/rpc/upload` 数据流；Agent 从一个短期 URL 拉取并写入；完成后 R2 对象被删除。
- [ ] 上传 100MB / 超限文件：超限在 Worker 流式阶段拒绝，R2 无残留。
- [ ] Agent 离线时 upload：任务进入 `waiting_agent`；Agent 重连后自动下发并完成。
- [ ] Agent 更新：MCP/REST 快速返回 job accepted，不等待资产下载/替换；Agent 从 Worker 资产代理下载并完成替换；轮询得到 `succeeded`；DO 没有 `/rpc/agent_update` 资产流和 180 秒等待。
- [ ] 更新任务失败/超时/Agent 断线时状态正确，不出现重复自动更新；旧 Agent 的 legacy 分支有明确日志和开关。
- [ ] DO evict/重启：运行中的 exec/update 结果仍能更新 D1；不依赖内存 Map。
- [ ] 撤销 PAT/收窄权限：轮询立即 401/403；已下发命令/更新不能撤回（文档有明确说明）。
- [ ] 非所有者不能读 job；伪造 job ID/上传 token/更新资产 token 返回 404/403。
- [ ] 任务终态后写入正确审计；`file.upload` 计数只代表实际成功上传；更新审计保留 from/to build。
- [ ] 既有测试全通过；新增测试全通过；Rust 单元/Clippy/Node 检查通过。
- [ ] 运行 Cloudflare 面板数小时，`/rpc/exec`、`/rpc/upload`、`/rpc/agent_update` 不再出现长 duration；Monitor 中 DO active time 明显下降。

### 13.5 建议的验证命令

```bash
npm test
node --check public/app.js
cargo test --manifest-path agent/rust/Cargo.toml
cargo clippy --manifest-path agent/rust/Cargo.toml -- -D warnings
```

## 14. 建议实现拆分

### 阶段 A：任务底座与 exec

- `0015` 迁移、`schema.sql`、操作任务服务（创建/读取/条件更新/过期）。
- 新增 REST `POST /api/exec-jobs`、`GET /api/jobs/:id`。
- 新增 DO `/rpc/exec/submit` 与 `exec_result` D1 回调。
- 更新 `exec_command`、新增 `get_operation`，更新工具描述/测试/README。
- 此阶段不依赖 R2，可先上线降低 exec duration。

### 阶段 B：upload staging 与 Agent

- 配置 R2 binding、bucket、lifecycle。
- 新增 upload job 创建、签名 URL、Worker→R2 流式 staging、下载 URL。
- 新增 DO `/rpc/upload/submit`、Agent `upload_fetch`、能力协商。
- 将 MCP `create_upload` 切到新流程。
- 保留旧 upload 路径一个版本，确认全量 Agent 升级后删除。

### 阶段 C：agent update 与前端

- 新增 `agent_update` job、Worker 资产代理、DO `/rpc/agent_update/submit`。
- Agent 增加 `agent_update_fetch`、`update_fetch_proto`、下载/SHA/self-replace 流程。
- 更新 REST/MCP 语义和 `public/app.js` 的单台/批量更新状态处理。
- 旧 Agent 仅通过 `LEGACY_SYNC_UPDATE=1` 走过渡路径；完成全量升级后删除（2026-10-28 已删除）。
- 更新 README、审计、工具描述和验收用例。

### 阶段 D：清理与收口

- 删除同步 `pendingExec`/`pendingUpdate` 长等待路径。
- 增加 cron 清理、审计 duration/job_id、文档和监控。
- 对所有新任务统一用 `GET /api/jobs/:id` 查询，不允许新增同步长等待入口。

## 15. 明确不做的事

- 不把 exec/upload/update 的“提交后异步”实现为 `waitUntil` 继续在 DO 里等待；那不会降低 duration。
- 不把轮询接口打到 DO；轮询必须由 Worker 读 D1。
- 不把 upload 文件继续流经 DO 后再声称异步；必须把字节移到 R2/Agent 拉取路径。
- 不把 Agent 更新资产继续经 DO 转发；必须走 Worker 资产代理或等价的非 DO 数据面。
- 不在 DO 中用 `setInterval` 或长 `setTimeout` 维护任务状态。
- 不改变浏览器现有终端/文件管理 WebSocket 协议；它们不是本次 MCP 同步 upload 的问题路径。
- 不在本次改造中改变 Agent 更新的 SHA-256、平台、版本、backup 和自替换安全校验。

## 16. 变更文件清单

预期涉及：

```text
migrations/0015_async_operation_jobs.sql  新增
schema.sql                                同步新增表/审计列
wrangler.toml                             增加 UPLOADS R2 binding
src/jobs.js                               新增任务服务（推荐）
src/utils.js                              新增 job upload/download/update token 签名
src/routes.js                             exec/upload/update job API、资产代理、MCP 工具、轮询
src/do-terminal.js                        /rpc/exec/submit、/rpc/upload/submit、/rpc/agent_update/submit、结果回调
src/index.js                              scheduled 清理（如启用 cron）
src/config.js                             任务 TTL/上限常量
agent/rust/Cargo.toml                     增加流式 HTTP 客户端依赖
agent/rust/src/main.rs                    upload_fetch、agent_update_fetch、能力声明、结果回执
agent/rust/src/update.rs                  HTTP 下载调度与现有 staging/校验/self-replace 复用
agent/rust/src/metrics/linux.rs           上报 update_fetch_proto / upload_fetch_proto
agent/rust/src/metrics/other.rs             同步更新能力字段（非 Linux 平台）
public/app.js                             单台/批量 agent update 适配 job accepted + 轮询/失败提示
public/lang/zh-CN.js                      新增更新任务状态文案
public/lang/en-US.js                      新增更新任务状态文案
test/api.test.js                          异步 exec/upload/update API 用例
test/do.test.js                           DO 结果回调、evict/重连、互斥、无长等待用例
test/unit.test.js                         签名、状态机、工具契约
test/helpers.js                            R2 mock、DO/R2/agent update 测试桩
README.md                                 API/MCP/R2/部署/行为变更说明
```

前端范围说明：终端/文件管理仍走 WebSocket，不改为异步 job；但 Agent 更新的现有 `updateAgent`/批量更新调用 REST 更新接口，必须适配新的 job 返回和状态轮询。若另加通用“任务中心”UI，可复用 `GET /api/jobs/:id`，不属于本次必需范围。
