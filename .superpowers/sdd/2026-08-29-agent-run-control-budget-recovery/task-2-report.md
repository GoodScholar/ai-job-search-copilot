# Task 2 report — NEEDS_CONTEXT

## Status

Blocked before implementation by a load-bearing Task 1 persistence gap. No production or test changes are retained, and no commit was created.

## Evidence

`packages/database/src/schema.ts` defines `agent_run_events_event_type_check` with only the old seven event kinds ending in `run.failed`. Task 2's required command transaction must persist `run.pause_requested`, `run.paused`, `run.resume_requested`, `run.resumed`, `run.cancel_requested`, and `run.cancelled`; PostgreSQL would reject each write. Task 2 is explicitly prohibited from rewriting Task 1 migrations/contracts, so implementation cannot proceed safely.

The parent agent ruled that Task 1's original implementer will repair the missing check constraint in a separate fix round. Task 2 must remain paused until that fix is available.

The independently observed `ruleVersion` and `toolAllowlist` non-null fields are intentional. When resumed, Task 2 will update the existing start transaction to explicitly write the fixed rule version, allowlist, `modelSnapshot: null`, `usageComplete: true`, and zero aggregates for all new runs.

## TDD evidence from the discarded probe

| Slice | RED command / result | GREEN command / result |
| --- | --- | --- |
| Pure control reducer | `pnpm --filter @job-copilot/domain test -- src/agent-run-state.test.ts`; expected missing-module failure occurred, but the package script also executed the pre-existing suite and exposed the staged Task 1 start-row failure (`rule_version` is NULL). | `pnpm --filter @job-copilot/domain exec vitest run src/agent-run-state.test.ts`; 4/4 reducer assertions passed. The temporary reducer and test were then deleted because the real database constraint prevents its required integration slice. |
| Pure retry decision | `pnpm --filter @job-copilot/domain exec vitest run src/agent-run-state.test.ts`; expected `decideRetry is not a function` failure occurred. | `pnpm --filter @job-copilot/domain exec vitest run src/agent-run-state.test.ts`; 7/7 assertions passed. The temporary implementation and test were then deleted with the rest of the blocked probe. |

## Baseline checks

- `pnpm --filter @job-copilot/domain typecheck` fails before Task 2 due to staged contract/schema incompatibilities in `agent-runs.ts` and the old workbench fixture.
- `git diff --check` passes after cleanup.
- `git status --short` is empty after cleanup.

## Concerns

- Do not begin the control, checkpoint, Inbox, or audit integration slices until the repaired Task 1 migration/schema accepts the complete public event set.
- No Task 2 API, domain, test, migration, or contract changes currently remain.

## Resumed implementation

After Task 1 fix `d5654a4`, Task 2 explicitly initializes all new-run execution-spec and complete-ledger columns, extends the public detail projection, adds the pure control/retry policy, and adds the first durable control-command transaction with replay records and post-commit wakeup. Per the parent ruling, the existing Processor terminal writes now persist the matching termination kind/dimension and completed result aggregate without downgrading `usageComplete`.

Fresh `pnpm --filter @job-copilot/domain typecheck` passed. The focused integration command then could not start its PostgreSQL Testcontainer (`Timed out after 10000ms while waiting for container ports to be bound to the host`), so no integration-pass claim is made. Remaining Task 2 slices (checkpoint ledger, Inbox/audit allowlists, query extraction, and TDD coverage) are not complete.

## Task 2A — control slice

### Status

完成纯状态/重试策略、控制命令事务、启动完整快照映射与既有 Processor 终态不变量。未实现 checkpoint、usage 外部调用接线、Inbox、预算审计事件或 workbench active count。

父任务裁定本切片例外地加入六个控制审计 allowlist：`agent.run_pause_requested`、`agent.run_paused`、`agent.run_resume_requested`、`agent.run_resumed`、`agent.run_cancel_requested`、`agent.run_cancelled`；其余审计事件继续留给 2B/2C。控制 metadata 严格只允许 `runId`、`version`、`action` 与 `attemptCount`。

### RED/GREEN evidence

