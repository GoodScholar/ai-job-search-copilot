# Task 1 Report

## Status

`DONE`。实现仅限 contracts 与 PostgreSQL 持久化切片，未实现 Task 2+ 的领域命令、Worker、API 或 UI。

提交：`1131533 feat: define agent run controls and budgets (#10)`。

## 实现内容

- Agent Run 公共契约增加控制状态/命令/响应、执行规格、消费、结构化终止原因、暂停/取消生命周期、新事件及严格跨字段校验。
- 公共预算字段已从 `maxDurationMs` 替换为 `maxActiveDurationMs`；`0018` 对已有 JSON 快照执行兼容回填，公共 Schema 不会同时暴露两个字段。
- 新增 Agent Inbox 物品、固定中文投影、列表、四种无额外参数的严格动作联合和响应契约。
- 新增控制命令、消费账本、Inbox 项和 Inbox 动作的 Drizzle 表与 owner 复合外键；为恢复扫描与开放 Inbox 查询保留必要索引。
- `0018` 从 #9 旧行回填 rule/tool/model 与预算字段，并诚实保留 `usage_complete = false`。

## 文件

- `packages/contracts/src/agent-runs.ts`
- `packages/contracts/src/agent-runs.test.ts`
- `packages/contracts/src/agent-inbox.ts`
- `packages/contracts/src/agent-inbox.test.ts`
- `packages/contracts/package.json`
- `packages/database/src/schema.ts`
- `packages/database/migrations/0018_agent_run_control_budget_inbox.sql`
- `packages/database/migrations/meta/0018_snapshot.json`
- `packages/database/migrations/meta/_journal.json`
- `packages/database/src/migrate.integration.test.ts`

## TDD evidence

### Control / budget

- RED: `pnpm --filter @job-copilot/contracts test -- src/agent-runs.test.ts`
- Key failure: `TypeError: Cannot read properties of undefined (reading 'options')` for absent `AgentRunControlStateSchema`。
- GREEN: 同一命令，`Test Files 8 passed (8); Tests 74 passed (74)`。

### Execution / usage / termination

- RED: `pnpm --filter @job-copilot/contracts test -- src/agent-runs.test.ts`
- Key failure: `TypeError: Cannot read properties of undefined (reading 'parse')` for absent `AgentRunExecutionSpecSchema`。
- GREEN: 同一命令，`Test Files 8 passed (8); Tests 75 passed (75)`。

### Lifecycle event variants

- RED: `pnpm --filter @job-copilot/contracts test -- src/agent-runs.test.ts`
- Key failure: Zod `Invalid discriminator value` for `run.pause_requested`。
- GREEN: 同一命令，`Test Files 8 passed (8); Tests 76 passed (76)`。

### Agent Inbox

- RED: `pnpm --filter @job-copilot/contracts test -- src/agent-runs.test.ts src/agent-inbox.test.ts`
- Key failure: `Cannot find module './agent-inbox'`。
- GREEN: 同一命令，`Test Files 9 passed (9); Tests 79 passed (79)`。

### Persistence

- RED: `pnpm --filter @job-copilot/database test -- src/migrate.integration.test.ts`
- Key failure: 四张新表不在 public tables。
- GREEN: 同一命令，`Test Files 1 passed (1); Tests 15 passed (15)`；覆盖 owner、负消费、非法状态/动作、usage key 去重和 #9 升级。

## 最终验证

```text
contracts tests: 9 files, 79 tests passed
database migration tests: 1 file, 15 tests passed
contracts typecheck: exit 0
database typecheck: exit 0
git diff --check: exit 0
```

## Fix round 2/5

### 覆盖文件

- `packages/database/src/migrate.integration.test.ts`
- `packages/database/src/schema.ts`
- `packages/database/migrations/0018_agent_run_control_budget_inbox.sql`
- `packages/database/migrations/meta/0018_snapshot.json`

### NULL-safe terminal mapping

- RED: `pnpm --filter @job-copilot/database test -- src/migrate.integration.test.ts`
- Key failure: `promise resolved [] instead of rejecting`；`usage_complete = true, status = completed, termination_kind = null` 被 PostgreSQL CHECK 接受。
- GREEN: `pnpm --filter @job-copilot/database test -- src/migrate.integration.test.ts`，`Test Files 1 passed (1); Tests 15 passed (15)`。
- 新增真实 PostgreSQL 断言：完整 completed 缺 termination、`source_failed` 缺 failure code、`budget_exhausted` 缺 failure code/dimension 均拒绝；`usage_complete = false` 的旧 completed 行仍允许 null termination。
- 修复：`agent_runs_termination_mapping_check` 外层使用 `coalesce((...), false)`，使任何必需字段的 NULL 都转为拒绝；Drizzle schema、0018 SQL 与生成 snapshot 已同步。

