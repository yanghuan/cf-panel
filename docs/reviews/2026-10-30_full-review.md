# 全量代码 Review（2026-10-30 · 第 11 轮）

- 基线：`645a69f`（2026-08-28 第 10 轮）→ `490ccd3`（HEAD），**112 个提交**，`src/ public/ agent/rust/src/ migrations/ schema.sql test/ scripts/ docs/` 合计 **+16470 / −1729**。
- 范围：`src/` 全部 11 模块、`public/` 全部（含 i18n 语言包）、`agent/rust/src` 全部 13 源文件、`test/` 全部、`scripts/e2e.mjs`、`wrangler.toml`、`schema.sql`、`migrations/`、`docs/`。
- 动态验证：`npm test` → **267/267 通过**（21.1s）；`cargo clippy --all-targets` → **零警告**；E2E 未执行（需 wrangler dev + release 二进制）。
- 结论：异步化（exec/upload/agent_update）重构整体质量高，状态机与失败路径显式，安全边界未被削弱。本轮新发现 **1 个 P2（天账在实例 evict 后停止累加）**、7 个 P3、10 个 P4/观察项，另有 10 处文档与实现漂移。

## 一、改动概览（本轮 review 的主战场）

| 主题 | 关键提交 | 规模 |
|---|---|---|
| 异步任务（exec → upload → agent_update 三阶段） | `46dab4a` `44e2e9b` | 新增 `src/jobs.js`（533 行）、`migrations/0015`、R2 staging、签名 URL、`/api/jobs/:id` 轮询 |
| Agent 自主拉取数据面 | 同上 + `cb06ad4` | 新增 `agent/rust/src/{fetch,dns,proxy}.rs`，`main.rs` +1549 |
| DO 韧性（探活/往返/附件恢复） | `361b487`…`492a4fe` | `do-terminal.js` +1160，`rebuildIndex` 五项索引与双向撤销 |
| 监控时序降载 | `efbd11e` `4743201` | 降采样桶、分层保留、采集与上报解耦（`collect_*_cached`） |
| 前端能力 | `1635d49` `1ba3244` `862f438` `a2fc487` | PAT 权限编辑、大文件只读预览、拖拽排序、i18n 全量接线 |
| 单实例锁 / 代理 / DNS | `1ca6a70` `cb06ad4` `2f9b3ff` | flock/CreateFileW、CONNECT 代理、自建 DNS |

## 二、新发现

### P2-01 天账（`metrics_day`）在 MetricsDO 实例 evict 后停止累加，且离线补账实际失效 🟢 已修复（2026-10-30，见 §九）

- 位置：`src/do-metrics.js:68-71`（`dayPending`/`dayAccum` 仅内存）、`:281-302`（`accumulateDay` 以 `dt = nowSec - st.lastSec` 累加，冷启动 `st` 为 `{lastSec: nowSec}` ⇒ `dt = 0`）、`:307-318`（`sweepOfflineDaySpans` 只遍历内存 `lastSeenSec`）、`:375-377`。
- 根因：`dayAccum` 与 `lastSeenSec` 都没有持久化，也没有从 D1 `servers.last_seen` 播种。而本仓库自己在 `ensureHousekeepLoaded` / `pushOn` 注释中已确认「慢采/空闲下 MetricsDO 无 WS、两次 alarm 间实例常被 evict」（DO 约 10s 无请求即被驱逐）。无观看者时 agent 是 120s 慢采，逐帧落到冷实例，`dt` 恒为 0。
- 实测（用 `test/helpers.js` 的 D1/mock，两个 MetricsDO 实例模拟 evict，两帧相隔 2 分钟）：

  ```
  metrics_day rows after two reports in separate instances:
    { bytes_in: 0, bytes_out: 0, online_min: 0, total_min: 0, uptime_min: 1.67, restarts: 0 }
  同一实例内两次 accumulateDay（相隔 120s）：
    { bytes_in: 120000, bytes_out: 120000, online_min: 2, total_min: 2 }
  ```

- 影响：没有观看者（即绝大多数时间）时，流量累计静默为 0、可用率因分母为 0 显示 `-`（前端 `pctText(null)`），`uptime` 下降沿也检测不到（重启次数同样依赖内存游标）。真正被记账的只有「有人开着面板 → agent 切 5s 快采 → 实例常驻」的时段。这正好与 `docs/architecture.md`「按天账由上报链路实时累加」的承诺相反，也和测试 `MetricsDO: 长时间离线只补可用率分母`（同实例内验证）覆盖不到的生产路径不一致。
- 建议修复：
  1. `accumulateDay` 的游标随 `flushDayPending`（或单独 key）持久化到 DO Storage（每机一个 `daycur:<id>`，10 分钟一次写，成本可忽略）；
  2. 冷启动时用 D1 `servers.last_seen`（60s 节流写，粒度足够 120s 慢采）播种 `lastSec`，避免首帧 `dt=0`；
  3. `sweepOfflineDaySpans` 改为遍历 D1 `SELECT id,last_seen FROM servers`（`checkOfflineAlerts` 已有同一查询），不要依赖内存 `lastSeenSec`。
- 测试补强：现有用例都复用同一实例，需增加「新实例 + 旧 storage」或用例直接断言 `sweepOfflineDaySpans` 在空 `lastSeenSec` 下仍能补分母。

### P3-01 热区首次 `/query` 会用 storage 的首帧覆盖内存最新值（查询副作用污染后续归档）

- 位置：`src/do-metrics.js:371-374`（同分钟仅首帧 `storage.put`，后续帧只更新内存）、`:128-138`（`loadHot` 直接 `this.data.set(serverId, m)`）、`:141-144`（`ensureHot`）。
- 实测：同一分钟两帧 `cpu=10` / `cpu=90`，随后首次 `/query` 返回 `[10]`（应为 90）。之后该分钟跨过归档线时，`archiveIncrement` 也会把 10 写进 D1。
- 影响：首次打开监控图（每个实例生命周期一次）时，热区窗口内每分钟显示该分钟第一帧；若这期间发生归档，陈旧值会固化到 `metrics_min`。幅度通常很小（5s 内变化），但属于「只读查询修改后续写入」的隐性副作用。
- 建议：`loadHot` 改为合并而非替换（同 ts 以内存为准），或热写成功后再置 `hotLoaded`（但要保留 `/query` 补 storage 旧行的语义，合并更安全）。

