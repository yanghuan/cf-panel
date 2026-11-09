# 全量代码 Review（2026-11-06 · 第 12 轮）

- 基线：`490ccd3`（2026-10-30 第 11 轮）→ `dd793a7`（HEAD），**36 个提交**；全仓库 27 个文件 **+3646 / −464**（复核口径：所列的 `src/ public/ agent/rust/src/ test/ scripts/ docs/ wrangler.toml schema.sql migrations/` 实际为 **+3637 / −462**，差额来自 `README.md` 与 `agent/README.md` 的 **+9 / −2**）。
- 范围：`src/` 全部 11 个模块、`public/` 全部（含 i18n 与静态资源头）、`agent/rust/src` 全部 11 个 Rust 源文件、`test/`、`scripts/`、`migrations/`、`schema.sql`、`wrangler.toml`、两份 `README.md`、`.github/workflows/`、`.githooks/`、`docs/`；并只读核对线上 Worker/D1/GraphQL 用量与 GitHub Release manifest。
- 动态验证：`npm test` → **321/321**；`cargo test` → **75/75**；`bash agent/rust/check.sh`（rustfmt + clippy `-D warnings` + test）→ **全通过**；`node scripts/e2e.mjs` → **33/33**；`npm audit` → **0 vulnerabilities**；IDE 诊断 → **0 error / warning**。
- 结论：异步化架构、权限链、Hibernation 修复与测试体系整体质量高，线上 11-05 修复后 DO duration 已回落到安全区间。**本轮发现 2 个 P1、3 个 P2、10 个 P3/观察项及 10 类文档漂移**；复核另补 1 项观察项（§四 11）与多处同类的具体位置；无 P0。建议先修 P1/P2，再发布下一版 Worker/Agent。
- 本次仅审查并输出文档，未修改任何项目代码；后续复核修订同样只改本文档（见 §十一）。

---

## 一、改动概览（本轮 review 的主战场）

| 主题 | 关键提交 | 内容 |
|---|---|---|
| DO duration 根因定位与修复 | `4b67ad5`…`1715be7` | 状态快照、`[slow-*]` 埋点、定位重建阶段 `close(4001)` 制造永久 `CLOSING` |
| 连接重建与事件内附件缓存 | `d3b07ed` `76719f7` `eb42507` `44639d9` | 只跟随胜出连接、旧格式兼容、`attCache` 与事件入口清缓存、定时器泄漏修复 |
| 上报与跨 DO 调用韧性 | `a869cb6` `408a731` `6fd0122` | 三处跨 DO 调用超时、Webhook 后台化、`drop_server` 清理补齐 |
| 部署策略 | `1b02c1c` `f489013` | `durable_objects.code_update_strategy = immediate`，重启旧 DO 实例 |
| 文档与复核 | `3900a02` `dd793a7` | `do-duration-investigation.md`、正常快采与 duration 复发的区分判据 |

---

## 二、P1 新发现

### P1-01 Agent Key 轮换不能可靠撤销已建立的控制连接

`POST /api/servers/:id/rotate-key`、MCP `rotate_agent_key` 与删除服务器三处都只尽力调用四个分片的 `drop_server`，异常被吞掉后仍返回成功：

```js
// src/routes.js:852-860（REST 轮换；MCP :2109-2117、删除路径 :553-561 为同构循环）
for (let i = 0; i < SHARDS; i++) {
  try {
    await doForShard(env, i).fetch('https://do.internal/rpc/drop_server', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: id }),
    });
  } catch { /* 分片暂不可达；旧 key 重连会因指纹不存在被 401 拒绝 */ }
}
```

（复核订正：原稿此处引用了删除路径 `:560` 的注释文字；轮换/MCP 两处的 catch 注释为上行所示。）三处均不检查 `resp.ok`；MCP 路径（`routes.js:2095-2124`）还在返回 `note` 中明确声称"旧 key 已失效并已断开现有连接"（`:2123`）。

控制通道只在握手时检查 `agent_key_hash`（`src/do-terminal.js:571-603`），此后 `report`、`pong`、`exec_result` 等消息均只依赖连接附件中的 `serverId`，没有 key 版本/轮换 epoch 复核。

`drop_server` 只关闭 `agents.get(serverId)` 这一条"胜出连接"（`src/do-terminal.js:306-313`），而 `rebuildIndex` 为避免永久 `CLOSING` 已明确不关闭其余连接（`src/do-terminal.js:799-864`）。删除 `agents` 后，任何残留控制连接都可以通过"当前无登记者"分支重新占回索引：

