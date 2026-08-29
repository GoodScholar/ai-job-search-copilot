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

## Fix round 1（审查修复）

### RED / GREEN 证据

- RED：`pnpm --filter @job-copilot/domain test -- src/agent-runs.test.ts src/agent-runs.integration.test.ts`，退出码 1；观测到 `discoverySourceIdentifier is not a function`、旧 `raw/...` 对象路径、重复 identity 的 `resultCount: 2` 和 persisted attempt=3 仍 `completed`。
- GREEN：同一测试命令在修复后退出码 0，15 个文件、121 个测试通过。
- GREEN（追加 lease/duration 集成）：`pnpm --filter @job-copilot/domain test -- src/agent-runs.integration.test.ts`，退出码 0，15 个文件、123 个测试通过。
- 最终验证：`pnpm --filter @job-copilot/domain test -- src/agent-runs.integration.test.ts src/agent-runs.test.ts src/job-opportunity-persistence.test.ts src/job-imports.integration.test.ts src/audit-trail.integration.test.ts src/workbench-home.integration.test.ts`，退出码 0，15 个文件、123 个测试通过；`pnpm --filter @job-copilot/domain typecheck` 与 `pnpm --filter @job-copilot/contracts typecheck` 均退出码 0；`git diff --check` 无输出、退出码 0。

### 修复范围与自审

- source identifier 改为 canonical `{ sourceId, detailId }` SHA-256；原始对象键包含账户、run、source hash 和 raw hash。相同内容版本复用、失败和 stale 路径均 best-effort 删除未提交对象。
- 每个 Adapter 调用显式累计 tool call，所有 Adapter/对象存储边界使用 attempt deadline 的受控 timeout，并在调用后以可推进时钟复核；超限终态为 `AGENT_RUN_BUDGET_EXCEEDED`。
- claim 前先处理耗尽 attempts 的 run，原子写入 `run.failed` 和脱敏审计，避免第四次 claim；详情请求以前按 source identity 去重，ordinal/resultCount 使用实际持久化的唯一结果。
- PostgreSQL 集成测试覆盖活动 claim、过期接管及旧 token stale、attempt budget、重复 identity、来源版本复用和对象键/删除。未修改审查 ledger 已记录的 Minor。

## Fix round 2（claim 隔离对象清理）

- 实施：对象键遵循 controller ruling，改为 `accounts/{user}/agent-runs/{run}/sources/{sourceIdentifier}/{claimToken}/{rawHash}.json`。put 前即登记自身 key；put 异常/超时、stale、版本复用和事务失败均仅清理该 claimant 的未提交 key。
- 实施：删除操作纳入同一 attempt deadline 的 `bounded` 调用；删除挂起、失败或超时被吞没，不能延长 process 或覆盖主结果。超时 put 的原 Promise 通过 settle continuation 触发自身 key 的补偿，避免未处理 rejection。
- 覆盖：对象键集成断言已更新为 source hash、claim token、raw hash；既有 PostgreSQL lease takeover、旧 token stale、source-version 复用对象删除和完整事件顺序用例继续覆盖。
- 实际命令：`pnpm --filter @job-copilot/domain test -- src/agent-runs.integration.test.ts src/agent-runs.test.ts src/job-opportunity-persistence.test.ts src/job-imports.integration.test.ts src/audit-trail.integration.test.ts src/workbench-home.integration.test.ts`，退出码 0，15 个文件、123 个测试通过；`pnpm --filter @job-copilot/domain typecheck` 与 `pnpm --filter @job-copilot/contracts typecheck` 均退出码 0；`git diff --check` 退出码 0、无输出。