### P3-02 `hasActiveAgentUpdate` 不看 `deadline_at`，过期未收敛的更新任务可阻塞 exec/upload 最长 1 小时

- 位置：`src/jobs.js:199-204`（`status IN ('queued','waiting_agent','running')`，无 deadline 条件）；调用点 `src/routes.js:413`（exec）、`:944`/`:1840`（upload）、`src/do-terminal.js:1048`（重连重发）。
- 场景：`update_agent` 下发后 Agent 未回执且连接未断（如更新任务内部挂住、进程未退出），deadline=210s 到期后没有任何路径收敛（`settleExpiredAll` 只在每小时第 17 分钟的 cron 跑；`readJobForUser` 仅在有人轮询该 job 时收敛）。此后该机所有 `exec_command` / `create_upload` / 重连重发都返回 409/跳过，最长到下一次 cron。
- 建议：`hasActiveAgentUpdate` 增加 `AND deadline_at > ?`（并在命中过期行时顺手 `settleServerExpired`），与 upload 的 `settleServerExpired` 设计对齐。

### P3-03 `settleServerExpired` 的 `LIMIT 20` 可能选不到真正挡路的那条任务

- 位置：`src/jobs.js:214-236`，SQL 为 `WHERE server_id=? AND deadline_at<? AND status IN (...)` **无 ORDER BY、无 kind 过滤**，`LIMIT 20`。
- 场景：Agent 离线期间用户通过 MCP 连续下发 25 条命令 → 25 条 exec 任务过期但无人轮询；随后 `create_upload` 调用 `settleServerExpired` 只处理前 20 条（通常是最早插入的 exec），而过期的 upload/update 行仍在活动状态集合内 → 部分唯一索引命中 → 返回 `UPLOAD_BUSY`/`UPDATE_BUSY`，最长挡到 cron（1h）或下一次重试腾出名额。
- 建议：`ORDER BY deadline_at`（最老的先收敛）或 `AND kind IN ('upload','agent_update')`（本函数存在的目的就是让出这两个单机串行锁）。

### P3-04 服务器卡片的「更新 Agent」悬浮提示显示字面量 `{from}`

- 位置：`public/app.js:401` 把 `info` 定义为字符串（`[s.info.os, up].join(' · ')`），`:403` 却使用 `info.agent_version`（`undefined`）。
- `t('server.updateTip', { from: undefined, to })` 的占位符替换保留原样（`public/i18n.js:65`），中文界面显示「当前 {from} → 2026.10.30-…」。`metricTipHtml`（`:329`）里的同名用法是正确的（那里 `info` 是对象）。
- 建议：`s.info.agent_version`，并补一个静态断言（卡片 tooltip 不得出现 `{from}`）防回归。

### P3-05 移除 `PROBES` 配置后前端探活徽章永久残留

- 位置：`agent/rust/src/metrics/mod.rs:384` 无配置时上报 `probes: []`；`src/report.js:102-116` 把空数组归一为 `null`；`src/report.js:168-179` 仅当 `Array.isArray(payload.probes)` 时才更新 `probe_json`。
- 结果：operator 在 agent 上删掉 `PROBES` 并重启后，`servers.probe_json` 仍是旧结果，卡片一直显示绿/红徽章（错误的服务健康信息）；`probeState` 旧记录跨配置变更保留，同名探针重新启用时若仍在冷却窗口内，会跳过本应发出的 down 通知（冷却本为「连续失败」设计，这里被跨配置沿用了）。
- 建议：区分「未上报该字段」（保持原值）与「上报空数组」（清空）——在 `sanitizeReportPayload` 里保留 `[]` 语义（例如 `out.probes = []` 而不是 `null`），`handleReport` 对空数组写 `probe_json = NULL`。

### P3-06 `agentUpdateCore` 在 UPDATE_BUSY 判定之前写 `agent.update.request` 审计

- 位置：`src/routes.js:1680-1683`（审计）→ `:1688-1698`（`createAgentUpdateJob` 命中唯一索引 → 409）。
- 结果：并发/重复触发更新被 409 拒绝时，审计里仍留下一条「已请求更新」，而版本未动——这与同函数上方注释「纯判定必须放在写审计之前」的原则自相矛盾，事后排查会误判为下发失败。
- 建议：把审计移到 `createAgentUpdateJob` 成功之后（失败/忙返回则不留 request 记录），或先查 `hasActiveAgentUpdate` 再写审计。

### P3-07 14 个后端错误码没有前端翻译（含中文界面可见项）

- 位置：`public/lang/zh-CN.js:574-587` 只有 14 个 `error.*` key；`api()` 未命中即回退英文原文（`public/api.js:28-31`）。
- 缺失：`DESCRIPTION_TOO_LONG`、`COMMAND_REQUIRED`、`PATH_REQUIRED`、`AGENT_UPDATE_BUSY`、`UPLOAD_BUSY`、`UPDATE_BUSY`、`ORDER_ITEMS_REQUIRED`、`ORDER_BAD_ITEM`、`ORDER_TOO_MANY`、`LENGTH_REQUIRED`、`UPLOAD_CLAIMED`、`JOB_NOT_AWAITING_UPLOAD`、`TOO_LARGE`、`AGENT_UPGRADE_REQUIRED`。
- 其中中文 UI 实际可见：`DESCRIPTION_TOO_LONG`（描述超 500 字）、`AGENT_UPGRADE_REQUIRED`（旧 Agent 更新）、`UPDATE_BUSY`/`TOO_LARGE`。另有一处命名不一致：`src/routes.js:1448` 发 `TOO_LARGE`，语言包里写的是 `error.UPLOAD_TOO_LARGE`（即使补了 key 也命不中）。
- 建议：以 `src/routes.js` 的 `err(...,'CODE')` 为源生成/校验 `error.*`（可加一条单测：`src/` 里出现的全部 code 都能在 zh-CN/en-US 中找到）。

## 三、P4 / 观察项

