# Task 2 — 统一 run-preflight evaluator 与模型稳定投影

## 实现摘要

- 新增 `@job-copilot/domain/run-preflight`：事务可绑定 evaluator、短事务查询门面、稳定 SHA-256 警告 fingerprint，以及精确的 blocking/manual-warning 授权错误。
- evaluator 只投影 owner-bound 的当前 profile、主/请求目标、当前 Watchlist 中 enabled Greenhouse 来源、每个来源的最新健康记录、稳定模型投影及 effective policy；不输出自由文本、URL、配置指纹或原始错误。
- 模型诊断新增只读 `ModelDiagnosticProjectionReader`，使用现有 advisory lock 的非阻塞探测；`createModelDiagnostics().get()` 重用它。
- 新增仅供旧领域夹具显式注入的 `createReadyRunPreflightEvaluator()`，未被生产代码导入。

## TDD 证据

### RED

1. 已确认不存在遗留 `vitest`、`playwright`、`pnpm test` 进程。
2. 先添加 `run-preflight.integration.test.ts` 与模型 reader 集成断言，再运行：

   ```sh
   pnpm --filter @job-copilot/domain test -- src/run-preflight.integration.test.ts src/model-diagnostics.integration.test.ts
   ```

3. 该仓库的 package script 将参数后的 `--` 解释为全包扫描，RED 如预期暴露缺少 evaluator/reader/授权导出的错误；同时无关旧集成套件也被扫描。此命令不能作为定点结果。

### GREEN

```sh
pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/run-preflight.integration.test.ts src/model-diagnostics.integration.test.ts
```

结果：2 个文件、22 项测试全部通过。覆盖真实 PostgreSQL owner 隔离、活动/移除画像修订、主/次目标、Greenhouse/AnySearch/disabled 来源边界、来源健康最新行和非阻塞语义、deep-match 非必需来源项、策略预算/窗口、模型不同指纹与失败状态、fingerprint 稳定性、敏感字段负面证明及授权矩阵。

## 验证命令与结果

```sh
git diff --check
```

通过。

```sh
pnpm --filter @job-copilot/domain typecheck
```

未通过，唯一错误为本任务开始前 Task 1 contracts 变更造成的既有调用不匹配：

```text
src/agent-inbox.ts(77,1035): Property 'warningFingerprint' is missing in type
{ targetId: string; idempotencyKey: string; }
```

`agent-inbox.ts` 不在 Task 2 brief 允许修改的文件中，故未越界修复；Task 3 应在其完整受影响 fixture/API 接线中统一补齐该新必填字段，或由 owner 指派独立修复。

## 变更文件

- `packages/domain/src/run-preflight.ts`
- `packages/domain/src/run-preflight.integration.test.ts`
- `packages/domain/src/testing/run-preflight.ts`
- `packages/domain/src/model-diagnostics.ts`
- `packages/domain/src/model-diagnostics.integration.test.ts`
- `packages/domain/package.json`

## 自审

- evaluator 仅接受 `select/insert/execute` DB seam；公开查询自己开短事务。
- fingerprint 排除 `checkedAt` 与 `latestCheckedAt`，canonical JSON 排序键，且只包含 warning 的安全投影。
- `schedule` 同时检查 evaluator 当前时刻和 `scheduledFor`；manual 不检查窗口。
- 报告固定为画像、主目标、请求目标、来源能力、来源健康、模型、策略的顺序；所有中文文案由受限 code switch 生成。
- 外部 Adapter 仅用于来源能力声明；模型 projection reader 从不调用 Adapter。

## 疑虑

- 完整 domain typecheck 当前被上述已有 `agent-inbox.ts` 不匹配阻断，非 Task 2 所能修改。
- 指定 `pnpm ... test -- <files>` 运行方式在当前 package script 下会全包扫描；GREEN 使用等价的直接 Vitest 定点命令以维持单进程、非重叠测试纪律。

