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

## Task 4 fix round 2：新 HEAD Worker 证据

当前 HEAD `4c6c408`。运行前与运行后均未发现 96d4 的残留 Vitest/worker 测试进程（`pgrep` 仅命中检查命令自身）；未触碰其他仓库的 Playwright。

```text
pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run.integration.test.ts
Test Files  1 passed (1)
Tests       11 passed (11)
exit 0

pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run.module.test.ts src/agent-runs/agent-run.integration.test.ts src/agent-runs/agent-run-scheduler.test.ts
Test Files  3 passed (3)
Tests       53 passed (53)
exit 0
```

## 修复轮 1（2026-09-05）

- 移除了 `agent-runs.ts` 与 `deep-match-agent-runs.ts` 的生产 ready fallback；processor facade 与 deep-match starter 的 `runPreflight` 均为必传依赖。旧测试仅在各自测试文件中显式构造 ready evaluator。
- schedule 的 #51 覆盖改为真实 PostgreSQL evaluator：无既有 run 的当前 blocker 记录 `RUN_PREFLIGHT_BLOCKED`；既有 idempotent run 在策略收紧后仍回填 dispatched；真实 source-health warning 自动创建 run，并精确比对持久化的 preflight snapshot 与同次 evaluation 的 policy。
- Worker integration 曾 RED：legacy processor fixture 未显式注入 required preflight，结果为 `retry`（exit 1，9 tests 中 1 failed）；补入测试专用 ready evaluator 后 GREEN。

### 本轮串行验证

```text
pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/job-discovery-schedules.integration.test.ts
1 file passed; 19 tests passed; exit 0

pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/agent-run-processor.integration.test.ts
1 file passed; 101 tests passed; exit 0

pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run.module.test.ts
1 file passed; 37 tests passed; exit 0

pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run.integration.test.ts
1 file passed; 9 tests passed; exit 0

pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run-scheduler.test.ts
1 file passed; 5 tests passed; exit 0

pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/job-discovery-schedules.integration.test.ts src/deep-match-trigger.test.ts src/deep-match-persistence.integration.test.ts src/agent-run-processor.integration.test.ts
4 files passed; 144 tests passed; exit 0

pnpm --filter @job-copilot/domain typecheck && pnpm --filter worker typecheck && git diff --check
all exit 0
```

## 修复轮 4：processor blocker / replay

- 真实 `processor.process` blocker 用例现在断言 parent 为 completed、`run.completed` 与 discovery result 已提交，deep-match child 为零。
- 入口 warning 用例在首次完成后将 evaluator 的当前状态切换为 blocked，再以同一 processor replay；trace 仍只有最初的 automatic deep-match evaluation，child 数量为一且原 warning snapshot/policy 保留，证明幂等行在当前 preflight 前优先返回。

```text
Domain Step6: 4 files passed; 148 tests passed; exit 0
Worker module: 1 file; 37 tests passed; exit 0
Worker scheduler: 1 file; 5 tests passed; exit 0
domain typecheck; worker typecheck; git diff --check: exit 0
```

## 修复轮 5：区分 transaction / compensation / replay

两个新入口用例以独立 PostgreSQL client 在 evaluator 执行瞬间观察 parent 的已提交状态。warning 的 transaction `afterCompleted` trace 严格为 `running`，随后通过正式 `triggerDeepMatchAfterDiscovery` replay（当前 evaluator 已切为 blocked）仍复用 child 而不增加 trace，证明先查幂等。blocker trace 严格为 `[running, completed]`：前者是 transaction callback，后者是 post-commit compensation；父 result/event 已提交且 child 始终为零。

```text
pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/agent-run-processor.integration.test.ts
1 file passed; 105 tests passed; exit 0
```

本轮 `rg -n '\\.insert\\(agentRuns\\)' packages apps` 仍只有两处非测试生产插入：`agent-run-control.ts` 和 `deep-match-agent-runs.ts`，均先调用统一 preflight gate；其余命中为 integration fixture。

## 修复轮 2

`agent-run-processor.integration.test.ts` 新增真实 PostgreSQL preflight 基线：写入 active profile fact 与 available diagnostic 后由 `createRunPreflightEvaluator` 读取。automatic warning 在该真实 evaluation 上受控增加 warning 投影，证明 automatic 不需要 fingerprint、child 写入 snapshot/policy、重复事务调用只保留一个 child。另一个用例以真实 evaluator 的 unverified projection 形成 blocker，证明父 discovery 已完成及 `run.completed` event 保留、child 为零；并以非 `RunPreflightRejectedError` 的 evaluator 错误验证该错误继续抛出。

```text
pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/agent-run-processor.integration.test.ts
1 file passed; 103 tests passed; exit 0
pnpm --filter @job-copilot/domain typecheck && git diff --check
exit 0
```

## 修复轮 3：processor 公开入口

新增的 processor 入口用例不直接调用 deep-match helper：`processor.process` 的成功路径同时覆盖 discovery persistence transaction 内 `afterCompleted` 与提交后的补偿触发；trace 记录唯一一次 `workflow=deep_match, trigger=automatic` evaluation，第二次 processor replay 为 stale 且 child 不重复。数据库断言 child warning snapshot/policy 与真实 evaluator 一致。未知 evaluator 错误走原 retry/queued 语义且 child 为零，未被 automatic blocker 分支吞掉。

```text
pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/agent-run-processor.integration.test.ts
1 file passed; 105 tests passed; exit 0
pnpm --filter @job-copilot/domain typecheck && pnpm --filter worker typecheck && git diff --check
all exit 0
```

## Worker composition 补证据（Task 4 fix round 1）