1. **死代码与陈旧注释（`src/do-terminal.js`）**：`EXEC_TIMEOUT_GRACE_MS`(:22)、`UPLOAD_CHUNK_BYTES`(:30)、`UPLOAD_TIMEOUT_MS`(:31)、`UPLOAD_MAX_DEFAULT`(:32)、`AGENT_UPDATE_MAX_BYTES`(:33)、`AGENT_UPDATE_TIMEOUT_MS`(:34) 同步数据面删除后已无引用；`:462` 的「/api/file_upload 核心：流式读 body…」注释直接盖在 `dropAgentSessions` 上方；`:547` 写「5s 未收到」，实际 `OPEN_ACK_RETRY_MS = 3s`（`:44`）。
2. **`/api/servers/:id` 前缀匹配过宽**：`PATCH /api/servers/` / `DELETE /api/servers/` 用 `path.startsWith` + `split('/')[3]`（`src/routes.js:855,896`），因此 `DELETE /api/servers/123/rotate-key` 会删除服务器；功能上无害（需管理员），但建议收紧为正则。
3. **幂等键不校验目标**：`createExecJob` 命中 `(user_id, kind, idempotency_key)` 后直接返回旧 job（`src/jobs.js:49-55`），若同一 key 换 server/command 复用，会静默拿到另一台机器的结果；竞态兜底查询（`:85-90`）还缺少 `expires_at >= now`，理论上会返回已过期任务。
4. **`mcpCreateUpload` 的审计是强依赖**：`src/routes.js:1857-1859` 直接 `await ...run()`（REST 版用 best-effort `auditLog`）。审计写失败时上传任务已创建、URL 未返回，单机串行锁被占 10 分钟。
5. **`markUploadStaged` 失败无终态**：`src/routes.js:1460-1462` 删对象后直接 409，任务停在 `staging` 直到 600s deadline（最终由 `settleExpired(All)` 收敛）。可顺手 `finishUploadJob(false)`。
6. **终端重连定时器不随关闭取消**：`public/api.js:441-442,487` 的 `setTimeout(() => this.open(...))` 在用户关窗后仍会执行，`api('/api/terminal')` 已创建的服务端会话无人接管（PTY/agent 进程要等 10 分钟 TTL 回收）。`open()` 在请求返回后才发现 `closed`，建议先把定时器句柄存起来并在 `close()` 里清掉。
7. **i18n 标点残留**：分组标题 `（${count}）`（`public/app.js:548`）、批量删除名单 `join('、')`（`:2641`）、`token.hint` 名单 `join('，')`（`:2858`）、tooltip 的 `：`（`:2243`/`:2778`）在英文界面仍输出中文标点。`test/unit.test.js:929` 只匹配 `[一-龥]`，全角标点漏检。
8. **`alarm` 闲置判定在冷实例上误判**：`src/do-metrics.js:865` 用 `this.data.size === 0`，冷实例（storage 有行但内存空）会被判为空闲，alarm 退避到 1h；再叠加 `6 × 10min` 的 sweep 判据，fullSweep 可能滑到 2h 一次（仅影响 >keepMin 的 storage 行清理与兜底归档，不再是常态路径）。
9. **`fetch.rs` 在 async 任务里用 `std::fs::File` 同步写**：`agent/rust/src/fetch.rs:186-277` 的 `write_all` 会阻塞 tokio worker（块很小，影响有限）。项目已统一走 `blocking.rs` 线程池，这里可对齐（或至少在注释里说明取舍）。
10. **`proxy.rs` 对 CONNECT 响应后的多余字节直接报错**（`:203-205`）：严格的正确性取舍，但少数代理在 200 后立即捎带数据时会误判，值得在注释中保留已知限制（当前注释已提，未提兼容性影响）。

## 四、专项核查（本轮重点，未发现新问题）

1. **异步任务状态机**：所有状态流转均为条件 UPDATE + `meta.changes` 判据；重复回执、过期后迟到回执（upload/update/exec 三类，`[late]` 标记与状态纠正）都有明确语义与测试（`test/do.test.js:2946-3160`）；`expired → succeeded` 只对迟到回执开放，`succeeded/failed` 不可覆盖。✅
2. **R2 生命周期**：过期路径主动删 staging（`settleExpired`/`settleExpiredAll`/`requeueOrphanUploads`/`settleUploadJob`），cron 再按 TTL 与孤儿前缀兜底，与 `expires_at` 24h 解耦。✅
3. **签名 URL**：`purpose|jobId|serverId|extra|exp` 全绑定，content/download/asset 三用途不可互换；download 额外校验 `status === 'running'`、asset 额外校验 `build|platform|size`；`/mcp/*` 三端点均在 `requireJwtSecret` 之后。✅
4. **权限收窄**：`panel:admin` 只能 JWT 签发（REST + MCP 双路径），PATCH token 仅 JWT 管理员，`server_ids` 三态（null/[]/白名单）语义在 SQL、前端回显、审计里一致。✅
5. **路径安全**：词法黑名单 + `canonicalize` 真实路径双检，WS 写、REST 上传（`upload_fetch`）、find/list/rename/delete 全部汇聚 `is_system_path_resolved`；`/run` 的「拦自身、放行子树」两侧（Rust/前端）同规则且有测试。✅
6. **前端 XSS**：文件条目 `normalizeFileEntry` 只接受字符串；卡片/tooltip/审计/令牌列表全部 `escapeHtml`；自定义指标名只进 Chart.js canvas；Markdown 经 DOMPurify；CSP 有反向断言禁止 `script-src 'unsafe-inline'`。✅
7. **Agent 连接韧性**：TCP/TLS/101 三段 15s 总超时、控制通道 180s 读超时 + 30s 心跳、单帧发送 10s 超时、60s 上报队列有界、`CONTROL_READ_TIMEOUT_S` 与探活窗口的关系有注释与测试；单实例锁（flock/CreateFileW）与 4001 superseded 长退避闭环。✅
8. **数值/容量收口**：上报帧白名单（extra 数值、disk 条数、custom 50 条、probes 50 条、体积上限）、exec 命令字节上限按 JSON 转义计量（与 agent `CTRL_MSG_LIMIT` 同步）、stdout/stderr 有界读取 + 截断保留 UTF-8 边界。✅

## 五、文档一致性（需修）

