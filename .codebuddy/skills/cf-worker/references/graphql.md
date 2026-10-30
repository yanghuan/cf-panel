# GraphQL Analytics 查询模板（Durable Objects）

所有请求：

```bash
curl -s -X POST https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "content-type: application/json" \
  --data @query.json
```

`query.json` 形如 `{"query": "query { ... }"}`。响应在 `data.viewer.accounts[0]`，出错看 `errors[]`。

## 0. 把 namespaceId 映射成 DO 类名

Dashboard 上按 `TerminalDO` / `MetricsDO` / `PanelDO` 分列，GraphQL 只返回 `namespaceId`，需要自己映射：

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/$CF_SCRIPT_NAME/settings" \
  -H "Authorization: Bearer $CF_API_TOKEN"
```

取 `result.bindings[]` 中 `type == "durable_object_namespace"` 的项，`class_name` ↔ `namespace_id` 即为映射表。
同一响应还能确认线上实际生效的 `compatibility_date` / `compatibility_flags`。

## 1. 按小时 duration（定位拐点）

```graphql
query {
  viewer {
    accounts(filter: { accountTag: "<ACCOUNT_ID>" }) {
      durableObjectsPeriodicGroups(
        limit: 200
        filter: { date_geq: "2026-10-29", date_leq: "2026-10-31" }
        orderBy: [datetimeHour_ASC]
      ) {
        dimensions { datetimeHour }
        sum { duration }
      }
    }
  }
}
```

## 2. 按天 duration（判断是否超日限额）

把 `dimensions { datetimeHour }` 换成 `dimensions { date }`，`orderBy: [date_ASC]`。

## 3. 按天 × 按类（duration 与 requests 分别查，字段不通用）

```graphql
query {
  viewer {
    accounts(filter: { accountTag: "<ACCOUNT_ID>" }) {
      d: durableObjectsPeriodicGroups(
        limit: 50
        filter: { date_geq: "2026-10-30", date_leq: "2026-10-30" }
        orderBy: [namespaceId_ASC]
      ) {
        dimensions { namespaceId }
        sum { duration }
      }
      r: durableObjectsInvocationsAdaptiveGroups(
        limit: 50
        filter: { date_geq: "2026-10-30", date_leq: "2026-10-30" }
        orderBy: [namespaceId_ASC]
      ) {
        dimensions { namespaceId }
        sum { requests errors }
      }
    }
  }
}
```

两个数据集可以用别名（`d:` / `r:`）在一次请求里合并。

## 4. 按对象拆分（定位是哪个分片）

```graphql
durableObjectsPeriodicGroups(
  limit: 50
  filter: { date_geq: "2026-10-28", date_leq: "2026-10-29", namespaceId: "<TERMINAL_NS>" }
  orderBy: [date_ASC]
) {
  dimensions { date objectId }
  sum { duration }
}
```

`objectId` 是 DO 实例的哈希，无法直接反查名字；但 `TerminalDO` 的分片名形如 `shard-0..3`，四个对象同时升高说明是平台侧或消息量整体变化，单个升高才是单分片问题。

## 字段与参数陷阱

| 现象 | 原因 |
|---|---|
| `unknown field "requests"` | `durableObjectsPeriodicGroups` 只有 `duration`；requests 在 `durableObjectsInvocationsAdaptiveGroups` |
| `unknown field "count"` | 这两个数据集都没有 `count`，用 `sum { ... }` |
| `unknown enum value objectName_ASC` | 不支持按对象名排序，只能 `namespaceId_ASC` / `datetimeHour_ASC` / `date_ASC` |
| introspection 返回 `__type: null` | 该端点关闭了 introspection，字段只能靠文档或试错 |
| 当前小时数值明显偏低 | 数据延迟 5–10 分钟且小时未走完，按 `值 ÷ 已过分钟 × 60` 外推 |

## 计费口径说明

- `requests` 是**计费请求数**：WebSocket 入站消息按 20:1 折算，出站消息不计费，alarm 计 1 次。
- `duration` 是 GB-s（`wall-clock 秒 × 128MB / 1GB`），**包含** "idle but non-hibernateable" 的时间。
- 免费额度：100,000 请求/天、13,000 GB-s/天、SQL 读 500 万行/天、写 100,000 行/天，UTC 00:00 重置。