### Fix round final verification

```text
database migration tests: 1 file, 15 tests passed
database typecheck: exit 0
contracts tests: 9 files, 80 tests passed
contracts typecheck: exit 0
git diff --check: exit 0
```

## 自审与问题

- `0018_snapshot.json` 由 Drizzle 生成，未手工编辑。缺少 brief 所称 `db:generate` package script，故使用等价 package-local `drizzle-kit generate --config=drizzle.config.ts --name ...`；生成后仅修改 SQL migration，先回填旧行再设新非空列，这是 PostgreSQL 迁移必需的最小替代。
- 新引用均使用账户复合外键；没有引入 Redis/队列事实或通知系统。
- 已审阅 diff，未发现无关改动或未解决问题。

## Fix round 1/5

### 覆盖文件

- `packages/contracts/src/agent-runs.test.ts`
- `packages/database/src/migrate.integration.test.ts`

### Finding 1 — 终止映射

- RED: `pnpm --filter @job-copilot/contracts test -- src/agent-runs.test.ts`
- Key failure: `expected true to be false`；完整的 `completed` detail 错配 `cancelled_by_user` termination 被接受。
- GREEN: 同一命令，`Test Files 9 passed (9); Tests 80 passed (80)`。
- 修复：`AgentRunDetailSchema` 和 `agent_runs_termination_mapping_check` 同时限制非终态无 termination；完整终态按 status/kind/failure code/budget dimension 映射；只有 `usage_complete = false` 的旧终态可为空。

### Finding 2 — result snapshot

- RED: `pnpm --filter @job-copilot/database test -- src/migrate.integration.test.ts`
- Key failure: `promise resolved [] instead of rejecting`；`result_snapshot = '{}'::jsonb` 被数据库接受。
- GREEN: 同一命令，`Test Files 1 passed (1); Tests 15 passed (15)`。
- 修复：JSONB check 要求精确五键、run UUID/版本与同列一致、合法状态/步骤/控制状态、正整数 version 以及 cancelled 配对；测试覆盖空对象、多余键和不一致 run/version。

### Fix round final verification

```text
contracts tests: 9 files, 80 tests passed
database migration tests: 1 file, 15 tests passed
contracts typecheck: exit 0
database typecheck: exit 0
git diff --check: exit 0
```

## Fix round 3/5

### 覆盖文件

- `packages/database/src/migrate.integration.test.ts`
- `packages/database/src/schema.ts`
- `packages/database/migrations/0018_agent_run_control_budget_inbox.sql`
- `packages/database/migrations/meta/0018_snapshot.json`

### 事件类型持久化契约

- RED：`pnpm --filter @job-copilot/database test -- src/migrate.integration.test.ts`
- 关键输出：`run.pause_requested` 插入被 PostgreSQL 的 `agent_run_events_event_type_check` 以 `23514` 拒绝，符合数据库约束仍只允许 7 个旧事件的根因。
- GREEN：同一命令，`Test Files 1 passed (1); Tests 15 passed (15)`。
- 新增真实 PostgreSQL 覆盖：按合法 owner/run/sequence/version 与 JSON object 分别插入 7 个控制/预算事件均成功；`run.unknown` 仍被 `23514` 拒绝。
- 修复：Drizzle schema 与既有 `0018` 均替换同名 `agent_run_events_event_type_check`，允许 7 个旧事件和 7 个 Task 1 新事件；没有创建新迁移编号。`0018_snapshot.json` 由 Drizzle 基于 `0017` 元数据重新生成并同步。

### Fix round final verification

```text
database migration tests: 1 file, 15 tests passed
contracts focused tests: 9 files, 80 tests passed
contracts typecheck: exit 0
database typecheck: exit 0
git diff --check: exit 0
```

## 自审与问题

- 变更仅扩展 Task 1 已公开的事件枚举，保留旧 7 个事件及未知事件拒绝语义；未修改规则、工具 allowlist 或 Task 2 代码。
- 测试直接经迁移后的 PostgreSQL 插入，覆盖的是数据库事实源而非 Drizzle 定义的静态字符串。
