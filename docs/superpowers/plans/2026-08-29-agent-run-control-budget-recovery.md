# Agent Run Control, Budgets, and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能够查看并安全控制岗位发现 Agent 运行，在 PostgreSQL 中持久记录预算消费、有限重试、终止原因和可处理 Agent Inbox，并通过 Fake 场景完成 Issue #10 的端到端验收。

**Architecture:** 保持 PostgreSQL 为运行事实源、BullMQ 为唤醒机制。领域层通过 `AgentRunCommands`、`AgentRunProcessor`、`AgentRunQueries` 和 `AgentInbox` 四个小接口隐藏控制状态机、预算账本、检查点、Inbox 与审计；API、Worker、SSE 和 Web 只做认证、适配和投影。Worker 在外部调用和领域提交边缘执行检查点，所有重试、恢复和重复命令依赖持久状态及唯一键，而不是进程内状态。

**Tech Stack:** TypeScript、Zod、Drizzle ORM、PostgreSQL 17、NestJS/Fastify、BullMQ/Redis、Next.js App Router、React、Vitest、Testcontainers、Playwright。

**Spec:** `docs/superpowers/specs/2026-08-29-agent-run-control-budget-recovery-design.md`

## Global Constraints

- PostgreSQL 是 Agent Run、控制意图、预算、Inbox 和事件的唯一事实源；BullMQ 只负责唤醒。
- 队列保持 `agent-runs`，任务名保持 `discover-jobs`，任务载荷版本保持 `1`，载荷只能包含 `{ version, runId, userId }`。
- 工作流保持 `job-discovery-workflow-v1`，Adapter 保持 `fake-job-discovery-v1`，结果 Schema 保持 `job-discovery-result-v1`；新增规则版本固定为 `fake-job-discovery-rules-v1`。
- 运行预算固定为活跃时间 `60_000 ms`、最大领取次数 `3`、工具调用 `10`、结果 `5`、模型调用 `0`、Token `0`。
- 暂停、恢复和取消必须幂等；取消优先于暂停，控制只在 Spec 列出的安全检查点改变 Worker 行为。
- 排队、暂停和重试退避不计入活跃时间；所有来源调用先持久预占预算。
- 岗位正文、目标自由文本、提示词、模型响应、异常堆栈和对象 key 不得进入队列、SSE、Inbox、普通日志或审计 metadata。
- E2E 故障场景只能由 `APP_ENV=test` 下的固定幂等 UUID 映射触发，不能由求职目标或岗位正文触发。
- 现有 #9 运行必须仍可读取；缺少可靠历史明细时返回 `usage.complete = false`，不能伪造精确消费。
- 所有生产实现先有能够因缺失行为失败的测试，并保存 RED 与 GREEN 命令证据。
- 只修改 #10 直接需要的文件；已知 `apps/web/app/(workbench)/profile/targets/page.tsx` lint 问题不在本切片修复。

---

### Task 1: Define control, budget, Inbox contracts and persistence

**Files:**
- Modify: `packages/contracts/src/agent-runs.ts`
- Modify: `packages/contracts/src/agent-runs.test.ts`
- Create: `packages/contracts/src/agent-inbox.ts`
- Create: `packages/contracts/src/agent-inbox.test.ts`
- Modify: `packages/contracts/package.json`
- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/migrations/0018_agent_run_control_budget_inbox.sql`
- Create: `packages/database/migrations/meta/0018_snapshot.json`
- Modify: `packages/database/migrations/meta/_journal.json`
- Modify: `packages/database/src/migrate.integration.test.ts`

**Interfaces:**
- Consumes: Issue #9 `AgentRunDetailSchema`、`AgentRunEventSchema`、`AGENT_RUN_BUDGET` 和现有 owner 复合外键约定。
- Produces: `ControlAgentRunCommandSchema`、`ControlAgentRunResponseSchema`、执行规格/消费/终止 DTO、控制与预算事件、`AgentInboxListSchema`、`AgentInboxActionCommandSchema`，以及 Drizzle 表 `agentRunControlCommands`、`agentRunUsageEntries`、`agentInboxItems`、`agentInboxItemActions`。

- [ ] **Step 1: Write RED contract tests for lifecycle, control, usage, and termination**

在 `agent-runs.test.ts` 增加严格解析与未知字段拒绝测试，锁定以下接口：

```ts
expect(AgentRunStatusSchema.options).toEqual([
  "queued", "running", "paused", "completed", "failed", "cancelled",
]);

expect(ControlAgentRunCommandSchema.parse({
  commandId,
  action: "pause",
})).toEqual({ commandId, action: "pause" });

expect(AgentRunUsageSchema.parse({
  activeDurationMs: 1_250,
  attempts: 1,
  toolCalls: 2,
  sourceRequests: 2,
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  results: 1,
  complete: true,
})).toMatchObject({ activeDurationMs: 1_250, sourceRequests: 2 });

expect(AgentRunTerminationSchema.parse({
  kind: "budget_exhausted",
  failureCode: "AGENT_RUN_BUDGET_EXCEEDED",
  budgetDimension: "attempts",
})).toEqual({
  kind: "budget_exhausted",
  failureCode: "AGENT_RUN_BUDGET_EXCEEDED",
  budgetDimension: "attempts",
});
```

扩展事件测试覆盖：

```ts
const pauseRequested = {
  eventType: "run.pause_requested",
  status: "running",
  currentStep: "fetch_details",
  attemptCount: 1,
};