| 文档 | 内容 | 实际 |
|---|---|---|
| `docs/architecture.md:135` | 「无人观看 60s / 有人 5s」 | 慢采 **120s**（`do-terminal.js:19`） |
| `docs/architecture.md:98` | 「`getAlertCfg` 带 60s 缓存」 | `SETTINGS_TTL_MS = 300s`（`db.js:10`） |
| `docs/architecture.md:230` | 「TerminalDO 在…每次上报后查询 `/viewers`」 | 已改为事件驱动 + 附件缓存，仅兜底查询 |
| `README.md:390` | 「POST `/api/servers/:id/agent-update` 流式更新 Agent」 | 已异步：Agent 经资产代理自行拉取 |
| `agent/README.md:105` | 「更新包由 Worker 流式中转到控制 WebSocket（48KB 二进制帧）」 | 同步推送路径已删除（阶段 C） |
| `agent/README.md:57-72` | 环境变量表 | 缺 `AGENT_PROXY_URL`/`PROXY_URL`、`AGENT_TLS_ROOTS`、`AGENT_LENIENT_WS`（`--help` 有，README 无） |
| `schema.sql:73` | 「状态见 `src/jobs.js` JOBS_STATES」 | 不存在该常量（只有 `JOB_TERMINAL_STATES` / 局部 `ACTIVE_STATES`） |
| `scripts/e2e.mjs:6` | 「MCP 全量工具（16 个）」 | 17 个（脚本内断言已是 17） |
| `public/app.js:3096` | 「后端 name 无唯一约束」 | 迁移 0010 已加唯一索引 + 409 |
| `docs/async-exec-upload-design.md:562` | §7.5 仍写「列为后续项，不与本次改动混做」 | `17d413c` 已把探活改为上报顺风车（probe 帧仍保留，描述的目标「零额外请求」未完全达成，需二选一改文档或改实现） |

## 六、质量评价

- **异步化设计的完成度高**：任务表 + 条件更新 + 迟到回执 + R2 生命周期 + DO 只下发元数据，四层边界清晰；`docs/async-exec-upload-design.md`（1288 行）与代码同源，几乎每处取舍都能在文档找到动机。
- **测试锁定的是「性质」而非流程**：`expired → succeeded` 的迟到语义、`size mismatch` 双向校验、`agent disconnected` 的 upload 豁免、`cleanup` 不误清控制连接状态、`normalizeFileEntry` 拒绝数组、CSP 反向断言等，都是防回归价值最高的断言。
- **注释解释「为什么」**：本轮尤其体现在 `rebuildIndex` 五项索引的「只跟随胜出连接 / 必须双向撤销」、`archiveIncrement` 的水位兜底、`blocking.rs` 的三层防护，能看出是按线上症状逐条修的。
- **主要短板在「长期/低频路径」**：天账游标随实例丢失（P2-01）、过期任务收敛依赖 cron（P3-02/03）、文档数字与实现漂移（多处）——都是「平时看不出来、出问题很难查」的类型。建议把「跨实例状态必须持久化或可从 D1 播种」作为一条设计约束写进架构文档，再做一次针对「无观看者 + 单机部署」的端到端演练。

## 七、结论

本轮不存在阻塞发布的 P0/P1，安全边界与数据面隔离均维持前 10 轮水准。**P2-01（天账 evict 丢失）建议作为下一轮的首要修复项**：它是「功能存在但静默给出错误数字」，比崩溃更难被发现；P3-02/03 可在同一次改动里一起收口（都给「活动任务」判据补上 deadline 维度）。其余 P4 与文档漂移建议随下次功能提交顺带清理。

## 八、专项补充：性能、内存与 CF 免费额度（追加）

**前提：不变更 `REPORT_FAST_INTERVAL_S=5` / `REPORT_SLOW_INTERVAL_S=120`。** 本节的所有数字都是按代码常量推算的模型（未跑压测/未读生产 dashboard），验证方法见 §8.8。

### 8.1 计费口径（来自 `.codebuddy/skills/cf-worker/SKILL.md`）

- DO 请求 **100,000/天**；duration **13,000 GB-s/天**（≈28.2 个 128MB 实例小时）；UTC 00:00 重置，超限直接报错（不是限速）。
- **WebSocket 入站消息按 20:1 折算**（20 条 = 1 请求）；DO→DO 的 `fetch` 和 HTTP 请求是 1 请求。
- D1：5M 行读 / 100k 行写 / 天；duration 正常 `dur/req = 0.4–0.6s`，升到 8s 说明对象失去 hibernation 资格（按 70–140s evict 规则计费），不是流量变大。

**关键推论**：agent 的 5s 快采本身几乎不花 DO 请求——1 台机器 17,280 帧/天，÷20 后只有 **864 请求**。真正吃额度的是「服务端为了 5s 刷新画面」的两次转发：

| 固定动作 | 频率 | DO 请求/天 |
|---|---|---|
| TerminalDO → MetricsDO `/report` 批量转发（`report.js:33,238-250`） | 每个活跃分片每 5s | **17,280/分片**（720/小时） |
| MetricsDO → PanelDO `/rpc/latest_push`（`do-metrics.js:29,398-407`） | 全局每 5s | **17,280**（720/小时） |
| agent 上报入站帧 | 5s/台 | 864/台（÷20） |
| 探活 `pong`（`do-terminal.js:24-26`，`PROBE_REFRESH_MS=300s`） | 300s/台（慢采受帧距限制落 360s） | ≈14/台（÷20） |
| MetricsDO alarm（10min / 闲置 1h） | — | ≤144 |

即：**DO 请求的成本大头是「活跃分片数 × 720/小时 + 720/小时」，与机器数几乎无关**。这也解释了为什么"不调大采样间隔"几乎不影响最大的优化空间——可调的是转发/推送节拍与分片数，不是采样间隔。

### 8.2 额度模型

记 `N` = 快采机器数，`A` = 有快采机器的分片数（≤4，服务器按 `id % 4` 分布）：

```
快采（有人在看）：
  R_day ≈ 17,280 × (A + 1) + 864 × N + 14 × N + 144
慢采（无人观看）：
  R_day ≈ 720 × N（逐帧转发，未达 5s 节流上限） + 36 × N + min(720 × N, 2,880)（探针） + 12 × N + 144
```

