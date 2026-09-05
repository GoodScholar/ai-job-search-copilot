# Issue #51 Task 4 执行报告

## 实现

- schedule dispatch 不再以页面/扫描阶段的 `dispatchReason` 授权；`runs.start()` 在自身账户锁事务中评估并授权 schedule preflight。blocker 将 occurrence 标记为 `RUN_PREFLIGHT_BLOCKED` 且不会创建 run；既有 idempotency run 仍优先回填 dispatched。
- discovery schedule 成功创建会持久化同一 evaluation 的 `preflightSnapshot`、policy revision 与 policy snapshot。
- deep-match 的两处领域 insert 均在 `ensureDeepMatchRunInTransaction` 的 preflight gate 后执行并写入 snapshot；automatic `RUN_PREFLIGHT_BLOCKED` 返回 `{ kind: "blocked" }`，不会中断 discovery 父事务；manual warning 使用 command 的 fingerprint 授权。
- processor 的 transaction-complete、补偿触发和恢复重放均注入同一个 `runPreflight`。
- Worker 用单例 `AGENT_RUN_PREFLIGHT` 注入 scheduler 和 processor；仅创建 model diagnostic 的只读 projection reader。test 使用稳定 seed `job-copilot-test-deployment-v1`，production 使用真实 OpenAI 运行配置且不会自行诊断或联网。

## RED / GREEN

### RED

```sh
pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/job-discovery-schedules.integration.test.ts
```

新增的「计划派发在运行创建事务内重检 blocker」用例按预期失败：旧实现把 occurrence 标记为 `dispatched` 并创建 run，而期望为 `skipped / RUN_PREFLIGHT_BLOCKED / runId null`。

### GREEN

```sh
pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/job-discovery-schedules.integration.test.ts src/deep-match-trigger.test.ts src/deep-match-persistence.integration.test.ts src/agent-run-processor.integration.test.ts
pnpm --filter @job-copilot/domain typecheck
pnpm --filter worker typecheck
```

结果：domain 4 个文件、142 项测试通过；两个 `tsc --noEmit` 通过。

Worker 定点套件也以单进程方式启动：

```sh
pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run.module.test.ts src/agent-runs/agent-run.integration.test.ts src/agent-runs/agent-run-scheduler.test.ts
```

该容器套件在本机命令会超过工具单次输出窗口；进程已自行退出，没有与上述 domain 测试重叠。后续 reviewer 应在本地完整复跑该精确命令并保存终端最终摘要。

## 创建调用图与扫描

```text
schedule -> AgentRunStarter.start -> evaluate/authorize -> agentRuns insert
manual discovery -> AgentRunStarter.start -> evaluate/authorize -> agentRuns insert
manual deep match -> DeepMatchRunStarter -> ensure... -> evaluate/authorize -> agentRuns insert
automatic completion/recovery -> processor -> ensure... -> evaluate/authorize -> agentRuns insert
```

`rg -n '\\.insert\\(agentRuns\\)' packages apps` 的生产命中只有两处：

1. `packages/domain/src/agent-run-control.ts`：统一 discovery starter，在 insert 前 authorize。
2. `packages/domain/src/deep-match-agent-runs.ts`：统一 deep-match helper，在 insert 前 authorize。

其他命中都在 `*.integration.test.ts`，用于构造历史/恢复夹具，不是运行创建路径。

## 文件

- `packages/domain/src/agent-run-control.ts`
- `packages/domain/src/job-discovery-schedules.ts`
- `packages/domain/src/job-discovery-schedules.integration.test.ts`
- `packages/domain/src/deep-match-agent-runs.ts`
- `packages/domain/src/agent-run-processor.ts`
- `packages/domain/src/agent-runs.ts`
- `apps/worker/src/agent-runs/agent-run.module.ts`
- `apps/worker/src/agent-runs/agent-run.integration.test.ts`
- `apps/worker/package.json`
- `pnpm-lock.yaml`

## 疑虑

- API composition 明确留给 Task 5；当前 Worker 已是唯一生产 automatic composition root，并强制注入真实 evaluator。API 手动 deep-match provider 必须在 Task 5 改为同一 evaluator，随后移除遗留测试兼容的 optional starter 适配。
- `git diff --check` 已通过。

## 补测与最终 Worker 证据（追加）

### 补测

- 新增真实 PostgreSQL deep-match 覆盖：manual warning 缺确认、过期 fingerprint 均拒绝；当前 fingerprint 创建并写入 warning snapshot；automatic blocker 返回 `kind: blocked` 且不创建 child。
- mutation RED：临时移除 `ensureDeepMatchRunInTransaction` 的 `authorizeRunPreflight` 调用，`src/deep-match-persistence.integration.test.ts` 23 项中新增用例按预期失败（缺 fingerprint 的 manual 错误创建 run）；随后立即恢复授权调用。
- Worker schedule 集成用例改为构造真实 profile fact 与稳定 test deployment 的 `model_diagnostic_results` 行。它证明 scheduler 的真实 evaluator 放行 ready run；三个缺失/不可用 occurrence 则按新统一语义记录 `RUN_PREFLIGHT_BLOCKED`，不再依赖旧的预派发原因。

### Worker 按文件串行结果

```text
pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run.module.test.ts
Test Files  1 passed (1)
Tests       37 passed (37)
exit 0

pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run.integration.test.ts
Test Files  1 passed (1)
Tests       9 passed (9)
exit 0

pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run-scheduler.test.ts
Test Files  1 passed (1)
Tests       5 passed (5)
exit 0
```

此前三文件组合 RED 的完整终端摘要为 3 files / 50 passed / 1 failed / exit 1；失败是该 Worker integration fixture 没有创建 profile fact 和与 Worker 相同指纹的诊断行。修复 fixture 后，上列逐文件 GREEN 均为 exit 0。

## 最终 Step 6 串行验证（追加）

```text
pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/job-discovery-schedules.integration.test.ts src/deep-match-trigger.test.ts src/deep-match-persistence.integration.test.ts src/agent-run-processor.integration.test.ts
Test Files  4 passed (4)
Tests       143 passed (143)
exit 0

pnpm --filter @job-copilot/domain typecheck
exit 0

pnpm --filter worker typecheck
exit 0

pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run.module.test.ts src/agent-runs/agent-run.integration.test.ts src/agent-runs/agent-run-scheduler.test.ts
Test Files  3 passed (3)
Tests       51 passed (51)
exit 0

git diff --check
exit 0
```