| Slice | RED | GREEN |
| --- | --- | --- |
| State/retry policy | `pnpm --filter @job-copilot/domain exec vitest run src/agent-run-state.test.ts`：5 个测试中 2 个失败。草稿会把正常来源重试错误地因 `maxModelCalls: 0` 判成模型预算耗尽，并让被误标为暂时的模型认证/策略/Schema 失败走预算分支。 | 同一命令：6/6 通过。`decideRetry` 现在先终止永久模型错误，并只按实际/预占工具或模型消费检查对应预算；当前 Fake 的模型预占在调用前被拒绝。新增“临时模型故障有剩余模型预算才 retry”测试是 inherited implementation 的直接 GREEN（运行时已有通用分支），其 TypeScript 输入类别随后显式纳入公开函数签名。 |
| Control module | `pnpm --filter @job-copilot/domain exec vitest run src/agent-run-control.integration.test.ts`：预期失败，`Cannot find module './agent-run-control'`。 | 同一命令：3/3 通过。覆盖账户隔离 404、commandId 同动作精确回放、不同动作冲突、取消覆盖暂停、队列唤醒失败不回滚、事件/审计仅一次；测试经 `agent-runs` façade 调用以验证重导出。 |
| Processor terminal event | 将旧“最终尝试”测试改为实际第三次可重试来源失败，要求终止 DTO 与 `run.failed` 事件都为 `AGENT_RUN_BUDGET_EXCEEDED`；初次运行失败，事件仍写原始 `AGENT_RUN_ADAPTER_RETRYABLE`。 | 最小修复令终态事件与审计使用持久化的终止 failure code。聚焦 Processor suite 22/22 通过。 |

### Files

- 新增 `packages/domain/src/agent-run-state.ts`、`agent-run-state.test.ts`：表驱动控制 reducer 和有限来源/模型重试策略。
- 新增 `packages/domain/src/agent-run-control.ts`、`agent-run-control.integration.test.ts`：账户锁事务、命令账本回放/冲突、单调事件、控制审计与提交后 best-effort queue。
- `packages/domain/src/agent-runs.ts` 保持 façade 重导出；新运行显式写规则、工具白名单、`modelSnapshot: null`、完整零 usage；详情投影 Task 1 DTO；Processor 写终态 kind/dimension/result aggregate。
- `packages/domain/src/audit-trail.ts` 仅扩展上述六个控制事件 allowlist。
- `packages/contracts/src/agent-runs.ts` 仅补公开控制 command/snapshot/response 类型导出。
- `packages/domain/src/agent-runs.integration.test.ts` 收紧启动快照、完成终态、结果聚合和第三次预算终止断言；没有放宽旧断言。

### Verification

- `pnpm --filter @job-copilot/domain exec vitest run src/agent-run-state.test.ts src/agent-run-control.integration.test.ts src/agent-runs.test.ts src/agent-runs.integration.test.ts src/audit-trail.integration.test.ts` → 5 files, 41 tests passed.
- `pnpm --filter @job-copilot/contracts typecheck` → passed.
- `git diff --check` → passed.
- `pnpm --filter @job-copilot/domain typecheck` 仍失败，唯一错误是非 2A 的 `packages/domain/src/workbench-home.integration.test.ts` 旧 fixture 未提供 Task 1 已设为必填的 `ruleVersion` 与 `toolAllowlist`。本轮按父任务要求恢复了该草稿变更，未把它带入提交。
- `pnpm --filter @job-copilot/domain test -- …` 的 package script 实际继续发现全量 17 个测试文件；143/144 通过，唯一失败仍是同一 workbench fixture 的 PostgreSQL `rule_version` NOT NULL 违反，非 Testcontainer 环境问题。

### Self-review / concerns

- 控制事务顺序为账户锁 → owner 查询 → commandId 查询 → reducer → run 更新 → 单调事件 → command record → 审计；重放在任何写入前返回首次 snapshot。
- queue 仅在已提交的 `run.resumed` 后 best-effort 唤醒；队列故障不会回滚 PostgreSQL 事实。
- 现有 Processor 尚未消费 `decideRetry`，也未接 checkpoint/usage ledger；这是 2B/后续 Worker 接线范围，不能据此宣称完整预算执行已落地。

## Task 2B — durable checkpoint / usage ledger / queries

### Status

完成 durable checkpoint 纵切。`createAgentRunCheckpoint(deps).check(input)` 仅由 `agent-runs.ts` façade 导出；真实 PostgreSQL 事务在账户锁下校验 owner、running claim 与 lease，按 checkpoint key 写 usage ledger 与聚合，处理控制优先级和预算终止。未实现 Inbox list/actions/restart，也未将 Processor 的外部 adapter 调用接入 checkpoint（均留给后续范围）。

### Files

