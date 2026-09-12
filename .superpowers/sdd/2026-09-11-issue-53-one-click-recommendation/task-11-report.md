# Task 11 交付报告：持久账户停止命令与独立控制版本

## 变更

- 在 contracts 增加严格的账户控制 state/command/response schema，并为计划 occurrence 增加 `ACCOUNT_RUN_STOPPED` 与 `ACCOUNT_RUN_SCHEDULE_SKIPPED`。
- 新增 0050 迁移、Drizzle snapshot 与 journal：策略控制字段、不可变账户命令 inbox、快照/版本/动作约束及调度跳过原因约束。
- 新增 `createAccountRunControl`：读取不物化 baseline；控制事务在账户锁中完成幂等检查、baseline、版本检查、状态转换、批量暂停、审计和命令持久化。
- 将原逐运行控制抽取为 `applyAgentRunControlInTransaction`，原 public control 继续负责账户锁和提交后唤醒。
- 审计新增 `account.run_stopped` / `account.run_stop_released` 的严格 metadata allowlist。
- 更新历史迁移测试的 0050 剥离列表和 journal 断言。

## RED / GREEN 证据

- RED：`pnpm --filter @job-copilot/domain exec vitest run src/account-run-control.integration.test.ts --no-file-parallelism`，因 `ACCOUNT_RUN_CONTROL_NOT_IMPLEMENTED` 失败；日志：`test-logs/task-11-red-domain.log`。
- GREEN：contracts 2 文件 6 tests；0050 migration 2 tests；相关 domain 3 文件 19 tests；逐运行控制回归 24 tests；历史迁移验证（28 + 11 tests）均通过。完整命令输出保存在同目录 `task-11-*.log`。
- 最终逐包 typecheck：contracts、database、domain 均通过；`git diff --check` 通过。

## 覆盖与自审

- 覆盖停止/释放/重放、旧版本冲突、相同状态 no-op、新旧 commandId 载荷冲突、严格审计 metadata、命令表不可变性、快照校验、跨账户相同 commandId、迁移后的默认未停止状态和两项新增 skip reason。
- 回归确认公共逐运行 pause/resume/cancel/replay（`agent-run-control.integration.test.ts`）仍通过。
- 自审确认账户 stop 仅处理 queued/running，`cancel_requested` 优先跳过，release 不触碰 runs；控制字段与策略 revision/version 分离。

## 疑点

- 无阻塞疑点。更广泛的 HTTP/UI 与 worker 停止消费由后续 Task 12/13 负责，未纳入本切片。
