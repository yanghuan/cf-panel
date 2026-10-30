---
name: cf-worker
description: 查询部署在 Cloudflare 上的 cf-panel Worker 的实时日志、Durable Objects 用量（duration / requests，可按小时、按天、按 DO 类、按分片对象拆分）与 D1 监控数据。用于排查 DO duration 异常上涨、抓取 [slow-report] / [slow-agent-conn] 埋点、验证部署后指标是否回落、核对免费额度（每日 100,000 请求 / 13,000 GB-s）以及读取 metrics_min、metrics_day、operation_jobs、audit_logs 等表。
---

# Cloudflare Worker 日志与 DO 数据查询

cf-panel 由 1 个 Worker + 3 个 Durable Object 类（`TerminalDO` / `MetricsDO` / `PanelDO`）+ D1 + R2 组成。本 skill 提供三条查询路径：**实时日志**（看埋点）、**用量分析**（GraphQL，看 billing 口径）、**D1 数据**（看业务数据）。

## 凭证

所有请求从本目录 `.env` 读取（已被 gitignore，**不要提交**）：

| 变量 | 说明 |
|---|---|
| `CF_API_TOKEN` | API Token；需要 Workers Scripts:Read、Account Analytics:Read、D1:Read |
| `CF_ACCOUNT_ID` | 账户 ID |
| `CF_SCRIPT_NAME` | Worker 名，默认 `cf-panel` |
| `CF_D1_NAME` | D1 数据库名，默认 `cf-panel` |

```bash
set -a; . .codebuddy/skills/cf-worker/.env; set +a
```

## 1. 实时日志（最快看到埋点）

```bash
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" \
  npx wrangler tail "$CF_SCRIPT_NAME" --format json
```

- 单个事件的关键字段：`wallTime`（毫秒）、`cpuTime`、`entrypoint`（`TerminalDO` / `MetricsDO` / `PanelDO`）、`outcome`、`logs[]`、`event.request.url`。
- 只看埋点输出：`| grep -o '\[slow-[^"]*'`
- 需要 `wrangler >= 4.156`。旧版 workerd 不认识 `durable_object_io_tasks_*` 等 compatibility flag，`wrangler dev` 会直接启动失败。
- 前置条件：账号侧 `[observability.logs] enabled = true`；本项目 `invocation_logs = false`，因此只有 `console.*` 会出现在 `logs` 里（没有每次调用的元数据行）。

## 2. DO 用量（GraphQL Analytics）

首选脚本（自动读 `.env`、把 namespace 映射成类名、折算单请求成本、对未走完的小时做外推）：

```bash
python3 .codebuddy/skills/cf-worker/scripts/do_usage.py            # 最近 2 天，按小时
python3 .codebuddy/skills/cf-worker/scripts/do_usage.py --days 1
python3 .codebuddy/skills/cf-worker/scripts/do_usage.py --days 3 --by-object   # 追加按分片拆分
```

手工查询的三个必知点（完整模板见 `references/graphql.md`）：

1. 端点 `POST https://api.cloudflare.com/client/v4/graphql`，body 为 `{"query": "..."}`。
2. 两个数据集字段不同：
   - `durableObjectsInvocationsAdaptiveGroups` → `sum { requests errors }`
   - `durableObjectsPeriodicGroups` → `sum { duration }`（**没有 requests**）
3. 数据是**计费口径**（WebSocket 入站消息已按 20:1 折算），且**延迟 5–10 分钟**；当前小时未走完时必须外推：`值 ÷ 已过分钟 × 60`。

## 3. D1 数据

```bash
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" \
  npx wrangler d1 execute "$CF_D1_NAME" --remote --command "SELECT ..." --json
```

常用表：`metrics_min`（分钟级，保留 30 天）、`metrics_day`（按天账，3 年）、`servers`、`operation_jobs`（异步 exec/upload/update）、`audit_logs`（90 天）。

## cf-panel 专属判读经验

1. **先算单请求成本** = `duration ÷ requests`。正常 **0.4–0.6 秒/请求**；到 8 秒说明对象拿不到 hibernation 资格（`non-hibernateable` 状态按 70–140 秒 evict 规则计费），不是流量涨了。
2. **duration 涨、requests 不变** ⇒ 单条变贵（驻留）；**两者同涨** ⇒ 流量变多。这是区分两类问题的第一判据。
3. `[slow-report]` 的 `cold` 字段：`1` = 该条消息触发了实例重构（evict 后首条）；`0` 且 `ms` 大 = 对象活着但处理慢。
4. **不要用 `wrangler deploy --dry-run` 验证 compatibility flag**：它只打包、不启动 workerd，必须用 `wrangler dev --local` 启动一次才算验证。
5. `durableObjectsPeriodicGroups.duration` 单位是 **GB-s**；一个 128MB 实例跑满 1 小时 = 460.8 GB-s。免费额度 13,000 GB-s/天 ≈ 28.2 个实例小时。
6. 免费额度按 **UTC 00:00 重置**；请求 100,000/天、duration 13,000 GB-s/天，任一项超限后该类操作直接报错（不是限速）。
7. Dashboard 的时间范围选择器默认可能是整个计费周期（如 `October 5 – November 5`），**不能直接和日限额比较**，必须先除以天数。