- 新增 `packages/domain/src/agent-run-checkpoint.ts`：来源 tool/source 双预占、active slice 结算、模型零预算预拒绝、stale/cancel/pause/budget 决策、一次性 failed event/Inbox/审计。
- 新增 `packages/domain/src/agent-run-queries.ts`：迁移 `detail/latest/get/eventsAfter` 权威投影；保留结果、事件和步骤，并从聚合列返回 usage，历史 run 保留 `complete: false`。
- `packages/domain/src/agent-runs.ts`：保持 façade，重导出 checkpoint 与 queries。
- `packages/domain/src/audit-trail.ts`：仅加入 `agent.run_budget_consumed`、`agent.run_budget_exhausted`、`agent.inbox_opened` 三个 strict metadata allowlist。
- `packages/domain/src/workbench-home.ts` 及其 integration fixture：active count 改为 `queued/running/paused`，旧 fixture 补 Task 1 必填 snapshot 字段。
- `agent-run-control.integration.test.ts`、`agent-runs.integration.test.ts`、`audit-trail.integration.test.ts`：覆盖 checkpoint ledger、边界、暂停/取消、过期 claim、active-time 排除、单一 budget side effects、旧 usage 标记和审计脱敏。

### RED/GREEN evidence

| Slice | RED | GREEN |
| --- | --- | --- |
| checkpoint + workbench | `pnpm --filter @job-copilot/domain exec vitest run src/agent-run-control.integration.test.ts src/workbench-home.integration.test.ts`：3 failures；checkpoint 为 `TypeError: createAgentRunCheckpoint is not a function`，paused active count 期望 2 实得 1。 | 同命令：2 files、10 tests passed（后来增加取消覆盖后总数随之增长）。 |
| checkpoint/query/audit focused regression | 新 API 未导出时上述 checkpoint RED 已证明测试会捕获生产缺口。 | `pnpm --filter @job-copilot/domain exec vitest run src/agent-run-state.test.ts src/agent-run-control.integration.test.ts src/agent-runs.test.ts src/agent-runs.integration.test.ts src/audit-trail.integration.test.ts src/workbench-home.integration.test.ts`：6 files、50 tests passed。 |

### Verification

- `pnpm --filter @job-copilot/domain typecheck` → passed.
- `pnpm --filter @job-copilot/contracts typecheck` → passed.
- `git diff --check` → passed.

### Self-review / concerns

- checkpoint 的预算判断在 usage 入账前完成：达到模型/工具预算时不写被拒绝的调用消费；有效 active slice 仍会结算。
- 同 checkpoint key 有既有 usage entry 时在任何聚合/事件/Inbox/审计写入前返回；账户 advisory lock 串行化同账户并发 checkpoint。
- Inbox 行仅由 checkpoint 创建，未实现 2C 的列表、行动或 restart；Processor adapter 调用也尚未改接 checkpoint，避免提前跨入 Task 3。

## Task 2C — Agent Inbox actions / normal failures / audit completion

### Status

完成最终领域纵切。`createAgentInbox(deps).list/act` 仅从 `agent-runs` façade 导出，按当前账户和显式状态投影固定 DTO；不持久化或返回自由文案。实现 decision 恢复/取消、普通失败 restart/dismiss、预算 dismiss 及目标调整 href。没有新增 API、BFF、UI 或 Worker resolver。

### RED/GREEN evidence

| Slice | RED | GREEN |
| --- | --- | --- |
| Inbox list/actions | 新增 `agent-inbox.integration.test.ts` 后运行 `pnpm --filter @job-copilot/domain exec vitest run src/agent-inbox.integration.test.ts`：4/4 失败，原因是 `createAgentInbox is not a function`。 | 同命令最终 6/6 通过：固定投影、owner 隔离、允许动作、actionId 重放、restart current target/retry 关联、失败留 open，以及“新 run 已创建而 resolve 失败”时重放复用。 |
| 普通失败与 retry 审计 | 在 `agent-runs.integration.test.ts` 增加普通不可重试失败只写 `run_failed` item/`agent.inbox_opened`，及 retry schedule 审计断言；初次运行 2 项失败，分别缺 item 与 audit。 | 最小补 `failOrRetry` 同事务副作用后 23/23 通过；budget exhaustion 继续交给 checkpoint，未提前抽取 Processor。 |

### Files

- 新增 `packages/domain/src/agent-inbox.ts`、`agent-inbox.integration.test.ts`：固定 Inbox 投影、动作账本、owner 隔离、重放/no-change/conflict、restart 重试链及 resolution retry safety。
- `packages/domain/src/agent-runs.ts`：façade 导出 Inbox；普通终态失败创建唯一 `run_failed` item，并对 retry schedule 写脱敏审计。
- `packages/domain/src/agent-run-control.ts`：成功直接 resume/cancel 也在同一控制事务解决对应 decision item，不复制 reducer。
- `packages/domain/src/audit-trail.ts`：补严格 allowlist `agent.run_retry_scheduled`、`agent.inbox_action_applied`、`agent.inbox_resolved`，并将 `agent.inbox_opened` 收紧为 kind/reason/dimension 的固定对应关系。
- `packages/contracts/src/agent-inbox.ts`：仅导出 action response 类型，供领域 facade 使用；既有 DTO 字段不变。
- 相关 integration tests：覆盖直接控制解决、普通失败单一事项、retry/action/resolution audit 与 metadata 脱敏。