const budgetUpdated = {
  eventType: "run.budget_updated",
  status: "running",
  currentStep: "fetch_details",
  usage: usageFixture,
};
```

同时断言 `currentStep = cancelled` 只和 `status = cancelled` 配对，`model` 为 `null` 时模型预算与消费必须为零，旧运行允许 `usage.complete = false`。

- [ ] **Step 2: Write RED Agent Inbox contract tests**

在 `agent-inbox.test.ts` 锁定：

```ts
const item = AgentInboxItemSchema.parse({
  itemId,
  runId,
  kind: "decision_required",
  status: "open",
  reasonCode: "AGENT_RUN_PAUSED",
  budgetDimension: null,
  title: "岗位发现已暂停",
  message: "选择继续或取消本次岗位发现。",
  availableActions: ["resume_run", "cancel_run"],
  createdAt: now,
  resolvedAt: null,
});

expect(AgentInboxActionCommandSchema.parse({
  actionId,
  action: "resume_run",
})).toEqual({ actionId, action: "resume_run" });
expect(() => AgentInboxItemSchema.parse({ ...item, rawError: "secret" })).toThrow();
```

`restart_run`、`resume_run`、`cancel_run` 和 `dismiss` 使用判别联合，拒绝多余参数。Inbox 文案由 `kind + reasonCode + budgetDimension` 的固定投影产生，不接受服务端自由文本字段。

- [ ] **Step 3: Run contracts and verify RED**

Run:

```bash
pnpm --filter @job-copilot/contracts test -- src/agent-runs.test.ts src/agent-inbox.test.ts
```

Expected: FAIL because control、usage、termination、Inbox schemas and event variants do not exist.

- [ ] **Step 4: Implement strict contracts and exports**

实现以下常量和 Schema，继续使用 `.strict()`：

```ts
export const AGENT_RUN_RULE_VERSION = "fake-job-discovery-rules-v1";
export const AGENT_RUN_TOOL_ALLOWLIST = [
  "job_discovery.search_batch",
  "job_discovery.get_detail",
] as const;

export const AgentRunControlStateSchema = z.enum([
  "none", "pause_requested", "cancel_requested",
]);
export const AgentRunControlActionSchema = z.enum(["pause", "resume", "cancel"]);
export const AgentRunBudgetDimensionSchema = z.enum([
  "active_duration", "attempts", "tool_calls", "model_calls", "tokens",
]);
```

把公共预算字段改为 `maxActiveDurationMs`，并在数据库映射层兼容旧 JSON 中的 `maxDurationMs`；不要让公共响应同时暴露两个名称。`AgentRunDetailSchema` 增加 `executionSpec`、`controlState`、`usage`、`termination`、`retryOfRunId`。

在 `packages/contracts/package.json` 导出：

```json
"./agent-inbox": "./src/agent-inbox.ts"
```

- [ ] **Step 5: Write RED migration assertions**

在迁移测试中断言新表和唯一键：

```ts
expect(tables).toEqual(expect.arrayContaining([
  "agent_run_control_commands",
  "agent_run_usage_entries",
  "agent_inbox_items",
  "agent_inbox_item_actions",
]));

expect(constraints).toEqual(expect.arrayContaining([
  "agent_run_control_commands_user_run_command_unique",
  "agent_run_usage_entries_run_key_category_unique",
  "agent_inbox_items_run_event_kind_unique",
  "agent_inbox_item_actions_user_item_action_unique",
]));
```

额外插入错误 owner、负消费、未知状态、无效控制动作和重复 usage key，证明数据库拒绝；插入旧形状 #9 运行后执行迁移，证明仍可读取且 `usage_complete = false`。

- [ ] **Step 6: Add Drizzle schema and generate migration metadata**

在 `agent_runs` 增加 Spec 指定列；`attempt_count` 仍是唯一领取计数。新增表使用 `(user_id, run_id)` 和 `(user_id, item_id)` 复合外键。状态检查更新为：

```sql
status in ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')
```

时间戳约束要求 `paused` 没有有效 claim、`cancelled_at` 仅出现在取消终态、所有聚合消费非负。生成迁移：

```bash
pnpm --filter @job-copilot/database db:generate -- --name agent_run_control_budget_inbox
```

确认生成编号为 `0018`，不得覆盖 `0016_agent_run_evidence_recovery.sql` 或 `0017_agent_run_recovery_index.sql`。

- [ ] **Step 7: Verify Task 1 and commit**

Run:

```bash
pnpm --filter @job-copilot/contracts test -- src/agent-runs.test.ts src/agent-inbox.test.ts
pnpm --filter @job-copilot/database test -- src/migrate.integration.test.ts
pnpm --filter @job-copilot/contracts typecheck
pnpm --filter @job-copilot/database typecheck
git diff --check
```

Commit:

```bash
git add packages/contracts packages/database
git commit -m "feat: define agent run controls and budgets (#10)"
```

---

### Task 2: Implement the durable control, budget, Inbox, and audit modules

**Files:**
- Create: `packages/domain/src/agent-run-state.ts`
- Create: `packages/domain/src/agent-run-state.test.ts`
- Create: `packages/domain/src/agent-run-control.ts`
- Create: `packages/domain/src/agent-run-control.integration.test.ts`
- Create: `packages/domain/src/agent-run-queries.ts`
- Create: `packages/domain/src/agent-inbox.ts`
- Create: `packages/domain/src/agent-inbox.integration.test.ts`
- Modify: `packages/domain/src/agent-runs.ts`
- Modify: `packages/domain/src/agent-runs.test.ts`
- Modify: `packages/domain/src/agent-runs.integration.test.ts`
- Modify: `packages/domain/src/audit-trail.ts`
- Modify: `packages/domain/src/audit-trail.integration.test.ts`
- Modify: `packages/domain/src/workbench-home.ts`
- Modify: `packages/domain/src/workbench-home.integration.test.ts`
- Modify: `packages/domain/package.json`

**Interfaces:**
- Consumes: Task 1 schemas/tables、现有 `AgentRunQueue`、账户 advisory lock 和 `AuditTrail`。
- Produces:

```ts
createAgentRunCommands(deps).start(input)
createAgentRunCommands(deps).control(input)
createAgentRunQueries({ db }).latest(input)
createAgentRunQueries({ db }).get(input)
createAgentRunQueries({ db }).eventsAfter(input)
createAgentRunCheckpoint(deps).check(input)
createAgentInbox(deps).list(input)
createAgentInbox(deps).act(input)
```

`packages/domain/src/agent-runs.ts` 保持外部 façade，重新导出这些接口和 Adapter 类型；调用方不直接导入内部状态文件。

- [ ] **Step 1: Write RED table-driven state transition tests**

在 `agent-run-state.test.ts` 通过纯函数接口测试每个状态：

```ts
expect(reduceControl({ status: "queued", controlState: "none" }, "pause"))
  .toEqual({ kind: "transition", status: "paused", controlState: "none", eventType: "run.paused" });