24 小时连续有人看：

| 规模 | DO 请求/天 | 占 100k | D1 写/天 | DO storage 写/天 |
|---|---|---|---|---|
| 1 台，1 分片 | ~35.6k | 36% | 3.0k | 2.9k |
| 2 台，2 分片 | ~53.7k | 54% | 6.0k | 5.8k |
| 4 台，4 分片 | ~90.0k | 90% | 12.1k | 11.5k |
| 10 台，4 分片 | ~95.3k | 95% | 30.2k | 28.8k |
| 30 台，4 分片 | ~113k（超） | 113% | **90.7k（D1 写见顶）** | 86.4k |
| 10 台慢采（无人看） | ~10.7k | 11% | 23.0k | 28.8k |
| 30 台慢采 | ~26.1k | 26% | 69.1k | 86.4k |

- **D1 写**是"机器数"维度的天花板：约 **30 台**。构成是 `metrics_min` 1,440（1 行/分钟）+ `last_seen` 1,440（60s 节流）+ `metrics_day` 144（10 分钟 flush），合计 3,024/台/天；每个自定义指标再 +288/天（慢采冷实例场景最坏 +720）。
- **DO duration** 与请求量近似成正比：按 0.5s/请求，95k 请求 ≈ 5.9k GB-s（46%）；一旦 `dur/req` 升到 8s，同样请求量就是 100,000 GB-s（7.7 倍超限）。所以 duration 是"卫生回归"的报警器，而不是稳态瓶颈。
- **DO storage 写** ~2,880/台/天（热行 1,440 + `arc` 水位 1,440），详见 8.4-2。
- 现实中浏览器 `visibilitychange` 会关 WS（`public/app.js:866-872`）、空闲 10 分钟自动暂停（`:839-841`），"24h 连续有人看"是上界而非典型值。

### 8.3 约束排序

1. **DO 请求**：有人看时由 `A + 1` 个 5s 节拍决定；4 分片全活跃时固定成本 86.4k/天，只剩 ~13k 余量。
2. **D1 写**：~30 台见顶（与是否有人看关系不大）。
3. **DO storage 内存/读放大**：`fullSweep` 与 `/latest` 冷启动都会 `list('m:')` 把整个热区（240×N 行）读进内存；500 台约 120k 行、数十 MB，叠加逐行 `JSON.parse` 与 `rowsByServer` 结构后接近 128MB 上限（详见 8.4-1 与 8.7-1）。
4. **D1 读**：中小规模无压力；500 台时 PanelDO 每次推送的全表读（17,280 × N/天）会接近 5M。
5. **duration**：稳态 <50%；异常驻留时瞬间超限。

### 8.4 可优化项：无采样影响、无界面新鲜度影响（建议直接做）

1. **`fullSweep` / `/latest` 冷启动的全量 list 改成分页/按前缀分块（数百台规模时的最高优先项，内存与 duration）**  
   `do-metrics.js:120-126` 的 `listStorage(prefix)` 直接 `state.storage.list({prefix})`。本项目三个 DO 都是 `new_sqlite_classes`（`wrangler.toml`），SQLite 后端的 `list()` **不带 options 时返回全部匹配项并全部载入内存**（旧 KV 后端的 1000 键截断不适用；官方文档明确提示"全量载入可能触及内存上限"）。由此：
   - `fullSweep`（`:884`）一次把 240×N 行读进 `rowsByServer`：500 台 ≈ 120k 行，值 + 结构 ≈ 50–100MB，接近/超过 isolate 上限；
   - `/latest` 冷启动（`:468`）同样全扫并逐行 `JSON.parse`，面板首次连接或 `/api/servers` 缓存 miss 时会形成一次 CPU/内存尖峰；
   - `fullSweep` 随后逐行 `await storage.delete`（`:969-982`），500 台每小时约 3 万次 await，duration 被串行拉长。
   
   修法：按服务器前缀分块（每块处理后立即释放，`delete(keys)` 批量删，单次最多 128 键）或 `limit` + `startAfter` 分页；`/latest` 冷启动改为读每机一个 `l:<id>` 小键（1/5 分钟写一次即可，+288 写/台/天，可与热行放在同一次 `put(Object)` 批量提交里），用 N 次读替代全扫，彻底去掉尖峰。
   （附注：慢采且无人看时，冷实例的 `data` 只有当前分钟，`archiveIncrement` 的区间循环与 `fresh` 兜底都拿不到行（`maxArchived=-1`），增量归档实际不产生 D1 行，归档由 `fullSweep` 兜底。它能读到全部行，所以不丢历史，只是归档延迟到一个 sweep 周期——这与 P2-01 的"实例内存跨 evict 不可靠"同源。）

2. **`arc:<id>` 水位降频写**：`archiveIncrement` 每跨一分钟就 `storage.put('arc:'+id)`（`do-metrics.js:226-229`），即 **1,440 次 DO storage 写/台/天**，与热行写入等量。改成每 10 分钟持久化一次即可——`INSERT OR IGNORE` 幂等，evict 后最多重复归档 10 行。**DO storage 写 −45%**（2,880 → 1,584/台/天）。

3. **告警/探活状态按需读**：`ensureAlertLoaded`/`ensureProbeLoaded`（`do-metrics.js:90-110`）每次冷实例都把全部机器的 `alert:*` / `probe:*` list 一遍。无观看者时 120s 一帧基本每帧都是冷实例 → 50 台 × 4 维 + 50 台 × 探针数 ≈ 数百行读/帧。改成：先判阈值，**只有越界才加载冷却状态**；探活按 `probe:<serverId>:` 前缀或单键读，只取当前机器。冷实例每帧的 storage 读从 O(全部机器×维度) 降到 O(1~4)。

4. **`/viewers` 自愈探针 30s → 300s**（`do-metrics.js:31,408-417`）：无观看者时最多 2,880 请求/天 → ≤288/天。只影响 `pushOn` 因 evict 丢失后的自愈延迟（≤5 分钟），不影响采样与告警。