```js
// src/do-terminal.js:1112-1121
if (att && (typeof att === 'string' || att.role === 'control')) {
  const cid = this.wsServerId(ws);
  if (cid) {
    const cur = this.agents.get(cid);
    const curDead = !cur || cur.readyState !== 1;
    if (curDead || cur === ws || this.wsAttTs(ws) >= this.wsAttTs(cur)) {
      this.agents.set(cid, ws);
    }
  }
}
```

`report` 随后仍会落库并转发 MetricsDO（`src/do-terminal.js:1161-1225`），`exec` 也会被下发到这个旧连接。项目近期确实出现过长期 `CLOSING` 控制连接，因此这不是纯理论路径。

**影响**：Key 泄露后的轮换可能无法真正撤销旧 Agent；旧控制连接仍可接收命令、上报数据或结算任务。对外承诺"旧 key 立即失效并断连"的位置共 5 处：`README.md:329`、`README.md:389`、`src/routes.js:123`（MCP `rotate_agent_key` 描述）、`:829-830`（REST 注释）、`:2123`（MCP 返回 `note`）；§六 的漂移表原先只列了 `README.md:329`。

**建议**：

1. 握手附件保存 `agent_key_id` 或轮换 epoch；控制消息按短 TTL 与 D1 当前身份比对，不匹配即关闭并丢弃。
2. `drop_server` 遍历 `state.getWebSockets()`，关闭所有 `role === 'control'` 且 `serverId` 匹配的连接；但 per-message 身份校验才是最终保障。注意本节修复不能与 11-05 的 duration 修复相冲突：`do-terminal.js:135-145` 的 `closeWs` 默认 `ws.close()`，对已消失对端同样会留下永久 `CLOSING` 并让对象拿不到 hibernation 资格（§一根因）。批量关闭应只作用于 `readyState === OPEN` 的连接并核验关闭结果，或优先依赖建议 1。
3. 检查 `drop_server` 的 `resp.ok`，失败时记录显式审计/错误，不能只依赖"下次重连会 401"；REST、MCP、删除三条路径都要改。
4. 补回归测试：`drop_server` RPC 失败、旧双开连接、轮换后旧连接发 `report` / 接收 `exec` 三条路径，并覆盖 MCP 轮换入口。

---

### P1-02 异步上传绕过真实路径保护，可经符号链接写入系统目录

文件会话的 `write_bytes` 有真实路径检查：

```rust
// agent/rust/src/session.rs:1723-1728
// 两条写入路径都汇聚到 write_bytes，在此统一拦截；调用方各自还有词法层快速预检。
// 本函数在 blocking 闭包内执行，canonicalize 阻塞由外层超时兜底
if is_system_path_resolved(path) {
    return err_json(SYSTEM_PATH_ERR);
}
```

但当前的 `upload_fetch` 异步上传并不调用 `write_bytes`。它只做纯词法检查：

```rust
// agent/rust/src/main.rs:949-951
// 系统路径保护：与旧同步路径、文件会话保持同一判据（/etc /usr /var /proc 等一律拒绝）。
// 少了这一层，拥有 server:exec 的凭据就能把文件写到 /etc/cron.d/ 这类位置。
if session::is_system_path(&path) {
```

然后直接按原始路径创建临时文件、父目录并 `rename`：

```rust
// agent/rust/src/main.rs:982-983
// 下载到目标同目录的临时文件：跨文件系统时 rename 会退化，同目录才是原子替换
let tmp = std::path::PathBuf::from(format!("{path}.cfp-upload-{upload_id}"));
```

```rust
// agent/rust/src/main.rs:1014-1018
if let Some(p) = std::path::Path::new(&path).parent() {
    std::fs::create_dir_all(p)?;
}
std::fs::rename(&tmp, &path)
```

例如 `/home/user/link/x` 中 `link -> /etc`，词法判定放行，下载与 `rename` 会跟随父目录链接写入 `/etc/x`。现有 `async_upload_rejects_system_paths_like_sync_path`（`main.rs:2166-2183`）只覆盖字面系统路径，未覆盖 `upload_fetch` 的符号链接穿越；`session.rs:1937-1961` 已验证 `is_system_path_resolved` 能拦住这种路径，只是新路径没有调用。