expect(reduceControl({ status: "running", controlState: "none" }, "pause"))
  .toEqual({ kind: "transition", status: "running", controlState: "pause_requested", eventType: "run.pause_requested" });

expect(reduceControl({ status: "running", controlState: "pause_requested" }, "cancel"))
  .toEqual({ kind: "transition", status: "running", controlState: "cancel_requested", eventType: "run.cancel_requested" });

expect(reduceControl({ status: "cancelled", controlState: "none" }, "resume"))
  .toEqual({ kind: "conflict", code: "AGENT_RUN_CONTROL_CONFLICT" });
```

覆盖相同动作无变化、`resume` 撤销 `pause_requested`、取消不可撤销，以及完成/失败终态冲突。

- [ ] **Step 2: Run state tests and verify RED**

Run:

```bash
pnpm --filter @job-copilot/domain test -- src/agent-run-state.test.ts
```

Expected: FAIL because the reducer does not exist.

- [ ] **Step 3: Implement the pure reducer and command transaction**

`reduceControl` 不读数据库、不产生时间或 UUID。`createAgentRunCommands.control` 负责：

```ts
control(input: {
  userId: string;
  requestId: string;
  runId: string;
  command: ControlAgentRunCommand;
}): Promise<ControlAgentRunResponse>
```

事务顺序固定为：账户锁 → owner 查询 → command ID 重放检查 → reducer → 运行更新 → 单调事件 → 控制命令记录 → 审计。相同 command ID 不重复写入。`resume` 或立即控制后需要唤醒时，只在事务提交后 best-effort enqueue。

- [ ] **Step 4: Write RED integration tests for command idempotency, ownership, events, and audit**

证明：

```ts
const first = await commands.control({ userId, requestId, runId, command: { commandId, action: "pause" } });
const replay = await commands.control({ userId, requestId: randomUUID(), runId, command: { commandId, action: "pause" } });
expect(replay).toEqual(first);
expect(await countEvents(runId, "run.paused")).toBe(1);
expect(await countAudits(runId, "agent.run_paused")).toBe(1);
```

同时覆盖跨账户 404、同 command ID 不同动作冲突、取消覆盖暂停、暂停/恢复后的 queue wakeup 失败仍保留数据库状态。

- [ ] **Step 5: Write RED budget ledger and checkpoint tests**

`createAgentRunCheckpoint` 接口：

```ts
check(input: {
  userId: string;
  runId: string;
  claimToken: string;
  checkpointKey: string;
  reserve?: { toolCalls?: number; sourceRequests?: number; modelCalls?: number };
}): Promise<AgentRunCheckpointDecision>
```

测试相同 `checkpointKey` 不重复计费、预算边界前允许、边界后拒绝、暂停/取消优先级、过期 claim 返回 `stale`、活跃时间结算排除暂停区间，以及预算耗尽只写一个 `run.failed` 和 Inbox 项。

同时用表驱动测试锁定来源/模型失败策略：只有 Adapter 明确标记的临时故障可在剩余领取次数、活跃时间及对应调用预算内返回 `retry`；认证、校验、Schema、策略拒绝等永久故障直接 `fail`；任一预算不足返回 `budget_exhausted`。当前 Fake 规格 `model = null`、`maxModelCalls = 0`，任何模型调用预占都必须在调用前被拒绝：

```ts
expect(decideRetry({
  failure: { category: "source", retryable: true },
  usage: { attempts: 1, activeDurationMs: 1_000 },
  budget: { maxAttempts: 3, maxActiveDurationMs: 60_000 },
})).toEqual({ kind: "retry" });

