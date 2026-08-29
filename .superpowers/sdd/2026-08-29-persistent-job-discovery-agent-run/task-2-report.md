# Task 2 报告：持久化 Discovery Agent Run

## RED / GREEN 证据

- RED（起点与幂等）：`pnpm --filter @job-copilot/domain test -- src/agent-runs.test.ts src/agent-runs.integration.test.ts`，退出码 1；两个 suite 均因 `Cannot find module './agent-runs'` 失败。
- GREEN（起点与查询）：同一命令在实现后退出码 0，14 个文件、112 个测试通过。
- RED（处理器、共享持久化、工作台）：`pnpm --filter @job-copilot/domain test -- src/agent-runs.integration.test.ts src/job-opportunity-persistence.test.ts src/workbench-home.integration.test.ts`，退出码 1；分别观测到缺失 `createAgentRunProcessor`、缺失 `job-opportunity-persistence` 和 `runningAgentRuns: 0`。
- RED（恢复查询）：`pnpm --filter @job-copilot/domain test -- src/agent-runs.integration.test.ts`，退出码 1；观测到 `createAgentRunRecoveryQueries is not a function`。
- 最终 GREEN：`pnpm --filter @job-copilot/domain test -- src/agent-runs.test.ts src/agent-runs.integration.test.ts src/job-opportunity-persistence.test.ts src/job-imports.integration.test.ts src/audit-trail.integration.test.ts src/workbench-home.integration.test.ts`，退出码 0，15 个文件、118 个测试通过。
- 类型检查：`pnpm --filter @job-copilot/domain typecheck` 与 `pnpm --filter @job-copilot/contracts typecheck` 均退出码 0；`pnpm --filter @job-copilot/contracts test -- src/contracts.test.ts` 退出码 0（8 个文件、73 个测试）。

## 变更

- 新增 agent run 命令、查询、恢复查询、claim/lease 处理器、事件投影和 canonical JSON hash。
- 新增机会持久化 seam；手动导入保留原有 source/import 生命周期，只委托 dedup/upsert 和 evidence link。
- 新增严格的 agent run 审计 allowlist，并将工作台计数改为当前账户 queued/running run 的真实数量。

## 自审与顾虑

- 已执行 `git diff --check`，无空白错误；PostgreSQL 集成测试覆盖所有权、幂等、恢复、重试、终态、来源/机会/result 复用和工作台计数。
- 顾虑：现有新增测试没有单独以可推进时钟验证 `maxDurationMs` 超限路径，也没有直接断言未生成新 source version 时对象存储的补偿删除；建议主控审查时重点覆盖这两项绑定语义。