5. **PanelDO 列表缓存**：`LIST_CACHE_TTL_MS=4500`（`do-panel.js:13`）是当年为"前端 3s sync"设的；现在 sync 只在连接时发一次、推送是 5s，**每次推送都刚好 miss**（5s > 4.5s）→ 每 5s 一次 `SELECT * FROM servers`。改成 15–30s，并：
   - 把 `clear_list_cache`（`do-panel.js:128-132`）从"仅删除时调用"扩展到**所有** server 增删改/排序（现在 create/rename/reorder 只清 Worker 侧 `serverListCache`，`routes.js:529,554`）；
   - 并发 miss 合并（in-flight promise），避免 N 个观看者同时打同一条 SQL。
   500 台规模时这是 8.6M 行读/天 → 1.4M 的关键。

6. **`buildList` 预解析 + 列裁剪**：每次推送对每台机器做 3 次 `JSON.parse`（`do-panel.js:272-275`），多观看者还会重复做。把解析结果放进 `listCache`，推送时只做权限过滤 + 组装；同时把 `queryServersForUser` / `filterServersCached` 的 `SELECT *` 改成显式列——**不要把 `agent_key_hash` 载入面向浏览器的 DO**（安全 + 缓存内存）。

7. **前端 `updateAgent` 去掉 `/api/servers` 2.5s 轮询**（`public/app.js:234-241`）：推送已经带 `info.agent_version`，一次更新最多白打 36 次 Worker 请求 + 36 次全表读 + `/latest`。

8. **`fullSweep` 批量删**：见 8.4-1，按 128 键/批把删除 await 从 N 次降到 N/128（500 台每小时约 3 万行 → ~235 次），直接压 duration。

9. **修正 `/api/usage` 估算**：`d1_writes = reportFrames * 0.5`（`routes.js:1586`）与实际构成不符——快采高估约 3 倍（8,640N vs 3,024N），慢采低估约 6 倍（360N vs 2,304N）；`do_events = frames*2` 既没有 WS 20:1 折算，也没有按分片聚合，与实际请求构成不符；且 `usage:total` 只在 alarm 落盘（`do-metrics.js:763-775`），evict 期间的计数会丢。既然额度是重点，建议改成按"服务器数 × 采样档位 + 活跃分片数"的解析公式，或至少把三个常量写进 note。

10. **R2 孤儿清理分页**：`index.js:67` 的 `env.UPLOADS.list({ prefix })` 忽略 `truncated`，超过 1000 个对象时清理不全（低频，P4）。

### 8.5 需要产品决策（有明确数字）

| 改动 | 节省 | 代价 |
|---|---|---|
| `REPORT_FWD_THROTTLE_S` 5→10s（`report.js:33`） | 4 分片快采 **−34,560 请求/天（−38%）**；1 分片 −17,280 | 卡片/告警/探活判定 5s→10s；agent 采样、热行、D1 写都不变 |
| `LATEST_PUSH_INTERVAL_MS` 5→10s（`do-metrics.js:29`） | −8,640 请求/天（−9%） | 界面刷新 10s；若改 15s，PanelDO 有机会在两次推送间被 evict，duration 也会降 |
| `SHARDS` 4→2（`config.js`） | 4 个分片都有快采机器时，快采固定成本 **−34,560/天（−38%）**，完全不影响新鲜度 | 迁移：`id % SHARDS` 变化后老连接留在旧分片，需遍历旧分片 `drop_server` 让 agent 重连；否则短暂显示离线 |
| `LAST_SEEN_THROTTLE_S` 60→180/300（`report.js:8`） | D1 写 −960/−1,152 写/台/天，D1 写天花板 33 台 → ~48/53 台 | 冷启动/离线告警的 D1 兜底 last_seen 变粗（在线判定主用 MetricsDO `last_seen_s`） |
| `metrics_day` flush 10→30 分钟 | D1 写 −96/台/天 | **必须先修 P2-01**，否则放大 evict 丢失窗口 |
| 自定义指标桶水位持久化 | D1 写 −432/台/指标/天（慢采冷实例场景） | 多一次 DO storage 读/写，或把桶从 5min 调到 10/15min（改变查询粒度） |
| idle 10min→5min（`public/app.js:839-841`） | 更早退出快采，DO 请求按观看时长线性下降 | 体验（长时间只读日志但无输入会被暂停） |

### 8.6 不建议

- **用 Worker HTTP 接口替代 DO WS 上报**：入站 WS 已 20:1，换成 HTTP 后每帧都是 1 个 Worker 请求，还要重新鉴权/查 D1，大概率更贵。
- **`ARCHIVE_TO_D1=0` 当省额度手段**：D1 写归零，但热区回退 720 分钟、storage 读/写与 `fullSweep` 全扫成本上升，且丢历史。
- **降低快采/慢采**：受"不改采样"约束，而且实测它并不是请求大头（÷20 后仅 864/台/天）。

### 8.7 内存专项

1. **`fullSweep` 全量物化**：SQLite 后端的 `list()` 默认返回全部匹配项，`fullSweep` 会把整个热区（240×N 行）连同 value 载入内存，再构造 `rowsByServer`；500 台 ≈ 120k 行、50–100MB，叠加解析后的对象很可能触及 128MB。必须按服务器前缀分块（每块处理后立即释放）或分页。
2. **`data` 热区无上限**：只在 `/query` 时 `loadHot`，加载后不淘汰；500 台各查一次 ≈ 120k 行，JS 对象 + Map 开销可达 100MB 量级。建议加 LRU（例如只保留最近访问的 100 台），不影响采样与保留策略。
3. **`serverListCache` 按"用户键 → 整份列表"缓存，上限是 500 条**（`auth.js:190-228`）：500 台时单份列表 ≈200KB，满 500 条即 ≈100MB，理论上是管理员可触发的内存放大（建大量 PAT 后各请求一次）。建议按条目数 + 总字节双限，或只缓存行数据、不缓存组装后的列表。
4. **PanelDO `listCache`** 持有 `info_json`/`probe_json`（各 8KB 上限），500 台最坏 ~8MB，可接受；预解析后可只留展示字段。
5. **`listStorage` 单次返回整个热区 value 的瞬时 Map**：分页后每页更小，`fullSweep` 也不再一次持有全部行。
6. **Agent 侧**：`fetch` 流式落盘、`read_limited` 有界、`update` staging ≤32MB，无新增风险；唯一可提的是 `fetch.rs:186-277` 在 async 任务里用 `std::fs::File` 同步写（块很小，项目已有 `blocking.rs`，可对齐）。