expect(decideRetry({
  failure: { category: "model_auth", retryable: false },
  usage: { attempts: 1, activeDurationMs: 1_000 },
  budget: { maxAttempts: 3, maxActiveDurationMs: 60_000 },
})).toEqual({ kind: "fail", failureCode: "AGENT_RUN_MODEL_AUTH_FAILED" });
```

- [ ] **Step 6: Implement checkpoint and usage persistence**

把 `decideRetry` 实现为不读数据库的纯函数；Processor 只能消费它的判定，不能自行扩大重试范围。把每类消费和聚合更新放在同一事务中。来源调用预占使用：

```ts
await checkpoint.check({
  userId,
  runId,
  claimToken,
  checkpointKey: `${claimToken}:source:${operation}:${ordinal}`,
  reserve: { toolCalls: 1, sourceRequests: 1 },
});
```

活跃时间在 heartbeat/checkpoint 结算，`paused`、`queued` 和重试退避不保留 `activeSliceStartedAt`。预算耗尽事务同时写终止字段、事件、`budget_exhausted` Inbox 和脱敏审计。

- [ ] **Step 7: Write RED Inbox action tests**

证明：

- `decision_required` 只提供 `resume_run | cancel_run`；
- `run_failed` 提供 `restart_run | dismiss`；
- `budget_exhausted` 提供 `dismiss` 和目标调整链接投影；
- `restart_run` 使用当前活动目标版本并设置 `retryOfRunId`；
- 同一 action ID 重放不创建第二个运行；
- 成功恢复、取消或重启解决事项，失败动作保留开放；
- 不同账户无法查看或处理事项。

核心断言：

```ts
const acted = await inbox.act({
  userId,
  requestId,
  itemId,
  command: { actionId, action: "resume_run" },
});
expect(acted).toMatchObject({ applied: true, item: { status: "resolved" }, run: { status: "queued" } });
```

- [ ] **Step 8: Implement Inbox and audit allowlists**

`AgentInbox` 组合 `AgentRunCommands`，但自身拥有 Inbox action 幂等记录与解决事务。重新运行使用 `actionId` 作为启动幂等键；若新运行已创建但事项解决失败，重放先复用运行再完成解决。

在 `audit-trail.ts` 增加 Spec 列出的固定事件及严格 metadata Schema。所有 metadata 只允许 ID、版本、动作、计数、预算维度和稳定错误码。

- [ ] **Step 9: Update queries and workbench active count**

把详情组装移动到 `agent-run-queries.ts`，返回 Task 1 DTO。`runningAgentRuns` 统计：

```ts
inArray(agentRuns.status, ["queued", "running", "paused"])
```

旧运行没有明细时返回 `usage.complete = false`，新运行必须从聚合列得到完整值。

- [ ] **Step 10: Verify Task 2 and commit**

Run:

```bash
pnpm --filter @job-copilot/domain test -- src/agent-run-state.test.ts src/agent-run-control.integration.test.ts src/agent-inbox.integration.test.ts src/agent-runs.test.ts src/agent-runs.integration.test.ts src/audit-trail.integration.test.ts src/workbench-home.integration.test.ts
pnpm --filter @job-copilot/domain typecheck
pnpm --filter @job-copilot/contracts typecheck
git diff --check
```

Commit:

```bash
git add packages/domain
git commit -m "feat: persist agent run control and usage (#10)"
```

---

### Task 3: Apply checkpoints in the Worker and add deterministic E2E scenarios

**Files:**
- Create: `packages/domain/src/agent-run-processor.ts`
- Create: `packages/domain/src/agent-run-processor.integration.test.ts`
- Modify: `packages/domain/src/agent-runs.ts`
- Create: `apps/worker/src/agent-runs/job-discovery-adapter-resolver.ts`
- Create: `apps/worker/src/agent-runs/job-discovery-adapter-resolver.test.ts`
- Modify: `apps/worker/src/agent-runs/fake-job-discovery-adapter.ts`
- Modify: `apps/worker/src/agent-runs/fake-job-discovery-adapter.test.ts`
- Modify: `apps/worker/src/agent-runs/agent-run-consumer.ts`
- Modify: `apps/worker/src/agent-runs/agent-run-consumer.test.ts`
- Modify: `apps/worker/src/agent-runs/agent-run-reconciler.ts`
- Modify: `apps/worker/src/agent-runs/agent-run-reconciler.test.ts`
- Modify: `apps/worker/src/agent-runs/agent-run.module.ts`
- Modify: `apps/worker/src/agent-runs/agent-run.module.test.ts`
- Modify: `apps/worker/src/agent-runs/agent-run.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 checkpoint、queries、recovery queries 和现有 content store。
- Produces: `JobDiscoveryAdapterResolver`、正常 Fake/test-scenario Fake、可返回 `paused | cancelled | budget_exhausted` 的 Processor outcome。

- [ ] **Step 1: Write RED processor tests for every safe checkpoint**

使用可控 Adapter 与 content store 证明：

```ts
const outcome = await processor.process(job);
expect(outcome).toBe("paused");
expect(adapter.getDetail).not.toHaveBeenCalled();
expect(await runDetail()).toMatchObject({ status: "paused", controlState: "none" });
```