### Verification

- `pnpm --filter @job-copilot/domain exec vitest run src/agent-run-state.test.ts src/agent-run-control.integration.test.ts src/agent-inbox.integration.test.ts src/agent-runs.test.ts src/agent-runs.integration.test.ts src/audit-trail.integration.test.ts src/workbench-home.integration.test.ts` → 7 files, 58 tests passed.
- `pnpm --filter @job-copilot/domain typecheck` → passed.
- `pnpm --filter @job-copilot/contracts typecheck` → passed.
- `git diff --check` → passed.

### Self-review / concerns

- action metadata 只允许 Inbox/run 内部 ID、固定动作、固定 outcome 与稳定 reason；不含 target 内容、岗位正文、object key 或异常文本。
- restart 先用 actionId 启动；若解决事务回滚，action record 不会写入，下一次相同 actionId 通过已有 start idempotency row 复用新 run 后重试解决，避免第二次运行。
- `pnpm --filter @job-copilot/domain test -- …` 的 package script 会以 `--no-file-parallelism` 运行全套并在该工具的 30 秒输出边界被截断；使用同一列出的 Vitest 文件直调完成最终聚焦验证。未观察到测试或环境失败。

## Task 2 review fix round 1 (partial lifecycle repair)

### Evidence

- Root cause: processor claim omitted `activeSliceStartedAt`; retry/failure/completion did not consistently clear it; checkpoint treated the already-claimed third attempt as exhausted; queued pause did not create the required decision item.
- GREEN: `pnpm --filter @job-copilot/domain exec vitest run src/agent-run-control.integration.test.ts` → 1 file, 7 tests passed; `pnpm --filter @job-copilot/domain typecheck` and `git diff --check` passed.

### Changes

- Claim now atomically starts an active slice; retry, failure and completion clear it.
- Checkpoint accepts the legally claimed third attempt (`attemptCount > maxAttempts` only).
- Checkpoint final pause/cancel emit their matching control audit records.
- Immediate queued pause now opens the unique decision Inbox item and audit; direct resume/cancel tests consume that authoritative item.

### Remaining review items

- Shared active-slice settlement/budget-terminal helper, duplicate-key reserve matching/control priority, retry classification, Inbox failed-action replay and concurrent different-action ownership still require subsequent review fix rounds.

## Task 2 review fix round 1 — remaining findings closed

### Status

已关闭本轮 A–F 的剩余 finding；未接入 Task 3 的逐外部调用 checkpoint、resolver、API 或 UI。

### RED/GREEN evidence

| Slice | RED | GREEN |
| --- | --- | --- |
| A / active slice | `pnpm --filter @job-copilot/domain exec vitest run src/agent-runs.integration.test.ts src/agent-run-control.integration.test.ts src/agent-inbox.integration.test.ts`：真实 Processor retry/completed 都显示 `activeDurationMs: 0`。 | 同命令最终 3 files、40 tests passed；真实 claim 在 retry、completion 和 heartbeat 通过稳定 `claimToken + activeSliceStartedAt` ledger key 结算，离开 running 清空 slice。 |
| B / shared budget terminal | 上述 RED 同时暴露旧 Processor claim-before-attempt 与 checkpoint 各自写终态；前者没有 Inbox/budget audit 的共享语义。 | 新内部 lifecycle helper 统一 attempts、active deadline 与 checkpoint 的 `run.failed`、`agent.run_failed`、`agent.run_budget_exhausted`、唯一 Inbox 和类型化维度；第三次合法 attempt 不提前终止。 |
| C / checkpoint replay | 同一 checkpoint key 以不同 reserve 重放错误地返回 continue，且已有 key 会跳过 pause/cancel。 | checkpoint integration 新测试 GREEN：reserve 形状不一致稳定抛 `AGENT_RUN_CHECKPOINT_CONFLICT`；同 key 在 pause request 后仍完成 pause，且不重复 reserve usage。 |
| D / retry typing | 未类型化 `Error` 被映射为 retryable，Processor 返回 retry。 | 新 Processor 测试 GREEN：未知异常永久失败；仅 adapter 明确 `retryable` 的 source result 可经 `decideRetry` 重试，预算由同一纯策略判定。 |
| E / failed Inbox replay | 首次 restart failure 抛 `AGENT_RUN_TARGET_INACTIVE`，相同 actionId 重放却返回 `{ applied: false }`。 | Green 后两次均稳定抛 `AGENT_INBOX_ACTION_FAILED`；动作账本与审计保存该实际稳定原因，而非复用 run 的旧 failure reason。 |
| F / Inbox concurrency | 两个不同 actionId 并发 resume/cancel 都可完成。 | `Promise.allSettled` PostgreSQL 集成测试 GREEN：先持久化 `pending` ownership；不同 action 不能穿透，只有一个 action row/终态转换。迁移 `0019` 仅扩展内部 outcome check。 |