此外，整个提交阶段（`exists`、`create_dir_all`、`sync_all`、`rename`、`remove_file`）直接在 `tokio::spawn` 的 async 任务里做同步 IO，没有走统一 `file_blocking` 的超时、信号量和熔断；挂死 NFS 目录可让任务在下载完成后永久卡住，绕过服务端 `deadline_at`。`main.rs:995` 的注释以"此处已在 spawn 里"作为同步 `exists()` 可就地执行的依据，但 `tokio::spawn` 仍在 async worker 线程，不等于 `blocking.rs` 的阻塞线程池（复核订正：原稿把该注释概述成"已在阻塞线程里"，并非注释原文）。

**影响**：文件管理器明确宣称系统目录写保护；这是该安全边界的直接绕过。虽然 `server:exec` 凭据已可通过终端执行 shell，但产品语义和审计预期是不允许文件管理协议写入这些目录。

**建议**：

1. 下载前与 `rename` 前都在 `file_blocking` 内执行 `is_system_path_resolved(path)`，并尽量在最终提交前再次检查，缩小 TOCTOU 窗口。
2. 把异步上传的临时文件创建与原子提交收口到 `write_bytes` 或一个共享安全写函数，避免第三套路径语义继续漂移。复核补充：`main.rs:983` 直接把 `upload_id` 拼进临时文件名，缺少 `write_bytes` 的字符白名单（`session.rs:1716-1722`），收口时须一并补上，否则 `upload_id` 成为另一条路径注入面。
3. 所有同步文件系统调用移入 `file_blocking`；不要以 `tokio::spawn` 替代阻塞线程池。
4. 新增 `link -> /etc` 的异步上传回归测试，并修正 `session.rs:1724` "两条写入路径都汇聚到 write_bytes"的错误注释。

---

## 三、P2 新发现

### P2-01 MetricsDO 冷启动后 `/latest` 只返回部分服务器

`latestByServer` 只要非空就立即返回，后面的 `l:` 快照和逐机补扫全部不可达：

```js
// src/do-metrics.js:669-678
if (url.pathname === '/latest' && request.method === 'GET') {
  this.usage.latest += 1; // 用量观测
  const out = {};
  // 增量 latest Map：/report 热写 O(1) 维护，此处 O(S) 直接返回（避免对分钟 Map 扫描）
  if (this.latestByServer.size > 0) {
    for (const [serverId, l] of this.latestByServer) {
      if (l) out[serverId] = l;
    }
    return json(out);
  }
```

这与 `do-metrics.js:703-726` 注释"按机补扫、某台缺 `l:` 不能因其他机器有快照就跳过"直接矛盾。上一轮 §九 将 `/latest` 逐机补扫标记为已修，但漏掉了更早的这个提前返回。

**线上实测**：同一天连续两次 `list_servers`，第一次仅 4/17 台有实时指标，数秒后第二次为 16/17 台。复核（2026-11-06 本次核对）再次调用 `list_servers`，17 台中仅 2 台带 `metrics`（当次 12 台在线），说明冷实例只收到部分 `report` 时的提前返回可稳定复现，并非偶发。生产表现为部署/evict 后部分在线服务器短暂丢失 CPU、内存和实时卡片数据。

**建议**：删除提前返回；始终读取 `l:` 快照并按 D1 服务器清单补齐内存中缺失的机器，已有内存值优先。补"冷实例只收到 1 台 report，但应返回全部有效快照"的用例。

---

### P2-02 前端文件传输取消后重开可能串帧或提前完成

`_sendNextUpload` 的 `FileReader.onload` 只判断 `uploadState` 非空，没有确认仍是同一次上传：

```js
// public/api.js:187-189
u.reader.onload = () => {
  if (!this.uploadState) return; // 已取消（reader 异步完成）
  const commit = u.sent + chunk.size >= u.size;
```

Agent 的 `write_result` 也不回传 `upload_id`：

```rust
// agent/rust/src/session.rs:1786-1789
serde_json::json!({
    "type": "write_result", "ok": true, "path": path,
    "offset": offset, "written": written, "commit": commit,
})
```

`_onWriteResult(j)`（`public/api.js:207-218`）因此会把旧回执累加到当前上传。取消后立即重开同一路径时，旧异步读取块或旧 `write_result` 可能混入新任务，造成提前完成、块错序或文件损坏。`read_result` 同样只按 `path` 匹配（`public/api.js:293-400`），没有校验期望 offset 或请求代际；下载/预览取消后重开也有类似串帧面。

