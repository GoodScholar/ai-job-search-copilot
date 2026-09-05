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