覆盖：领取后暂停、来源调用前取消、来源调用后暂停、对象写入后取消并删除 claim 对象、提交事务前到达控制使迟到结果成为 stale，以及领域结果已经完成后重复任务不产生新结果。

- [ ] **Step 2: Run processor tests and verify RED**

Run:

```bash
pnpm --filter @job-copilot/domain test -- src/agent-run-processor.integration.test.ts
```

Expected: FAIL because the current processor does not call durable checkpoints or resolve adapters per run.

- [ ] **Step 3: Extract and implement the processor behind the existing façade**

`createAgentRunProcessor` 改为接收：

```ts
type ProcessorDependencies = {
  db: Database;
  adapterResolver: JobDiscoveryAdapterResolver;
  checkpoint: AgentRunCheckpoint;
  contentStore: DiscoveryContentStore;
  auditTrail: AuditTrail;
  id: () => string;
  clock: () => Date;
};
```

每次调用 Adapter 前用稳定 operation key 预占，调用后再次检查控制。结果事务 where 条件同时包含 `claimToken` 与 `controlState = none`。`paused`、`cancelled` 和 `budget_exhausted` 都是已处理 outcome，BullMQ 不重试；只有 `retry` 抛错。

- [ ] **Step 4: Write RED resolver and Fake scenario tests**

锁定环境约束：

```ts
expect(() => createJobDiscoveryAdapterResolver({
  APP_ENV: "production",
  E2E_AGENT_RUN_SCENARIOS: JSON.stringify({ [idempotencyKey]: "retry_once" }),
})).toThrow("E2E Agent Run 场景只允许测试环境");

const retryOnce = resolver.resolve({
  adapter: "fake",
  adapterVersion: "fake-job-discovery-v1",
  runId,
  idempotencyKey,
  attemptCount: 1,
});
await expect(retryOnce.searchBatch(input)).resolves.toMatchObject({ ok: false, error: { retryable: true } });
```

第二次尝试返回正常结果；`retry_until_budget` 每次返回类型化可重试错误；`slow_checkpoint` 只使用有限 `delayMs`，不依赖用户文本。

- [ ] **Step 5: Implement resolver and Worker wiring**

解析严格 JSON 映射：

```ts
const FakeScenarioMapSchema = z.record(
  z.uuid(),
  z.enum(["slow_checkpoint", "retry_once", "retry_until_budget"]),
);
```

只有 `APP_ENV === "test"` 才读取 `E2E_AGENT_RUN_SCENARIOS`。普通 local/test 无映射时返回正常 Fake。Resolver 输入只含内部 run metadata，不改变 `JobDiscoveryAdapter` 的搜索/详情接口。

- [ ] **Step 6: Extend consumer, reconciler, and integration tests**

Consumer 断言：

```ts
for (const outcome of ["completed", "paused", "cancelled", "budget_exhausted", "failed", "stale"] as const) {
  await expect(processAgentRunJob(job, processorReturning(outcome))).resolves.toBe(outcome);
}
await expect(processAgentRunJob(job, processorReturning("retry"))).rejects.toThrow();
```

Reconciler 只返回 `queued` 和租约过期 `running`。真实 PostgreSQL/Redis/MinIO 集成测试覆盖 Worker 重启、重复交付、暂停后不被扫描、恢复后完成、取消后无结果、retry-once 成功和 retry-until-budget 有限终止。

- [ ] **Step 7: Verify Task 3 and commit**

Run:

```bash
pnpm --filter @job-copilot/domain test -- src/agent-run-processor.integration.test.ts src/agent-runs.integration.test.ts
pnpm --filter worker test -- src/agent-runs/job-discovery-adapter-resolver.test.ts src/agent-runs/fake-job-discovery-adapter.test.ts src/agent-runs/agent-run-consumer.test.ts src/agent-runs/agent-run-reconciler.test.ts src/agent-runs/agent-run.integration.test.ts
pnpm --filter @job-copilot/domain typecheck
pnpm --filter worker typecheck
git diff --check
```

Commit:

```bash
git add packages/domain apps/worker
git commit -m "feat: checkpoint controllable agent runs (#10)"
```

---

### Task 4: Expose authenticated controls, Inbox, and replayable events

**Files:**
- Modify: `apps/api/src/agent-runs/agent-runs.controller.ts`
- Modify: `apps/api/src/agent-runs/agent-runs.module.ts`
- Modify: `apps/api/src/agent-runs/agent-runs.tokens.ts`
- Modify: `apps/api/src/agent-runs/agent-run-event-stream.ts`
- Modify: `apps/api/src/agent-runs/agent-run-event-stream.test.ts`
- Create: `apps/api/src/agent-inbox/agent-inbox.controller.ts`
- Create: `apps/api/src/agent-inbox/agent-inbox.module.ts`
- Create: `apps/api/src/agent-inbox/agent-inbox.tokens.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/api.integration.test.ts`
- Modify: `apps/web/lib/server/api-client.ts`
- Modify: `apps/web/lib/server/api-client.test.ts`
- Modify: `apps/web/lib/server/agent-runs.ts`
- Create: `apps/web/lib/server/agent-inbox.ts`
- Create: `apps/web/lib/server/agent-inbox.test.ts`
- Create: `apps/web/app/api/agent-runs/[runId]/controls/route.ts`
- Create: `apps/web/app/api/agent-runs/[runId]/controls/route.test.ts`
- Create: `apps/web/app/api/agent-inbox/route.ts`
- Create: `apps/web/app/api/agent-inbox/route.test.ts`
- Create: `apps/web/app/api/agent-inbox/[itemId]/actions/route.ts`
- Create: `apps/web/app/api/agent-inbox/[itemId]/actions/route.test.ts`