- `agent-run.integration.test.ts` 新增真实 Worker 调用链覆盖：从 Worker scheduler tick 创建 schedule discovery，再由真实 processor 提交 automatic deep-match child；对 Nest 的唯一 `AGENT_RUN_PREFLIGHT` 实例记录 evaluator identity/call trace，确认同一实例收到 `discovery/schedule` 与 `deep_match/automatic` 两类调用。测试不是 provider 注册或 mock 存在性断言。
- 同文件新增 production-like 缺模型配置覆盖：以 `APP_ENV=production` 构造 Worker evaluator，写入真实 profile/target 但不写入当前 deployment 指纹的 diagnostic 行；断言只读 projection 返回 `MODEL_DIAGNOSTIC_UNAVAILABLE` / `unverified` blocker，并把全局 fetch 设为失败以证明没有诊断或 OpenAI 请求。若 production fallback 改回 test ready fake，此测试会不再得到当前 deployment 的 unverified blocker。
- test diagnostic 继续从既有 `TEST_MODEL_DIAGNOSTIC_FINGERPRINT_SEED` 经 `createFakeModelDiagnosticAdapter` 派生，未引入第二套硬编码 fingerprint 规则。

### RED / mutation 记录

- 首次新增测试运行到断言阶段：production projection 的真实报告为 `blocked`，且包含 `MODEL_DIAGNOSTIC_UNAVAILABLE` / `unverified`；初始 `toMatchObject` 对数组作了错误的完整数组匹配，导致 1 项断言失败。该断言已改为先断言 report status，再按 code 寻找 model item；没有修改生产实现，也不把该测试辅助错误计为产品 RED。
- 计划中的两个受控 mutation（scheduler factory 绕过 injected provider、production 分支改用 ready fake）尚未执行。修正断言后，Testcontainers 在 `beforeAll` 连续三次无法得到 Docker 发布的 PostgreSQL host port，所有 11 项测试被跳过，故不能诚实声称 mutation 已执行。

### 本轮串行验证与外部阻塞

```text
pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run.module.test.ts
1 file passed; 37 tests passed; exit 0

pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run-scheduler.test.ts
1 file passed; 5 tests passed; exit 0

pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/job-discovery-schedules.integration.test.ts src/deep-match-trigger.test.ts src/deep-match-persistence.integration.test.ts src/agent-run-processor.integration.test.ts
4 files passed; 146 tests passed; exit 0

pnpm --filter @job-copilot/domain typecheck
exit 0

pnpm --filter worker typecheck
exit 0

git diff --check
exit 0
```

Worker integration 的修正前完整一次运行已到测试主体（10 passed、1 assertion failed，exit 1）；修正后连续三次在 `PostgreSqlContainer.start()` 的 `beforeAll` 阶段失败（11 skipped，exit 1）。运行中检查到新 `postgres:17-alpine` 容器健康，但 Docker 的 `HostConfig.PortBindings` 为 `HostPort: "0"` 且 `NetworkSettings.Ports["5432/tcp"]` 为空；Testcontainers 因而在等待 host port 绑定 10 秒后超时。现有用户 PostgreSQL 占用 `127.0.0.1:5432`，未被停止或修改。本缺口需要 Docker 恢复随机 host-port 分配后，单进程重跑 worker integration、两个 mutation check 与要求的三文件组合。

## 环境恢复与最终验收（Task 4 fix round 1）

### Docker 只读与清理边界

- `pgrep` 未发现 96d4 残留 Vitest/worker 测试进程；唯一 Docker PostgreSQL 是用户既有 `b6640bc0529294b0754c420cdae8ec6ea38f6f30358f7b3bf3cb5a5a0dd54c93` / `wanyou-dev-postgres-1`（`postgres:17.6-alpine`，已运行约 20 小时，host `127.0.0.1:5432`），未触碰。
- 检查时没有遗留的 `postgres:17-alpine` 或 Testcontainers reaper，故未停止或删除任何容器。最终 runner 退出后短暂存在的 reaper `fd1d44b672ef11932cab21b6b3437ee4f778cfd141018e638b0b7ef814434280` 已由 Testcontainers 自行清理；再次 inspect 返回 `no such object`。
- Docker 为 client/server `29.5.2`、API `1.54`、linux/arm64、overlayfs；未读取或输出敏感环境变量。

### 完整 RED / GREEN mutation

1. 临时将 scheduler command composition 改为 `createWorkerRunPreflight({ executionMode })`，绕过 injected provider。只跑 Worker integration 得到预期 `exit 1`：trace 仅有 `deep_match/automatic`，缺少 `discovery/schedule`，失败于新增同一实例断言。立即恢复 `runPreflight` 注入；重跑 `11 passed / exit 0`。
2. 临时将 `APP_ENV=production` 分支改走 test ready fake。只跑 Worker integration 得到预期 `exit 1`：production-like 测试实际 `status: ready`，期望 `blocked`。立即恢复 production OpenAI configuration projection；重跑 `11 passed / exit 0`。

### 最终从头串行验收

```text
pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run.module.test.ts
1 file passed; 37 tests passed; exit 0

pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run.integration.test.ts
1 file passed; 11 tests passed; exit 0

pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run-scheduler.test.ts
1 file passed; 5 tests passed; exit 0

pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/agent-run.module.test.ts src/agent-runs/agent-run.integration.test.ts src/agent-runs/agent-run-scheduler.test.ts
3 files passed; 53 tests passed; exit 0

pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/job-discovery-schedules.integration.test.ts src/deep-match-trigger.test.ts src/deep-match-persistence.integration.test.ts src/agent-run-processor.integration.test.ts
4 files passed; 146 tests passed; exit 0

pnpm --filter @job-copilot/domain typecheck
exit 0

pnpm --filter worker typecheck
exit 0

git diff --check
exit 0
```
