# DO duration 暴涨排查记录（2026-10-26 ~ 10-31）

一次「请求数只涨 8%，duration 却翻 6 倍」的完整排查。最后定位到 **DO 实例陷入
non-hibernateable 状态**（大量未完成 I/O 让对象无法 hibernation），而不是流量增长。
记录判断路径与可复用的排查手段，避免下次重复摸索。

## 一、现象

| 指标 | 10-25（正常） | 10-26（异常） | 变化 |
|---|---|---|---|
| TerminalDO 请求 | 28,605 | 30,894 | +8% |
| 总 duration | 2,091 GB-s/天 | 13,241 GB-s/天 | **+533%** |
| 单请求折算驻留 | 0.55 秒 | 4.0 秒 | ×7 |
| 免费额度占用 | 16% | **102%（已超限）** | — |

关键观察：

1. **请求数与 duration 脱钩** —— 流量没涨，单条变贵。
2. **四个分片同步恶化** —— 排除单对象卡死。
3. **拐点落在 10-26 09:00 UTC，而该时段没有任何部署** —— 排除代码变更。
4. **会自行恢复，且在不同分片之间转移** —— 见下表。

按分片看（秒/请求），同一 version、同一小时：

```
小时    2f7b     33ca     a0f9     e8bb
01:00   1.55    12.35     0.69    13.35
05:00   0.21     0.14     2.96     0.14   ← a0f9 和 e8bb 对调了
09:00   0.19     0.14     3.89     0.14
```

一条都跑同样的代码，差 100 倍，且差异会在对象之间跳。

## 二、换算口径（重要）

GraphQL 的 `duration` 单位是 **GB-s**（128MB 实例 × 墙钟秒 / 1GB），除以请求数得到
「单请求折算驻留」：

```
驻留秒 = duration ÷ requests × 7.8125
```

再折算「对象每小时存活占比」更直观：

```
存活占比 = 驻留秒 × 该小时请求数 ÷ 3600
```

实测：

| 分片 | 小时 | 存活占比 |
|---|---|---|
| a0f991（健康） | 22:00 | **1.4%** |
| e8bbb6（异常） | 22:00 | **77.9%** |

健康对象每小时只活 52 秒（1.4%），异常对象活 2,803 秒（78%）。

## 三、根因：non-hibernateable

官方 `Lifecycle of a Durable Object` 定义三种空闲状态：

| 状态 | 计费 |
|---|---|
| Idle, in-memory **hibernateable** | 10 秒后 hibernate，**窗口内也不计费** |
| Idle, in-memory **non-hibernateable** | **计费**，直到 70–140 秒后被 evict |
| Hibernated / Inactive | 不计费 |

hibernation 需要**同时**满足四条：

1. 无 `setTimeout` / `setInterval`
2. 无未完成 I/O / `waitUntil` Promise / 开放出站连接
3. 未使用标准 WebSocket API（必须走 `acceptWebSocket` + `webSocketMessage`）
4. **没有正在处理的请求/事件**（`webSocketMessage` 返回的 Promise 未 settle）

78% 这个数字正好是「non-hibernateable + evict 兜底」的特征值：

```
间隙占比 = 唤醒等待 / evict 周期 ≈ 20 / (70~140) ≈ 14%~29%
存活占比 = 71%~86%        ← 实测 78%、85%，落在区间内
```

**若真是永久卡死，存活占比会是 100%。** 实际不到，说明 evict 还在工作。

## 四、代码侧的挂起点

排查时发现上报热路径上有三处**没有超时**的跨 DO `fetch`，任一处挂住都会让
`webSocketMessage` 不返回，从而违反第 4 条判据：

| 位置 | 下游 | 修复 |
|---|---|---|
| `report.js` → MetricsDO `/report` | 含告警 webhook（`sendWebhook` 自身无超时） | `AbortSignal.timeout(2000)` |
| `do-terminal.js` 握手 → PanelDO `/viewers` | 读内存计数器（1–3ms） | `AbortSignal.timeout(1000)` |
| `do-terminal.js` 兜底 → PanelDO `/viewers` | 同上 | `AbortSignal.timeout(1000)` |

