# Issue #52 Task 6 报告

## 范围

- 新增服务端 `updateFirstRecommendationJourneyInteraction`：只接受 Task 1 的严格命令契约，使用 `PUT /v1/workbench/first-recommendation-journey`、Bearer 会话和 `cache: no-store`，并严格校验交互响应。
- 新增同源 BFF：`PUT /api/workbench/first-recommendation-journey` 只读取 `job_copilot_session`，拒绝非法 JSON、未知字段和 `userId` 注入；成功与失败均返回 `Cache-Control: no-store`。
- 仅原样收窄上游 401、404、409；网络、其他状态和非法上游成功体均收窄为不含正文的 502。
- 补齐首页契约升级后的测试 fixture，明确允许 `firstRecommendationJourney: null` 作为局部不可用投影。

## 验证

- `pnpm --filter web test -- lib/server/api-client.test.ts lib/server/workbench.test.ts app/api/workbench/first-recommendation-journey/route.test.ts`
- `pnpm --filter web typecheck`
- `git diff --check`

## 说明与风险

- 工作区不存在 `task-6-brief.md`；本任务以已批准的 Issue #52 design、implementation plan、progress ledger 和派发说明为准。
- BFF 有意不回显上游问题正文；调用方仅可根据 401、404、409 或通用 502 作后续处理。
- 本任务不包含 Task 7 的 React 旅程呈现或客户端交互。