**建议**：写入和读取回执回传 `upload_id` / 请求代际；前端校验当前 state、generation、offset；`close()` 清空所有状态并让旧异步回调失效。

---

### P2-03 Agent Release 工作流未把第三方 Action 固定到 commit SHA

发布 job 持有 `contents: write`：

```yaml
# .github/workflows/agent-rust.yml:131-135
build-release:
  needs: [test, prepare, build-macos, build-windows]
  permissions:
    contents: write # 仅发布 job 需要写权限（创建 Release）
  runs-on: ubuntu-latest
```

发布动作及多个基础设施 Action 仍使用可移动标签/分支：

```yaml
# .github/workflows/agent-rust.yml:293-295
- name: 发布到 GitHub Releases
  uses: softprops/action-gh-release@v2
  with:
```

`@v4.2.2`、`@v4`、`@v2`、`@stable` 都是可变引用，注释中"固定具体版本（防 supply chain 变更）"不足以防标签移动。该流程直接发布 Agent 二进制和 `agent-manifest.json`；Agent 自更新只验证 manifest 内的 SHA-256，若发布 Action 或仓库凭证被攻破，会形成完整供应链入口。

复核补充：`.github/workflows/test.yml:20,22,34,36,51` 同样使用 `@v4.2.2` / `@v4.2.0` / `@stable`，虽为只读 job、权限较小，但供应链面未一起收敛；`.github/workflows/agent-rust.yml` 的 `@v4.2.2` 出现在全部 5 个 job（5 处 `checkout`），不止发布 job。

**建议**：全部固定到完整 commit SHA；限制发布工作流触发范围；为 Release 增加签名/provenance；CI 只读 job 继续保持最小权限。

---

## 四、P3 / 观察项

1. **任务回执未绑定服务器**：`do-terminal.js:1139-1159` 按 `job_id` 直接结算，`jobs.js` 的 `finish*Job` 也只按 id 条件更新。持有 A 机 Agent Key 且获知 B 机 job id 的连接可伪造 B 机结果。建议结算前校验 `row.server_id === wsServerId(ws)`；`settleUploadJob` / `settleUpdateJob` 是同一模式，须一并覆盖。
2. **上传响应返回过期状态**：`routes.js:1486` 读取的 `staged` 是 DO 下发前的快照，DO 随后已改为 `waiting_agent/running`（`do-terminal.js:473-498`），`:1510` 仍返回旧状态。应 dispatch 后重新 `getJob`。
3. **幂等键未校验 timeout**：`jobs.js:47-54` 只比较 server/command；同 key 改 `timeout` 仍静默返回旧任务。应纳入一致性比较，或明确文档忽略 timeout。
4. **Agent exec spawn/wait 失败被记为 succeeded**：`main.rs:1744-1757`、`:1796-1805` 未回传 `error`（只有 `stderr` 与 `exit_code: -1`），而 `do-terminal.js:1574-1587` 的 `settleExecJob` 只把 `j.error` 交给 `finishExecJob`（`jobs.js:149` 的 `error ? 'failed' : 'succeeded'`）。基础设施失败应映射为 `failed`。
5. **前端状态清理不完整**：`FileSession.close()` 未清 `prependState`（`api.js:91-100`），重开会话后 `prependMore()` 可能被永久挡住；`PushSession` 的重连 `setTimeout` 未保存/取消（`api.js:530-578`），`close()` 后迅速 `open()` 可能产生双 WS、重复观看者并维持快采。
6. **报告转发不检查 HTTP 状态**：`report.js:264-276` 只在网络 reject 时记录失败；MetricsDO 返回 500 时 `fetch()` 仍 resolve，批次已经被清空，造成静默丢帧。应检查 `resp.ok` 并保留/重试该批帧。
7. **MCP `update_agent` 描述误导客户端**：`routes.js:50-51` 仍写"经控制通道流式中转"，且没有明确异步 `job_id`；实际由 Agent 自行拉取资产并必须轮询 `get_operation`。
8. **下载 URL 的"同源"只校验 host 与路径前缀**：`fetch.rs:357-377` 校验 host 相等、path 以 `/mcp/` 开头，但不校验 port，也不校验 scheme 是否与 `AGENT_WSS_URL` 的 tls 语义一致（`parse_url` 允许 `http://`，`:328` 只拒绝非 http(s) 协议）；`fetch.rs:589-596` 的测试还显式允许不同端口。若 `panel_origin` 被污染，Agent 可带签名 token 请求同主机任意端口或明文 `http` 服务。建议对生产 `wss` 强制 `https` 且端口一致，仅本地调试放宽。
9. **Monaco 是唯一远程 CDN 依赖**：`public/utils.js:388-404` 从 `cdnjs.cloudflare.com` 加载 loader/worker，无 SRI；CSP 又允许该域执行脚本。虽然版本固定，仍与"依赖本地 vendor、避免供应链风险"的描述不完全一致。
10. **生产运维姿态**：存在一把无 `server_ids` 限制、有效期很长的 `panel:admin` PAT；`geo_lookup=true` 会按设计向第三方查询公网 IP；`/api/usage` 对 17 台服务器"24 小时连续快采"的估算为 `101,765 DO 请求/天`，超过 100,000 免费硬限。建议缩短 admin PAT 有效期、按最小权限重建，并把用量估算作为扩容/降频决策依据。
11. **（复核补充）跨 DO 调用超时只覆盖上报热路径**：`a869cb6` 只给 3 处加了 `AbortSignal.timeout`（`do-terminal.js:633`、`:1423`、`report.js:269`）。仍有 `do-metrics.js:614`（`/rpc/latest_push`）、`:626`（`/viewers`）、`do-panel.js:274`（`/latest`）等**DO 内发起**的跨 DO `fetch` 无超时；Worker 侧的 `auth.js:177,209`、`routes.js:442,546,555,854,1491,1610,1779,2111` 同样没有。对端挂起时，前者会复现"未完成 I/O 钉住 hibernation、持续计 duration"的同类根因，后者拖住请求。建议按调用方所在层级统一补齐超时，并把"跨 DO 超时覆盖"列为下轮专项核查项。

