# Task 3 报告：持久化运行前检查快照

## 实现

- 新增 `0047_agent_run_preflight_snapshot`：`agent_runs.preflight_snapshot jsonb null`、仅允许对象的 PostgreSQL CHECK，且不回填历史行。
- 迁移同步允许 schedule occurrence 使用 `RUN_PREFLIGHT_BLOCKED`，既有 `skipped/run_id null` 结果约束仍强制该原因不可绑定 run。
- Drizzle `agentRuns` 增加 `preflightSnapshot`，放在账户策略快照字段旁。
- `AgentRunStarter` 使用完整 `StartAgentRunCommand`，`CommandDependencies.runPreflight` 为必需依赖。
- 手动 discovery 在账户 advisory lock 和 owner-bound 幂等查询之后，于同一事务内 evaluate + authorize；重放始终优先返回既有运行。授权成功后，evaluation 的 policy revision/snapshot 与 report 同 target/execution/budget 一起写入 `agent_runs`。
- summary/detail 都用 `RunPreflightSnapshotSchema` 解析已持久化的非空 JSON；历史 null 保持 null，不以当前检查替换。
- 为既有领域测试显式注入 ready evaluator。该 helper 现在会物化 revision 0 policy 行，确保它的 policy revision 与 `agent_runs_policy_owner_revision_fk` 在真实 PostgreSQL 中成立。

## RED / GREEN

1. RED：新增真实 PostgreSQL migration 断言后，运行
   `pnpm --filter @job-copilot/database test -- src/migrate.integration.test.ts`
   失败 2 项：缺少 `agent_runs_preflight_snapshot_object` 与 journal 末项仍为 0046，符合预期。
2. GREEN：完成 0047、journal 与 schema 后，使用定点等价命令（package test wrapper 会扫同包配置中的额外文件）运行：
   `pnpm --filter @job-copilot/database exec vitest run --no-file-parallelism src/migrate.integration.test.ts`
   通过，27 tests。
3. domain 定点 GREEN：
   `pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/agent-run-control.integration.test.ts src/agent-runs.test.ts src/agent-runs.integration.test.ts`
   通过，54 tests。

## 最终串行验证

```text
pnpm --filter @job-copilot/database exec vitest run --no-file-parallelism src/migrate.integration.test.ts
  27 passed

pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism \
  src/agent-run-control.integration.test.ts src/agent-runs.test.ts \
  src/agent-runs.integration.test.ts src/agent-inbox.integration.test.ts \
  src/company-watchlists.integration.test.ts src/job-discovery-persistence.integration.test.ts \
  src/recommendation-feedback.integration.test.ts
  140 passed

pnpm --filter @job-copilot/database typecheck
pnpm --filter @job-copilot/domain typecheck
  both passed

git diff --check
  passed
```

## 越界文件（已获 Supervisor 裁决）

- `packages/domain/src/testing/run-preflight.ts`：ready evaluator 物化 revision 0 policy，保证新 policy FK 的真实数据库语义。
- `packages/domain/src/agent-run-processor.integration.test.ts`、`packages/domain/src/job-discovery-schedules.integration.test.ts`：仅机械注入 ready evaluator，使必需依赖后的 domain typecheck 通过；未添加 Task 4 行为、断言或调用路径。

## 自审与疑虑

- 幂等读取在锁后且在 evaluator 前；被阻塞或无 warning fingerprint 的重放不重新授权，直接复用原行。
- 手动路径的 policy 只取 evaluator 返回值，避免第二次读取与快照不一致；schedule 路径刻意保持既有策略读取与 null snapshot，留给 Task 4。
- migration 用真实 PostgreSQL 检查 null、对象、数组/字符串/数字和 occurrence outcome 组合。
- 现有 SQL-shape 回归因新增 preflight JSON 参数将上限从 34 调整到 35，仍验证常数形状。

## Fix round 1/5