另外把 5 处告警 webhook 从 `await` 改为 `state.waitUntil()` 托管（`bgRun`）：
webhook 慢不再阻塞 `/report` 返回。`sendWebhookRaw` 自身加 5s 超时。

同时把 DO 内原有的 fire-and-forget 全部 await 化（`broadcastViewers`、`setPush`、
`resendWaitingUploads`、`settleJobsOnDisconnect`、各处 `storage.delete`），并删掉
exec 探活的 1 秒 `setTimeout`（改为「上报顺风车 probe + 无记录乐观放行」）。

## 五、可复用的排查手段

### 1. 按分片看，不要看总量

总量会把「一片 15 秒、三片 0.2 秒」平均成「1 秒」，掩盖问题。必须
`dimensions { datetimeHour objectId }` 拆开。

### 2. 换算成「存活占比」而不是「单条成本」

单条成本会随请求量变化；存活占比直接反映“对象有没有休眠”。

### 3. `[cold]` 埋点区分「被回收」与「常驻」

`TerminalDO` 每小时输出一行：

```
[cold] {"hour":"2026103022","req":173,"cold":0,"rebuilt":1}
```

| `cold / req` | 含义 |
|---|---|
| ≈ 1.0 | 每条消息都是冷启动 → 被正常回收 |
| 0.1–0.3 | 按 evict 周期被回收（non-hibernateable） |
| **0** | 整小时从未被回收 → 常驻 |

### 4. `[slow-report]` 的盲区

埋点在 `handleReport` **返回之后**才执行，所以**挂起时不会输出**。
「0 条 slow 日志」既可能是"真不慢"，也可能是"挂了没走完"，需结合 wallTime 与
`[cold]` 一起判断。

### 5. `--durable-objects-code-update-mode immediate`

Cloudflare 自 2026-10-30 起默认 **deferred**：部署后活跃对象可继续跑旧代码最多 300 秒，
等它 hibernate 才切新版。**实例一旦 non-hibernateable，靠部署重启不掉它。**

```bash
npx wrangler deploy --durable-objects-code-update-mode immediate
```

本项目已在 `wrangler.toml` 固化为 `[durable_objects.code_update_strategy] mode = "immediate"`。
实测：执行后 UTC 02:00 起四个分片全部回到 0.5–1.0 秒，寄生状态未再复发。

## 六、修复效果

| 时段 | 单条成本 | 日额度占用 |
|---|---|---|
| 10-26 ~ 10-30 | 2.11–2.61 秒 | 99–104%（连续五天超限或临界） |
| 10-31 04:00 之后 | **0.47–0.86 秒** | **已用 16%（截至 11 时）/ 全外推约 18%** |

（额度基准 13,000 GB-s/天。10-31 前 11 小时累计 2,102 GB-s；按 04:00 之后
约 100 GB-s/小时的稳定速率外推 24 小时约 2,400 GB-s。）

四个分片从「0.2 / 15 / 15 / 15 秒」收敛到「0.5–1.0 秒，四片一致」。

## 七、未被证实的部分

无法区分以下哪一项起决定作用：

1. `immediate` 硬重启清掉了实例的坏状态；
2. 超时保护阻止了再次进入该状态；
3. 两者共同作用。

**判据**：若 24–48 小时内不再有分片爬回 5 秒以上，视为已修复；若复发，用 `[cold]`
区分「被回收」（`cold/req` 0.1–0.3）与「常驻」（`cold=0`）。后者才是平台侧问题，
届时可凭本节数据开 Cloudflare 工单（同一 version、四个 objectId、同小时差 100 倍、
异常在分片间转移）。

## 八、相关提交

| 提交 | 内容 |
|---|---|
| `890d88c` | 消除 DO 内未完成 I/O（fire-and-forget 改 await） |
| `17d413c` | exec 探活改为上报顺风车，删掉探活 setTimeout |
| `3082f34` `56ee613` | 省 `/viewers` 兜底与过密 pong（请求 −38%） |
| `a869cb6` | 上报路径三处跨 DO 调用加超时 |
| `408a731` | 告警 webhook 改 `state.waitUntil` 后台执行 |
| `1b02c5c` | 启用 `code_update_strategy = immediate` |
| `85e0247` | 新增 `[cold]` 每小时统计埋点 |