**Interfaces:**
- Consumes: Task 2 domain interfaces and Task 1 contracts。
- Produces: authenticated REST `/v1/agent-runs/:runId/controls`、`/v1/agent-inbox`、`/v1/agent-inbox/:itemId/actions` and same-origin BFF routes.

- [ ] **Step 1: Write RED API integration tests**

覆盖：

```ts
const paused = await inject({
  method: "POST",
  url: `/v1/agent-runs/${runId}/controls`,
  headers: bearer(sessionToken),
  payload: { commandId, action: "pause" },
});
expect(paused.statusCode).toBe(200);
expect(paused.json()).toMatchObject({ applied: true, run: { status: "paused" } });
```

并验证 400 严格字段、401、跨账户 404、终态 409、相同 command ID 重放、不同动作冲突、Inbox 列表与四种动作、queue 失败后的持久状态。

- [ ] **Step 2: Implement API controllers and composition**

错误映射固定为：

```ts
AGENT_RUN_NOT_FOUND -> 404
AGENT_RUN_CONTROL_CONFLICT -> 409
AGENT_RUN_COMMAND_ID_CONFLICT -> 409
AGENT_INBOX_ITEM_NOT_FOUND -> 404
AGENT_INBOX_ACTION_CONFLICT -> 409
```

Controller 不接受 owner；request ID 继续从 Fastify hook 取得。`AgentInboxModule` 注入与 Agent Run Module 相同的数据库、queue 和审计依赖，不创建第二套状态规则。

- [ ] **Step 3: Write RED SSE tests for control and paused terminal events**

扩展事件流测试：

```ts
expect(await readAll(stream)).toContain("event: run.pause_requested");
expect(await readAll(pausedStream)).toContain("event: run.paused");
```

证明 `run.paused`、`run.cancelled`、`run.completed`、`run.failed` 后关闭，`run.pause_requested` 和 `run.resume_requested` 不关闭；恢复时从旧 sequence 继续且不重复。

- [ ] **Step 4: Implement event stream terminal policy**

使用单一 helper：

```ts
function isStreamTerminal(eventType: AgentRunEventType): boolean {
  return ["run.paused", "run.cancelled", "run.completed", "run.failed"].includes(eventType);
}
```

仍保留 250ms 数据库轮询、15 秒 heartbeat、abort cleanup 和账户预校验。

- [ ] **Step 5: Write RED API-client and BFF tests**

验证 server-only client 严格解析响应并调用：

```ts
api.controlAgentRun(sessionToken, runId, command)
api.listAgentInbox(sessionToken, "open")
api.actOnAgentInboxItem(sessionToken, itemId, command)
```

BFF 缺少 Cookie 返回 401，无效 UUID 返回 404，只透传 400/401/404/409，其他上游故障折叠为 502；浏览器响应不包含 Bearer Token 或内部异常。

- [ ] **Step 6: Implement Web server adapters and routes**

`getOpenAgentInbox()` 与 `getLatestAgentRun()` 使用相同登录重定向规则。控制和 Inbox 动作 Route Handler 只调用 server-only `api`，并设置 `Cache-Control: no-store`。

- [ ] **Step 7: Verify Task 4 and commit**

Run:

```bash
pnpm --filter api test -- src/agent-runs/agent-run-event-stream.test.ts src/api.integration.test.ts
pnpm --filter web test -- lib/server/api-client.test.ts lib/server/agent-inbox.test.ts 'app/api/agent-runs/[runId]/controls/route.test.ts' app/api/agent-inbox/route.test.ts 'app/api/agent-inbox/[itemId]/actions/route.test.ts'
pnpm --filter api typecheck
pnpm --filter web typecheck
git diff --check
```

Commit:

```bash
git add apps/api apps/web/lib apps/web/app/api
git commit -m "feat: expose agent run controls and inbox (#10)"
```

---

### Task 5: Build the mission-control details and Agent Inbox UI