### 8.8 观测与验证

- 用 skill 脚本先量一次，再决定改哪项：

  ```bash
  set -a; . .codebuddy/skills/cf-worker/.env; set +a
  python3 .codebuddy/skills/cf-worker/scripts/do_usage.py --days 2 --by-class
  ```

- 看三个数：`requests`（是否接近 100k/天）、`dur/req`（正常 0.4–0.6s，>2s 说明有驻留/非 hibernatable）、按类拆分的 `TerminalDO / MetricsDO / PanelDO` 占比（预期 MetricsDO 转发与 PanelDO 推送是大头）。
- `usage` 面板目前不可信（见 8.4-9），不要用它判断是否接近额度。

### 8.9 落地顺序

1. `arc:` 水位降频 + 告警/探活按需读（DO storage 写 −45%、读大幅下降，纯收益；中小规模收益最直接）；
2. `fullSweep` / `/latest` 冷启动改分页或按前缀分块 + 批量删（数百台规模的内存与 duration，纯收益）；
3. PanelDO 列表缓存 TTL/失效/并发合并 + `buildList` 预解析 + 去掉前端 `updateAgent` 轮询（D1 读与 CPU，纯收益）；
4. `/viewers` 探针 300s + usage 估算修正（小收益，但让额度面板可信）；
5. 若要立刻腾出请求额度：`REPORT_FWD_THROTTLE_S` 5→10（−38% 请求，界面 10s）或 `SHARDS` 4→2（−38% 分片固定成本，需迁移动作）。

> 1–4 项不改任何快采/慢采间隔，也不改界面刷新节拍，建议直接实施；第 5 项涉及新鲜度或分片迁移，需单独决策。

## 九、修复验证（2026-10-30，已提交 `6bb26ce` + `0a43f0a`）

修复后 `npm test` → **297/297 通过**；`node scripts/e2e.mjs` → **33/33**（wrangler dev + release agent，含 MCP 17 工具）。Rust 源码未改（仅为 E2E 重新构建了 release 二进制）。