## 门禁修复（追加）

账本裁决确认上述 typecheck 是必须关闭的门禁。最小修复将 `StartAgentRunCommand` 导出类型从 `z.infer` 改为 `z.input<typeof StartAgentRunCommandSchema>`：调用方可以省略拥有 `.default(null)` 的 `warningFingerprint`，而所有生产边界仍由 `StartAgentRunCommandSchema.parse()` 输出显式 `warningFingerprint: null`。未修改 `agent-inbox.ts`，也未改变运行语义。

以下命令按单进程串行执行，全部通过：

```sh
pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/run-preflight.integration.test.ts src/model-diagnostics.integration.test.ts
# 2 files / 22 tests passed
pnpm --filter @job-copilot/domain typecheck
# tsc --noEmit passed
pnpm --filter @job-copilot/contracts exec vitest run --no-file-parallelism src/agent-runs.test.ts
# 1 file / 21 tests passed
pnpm --filter @job-copilot/contracts typecheck
# tsc --noEmit passed
```

修复后不再存在 typecheck 疑虑。

## 审查修复 round 1/5（追加）

### RED

先确认无遗留测试进程后，先扩展真实 PostgreSQL 集成测试，运行：

```sh
pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/run-preflight.integration.test.ts
```

结果：11 项中 2 项按预期失败。

- 单一 enabled Greenhouse 缺少 `continuous_monitoring` 被错误投影为 `SOURCE_CAPABILITY_PARTIAL` warning，而测试要求 `SOURCE_CAPABILITY_UNAVAILABLE` blocking。
- schedule 缺少 `scheduledFor` 时错误回退到当前时刻并报告策略 ready，而测试要求安全阻塞。

### 最小修复与覆盖

- capability 判定改为：零真实来源或 `capable === 0` 均为 unavailable/blocking；仅 `0 < capable < enabled` 为 partial/warning。
- schedule 现在要求 `scheduledFor` 存在，并分别检查 evaluator 当前时刻与该 occurrence 时刻。
- fingerprint 只包含版本、workflow、trigger、target、warning code、剔除时间字段后的安全 evidence 与固定 actions；移除了展示文案、severity 和 retryable。
- 新增/加强了单来源 schedule 能力缺失、双来源 partial、缺少时间、当前/occurrence 各自越窗、advisory lock `checking`、当前账户敏感字段负面证明，以及 health counts/code/target/workflow/trigger 变化的 hash 回归覆盖。

### GREEN

以下命令严格单进程串行执行：

```sh
pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/run-preflight.integration.test.ts src/model-diagnostics.integration.test.ts
# 2 files / 24 tests passed
pnpm --filter @job-copilot/domain typecheck
# tsc --noEmit passed
git diff --check
# passed
```

## 审查修复 round 2/5（追加）

上一轮集成矩阵通过真实数据库覆盖了变化，但 `workflow`、`targetId`、`code` 的 fingerprint 变更仍带有其他状态变化。为消除该证据缺口，新增了窄的 `fingerprintRunPreflightWarnings()` 纯投影 seam：生产 evaluator 使用它；输入只允许 workflow、trigger、targetId 以及 warning 的 code/evidence/actions，不能传入 summary、impact、severity 或 retryable。这不是规则 DSL，而是已经存在的确认 hash 的最小安全投影边界。

### RED

```sh
pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/run-preflight.integration.test.ts
```

结果：新增测试按预期失败，`fingerprintRunPreflightWarnings is not a function`。测试用完全相同的单条 warning fixture，逐一只修改 workflow、targetId 或 code，要求每次 hash 改变；因此删除任一字段的 hash 输入会被捕获。

### GREEN

以下命令串行通过：

```sh
pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/run-preflight.integration.test.ts src/model-diagnostics.integration.test.ts
# 2 files / 25 tests passed
pnpm --filter @job-copilot/domain typecheck
# tsc --noEmit passed
git diff --check
# passed
```