**Files:**
- Modify: `apps/web/app/(workbench)/home/page.tsx`
- Modify: `apps/web/app/(workbench)/home/page.test.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.test.tsx`
- Modify: `apps/web/components/workbench/agent-run-panel.tsx`
- Modify: `apps/web/components/workbench/agent-run-panel.test.tsx`
- Create: `apps/web/components/workbench/agent-inbox-panel.tsx`
- Create: `apps/web/components/workbench/agent-inbox-panel.test.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: Task 4 same-origin routes and strict DTOs。
- Produces: user-facing execution spec、budget details、safe control actions、Agent Inbox actions and refresh-safe SSE projection.

- [ ] **Step 1: Write RED page and component tests**

Page 测试证明四项数据并行读取：

```ts
expect(WorkbenchHomeView).toHaveBeenCalledWith(expect.objectContaining({
  home,
  targets,
  initialRun,
  inbox,
}), undefined);
```

Run panel 测试覆盖：

```ts
expect(screen.getByText("fake-job-discovery-rules-v1")).toBeVisible();
expect(screen.getByText("本流程未使用模型")).toBeVisible();
expect(screen.getByText("2 / 10 次来源请求")).toBeVisible();
expect(screen.getByRole("button", { name: "暂停岗位发现" })).toBeEnabled();
```

点击暂停后立即显示“等待安全暂停”，使用同一 `commandId` 重试；收到 `run.paused` 后关闭 EventSource、刷新详情并显示继续/取消。取消请求不可被恢复覆盖。控制失败显示稳定中文说明。

Inbox panel 测试覆盖开放事项、固定文案、`restart_run`、`resume_run`、`cancel_run`、`dismiss`、动作幂等 key、成功移除已解决事项和失败保留事项。

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```bash
pnpm --filter web test -- components/workbench/agent-run-panel.test.tsx components/workbench/agent-inbox-panel.test.tsx components/workbench/workbench-home-view.test.tsx 'app/(workbench)/home/page.test.tsx'
```

Expected: FAIL because the details, controls, Inbox component and page data do not exist.

- [ ] **Step 3: Implement the run detail and control projection**

统一事件集合包含所有新事件。运行活跃判断为：

```ts
const runIsUnfinished = run != null && ["queued", "running", "paused"].includes(run.status);
```

按钮显示规则：

```ts
const canPause = run?.status === "queued" || (run?.status === "running" && run.controlState === "none");
const canResume = run?.status === "paused" || run?.controlState === "pause_requested";
const canCancel = run != null && ["queued", "running", "paused"].includes(run.status) && run.controlState !== "cancel_requested";
```

每次用户动作生成一个 UUID，并在网络重试时复用；动作完成或明确冲突后才清除。SSE 只作为增量投影，每个暂停或终态事件后重新读取详情。

- [ ] **Step 4: Implement the Inbox panel and home composition**

`WorkbenchHomePage` 并行调用：

```ts
await Promise.all([
  getWorkbenchHome(),
  getJobTargets(),
  getLatestAgentRun(),
  getOpenAgentInbox(),
]);
```

Inbox 项以 `article` 列表呈现，动作按钮名称包含事项语义。预算耗尽显示“调整求职目标”链接到 `/profile/targets` 和“标记已处理”按钮；导航不自动解决事项。

- [ ] **Step 5: Add responsive, accessible styles**

复用现有 workbench ledger 视觉语言。预算使用 `<dl>` 和文本数值，不只用颜色；控制与 Inbox 按钮最小高度 44px，可见焦点，`aria-live` 只播报动作结果，不重复整个时间线。移动端将预算网格折为单列。

- [ ] **Step 6: Verify Task 5 and commit**

Run:

```bash
pnpm --filter web test -- components/workbench/agent-run-panel.test.tsx components/workbench/agent-inbox-panel.test.tsx components/workbench/workbench-home-view.test.tsx 'app/(workbench)/home/page.test.tsx'
pnpm --filter web typecheck
git diff --check
```

Commit:

```bash
git add apps/web/app/'(workbench)' apps/web/components/workbench apps/web/app/globals.css
git commit -m "feat: add agent mission controls and inbox (#10)"
```

---

### Task 6: Prove Issue #10 end to end and complete the review gates

**Files:**
- Modify: `apps/web/playwright.config.ts`
- Modify: `apps/web/e2e/agent-runs.spec.ts`
- Modify: files from Tasks 1–5 only when a failing acceptance test proves a missing behavior

**Interfaces:**
- Consumes: complete Web/API/Worker/PostgreSQL/Redis/MinIO path and `APP_ENV=test` scenario resolver。
- Produces: Playwright evidence for pause/resume、cancel、retry success、budget exhaustion、Inbox actions、refresh recovery、desktop/mobile accessibility.

- [ ] **Step 1: Configure fixed test-only scenarios**

在 `playwright.config.ts` 的 webServer env 增加固定 UUID 映射：

```ts
E2E_AGENT_RUN_SCENARIOS: JSON.stringify({
  "10000000-0000-4000-8000-000000000101": "slow_checkpoint",
  "10000000-0000-4000-8000-000000000102": "slow_checkpoint",
  "10000000-0000-4000-8000-000000000103": "retry_once",
  "10000000-0000-4000-8000-000000000104": "retry_until_budget",
}),
```

Playwright 在每个场景开始前通过 `page.addInitScript` 按调用顺序返回目标 UUID；不增加产品测试控制端点。

- [ ] **Step 2: Write RED Playwright journeys**

扩展 `agent-runs.spec.ts` 为四条独立场景。先增加固定 UUID 和启动 helpers：

```ts
const scenarios = {
  pause: "10000000-0000-4000-8000-000000000101",
  cancel: "10000000-0000-4000-8000-000000000102",
  retryOnce: "10000000-0000-4000-8000-000000000103",
  retryBudget: "10000000-0000-4000-8000-000000000104",
} as const;

async function useFirstRandomUuid(page: Page, value: string): Promise<void> {
  await page.addInitScript((fixed) => {
    const original = crypto.randomUUID.bind(crypto);
    let used = false;
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => {
        if (used) return original();
        used = true;
        return fixed;
      },
    });
  }, value);
}