### Verification

- `pnpm --filter @job-copilot/domain exec vitest run src/agent-run-state.test.ts src/agent-run-control.integration.test.ts src/agent-inbox.integration.test.ts src/agent-runs.test.ts src/agent-runs.integration.test.ts src/audit-trail.integration.test.ts src/workbench-home.integration.test.ts` → 7 files, 62 tests passed。
- `pnpm --filter @job-copilot/database exec vitest run src/migrate.integration.test.ts` → 15 tests passed。
- `pnpm --filter @job-copilot/domain typecheck`、`pnpm --filter @job-copilot/contracts typecheck`、`pnpm --filter @job-copilot/database typecheck`、`git diff --check` → passed。

### Self-review / concerns

- `pending` 仅是 durable Inbox action ownership，不是用户自由文本或公共 DTO；restart 在 start 成功而 resolution 回滚后仍可用相同 actionId 重放完成。
- active-time ledger 与 aggregate 在同一事务中更新，使用稳定 slice key 的冲突结果决定是否累计，避免事务重试双计。
- Processor 仍不在每次 Adapter 调用前调用 checkpoint：这是 Task 3 的外部调用接线边界，本轮只修复既有 Processor lifecycle 和 retry/terminal 语义。

## Task 2 review fix round 2

### Status

关闭 scoped re-review 留下的三项未完全修复与一项新 breakage；未扩展 Task 3、API 或 UI。

### RED/GREEN evidence

| Slice | RED | GREEN |
| --- | --- | --- |
| Expired reclaim | `pnpm --filter @job-copilot/domain exec vitest run src/agent-runs.integration.test.ts src/agent-run-control.integration.test.ts src/agent-inbox.integration.test.ts`：过期 running claim 被新 claim 覆盖，旧有效 lease 的 30 秒未入账；累计到 active budget 仍创建新 claim。 | 同命令 3 files、44 tests passed：用旧 token/start key 结算到 `min(claimExpiresAt, claimNow)`，仅累计有效 30 秒；到 active budget 时直接 `budget_exhausted(active_duration)`，没有 `run.started`。 |
| Typed budget dimension | 同一 RED：将 run snapshot 的工具预算设为 0 后，Processor 仍完成，证明 `adapterCall` 使用了常量且 budget error 没有维度。 | `AgentRunBudgetError` 携带 dimension；deadline/bounded 为 `active_duration`，adapter tool boundary 为 `tool_calls`。GREEN 断言 tool terminal、唯一 Inbox、`run.failed`、budget 与 Inbox audit 各一次，并保留 active deadline 断言。 |
| Control priority | 已有 checkpoint 加不同 reserve + cancel 先抛 `AGENT_RUN_CHECKPOINT_CONFLICT`。 | GREEN 后 cancel 优先落地，不追加 reserve usage；正常 `controlState=none` 的 mismatch 仍稳定拒绝。 |
| Failed ownership retryability | restart 在 inactive target 后留下 failed action；修复 target 后新 actionId 被旧 row 永久冲突。 | GREEN 后同 actionId 精确重放 `AGENT_INBOX_ACTION_FAILED`，open item 的所有历史 failed row 不阻止新 actionId restart；pending/applied/no-change 仍阻止不同 action。 |

### Verification

- `pnpm --filter @job-copilot/domain exec vitest run src/agent-runs.integration.test.ts src/agent-run-control.integration.test.ts src/agent-inbox.integration.test.ts` → 3 files, 44 tests passed。
- Task 2 七文件聚焦套件 → 7 files, 66 tests passed。
- domain/contracts/database typecheck → passed；database migration integration → 15 tests passed；`git diff --check` → passed。

### Self-review / concerns

- expired reclaim 只把过期 lease 之前的可证明执行时间入账，不把崩溃后的 downtime 计入；settlement key 仍是旧 claim token 与旧 slice start，重试幂等。
- `pending` ownership 仍是内部 durable 状态；同一 item 只有所有历史 action 均为 `failed` 且事项保持 open 时，才允许新的 actionId 获得 retry ownership。