---

## 五、专项核查（未发现新问题）

- JWT/PAT 鉴权、JWT 管理员签发 `panel:admin`、PATCH token 的提权链熔断：实现与测试一致。
- 已建终端/文件会话的 PAT 撤销与降权双向重校验：已覆盖。
- 签名 URL 的 `content/download/asset` 三用途隔离、job/server/extra/exp 绑定、`running` 状态检查：无开放代理。
- `sanitizeReportPayload` 白名单、数值归一化、条数/体积上限；审计 CSV 公式注入防护；`escapeHtml`、DOMPurify、CSP：整体到位。
- 文件会话 `write_bytes`、`rename/delete/move/copy/find` 的真实路径检查：除 P1-02 的异步上传分叉外，路径模型一致。
- 任务状态机、重复/迟到回执、过期收敛、R2 暂存对象清理、cron 分页：上轮修复保留，生产 0 条活动任务。
- `wrangler.toml` 的 observability、immediate code update、Smart Placement、D1/R2/DO 绑定：与文档一致。
- `schema.sql` 与 `migrations/0015` 的任务表和部分唯一索引：一致。

---

## 六、文档与注释漂移

| 位置 | 问题 |
|---|---|
| `README.md:313` | 在线编辑写"上限 1MB"，实际 `EDIT_MAX_BYTES = 2MB`（`public/utils.js:460`） |
| `README.md:321` | 仍写"Worker → TerminalDO → 控制 WS 流式中转"；`:390` 已写异步，二者矛盾（`docs/architecture.md:320-352` 整节同属旧方案，见下） |
| `README.md:329`、`:389`；`src/routes.js:123`、`:829-830`、`:2123` | 五处都声称轮换 Key 立即失效并断连（REST 注释、MCP 工具描述与返回 note）；受 P1-01 影响，该保证不成立。原表只列了 `README.md:329` |
| `src/routes.js:738` | REST 更新入口注释仍写"Worker 流式中转 Release 资产" |
| `src/routes.js:1891`、`:63` | 注释与 `create_upload` 工具描述都称签名绑定 `server_id/path/overwrite`；实际 token 绑定 `purpose\|jobId\|serverId\|extra\|exp`（`utils.js:200-206`；复核订正：原表漏了 `extra`，且表格内未转义 `\|` 会截断列），path/overwrite 从 D1 读取 |
| `agent/README.md:115` | 写"更新接口仅 JWT 管理员可调用"；实际支持带 `agent:update` scope 的 PAT |
| `docs/architecture.md:320-352, 367-368` | 整节 §3.5.3（标题即"Worker 中转 + self-replace"）仍描述 `Response.body` 流式传 DO、≤48KB `agent_update` Binary 帧；`:367-368` 仍写同步旧路径 `exec_id` 与过渡期共存。原表只列 328-330 |
| `docs/async-exec-upload-design.md:14, 23-26, 94-103, 361, 784-785, 801, 939, 1110, 1119-1121, 1146, 1166, 1197, 1207, 1241` | 顶部称阶段 E 删除旧路径，后文多处仍称 `/rpc/upload`、`/mcp/file_upload`、`LEGACY_SYNC_UPDATE` 保留；应标注历史草案范围。原表只列 4 处 |
| `agent/rust/build.rs:18-25` | 只扫描 `src/` 顶层 `.rs`，遗漏 `src/metrics/*.rs`；完整检查由 `cargo fmt --check` 兜底，但"新增文件自动纳入"注释不准确（`:8` 的 `rerun-if-changed=src/` 是递归的，只有文件收集不递归） |
| `do-terminal.js:100-101`；`main.rs:1728-1730` | 两类不同性质的残留：前者是统计窗口口径（现为 `STAT_WINDOW_MS` 固定窗口，见 `do-terminal.js:157-163`），"每小时/跨整点"已过时；后者是同步 exec 路径残留（全仓库已无 `EXEC_TIMEOUT_GRACE_MS` 常量）。原表把两者合称"同步路径注释" |

