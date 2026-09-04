# Task 4A — API/SSE 交付报告

## RED → GREEN

- RED（API）：`pnpm --filter api test -- src/api.integration.test.ts`。新增控制与 Inbox 路径尚未注册，未认证控制请求返回 `404`（预期 `401`）。同次发现既有测试直接写入 `completed` 运行时遗漏 #10 终止映射；已将测试数据最小补全为 `termination_kind = completed`。
- RED（SSE）：`pnpm --filter api test -- src/agent-runs/agent-run-event-stream.test.ts`。`run.paused` 未关闭流，`run.cancelled` 使读取超时。
- GREEN：`pnpm --filter api test -- src/agent-runs/agent-run-event-stream.test.ts src/api.integration.test.ts` — 12 files、145 tests passed。

## 变更

- 新增认证控制端点 `POST /v1/agent-runs/:runId/controls`，从认证上下文取得 owner，并将领域稳定错误映射为 404/409。
- 新增 Agent Inbox controller/module/token：`GET /v1/agent-inbox?status=open` 与 `POST /v1/agent-inbox/:itemId/actions`；动作仍由领域 Inbox 服务处理，未在 controller 复制状态机。
- Agent Runs module 公开既有 commands/queries 注入令牌，供 Inbox composition 复用同一数据库、队列和审计依赖。
- SSE 以单一 `isStreamTerminal()` 处理 `run.paused`、`run.cancelled`、`run.completed`、`run.failed`；`run.pause_requested` 与 `run.resume_requested` 继续流式传送。保留原有 250ms 轮询、15 秒心跳、abort 清理、owner 预校验与游标恢复。
- API integration 覆盖严格字段、401、跨账户 404、命令重放/冲突、四种 Inbox 动作、恢复后队列失败仍保留 `queued` 事实状态。

## 验证

```text
pnpm --filter api test -- src/agent-runs/agent-run-event-stream.test.ts src/api.integration.test.ts
# 12 files、145 tests passed
pnpm --filter api typecheck
pnpm --filter @job-copilot/contracts typecheck
pnpm --filter @job-copilot/domain typecheck
git diff --check
```

## Concerns

- `AGENT_RUN_COMMAND_ID_CONFLICT` 是任务说明中的 HTTP 映射名；当前领域控制接口只会公开 `AGENT_RUN_CONTROL_CONFLICT`（相同 command ID 的不同动作），因此 controller 如实映射现有领域稳定码。后续联合审查应确认是否需要在领域层区分该码，不能由 API 擅自制造第二套判断规则。

## 联合审查修复

- RED（命令 ID）：领域控制集成测试先将同 `commandId` 不同动作的预期改为 `AGENT_RUN_COMMAND_ID_CONFLICT`，旧实现仍返回生命周期冲突码而失败。
- RED（Inbox）：API 集成测试使 `restart_run` 的目标不可用，旧 controller 将 `AGENT_INBOX_ACTION_FAILED` 映射为 409；预期为全局过滤器产生的脱敏 500，且 action ledger 保持 `failed`、相同 actionId 重放仍失败。
- GREEN：领域仅在 durable prior-command 的不同动作分支公开 `AGENT_RUN_COMMAND_ID_CONFLICT`；controller 明确映射两个控制冲突码为 409，而 Inbox controller 只映射明确 not-found/conflict，真实执行失败向上抛给全局脱敏 500。
- SSE 覆盖重构为表驱动：`paused/cancelled/completed/failed` 终止；`pause_requested/resume_requested/cancel_requested` 继续流；原有游标恢复断言保留。

```text
pnpm --filter api test -- src/agent-runs/agent-run-event-stream.test.ts src/api.integration.test.ts
# 12 files、150 tests passed
pnpm --filter @job-copilot/domain test -- src/agent-run-control.integration.test.ts
# 19 files、175 tests passed
pnpm --filter api typecheck
pnpm --filter @job-copilot/domain typecheck
pnpm --filter @job-copilot/contracts typecheck
git diff --check
```

---

# Task 4B — Web server adapters 与同源 BFF 交付报告

## RED → GREEN

- RED：`pnpm --filter web test -- lib/server/api-client.test.ts lib/server/agent-inbox.test.ts 'app/api/agent-runs/[runId]/controls/route.test.ts' app/api/agent-inbox/route.test.ts 'app/api/agent-inbox/[itemId]/actions/route.test.ts'`。`controlAgentRun`、`listAgentInbox`、`actOnAgentInboxItem`、`getOpenAgentInbox` 与三个 BFF 路由均不存在；测试因缺少模块和方法失败。
- GREEN：`pnpm --filter web exec vitest run lib/server/api-client.test.ts lib/server/agent-inbox.test.ts 'app/api/agent-runs/[runId]/controls/route.test.ts' app/api/agent-inbox/route.test.ts 'app/api/agent-inbox/[itemId]/actions/route.test.ts'` — 5 files、36 tests passed。

## 变更

- server-only API client 新增运行控制、打开 Inbox 列表与 Inbox 动作方法；请求和成功响应均经共享 Zod 契约严格解析，Bearer token 只停留在服务端。
- 新增 `getOpenAgentInbox()`，与既有 `getLatestAgentRun()` 使用相同 HttpOnly session 与登录重定向规则。
- 新增运行控制、Inbox 列表、Inbox 动作的同源 BFF；无 session 返回 401，无效 UUID 返回 404，body 严格校验返回 400，只透传 400/401/404/409，其余上游异常收敛为无体 502，并统一返回 `Cache-Control: no-store`。
- 控制 BFF 直接传回 client 的 `ControlAgentRunResponse`，所以同一 `commandId` 的重放结果不会在 BFF 重写或丢失。

## 验证

```text
pnpm --filter web exec vitest run lib/server/api-client.test.ts lib/server/agent-inbox.test.ts 'app/api/agent-runs/[runId]/controls/route.test.ts' app/api/agent-inbox/route.test.ts 'app/api/agent-inbox/[itemId]/actions/route.test.ts'
# 5 files、36 tests passed
pnpm --filter @job-copilot/contracts typecheck
# passed
git diff --check
# passed
```

## Concerns

- `pnpm --filter web typecheck` 仍被 Task 4B 范围以外的既有 `components/workbench/agent-run-panel.tsx` 与其测试阻断：旧 `maxDurationMs` 名称以及新增模型失败码缺少 UI 映射（3 个 TypeScript errors）。本切片未触碰 UI；该问题应由 Task 5/联合审查处理。Task 4B 新增/修改文件没有 TypeScript diagnostics。
