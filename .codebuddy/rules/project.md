# cf-panel 项目规则

## 项目概览

- Cloudflare Workers + Durable Objects + D1 的服务器监控面板：前端 `public/`（原生 JS）、后端 `src/index.js`、Rust agent `agent/rust`。
- 测试：单元/集成 `npm test`（node:test + node:sqlite）；E2E `bash test/e2e.sh`（依赖 node>=22、Rust agent 构建产物、jq/socat/websocat）。
- 额度/配额优化分析见 `docs/reviews/`（review 文档随实现持续更新）。

## 代码注释与测试命名

- 代码注释、测试名、断言消息中**不得使用 review 文档的章节标号**（如 A1/A2/A3、B1~B10、14.x/15.x/16.x 等）。
- 原因：标号在多个 review 文档中可能重复，文档更新或删除后标号失效，阅读时造成困扰。
- 注释保留语义描述即可（如「批量上报」「按分钟去重」「转发节流」），不依赖文档章节编号。
- 新增优化、修复或重构的注释与测试命名同样遵循此规则。

## 变更约束

- 涉及 Durable Objects / 上报链路 / 归档水位的改动须先跑 `npm test`，改动影响部署链路时跑 E2E。
- 新增迁移时同步更新 `schema.sql`（测试环境用其建表）。