| 发现 | 状态 | 实现与验证 |
|---|---|---|
| P2-01 天账跨实例丢失 | ✅ 已修 | `do-metrics.js`：`ensureDayCursor`（Storage `daycur:<id>` → D1 `last_seen` 播种、未来时间 clamp）、`persistDayCursors`（alarm 内先持久化游标再写 D1）、`sweepOfflineDaySpans` 改 async 且遍历 D1 `servers.last_seen`、`/drop` 清 `daycur`。跨实例两帧：`{0,0,0}` → `{bytes_in:120000, online_min:2, total_min:2}` |
| P3-01 热区查询污染 | ✅ 已修 | `loadHot` 改为合并（内存优先、storage 补缺）。同分钟 10→90 后首次 `/query` 返回 90 |
| P3-02 过期 update 阻塞 | ✅ 已修（含两次补强） | `hasActiveAgentUpdate` 加 `deadline_at > ?`（**只读**：过期行收敛交给 `settleServerExpired`，避免每次开终端/exec 多一条 0 行 UPDATE）；`TerminalDO.isUpdating` 以 D1 为权威、且**始终查 D1**（evict 后本地 Map 为空也要拦），标记按 `Map<serverId, jobId>` 判定——排除「本次要下发的任务」、迟到回执只清同 jobId；3 条用例（过期清除 / 冷实例仍拦 / 旧标记不挡新任务） |
| P3-03 收敛名额被 exec 挤占 | ✅ 已修 | `settleServerExpired` 加 `kind IN ('upload','agent_update')` + `ORDER BY deadline_at`；新增 25 条过期 exec 的用例 |
| P3-04 更新 tooltip `{from}` | ✅ 已修 | `s.info.agent_version`；新增静态断言 |
| P3-05 探针配置移除残留 | ✅ 已修（含复核补强） | `[]` 语义保留、`probe_json` 写 NULL、`probesCleared` 顺风车；复核补：`clearProbeState` 方法此前**只调用未定义**（被 `catch` 静默吞掉，275 个用例未覆盖），已补内存 + Storage 清理并加用例 |
| P3-06 409 也写 request 审计 | ✅ 已修 | 审计移到 `createAgentUpdateJob` 成功后；审计失败 `failJob` 收敛再抛；用例改为断言 409 不留痕 |
| P3-07 错误码缺翻译 | ✅ 已修 | 两语言包各补 14 个；`TOO_LARGE` 与后端真实 code 对齐；新增「以 src 为源」的覆盖测试 |
| 文档漂移 10 处 | ✅ 已修 | architecture（120s/300s/事件驱动）、README（异步更新）、agent/README（异步拉取 + 3 个变量）、schema、e2e 17 工具、app.js 注释、设计文档 §7.5；README 保持 CRLF，diff 仅 1 行 |
| 复核补的游标失败顺序 | ✅ 已修 | `persistDayCursors` 返回失败集合；`flushDayPending` 对本轮游标未落盘的机器**不写 D1**（否则 D1 有增量、游标更早 → 下次重复记账），增量保留到下次重试；新增用例 |
| 探针状态兜底对账 | ✅ 已修 | alarm 内 `pruneStaleProbeStates`：以 D1 `probe_json` 为准清理残留冷却，覆盖「清理帧丢失」与「只删掉其中一个探针」；门控 = 配了 webhook + 每小时一次（原 10 分钟一次 = 72 万键读/天 → −6×） |
| A/B 档额度优化 | ✅ 已实施（四审补齐三项） | `arc` 水位降频（1,440 → 144 写/台/天，含冷启动 `arcPersisted` 初始化）；`fullSweep` 500 行/页分页 + 单机缓冲 + 128 键批量删；`/latest` 冷启动改读 `l:` 快照（288 写/台/天，最坏 720）+ 缺快照逐机补扫（单轮 ≤100 台）；PanelDO 列表缓存 20s + 并发合并 + 失效代际 + 6 条写路径清缓存（带 1s 超时）+ **列裁剪（不读 agent_key_hash）+ info/probe/alert_override 预解析**；**告警/探活冷却状态按需读**（阈值前置判定 + 按机前缀，正常帧零读）；`/viewers` 探针 300s；前端更新后不再 2.5s 轮询；`/api/usage` 估算改按服务器数解析 |
| 二审 P3-1 慢采 D1 写偏高 31% | ✅ 已修 | `slow_d1_writes` 3024 → 2304（慢采 `last_seen` 每帧写 720，非 60s 节流的 1,440），note 按两档写明 |
| 二审 P3-2 `/latest` 回退是全局判断 | ✅ 已修 | 缺 `l:` 的机器按 `m:<id>:` 前缀**逐机补扫**，其余机器零额外读；用例断言只扫 `l:` 与 `m:2:` |
| 二审 P3-3 文档 `l:` 频率口径 | ✅ 已修 | architecture 补「冷启动首帧必写、最坏 720 写/台/天」 |
| 二审 P4-1 探针对账读放大 | ✅ 已修 | 见上（告警开启 + 每小时一次双门控） |
| 二审 P4-2 `isUpdating` 写语句放大 | ✅ 已修 | `hasActiveAgentUpdate` 回归纯 SELECT；用例改为断言「只读判据不得改状态」，收敛由 `settleServerExpired` 覆盖 |
| 二审 P4-3 清缓存同步 await | ✅ 已修 | `clearPanelListCache` 带 1s 超时；PanelDO 不可达时写请求照常 200（用例） |
| 二审 P4-4 本文档过期 | ✅ 已修 | 即本节 |
| 二审 P4-5 `l:` 存分钟内首帧 | ✅ 已知取舍（三审修正数字） | 快照取「写入那一刻的最新帧」，值龄在分钟粒度内从 0 增长到 1 个上报周期。每帧写快照真实成本：**快采 +15,840 写/台/天**（热行 1,440 → 17,280）、**慢采 +432**（288 → 720）；而「下一分钟首帧写上一帧的值」这种零额外写的变体恒差一个上报周期（值龄从 1 个周期起算），更差——故维持现状 |
| 二审 P4-6 `arcPersisted` 未从 storage 初始化 | ✅ 已修 | 冷启动读 `arc:<id>` 时同步 `arcPersisted`；用例断言「冷启动推进 <10 分钟不写水位」 |
| 三审 #1 升级回退路径缺容错 | ✅ 已修 | 无 `l:` 时的全量 `m:` 扫描补 `try/catch`（与 `l:` 路径、`loadLatestFromHot` 一致）；用例断言坏行不导致 500 |
| 三审 #2 `l:` 快照成本数字 | ✅ 已修 | 见上一行（评论与本文档同步修正） |
| 三审 #3 冷启动多一条 D1 读 | ✅ 已澄清 | 注释点明「已有快照的机器零 Storage 读，代价是多一条 `SELECT id FROM servers`（冷启动 + 低频）」 |
| 三审 #4 升级首轮补扫串行 | ✅ 已修 | 单轮上限 `LATEST_BACKFILL_MAX=100` 台 + `ORDER BY id`（SQLite 可能走覆盖索引导致顺序变成字典序）；用例：101 台缺快照只补前 100 |
| 三审 #5 对账失败仍推进时间戳 | ✅ 已修 | `pruneStaleProbeStates` 返回布尔；失败（Storage/D1 抖动或删除失败）不推进 `lastProbePruneAt`，下轮 alarm（10 分钟）重试；用例覆盖 |
| 三审 #6 本文档标题 | ✅ 已修 | 标题改为 `6bb26ce` + `0a43f0a` |
| 三审 #7 `slow_do_events` 偏低 | ✅ 已修 | 补探活 pong（288/天 ÷20）与 `/viewers` 自愈反查（288/天）；note 写明构成；快/慢两档都补 |
| 四审 (1) architecture 措辞自相矛盾 | ✅ 已修 | `l:<id>` 描述与 §九 统一为「写入那一刻的最新帧（= 该分钟首帧），同分钟后续帧只在内存」 |
| 四审 (2) §8.9 第 1 项只做一半（告警/探活仍全量读） | ✅ 已修 | `ensureAlertLoaded`/`ensureProbeLoaded` 改 `...For(serverId)` 按机前缀加载；`checkAlerts` 先做零读阈值判定，**未越界直接返回**（冷实例每帧的 `list('alert:')` 消失），越界才恢复该机冷却；用例覆盖「未越界零读 / 越界按机读一次」 |
| 四审 (3) §8.9 第 3 项部分未做 | ✅ 已修 | `filterServersCached` 与 `queryServersForUser` 的 `SELECT *` 改显式列（不再把 `agent_key_hash` 读进面向浏览器的 DO）；`info/probe/alert_override` 在缓存填充时预解析（原先每次推送 × 每台 × 3 次 parse）；用例断言 SQL 无 `*`/无 `agent_key_hash`、字段已预解析 |
| 四审 (4) §8.4-10 R2 孤儿清理忽略 truncated | ✅ 已修 | `runJobMaintenance` 跟随 `cursor` 分页续读（每轮 ≤`R2_LIST_MAX_PAGES`=20 页），游标未前进则退出防死循环；R2 桩支持 `listPageSize`，用例：5 个孤儿 + 每页 2 → 全部回收 |

**残余（本轮仍不做）**

1. 「清理帧丢失 / 只删一个探针」已由 alarm 对账收口，残余降级为：**对账周期内（≤1 小时）** 同名探针重新启用可能沿用旧冷却——前提是配了 webhook，最坏造成一次通知抖动。
2. `settleServerExpired` / `settleExpiredAll` 的收敛路径不写审计（`expired` 的 upload/update 无终态审计行），与「审计只在终态写」的既有取舍一致。
3. §八 仍剩：C 档（`REPORT_FWD_THROTTLE_S` 5→10、`SHARDS` 4→2、`LAST_SEEN_THROTTLE_S` 60→180、idle 10→5min）、8.7 内存专项（`serverListCache` 条目/字节双限、`data` 热区 LRU、`fetch.rs` 同步写改走 `blocking.rs`）、8.4-10 的 `proxy.rs` 兼容性注释。8.9 前三项与 8.4-5/-10 已闭环。