---

## 七、线上状态与免费额度

### 7.1 Worker / D1 / 部署

> 以下为 review 时点的只读快照；随日增长的计数与在线数在复核时的取值见 §11.3，原数字不改写。

- 最后线上部署：`2026-11-05T16:13:55Z`，与 HEAD `dd793a7`（`2026-11-06 00:12 +0800`）吻合。
- `wrangler d1 migrations list cf-panel --remote`：无待应用迁移。
- D1：`17` 台服务器、`102` 条任务（101 `succeeded` + 1 `timed_out`，0 活动）、`5,346` 条审计、`96,181` 行 `metrics_min`、`669` 行 `metrics_day`，数据库约 `39.4 MiB`。
- 审计最早 `2026-08-08 14:24:04`，约 90 天保留期；`metrics_min` 最早与最新相差约 30.2 天，清理正常。
- 线上 17 台服务器中 13 台在线。16 台 Agent 为 `2026.10.28-1156`，1 台离线节点为 `2026.09.24-1442` 且禁用自更新；最新 Release manifest 为 `2026.10.30-1855-27698fd1`，fleet 尚未升级。

### 7.2 Cloudflare DO 计费口径

| UTC 日 | duration | requests | dur/req | 备注 |
|---|---:|---:|---:|---|
| 2026-11-04 | `12,392.9 GB-s` | `25,871` | `3.74s` | 约 95.3% duration 日额度，明确复发窗口 |
| 2026-11-05 | `2,927.4 GB-s` | `29,704` | `0.77s` | 约 22.5% duration 日额度，11-05 修复生效 |

- 请求量距 `100,000/天` 硬限仍有余量；duration 从贴限回落到安全区间，但 `0.77s` 仍略高于 `0.4–0.6s` 理想值，需继续观察。
- 白天有人观看的小时请求峰值约 `2,571/hour`，仍属正常快采；`dur/req` 未同步升到整小时驻留量级，说明永久 `CLOSING` 根因已消除。
- `/api/usage` 的 `101,765 DO 请求/天` 是"17 台 × 24h 连续快采"理论上界，不是当前实际值；若未来保持全天观看，需要评估 `REPORT_FWD_THROTTLE_S` 5→10 或 `SHARDS` 4→2 等已有产品决策。

---

## 八、上轮结论复核

