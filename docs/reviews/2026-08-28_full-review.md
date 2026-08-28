# 全量代码 Review（2026-08-28 · 第 10 轮）

- 范围：src/ 全部 7 模块、public/ 前端全部、agent/rust/src 全部 9 源文件、test/ 全部、scripts/e2e.mjs、wrangler.toml、schema.sql、migrations/、docs/
- 动态验证：`npm test` → **157/157 通过**（24s）；`cargo check` 通过；`cargo clippy` **零警告**
- 结论：**生产就绪**。前 9 轮 review 整改全部落实并有测试锁定；本轮未发现高危/中危问题，仅 1 个低危新发现与 3 个观察项。

## 一、动态验证

| 项 | 结果 |
|---|---|
| Worker 测试（unit/api/do + e2e 之外的套件） | 157 pass / 0 fail |
| `cargo check`（agent） | clean |
| `cargo clippy`（agent） | 0 warning |
| E2E（scripts/e2e.mjs，14 个 MCP 工具全链路） | 本轮未执行（需 wrangler dev + release 二进制；静态审查其逻辑无回归） |

## 二、本轮专项核查（历史遗漏扫描）

1. **服务器列表缓存键**（auth.js `serverListCacheKey`）：已包含 `user.id:role:username` + PAT `scopes|serverIDs`——同用户不同白名单 PAT 不会串缓存。✅
2. **前端 XSS 收口**：`renderFileList` / 目录选择器 / 审计导出 / 图表标题全部经 `escapeHtml` 或常量；自定义指标名仅进入 Chart.js canvas label（非 HTML）；Markdown 预览经 DOMPurify。未发现新逃逸点。✅
3. **上传大小上限**：agent 端 `write_bytes` 每块写后校验临时文件 ≤500MB（session.rs:1388），读/zip 侧另有 `FILE_LIMIT` 预检 + u32 双保险。WS 写入与 REST 上传两条路径都汇聚 `write_bytes` 统一拦截系统路径。✅
4. **审计 SQL**：全部参数化绑定；CSV 导出含公式注入防护（`=+-@\t\r` 前缀单引号）。✅
5. **`/proc/net/dev` 解析**（metrics/linux.rs）：rx 取第 1 列、tx 取第 9 列（迭代器跳 7），与内核字段布局一致。✅
6. **MetricsDO 休眠唤醒正确性**：`fullSweep` 无条件按时间差执行且从 storage 恢复全量行，不依赖内存热区；idle 退避只影响下次 alarm 间隔，旧行清理最长延迟 1h。✅

## 三、新发现

### P3-01 dev 环境 `wss_base` 协议错误（展示层）✅ 已修复
- `src/routes.js:574`：`wss_base: \`wss://${url.host}/ws/agent\`` 硬编码 `wss://`；`public/app.js:539` 添加服务器后原样展示。
- `wrangler dev`（http）下展示的地址应为 `ws://`，用户照抄会导致 agent 连不上；前端自身 WS 已按 `location.protocol` 切换，仅此展示值未跟随。
- 生产（Workers 仅 https/wss）无影响；e2e 以 `AGENT_WSS_URL` 显式绕过故未暴露。
- **修复（同日）**：新增 `agentWssBase(url)` 辅助函数（协议跟随 `url.protocol`），REST `POST /api/servers` 与 MCP `add_server` 两条生成路径统一收口；`mcpAddServer` 签名 `host` → `url`。新增专项测试「wss_base 协议跟随访问协议」覆盖 REST/MCP × http/https 四组合（测试助手 `call`/`mcp` 增加 `base` 参数），既有断言同步更新。**158/158 通过**。

### P4-01 fullSweep 归档批截断为静默延迟 ⚠️ 勘误（同日复核）：系**误报**
- 原描述"`inserts.length >= ARCHIVE_BATCH_ROWS(200)` 时 break 出服务器循环"**与代码不符**：`do-metrics.js` 中不存在 `ARCHIVE_BATCH_ROWS` 常量，`fullSweep` 亦无此类截断——实际实现是每台服务器**全量**构建 candidates 的 stmts 后按 **100 行/批**（D1 batch 上限）分批提交，批间失败才 break（失败处理而非截断），成功批次由 `INSERT OR IGNORE` 幂等重放、水位不越过失败区间。不存在"剩余服务器归档推迟 1h"的静默延迟路径。
- 教训：引用不存在的常量名即幻觉信号，发现时应当场 grep 验证而非仅凭阅读印象记录。

### 观察项
1. **MetricsDO 单例容量上限未文档化** ✅ 已补充：全部上报汇聚单 DO（`idFromName('main')`，**勘误：原文误记为 'metrics'**），单线程串行。当前双档节流 + 批量 flush 设计在数百台内无压力；已在 `docs/architecture.md` §3.3.2 写明容量预期（建议 ≤500 台）及超限时按 `server_id` 分片的扩容路径（§3.3.2 后经 4743201 修订：归档批次 200→100、热区窗口语义更新）。
2. **Monaco 经 cdnjs 动态加载、无 SRI**（`_headers` CSP 允许）：动态 loader 无法静态 pin integrity；编辑器仅管理员可用且有 textarea 降级，风险低。追求供应链完全自托管可 vendor 化（体积代价约 3MB）。**维持现状（既有权衡）。**
3. **e2e.mjs 本轮未跑**：静态审查无回归迹象；建议下次改动 agent/协议后执行一次全链路。

## 四、质量评价（维持前轮结论）

- **注释密度与质量突出**：解释"为什么"而非"是什么"（如 DO 缓存节拍推导、zip descriptor 偏移约束、fail-closed 语义），9 轮 review 决策均有落点。
- **纵深防御成体系**：权限（PAT scopes×服务器白名单）→ 签名（上传 HMAC 短时效）→ agent 路径黑名单（词法预检 + canonicalize 真实路径双检）→ 更新链哈希 + 版本探测 + 原子替换 + 备份回滚。
- **测试锁定安全属性**而非仅功能：`normalizeFileEntry` 静态断言、`secret 缺失拒绝启动`、`WS 身份不可逆化`、CSP 完整性等均有专项断言，防回归意识强。
- **缓存全生命周期管理**：TTL + 显式失效 + 防膨胀 clear + 键含身份，未发现新泄漏路径。

## 五、结论

经过 10 轮迭代，代码库已达到个人/小团队自托管面板的高完成度：安全边界清晰、失败路径显式、可观测性完整。本轮唯一建议修复项 P3-01 与观察项 1（容量文档化）已于同日处理完毕（修复后 **158/158 测试通过**）；P4-01 经复核为误报（见勘误）；观察项 2 维持既有权衡。无阻塞发布的问题。

> **追记（同日，988cde7 + 4743201 复核后）**：P3-01 同类遗漏（create_upload 签名 URL 协议硬编码）由 988cde7 收口；4743201 另修复本轮漏掉的三个真实问题——trim 每帧 O(窗口) 全扫（P1-2）、热区 720 分钟 6 倍冗余（P2-1）、agent collect_temp 同步调用阻塞 async 运行时（P2-2）——第 10 轮均未发现，记录在案。测试 161/161。
