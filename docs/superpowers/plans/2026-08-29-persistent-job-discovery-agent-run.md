# Persistent Job Discovery Agent Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让登录用户从活动求职目标启动一条可恢复、可回放、幂等的 Fake 岗位发现运行，并在工作台看到持久化进度和最终岗位结果。

**Architecture:** PostgreSQL 保存运行、步骤、事件和结果，是唯一业务事实源；BullMQ 只负责即时唤醒，Worker Reconciler 从数据库恢复丢失或租约过期的运行。Worker 通过无网络的 Fake Discovery Adapter 读取固定公司观察列表，将原文写入 MinIO，并复用来源发布记录、版本和岗位机会模型。API 以认证 SSE 回放数据库事件，Next.js BFF 使用 HttpOnly 会话代理到浏览器。

**Tech Stack:** TypeScript、Zod、Drizzle/PostgreSQL、NestJS/Fastify、BullMQ/Redis、MinIO、Next.js App Router、React、Vitest/Testcontainers、Playwright

**Spec:** `docs/superpowers/specs/2026-08-29-persistent-job-discovery-agent-run-design.md`；GitHub `GoodScholar/ai-job-search-copilot#9`；`PRODUCT.md`、`CONTEXT.md`、ADR 0003/0006/0009/0010/0014/0018/0020/0022/0024/0028/0030/0031

## Global Constraints

- Node.js 使用仓库现有版本，包管理器为 pnpm；不新增生产依赖，除非现有 Fastify/RxJS 无法提供流式响应。
- PostgreSQL 是运行、步骤、事件和结果的唯一事实源；Redis/BullMQ 只负责唤醒。
- 当前实现无 LLM、无真实网络岗位源、无浏览器自动化、无外部写入；预算固定 `maxModelCalls = 0`、`maxTokens = 0`。
- 工作流版本、Fake Adapter 版本、来源范围、预算、租约和扫描间隔必须与 Spec 完全一致。
- 岗位内容始终是不可信数据，不能改变工具、预算、步骤或权限。
- 所有查询和写入按 `userId` 绑定所有权；跨账户运行、事件和目标返回非披露式 404。
- 原始岗位详情不进入队列、SSE、普通日志、审计 metadata 或错误响应。
- 所有生产实现必须先有能够因缺失行为失败的测试，并保存 RED 与 GREEN 命令证据。
- 只修改 #9 直接需要的文件；已知 `apps/web/app/(workbench)/profile/targets/page.tsx` lint 问题不在本切片顺手修复。

---

### Task 1: Define agent-run contracts and durable persistence