async function startScenario(page: Page, idempotencyKey: string): Promise<string> {
  await useFirstRandomUuid(page, idempotencyKey);
  await signIn(page);
  await replaceActiveTarget(page);
  await page.getByRole("link", { name: "AI Job Search Copilot" }).click();
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/agent-runs") && response.request().method() === "POST");
  await page.getByRole("button", { name: "发现岗位" }).click();
  return ((await (await responsePromise).json()) as { runId: string }).runId;
}
```

四条场景写出真实用户断言：

```ts
test("暂停后保持持久状态，并可从 Inbox 恢复完成", async ({ page }) => {
  const runId = await startScenario(page, scenarios.pause);
  await page.getByRole("button", { name: "暂停岗位发现" }).click();
  await expect(page.getByRole("status")).toContainText(/等待安全暂停|岗位发现已暂停/);
  await expect(page.getByRole("heading", { name: "岗位发现已暂停" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "继续本次岗位发现" }).click();
  await expect(page.getByRole("status")).toContainText("岗位发现完成", { timeout: 20_000 });
  expect((await (await page.request.get(`/api/agent-runs/${runId}`)).json() as { status: string }).status).toBe("completed");
});

test("取消在安全检查点终止且不保存岗位结果", async ({ page }) => {
  const runId = await startScenario(page, scenarios.cancel);
  await page.getByRole("button", { name: "取消岗位发现" }).click();
  await expect(page.getByRole("status")).toContainText(/等待安全取消|岗位发现已取消/);
  await expect.poll(async () =>
    await (await page.request.get(`/api/agent-runs/${runId}`)).json() as { status: string; results: unknown[] })
    .toMatchObject({ status: "cancelled", results: [] });
});

test("来源临时失败后在预算内重试成功", async ({ page }) => {
  await startScenario(page, scenarios.retryOnce);
  const timeline = page.getByRole("list", { name: "岗位发现运行时间线" });
  await expect(timeline).toContainText("正在重新尝试", { timeout: 20_000 });
  await expect(page.getByRole("status")).toContainText("岗位发现完成", { timeout: 20_000 });
  await expect(page.getByText("2 / 3 次尝试")).toBeVisible();
});

test("重试预算耗尽后安全终止并形成 Inbox", async ({ page }) => {
  await startScenario(page, scenarios.retryBudget);
  await expect(page.getByRole("status")).toContainText("重试预算已用尽", { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "岗位发现预算已用尽" })).toBeVisible();
  await expect(page.getByRole("link", { name: "调整求职目标" })).toHaveAttribute("href", "/profile/targets");
  await page.getByRole("button", { name: "标记已处理" }).click();
  await expect(page.getByRole("heading", { name: "岗位发现预算已用尽" })).toHaveCount(0);
});
```

每条都通过真实登录和求职目标 UI 启动，不直接写数据库；断言详情中的目标、来源、规则、预算消费、时间线、终止原因和 Inbox 动作。至少暂停场景在刷新后使用保存的 SSE cursor 恢复。Desktop Chrome 检查键盘顺序，Mobile Safari 检查触控目标与横向溢出，两者运行 axe。

- [ ] **Step 3: Run Playwright RED**

Run:

```bash
pnpm --filter web test:e2e -- agent-runs.spec.ts
```

Expected: FAIL at the first still-unwired control、scenario、Inbox or budget behavior. 保存失败位置，不通过放宽断言隐藏缺口。

- [ ] **Step 4: Make only acceptance-driven fixes and rerun GREEN**

只修改 Tasks 1–5 已列文件。每个修复先增加最窄 Vitest 回归，再重跑受影响包，最后运行：

```bash
pnpm --filter web test:e2e -- agent-runs.spec.ts
```

Expected: all Issue #10 scenarios pass in Desktop Chrome and Mobile Safari; project-specific skips必须有明确设备原因，不能跳过控制语义。

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
pnpm typecheck
pnpm test
pnpm --filter web test:e2e -- agent-runs.spec.ts
pnpm build
git diff --check
```

Run lint separately:

```bash
pnpm lint
```

Expected: all required gates exit 0. If only the documented pre-existing `profile/targets/page.tsx` lint error remains, record it without changing that file；任何新增 lint 错误都必须修复。

- [ ] **Step 6: Run the required two-axis code review**

使用 `/code-review`，固定点为包含本计划的提交：

- Standards sources: root `AGENTS.md`、`apps/web/AGENTS.md`、`PRODUCT.md`、`CONTEXT.md`、ADR 0006/0014/0018/0030/0031。
- Spec sources: `docs/superpowers/specs/2026-08-29-agent-run-control-budget-recovery-design.md` 和 GitHub Issue #10。

并行输出 Standards 与 Spec 审查。每个 Critical/Important finding 都由原实现上下文完成修复，再重跑受影响测试；不得只记录未解决的验收缺口。

- [ ] **Step 7: Commit final acceptance fixes and close Issue #10**

Commit:

```bash
git add apps packages scripts docs
git commit -m "fix: complete agent run control acceptance (#10)"
```

若没有最终修复 diff，不创建空提交。确认：

```bash
git status --short
```

在 GitHub Issue #10 评论中列出状态机、预算、Inbox、Worker 恢复、Playwright 和全量测试证据；只有七项 acceptance criteria 全部可证明时才关闭。未经用户授权不 push、不创建 PR、不合并回 `main`。