| 第 11 轮结论 | 本轮复核 |
|---|---|
| P2-01 天账跨实例游标丢失 | ✅ 已修：`ensureDayCursor` / `persistDayCursors` / D1 驱动的 `sweepOfflineDaySpans` 均在 |
| P3-01 `loadHot` 覆盖内存最新值 | ✅ 已修：合并而非替换 |
| P3-02/03 过期任务阻塞与 LIMIT 挤占 | ✅ 已修：deadline 判据、kind 过滤、ORDER BY |
| P3-04～07 tooltip / 探针 / 审计 / 错误码 | ✅ 已修，且错误码覆盖测试通过 |
| A/B 档额度优化、latest 快照列裁剪等 | ✅ 大部分落地 |
| "`/latest` 逐机补扫已修" | ⚠️ 部分：P2-01 的提前 return 仍能跳过全部补扫 |
| "上传路径全部汇聚 `is_system_path_resolved`" | ❌ 不成立：P1-02 的 `upload_fetch` 分叉绕过 |
| "Agent 连接韧性闭环" | ⚠️ 连接存活/重连已加强，但 Key 轮换后的身份撤销未闭环：P1-01 |
| "文档漂移 10 处已修" | ⚠️ 原列表多数已修，但本轮仍发现 10 类新的/残留漂移 |
| "残余：cache 无字节上限、data 无 LRU、fetch.rs 同步写、R2 cursor 不跨轮持久化" | ⚠️ 仍存在；当前 17 台规模未触发，继续作为容量扩展前的技术债 |

---

## 九、修复优先级

1. **P1-01**：附件加入 key 身份/轮换 epoch，控制消息 per-message 复核；`drop_server` 关闭所有匹配控制连接；补失败与旧双开连接测试。
2. **P1-02**：异步上传下载前/提交前执行 `is_system_path_resolved`，统一安全写路径；提交 IO 移入 `file_blocking`；补符号链接测试。
3. **P2-01**：`/latest` 删除提前 return，始终合并快照与逐机补扫；补冷启动多机测试。
4. **P2-02**：文件传输回执加入 `upload_id` / generation / offset 校验，`close()` 清空全部状态。
5. **P2-03**：Release 工作流所有 Action 固定 SHA，补发布签名/provenance。
6. **P3**：回执绑定 serverId、上传响应重新读库、exec 失败状态、报告 `resp.ok`、前端状态机、MCP 描述与文档漂移；复核补充的跨 DO 超时覆盖（§四 11）、`upload_id` 白名单（P1-02 建议 2）与轮换承诺的另 4 处文案一并处理。
7. **运维**：修复发布后分批升级 16 台 Agent，人工处理禁用自更新的离线节点；轮换/缩短长期 admin PAT；持续监控 `dur/req` 和 `100k 请求/天` 上界。

---

## 十、结论

本轮没有阻塞运行的 P0，现有 321 个 Node 用例、75 个 Rust 用例和 33 项 E2E 全部通过，线上部署、迁移、任务清理与 11-05 后的 DO 额度均处于健康状态。

主要风险集中在"跨实例/异步化之后的新分叉"：

- 身份撤销仍假设"断开连接即可"，没有 per-message 身份复核；
- 文件保护仍假设"所有写入都经过 `write_bytes`"，但 `upload_fetch` 已分叉；
- `/latest` 仍假设"内存增量 Map 非空即完整"，但冷启动后它可能只有子集。

这三项都属于"平时测试全绿、生产低频路径才暴露"的类型。建议按第九节顺序修复，并在下一次发布时同时验证：Key 轮换失败演练、符号链接上传拒绝、DO evict 后多机 `/latest` 完整性，以及 duration 是否稳定在 `0.4–0.6s/请求`。

---

## 十一、复核补记（2026-11-06，仅文档）

对本轮文档做逐条复核：git 基线与改动量、全部代码行号引用、6 组动态验证、线上 Worker/D1/GraphQL/Release 只读数据，以及第 11 轮结论的复核对象。**结论：2 个 P1、3 个 P2、10 个 P3 与 10 类文档漂移全部成立，"无 P0"的判断不变**；订正与补充已就地写入前文。

### 11.1 复核通过（逐项复现）