- RED：`ready preflight fixture 将报告中的策略证据与返回策略保持同一修订` 在 revision 1 policy 下失败，报告证据错误固定为 revision 0。
- GREEN：ready evaluator 先物化/读取 policy，再构造报告；账户策略 evidence revision、返回 revision 与 snapshot 现在来自同一次读取。
- 新增真实 PostgreSQL + `createRunPreflightEvaluator` 覆盖：blocked 无 run/step/event；未确认 warning 被拒绝、当前 fingerprint 成功；成功行原子保存 evaluator report 和 policy；页面预读后 target 停用会在启动事务重检并拒绝；成功运行随后变 blocked 时，相同 idempotency key 的无 fingerprint 重放仍优先复用。
- 新增 checkpoint 回归：历史宽松 budget/source scope/preflight 快照保持原文，`toolCalls: 11` 仍被 fake workflow 当前硬上限 10 拒绝。
- mutation check：若移除 helper 的 policy-first 读取或再次固定 evidence revision，fixture consistency test 失败；若将 checkpoint 改为直接使用历史 budget snapshot，宽松快照测试不再返回 `tool_calls` exhausted；若将 preflight 移至幂等查询前，停用 target 后重放测试失败。
- 定点证据：fixture consistency + real preflight test 2 passed；hard-limit test 1 passed（首次容器启动端口等待超时，确认无测试遗留进程后串行重跑通过）；`pnpm --filter @job-copilot/domain typecheck` 与 `git diff --check` 通过。

## Fix round 1 完整复跑（exit 0）

```text
$ pnpm --filter @job-copilot/database exec vitest run --no-file-parallelism src/migrate.integration.test.ts
Test Files  1 passed (1)
Tests       27 passed (27)

$ pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/agent-run-control.integration.test.ts src/agent-runs.test.ts src/agent-runs.integration.test.ts src/agent-inbox.integration.test.ts src/company-watchlists.integration.test.ts src/job-discovery-persistence.integration.test.ts src/recommendation-feedback.integration.test.ts
Test Files  7 passed (7)
Tests       144 passed (144)

$ pnpm --filter @job-copilot/database typecheck
$ pnpm --filter @job-copilot/domain typecheck
$ git diff --check
all exit 0
```

新增 owner-bound 独立用例验证：账户 B 不能使用 A 的 targetId 取得/重放 A 的运行；即便 idempotency key 相同，B 的旧 warning fingerprint 也会收到 B 自己的最新 warning 报告，使用 B 当前 fingerprint 后只创建 B 自己的 run。mutation check：若去掉 owner `userId` 条件，测试会错误复用 A run；若 fingerprint 不包含 target/账户状态，B 旧 fingerprint 拒绝断言会失效。

## Fix round 2/5：手动启动权威状态重检矩阵

- 在真实 PostgreSQL 的 `agent-run-control.integration.test.ts` 增加一组 data-driven 覆盖。每个场景均使用隔离账户和幂等键，先通过真实 `createRunPreflightEvaluator` 取得 `ready_with_warnings` 页面报告与可确认启动的 fingerprint，随后才改变数据库权威状态并调用真实手动启动器。
- 覆盖的五类变化及锁内最新 blocker：移除最后 active profile fact → `PROFILE_EVIDENCE_MISSING`；停用 requested target → `REQUESTED_JOB_TARGET_INACTIVE`；停用唯一 enabled Greenhouse source → `SOURCE_CAPABILITY_UNAVAILABLE`；将当前 deployment fingerprint 的模型诊断写为 `failed` → `MODEL_DIAGNOSTIC_UNAVAILABLE`；将 relevant account policy 的 `publicDiscovery.maxResults` 改为 `0` → `ACCOUNT_RUN_POLICY_BLOCKED`。
- 每项均断言拒绝码为 `RUN_PREFLIGHT_BLOCKED`、返回报告为 `blocked` 且含对应 blocking item，并分别确认该账户的 `agent_runs`、`agent_run_steps`、`agent_run_events` 均未新增。
- 新覆盖首次在既有生产实现上直接通过，故这是补覆盖而非伪造 RED。mutation check：临时将启动事务内 `authorizeRunPreflight` gate 改为不执行后，定点文件以 exit 1 失败（24 项中 4 项失败；新增矩阵错误地得到已创建运行而非 `RUN_PREFLIGHT_BLOCKED`）；随后立即恢复原实现。

### Fix round 2 验证（全部 exit 0，除上述预期 mutation run）

```text
$ pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/agent-run-control.integration.test.ts
Test Files  1 passed (1)
Tests       24 passed (24)

$ pnpm --filter @job-copilot/database exec vitest run --no-file-parallelism src/migrate.integration.test.ts
Test Files  1 passed (1)
Tests       27 passed (27)

$ pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/agent-run-control.integration.test.ts src/agent-runs.test.ts src/agent-runs.integration.test.ts src/agent-inbox.integration.test.ts src/company-watchlists.integration.test.ts src/job-discovery-persistence.integration.test.ts src/recommendation-feedback.integration.test.ts
Test Files  7 passed (7)
Tests       146 passed (146)

$ pnpm --filter @job-copilot/database typecheck
$ pnpm --filter @job-copilot/domain typecheck
$ git diff --check
all exit 0
```