**Files:**
- Create: `packages/contracts/src/agent-runs.ts`
- Create: `packages/contracts/src/agent-runs.test.ts`
- Modify: `packages/contracts/package.json`
- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/migrations/0015_agent_runs.sql`
- Create: `packages/database/migrations/meta/0015_snapshot.json`
- Modify: `packages/database/migrations/meta/_journal.json`
- Modify: `packages/database/src/migrate.integration.test.ts`

**Interfaces:**
- Consumes: `JobTargetConstraintsSchema`, account UUIDs and existing source/opportunity ownership conventions.
- Produces: Agent Run DTOs, SSE event DTOs, discovery Adapter schemas, queue constants and Drizzle tables `agentRuns`, `agentRunSteps`, `agentRunEvents`, `agentRunJobResults`.

- [ ] **Step 1: Write RED contract tests**

Test strict parsing for:

```ts
StartAgentRunCommandSchema.parse({ targetId, idempotencyKey });
AgentRunDetailSchema.parse({
  runId, targetId, targetVersion: 1, targetSnapshot, sourceScope,
  workflowVersion: "job-discovery-workflow-v1",
  adapter: "fake", adapterVersion: "fake-job-discovery-v1",
  outputSchemaVersion: "job-discovery-result-v1", budget: AGENT_RUN_BUDGET,
  status: "queued", currentStep: "queued", version: 1, attemptCount: 0,
  failureCode: null, queuedAt: now, startedAt: null, completedAt: null,
  failedAt: null, updatedAt: now, steps, events, results: [], reused: false,
});
```

Lock constants exactly as specified: queue `agent-runs`, job `discover-jobs`, payload version 1, lease 30 seconds, scan 1 second, run budget 60 seconds/3 attempts/10 calls/5 results/0 models/0 tokens, Fake source IDs and version strings. Prove all schemas reject unknown keys and Adapter errors contain only stable `code` and `retryable`.

- [ ] **Step 2: Run contract tests and verify RED**

Run: `pnpm --filter @job-copilot/contracts test -- src/agent-runs.test.ts`

Expected: FAIL because the module and schemas do not exist.

- [ ] **Step 3: Implement contracts and exports**

Use strict Zod objects and discriminated result unions. Define event cursor as a nonnegative safe integer serialized as a decimal SSE ID. Queue payload is exactly `{ version, runId, userId }`. Do not include target snapshots or source content.

- [ ] **Step 4: Write RED migration assertions**

Assert tables and constraints:

```ts
expect(await listPublicTables(database)).toEqual(expect.arrayContaining([
  "agent_runs", "agent_run_steps", "agent_run_events", "agent_run_job_results",
]));
expect(constraints).toEqual(expect.arrayContaining([
  "agent_runs_user_idempotency_unique",
  "agent_run_steps_run_step_unique",
  "agent_run_events_run_sequence_unique",
  "agent_run_job_results_run_opportunity_source_unique",
]));
```

Also assert `job_opportunities.import_id` is nullable and existing manual-import ownership constraints still exist.

- [ ] **Step 5: Add Drizzle schema and generate migration metadata**

Add composite owner FKs, status/current-step checks, positive version/sequence/ordinal checks, JSON-object checks and timestamp-state consistency checks. Make only `job_opportunities.import_id` nullable; keep `source_posting_version_id` required.

Run: `pnpm --filter @job-copilot/database db:generate -- --name agent_runs`

- [ ] **Step 6: Verify Task 1 and commit**

Run: `pnpm --filter @job-copilot/contracts test -- src/agent-runs.test.ts`

Run: `pnpm --filter @job-copilot/database test -- src/migrate.integration.test.ts`

Run: `pnpm --filter @job-copilot/contracts typecheck && pnpm --filter @job-copilot/database typecheck`

Commit: `feat: define durable agent runs (#9)`

---

### Task 2: Implement idempotent run lifecycle and discovery persistence

**Files:**
- Create: `packages/domain/src/agent-runs.ts`
- Create: `packages/domain/src/agent-runs.test.ts`
- Create: `packages/domain/src/agent-runs.integration.test.ts`
- Create: `packages/domain/src/job-opportunity-persistence.ts`
- Create: `packages/domain/src/job-opportunity-persistence.test.ts`
- Modify: `packages/domain/src/job-imports.ts`
- Modify: `packages/domain/src/job-imports.integration.test.ts`
- Modify: `packages/domain/src/audit-trail.ts`
- Modify: `packages/domain/src/audit-trail.integration.test.ts`
- Modify: `packages/domain/src/workbench-home.ts`
- Modify: `packages/domain/src/workbench-home.integration.test.ts`
- Modify: `packages/domain/package.json`
- Modify: `packages/contracts/src/workbench.ts`
- Modify: `packages/contracts/src/contracts.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts/tables, current active target revision, advisory lock and audit trail.
- Produces:

```ts
export interface AgentRunQueue { enqueue(job: AgentRunJob): Promise<void>; }
export interface DiscoveryContentStore {
  put(input: { objectKey: string; bytes: Uint8Array; mediaType: "application/json"; runId: string }): Promise<void>;
  delete(input: { objectKey: string }): Promise<void>;
}
export interface JobDiscoveryAdapter {
  search(input: DiscoverySearchInput): Promise<DiscoverySearchResult>;
  searchBatch(input: DiscoveryBatchSearchInput): Promise<DiscoveryBatchSearchResult>;
  getDetail(input: DiscoveryDetailInput): Promise<DiscoveryDetailResult>;
}
```

`createAgentRunCommands`, `createAgentRunQueries`, `createAgentRunProcessor`, `createAgentRunRecoveryQueries` and one shared opportunity persistence seam used by both imports and discovery.

- [ ] **Step 1: Write RED tests for start, snapshot and idempotency**

Prove:

- one active target produces one queued run, three pending steps and sequence 1 `run.queued` event;
- duplicate `(userId, idempotencyKey)` returns the same run and calls queue wakeup again;
- different accounts can use the same idempotency key;
- inactive, missing and foreign targets do not start;
- target changes after start do not mutate the stored snapshot;
- queue failure leaves the new run queued for recovery.

Run: `pnpm --filter @job-copilot/domain test -- src/agent-runs.test.ts src/agent-runs.integration.test.ts`

Expected: FAIL because the domain seam does not exist.

- [ ] **Step 2: Implement start, query and event replay**

Use the account advisory lock for idempotency and target snapshot. Insert the run, all three steps, event sequence 1 and `agent.run_queued` audit in one transaction. `latest` and `get` return current state, ordered steps/events/results; `eventsAfter` filters by owner and `sequence > cursor`.

- [ ] **Step 3: Write RED processor tests for lease and recovery**

Prove an active claim prevents a second processor, an expired claim can be replaced, stale claim tokens cannot update the run, retryable failure returns to queued until attempt 3, and terminal failure writes the matching event/time without raw error text.

- [ ] **Step 4: Write RED persistence tests for source versions and opportunities**

Process deterministic Adapter results twice and assert exactly one source posting, one content-identical source version, one opportunity, one opportunity-source link and one run-result link. Process the same job in a second run and assert the opportunity is reused while each run owns its result link. Assert discovery opportunities have `importId = null` and manual import normalization continues to preserve its import ID.

- [ ] **Step 5: Implement the processor and shared persistence seam**

The processor must:

1. claim queued or expired-running records with a 30-second lease;
2. record `run.started` and per-step events under the claim token;
3. call `searchBatch`, then bounded `getDetail` calls;
4. canonicalize raw detail JSON, compute hashes and write deterministic MinIO keys;
5. in one transaction upsert source posting/version/opportunity/evidence/result, complete the third step and run, and append `run.completed` plus redacted audit;
6. on retryable failure with remaining attempts release to queued and append `run.retry_scheduled`;
7. on terminal/final failure append `run.failed` and audit;
8. return `completed | retry | failed | stale` without exposing raw exceptions.

Extract only the source/opportunity upsert logic needed by both job imports and discovery. Preserve existing import behavior and tests.

- [ ] **Step 6: Make workbench running count real**

Change `runningAgentRuns` from `z.literal(0)` to `z.int().nonnegative()` and count only current-account `queued`/`running` runs. Keep recommendations and applications at literal zero.

- [ ] **Step 7: Verify Task 2 and commit**

Run: `pnpm --filter @job-copilot/domain test -- src/agent-runs.test.ts src/agent-runs.integration.test.ts src/job-opportunity-persistence.test.ts src/job-imports.integration.test.ts src/audit-trail.integration.test.ts src/workbench-home.integration.test.ts`

Run: `pnpm --filter @job-copilot/domain typecheck && pnpm --filter @job-copilot/contracts typecheck`

Commit: `feat: persist recoverable discovery runs (#9)`

---

### Task 3: Add the Fake discovery Adapter, Worker consumer and reconciler

**Files:**
- Create: `apps/worker/src/agent-runs/fake-job-discovery-adapter.ts`
- Create: `apps/worker/src/agent-runs/fake-job-discovery-adapter.test.ts`
- Create: `apps/worker/src/agent-runs/agent-run-consumer.ts`
- Create: `apps/worker/src/agent-runs/agent-run-consumer.test.ts`
- Create: `apps/worker/src/agent-runs/agent-run-reconciler.ts`
- Create: `apps/worker/src/agent-runs/agent-run-reconciler.test.ts`
- Create: `apps/worker/src/agent-runs/minio-discovery-content-store.ts`
- Create: `apps/worker/src/agent-runs/agent-run.module.ts`
- Create: `apps/worker/src/agent-runs/agent-run.integration.test.ts`
- Modify: `apps/worker/src/app.module.ts`

**Interfaces:**
- Consumes: Task 2 processor/recovery seams and current Redis/MinIO/database runtime patterns.
- Produces: deterministic Fake Adapter, BullMQ worker for `agent-runs`, and startup/1-second database reconciliation.

- [ ] **Step 1: Write and run RED Fake Adapter tests**

Cover `search`, `searchBatch`, `getDetail`, stable ordering, target filtering, five-result cap, unknown detail, injected retryable failure and injected nonretryable failure. Assert ordinary user text cannot trigger the fault path.

Run: `pnpm --filter @job-copilot/worker test -- src/agent-runs/fake-job-discovery-adapter.test.ts`

Expected: FAIL because the Adapter does not exist.

- [ ] **Step 2: Implement Fake Adapter v1**

Use only in-code fictional fixtures for `fake:aurora-careers` and `fake:orbit-careers`. Keep fixture content deterministic and explicitly normalized; no fetch, timers, filesystem or model calls.

- [ ] **Step 3: Write RED consumer and reconciler tests**

Assert BullMQ attempts map to domain `finalAttempt`, active claims cause BullMQ retry, completed/failed/stale outcomes resolve without duplicate work, and only retry outcome throws. Reconciler tests prove startup scan and interval scan enqueue each recoverable run with `runId` as job ID and ignore terminal runs.

- [ ] **Step 4: Implement Worker wiring**

Follow current `JobImportConsumer`/module patterns. Reconciler performs an immediate scan on module init and every 1,000 ms, prevents overlapping scans, and clears its timer on destroy. Queue add uses 3 attempts and bounded backoff that outlives a 30-second active lease. MinIO Adapter only accepts `application/json` and never logs bytes or object keys.

- [ ] **Step 5: Write and run the full recovery integration test**

With PostgreSQL, Redis and MinIO Testcontainers:

1. create a queued run without using API enqueue;
2. start the Worker module and let Reconciler discover it;
3. observe queued → running → completed in PostgreSQL;
4. verify persisted source versions, opportunity and result;
5. deliver the same job again and verify no duplicates;
6. leave a running record with expired lease, recreate the Worker, and verify completion.

- [ ] **Step 6: Verify Task 3 and commit**

Run: `pnpm --filter @job-copilot/worker test -- src/agent-runs/fake-job-discovery-adapter.test.ts src/agent-runs/agent-run-consumer.test.ts src/agent-runs/agent-run-reconciler.test.ts src/agent-runs/agent-run.integration.test.ts`

Run: `pnpm --filter @job-copilot/worker typecheck`

Commit: `feat: execute fake discovery runs (#9)`

---

### Task 4: Expose authenticated run APIs and replayable SSE

**Files:**
- Create: `apps/api/src/agent-runs/agent-runs.tokens.ts`
- Create: `apps/api/src/agent-runs/agent-runs.controller.ts`
- Create: `apps/api/src/agent-runs/agent-run-event-stream.ts`
- Create: `apps/api/src/agent-runs/agent-run-event-stream.test.ts`
- Create: `apps/api/src/agent-runs/agent-runs.module.ts`
- Create: `apps/api/src/agent-runs/bullmq-agent-run-queue.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/api.integration.test.ts`
- Modify: `apps/web/lib/server/api-client.ts`
- Modify: `apps/web/lib/server/api-client.test.ts`
- Create: `apps/web/lib/server/agent-runs.ts`
- Create: `apps/web/lib/server/agent-runs.test.ts`
- Create: `apps/web/app/api/agent-runs/route.ts`
- Create: `apps/web/app/api/agent-runs/route.test.ts`
- Create: `apps/web/app/api/agent-runs/[runId]/route.ts`
- Create: `apps/web/app/api/agent-runs/[runId]/events/route.ts`
- Create: `apps/web/app/api/agent-runs/[runId]/events/route.test.ts`

**Interfaces:**
- Consumes: Task 2 commands/queries and existing SessionGuard, request ID, API client and session-cookie patterns.
- Produces: authenticated create/latest/detail/event endpoints and same-origin Web BFF routes.

- [ ] **Step 1: Write RED API integration tests**

Assert:

- `POST /v1/agent-runs` returns 201 for new and 200 with the same `runId` for duplicate key;
- strict 400 validation, 401 without auth, 404 for inactive/foreign target;
- latest/detail are account isolated;
- API queue failure still returns the durable queued run;
- queue payload excludes target snapshot and job content.

- [ ] **Step 2: Implement REST endpoints and queue Adapter**

Use existing Nest/Fastify composition patterns. Map domain codes to strict ApiProblem responses. Do not introduce an API-side recovery loop; Worker owns reconciliation.

- [ ] **Step 3: Write RED SSE stream tests**

Test complete replay from cursor 0, replay after `Last-Event-ID`, `afterEventId`, larger-of-two cursor selection, event order, terminal close, 15-second heartbeat via fake timers, abort cleanup and no raw detail fields in `data`.

- [ ] **Step 4: Implement database-backed SSE**

The stream polls `eventsAfter` every 250 ms, emits SSE `id`, stable event name and JSON data, and closes after terminal event. Authenticate and resolve ownership before sending response headers. Use request abort to stop timers/queries.

- [ ] **Step 5: Write RED Web API-client and BFF tests**

Assert bearer forwarding remains server-only, response Schema parsing, cookie absence returns 401, run UUID validation returns 404, `Last-Event-ID`/query cursor forwarding, `text/event-stream` headers, upstream streaming body passthrough and abort propagation.

- [ ] **Step 6: Implement Web server adapters and BFF**

Expose `getLatestAgentRun`, `getAgentRun`, `startAgentRun`, and a raw stream opener in the server-only API client. The browser calls only same-origin `/api/agent-runs` routes.

- [ ] **Step 7: Verify Task 4 and commit**

Run: `pnpm --filter @job-copilot/api test -- src/agent-runs/agent-run-event-stream.test.ts src/api.integration.test.ts`

Run: `pnpm --filter web test -- lib/server/api-client.test.ts lib/server/agent-runs.test.ts app/api/agent-runs/route.test.ts 'app/api/agent-runs/[runId]/events/route.test.ts'`

Run: `pnpm --filter api typecheck && pnpm --filter web typecheck`

Commit: `feat: stream authenticated agent progress (#9)`

---

### Task 5: Build the workbench journey and prove Issue #9

**Files:**
- Create: `apps/web/components/workbench/agent-run-panel.tsx`
- Create: `apps/web/components/workbench/agent-run-panel.test.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.test.tsx`
- Modify: `apps/web/app/(workbench)/home/page.tsx`
- Modify: `apps/web/app/(workbench)/home/page.test.tsx`
- Modify: `apps/web/app/globals.css`
- Create: `apps/web/e2e/agent-runs.spec.ts`

**Interfaces:**
- Consumes: Task 4 same-origin REST/SSE routes, current job-target overview and workbench RSC.
- Produces: target selection, idempotent start, event timeline, refresh recovery and final persisted job cards.

- [ ] **Step 1: Write RED component/page tests**

Cover:

- no active target links to `/profile/targets`;
- active target selector and “发现岗位” button;
- one idempotency UUID reused while retrying the same start submission;
- queued/running/step/completed events remain in an accessible timeline;
- out-of-order or duplicate SSE IDs are ignored;
- cursor is saved per run in `sessionStorage` and included on remount;
- terminal event closes EventSource and reloads detail;
- final company/title/location/source appears from the detail response;
- stable Chinese error copy and 44px controls.

Run: `pnpm --filter web test -- components/workbench/agent-run-panel.test.tsx components/workbench/workbench-home-view.test.tsx 'app/(workbench)/home/page.test.tsx'`

Expected: FAIL because the panel and props do not exist.

- [ ] **Step 2: Implement the workbench Agent Run panel**

RSC loads workbench, target overview and latest run in parallel. Client state is a projection of strict DTOs/events; database detail remains authoritative after refresh. Preserve current profile and manual job-import entry behavior. Do not increment recommendations from discovered results.

- [ ] **Step 3: Write the failing Playwright acceptance journey**

The test signs in, creates an active target through the real UI, returns home, starts discovery, observes queued and running step history, refreshes before terminal or while replay is active, observes completion, and verifies at least one persisted job result. Submit the same idempotency key through API twice and prove the same run. Include desktop Chrome and mobile Safari accessibility/overflow checks.

- [ ] **Step 4: Run Playwright RED and make only acceptance-driven fixes**

Run: `DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- agent-runs.spec.ts`

Expected before the final wiring fixes: FAIL at the first incomplete acceptance behavior.

- [ ] **Step 5: Run focused and full verification**

Run: `pnpm typecheck`

Run: `DOCKER_API_VERSION=1.51 pnpm test`

Run: `DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- agent-runs.spec.ts`

Run: `pnpm build`

Run: `git diff --check`

Expected: all commands exit 0. Run `pnpm lint` separately; if the pre-existing `profile/targets/page.tsx` JSX-in-try/catch failure remains the only failure, record it without changing that file.

- [ ] **Step 6: Run final two-axis review**

Fixed point: the commit containing this plan. Standards sources: root `AGENTS.md`, `apps/web/AGENTS.md`, `PRODUCT.md`, `CONTEXT.md`, relevant ADRs. Spec sources: the linked design and GitHub #9. Resolve every Critical/Important finding with a reviewed fix round and rerun affected tests.

- [ ] **Step 7: Commit acceptance fixes and update Issue #9**

Commit: `fix: complete discovery agent acceptance (#9)`

Verify `git status --short` is empty. Add concise evidence to GitHub #9 and close it only after every acceptance item is demonstrated. Do not push or create a PR without user authorization.