- 基线 `490ccd3..dd793a7` = 36 提交；`npm test` 321/321、`cargo test` 75/75、`check.sh`（rustfmt + clippy `-D warnings` + test）全通过、E2E 33/33、`npm audit` 0 vulnerabilities、IDE 诊断 0 error/warning。
- 代码引用逐条比对无误：P1-01（`routes.js:852-860`、`do-terminal.js:306-313/571-603/799-864/1112-1121/1161-1225`）、P1-02（`main.rs:949-951/982-983/1014-1018/2166-2183`、`session.rs:1723-1728/1786-1789/1937-1961`）、P2-01（`do-metrics.js:669-678/703-726`）、P2-02（`api.js:187-189/207-218/293-400`）、P2-03（`agent-rust.yml:131-135/293-295`）；§四 P3 各项结论与 §五 专项核查亦逐条复现（其中 P3-4/8 的表述见 §11.2 订正，结论不变）。
- 线上：最后部署 `2026-11-05T16:13:55.371Z`、`wrangler d1 migrations list --remote` 无待应用迁移；D1 `17` 台 / `102` 任务（101 `succeeded` + 1 `timed_out`，0 活动）/ `5,346` 审计与文档一致；按 GraphQL 重算 UTC 日汇总，11-04 `12,392.9 GB-s / 25,871 / 3.74s`、11-05 `2,927.4 GB-s / 29,704 / 0.77s` 与 §7.2 表格逐位一致，有人观看的小时峰值 `2,571` 亦吻合；`get_usage` 的 `101,765 DO 请求/天`、`geo_lookup=true`、无 `server_ids` 的长期 `panel:admin` PAT、16 台 `2026.10.28-1156` + 1 台禁用自更新的旧版节点全部复现；最新 Release tag `cf-panel-agent-2026.10.30-1855-27698fd1` 含 `agent-manifest.json`。
- §八 的复核对象在第 11 轮文档中均可查（§四路径安全 / Agent 连接韧性、§五 10 处漂移、§九修复表与残余清单），"⚠️ 仍存在"的判断与当前代码一致（`auth.js:195-230` 的 `serverListCache` 只有条数上限、无字节上限，`do-metrics.js:65` 的 `data` 无 LRU，`fetch.rs:186-201` 同步写，`src/index.js:72-89` 的 R2 cursor 不跨轮持久化）。

### 11.2 订正（不改变结论）

1. 改动量口径：`+3646 / −464` 是全仓库 27 文件，所列路径集合为 `+3637 / −462`，差额来自两份 README（§开头）。
2. P1-01 代码块 catch 注释原引了删除路径 `:560` 的文字；轮换/MCP 两处实际为"旧 key 重连会因指纹不存在被 401 拒绝"。
3. P1-02 `main.rs:995` 注释原文是"此处已在 spawn 里"，不是"已在阻塞线程里"。
4. §六 签名 token 实际绑定 `purpose|jobId|serverId|extra|exp`（原表漏 `extra`；表格内的 `|` 未转义会截断列）。
5. §六 `do-terminal.js:100-101` 是统计窗口口径残留，不是同步 exec 路径注释；已与 `main.rs:1728-1730` 分开描述。
6. P3-8 `fetch.rs` 并非"忽略 scheme"，而是未校验 scheme/port 与 `AGENT_WSS_URL` 一致（`parse_url` 仅拒绝非 http(s) 协议，另有 `/mcp/` 路径前缀限制）。

### 11.3 遗漏补充

- **覆盖路径**：P1-01 漏了 MCP `rotate_agent_key`（`routes.js:2095-2124`）与"立即断连"承诺的另 4 处；P2-03 漏了 `test.yml` 与发布工作流其余 4 个 job（共 5 个 job 全用可变引用）；§六 漏了 `routes.js:63`、`:123`、`:829-830`、`:2123`、`README.md:389`，以及 `architecture.md` 整节 §3.5.3 与 `async-exec-upload-design.md` 的 10 余处矛盾位置。
- **P1-02 新增面**：`upload_id` 未做字符白名单即拼入临时文件名；P1-01 建议 2 需回避永久 `CLOSING`（11-05 根因），否则修身份撤销会把 duration 问题带回来。
- **新增观察项**：§四 11「跨 DO 调用超时只覆盖上报热路径」——`a869cb6` 只加 3 处，MetricsDO/PanelDO 内仍有未设超时的跨 DO `fetch`。
- **线上动态值**：复核时 D1 `metrics_min` `98,582` 行、`metrics_day` `673` 行、库约 `40.3 MiB`、在线 `12/17`、`list_servers` 仅 `2/17` 带 `metrics`（再次印证 P2-01）；§7.1 是 review 时点快照，增长与在线数波动属正常，故不改写原数字。

### 11.4 边界

本次复核只更新本文档，未修改任何项目代码、配置或线上数据；线上查询均为只读（Worker/D1/GraphQL/GitHub API/面板 MCP 读接口）。P1/P2 的修复仍按 §九 优先级执行。
