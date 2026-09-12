# Task 12 B2：在途 deep-match 迟到结算

> 范围仅为 B2；不代表 Task 12、Group B 或后续发布竞争已完成。

## 实现

- `agent-run-processor.ts` 将每个 deep-match invocation 保留为独立 Promise：abort 先到时 processor 立即按权威 checkpoint 退出；忽略 signal 的 adapter 后续返回仍以原 `usageKey`、原 `attemptCount` 调用 `settleActual`，不会 stage、publish 或开启新调用。
- 迟到结算的 checkpoint 异常仅输出 `AGENT_RUN_LATE_USAGE_SETTLEMENT_FAILED`，不携带错误对象、provider 正文或模型输出；正常 invocation rejection 是预期 abort 路径，不输出该码。
- heartbeat 一旦取得 `paused` 或 `cancelled` 的权威控制结果，停止后续续约，防止已经确认的控制结果被后续 claim miss 覆盖为 `stale`；abort catch 也优先保留已知控制结果。

## RED / GREEN 与覆盖

| 要求 | 命名测试 | 证据 |
| --- | --- | --- |
| 实际账户 stop 后，旧 invocation 迟到仍结算；release 不恢复旧运行；cancel 优先；替代 claim 用量隔离 | `账户停止后 deferred 模型调用在%s再迟到返回时，只结算旧 invocation usage`（3 个参数化实例） | RED：`test-logs/task-12-b2-observability-red.log`（真实 stop 后错误返回 `stale`）；GREEN：`test-logs/task-12-b2-focused-green.log` |
| 同一轮 AbortSignal 与 adapter resolve | `同一轮 abort 和 adapter resolve 时仍只结算一次 usage 且不暂存或发布` | `test-logs/task-12-b2-abort-resolve-green.log`；该补验收在同步 signal flag 实现下直接通过，未伪造 RED |
| 迟到 settle checkpoint 异常安全、固定码可观察 | `迟到模型 usage 的 checkpoint 失败只记录固定错误码，不把正常 abort 误报为结算失败` | RED：`test-logs/task-12-b2-observability-red.log`（无固定码）；GREEN：`test-logs/task-12-b2-focused-green.log` |
| 正常 abort rejection 不误报迟到结算失败 | `被 abort 拒绝的模型调用不标记迟到 usage 结算失败` | `test-logs/task-12-b2-focused-green.log` |

各 usage 断言精确为 `model_call=1`、`input_tokens=7`、`output_tokens=11`；均断言 adapter `calls=1`、无 candidate assessment、无 recommendation list。替代 claim 场景额外断言 replacement 的 attempt 和 usage 聚合保持不变。

## 验证

- `pnpm --filter @job-copilot/domain exec vitest run src/account-run-control.integration.test.ts src/agent-run-control.integration.test.ts src/agent-run-processor.integration.test.ts --no-file-parallelism`：153 passed，`test-logs/task-12-b2-processor-control-green.log`。
- `pnpm --filter @job-copilot/domain typecheck`：通过，`test-logs/task-12-b2-domain-typecheck.log`。
- `git diff --check`：通过（提交前再次执行）。
