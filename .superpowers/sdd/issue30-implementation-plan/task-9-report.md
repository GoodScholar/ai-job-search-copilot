# Task 9 / Slice 8 实施报告

基线：`4473524`。本 Slice 未推送、未创建 PR、未合并。

## TDD 提交

| Red → Green | 串行 Red 命令与真实失败原因 |
| --- | --- |
| `b48d101` → `3aa3a41` | `pnpm --filter worker exec vitest run src/agent-runs/agent-run.module.test.ts --no-file-parallelism`：production 仍选旧 Fake。 |
| `5c43167` → `e8ca47c` | `DOCKER_API_VERSION=1.51 pnpm --filter domain exec vitest run src/agent-run-control.integration.test.ts --no-file-parallelism`：run 未冻结 v4 profile/watchlist/query snapshot。 |
| `8cde986` → `8f393c6` | `pnpm --filter worker exec vitest run src/agent-runs/job-discovery-adapter-resolver.test.ts --no-file-parallelism`：resolver 不接受冻结 v4 workflow。 |
| `564cf0e` → `28c7630` | `DOCKER_API_VERSION=1.51 pnpm --filter domain exec vitest run src/agent-run-processor.integration.test.ts --no-file-parallelism`：trusted v4 缺 claim-bound persistence bridge。 |
| `a6081e5` → `2ff3e46` | `pnpm --filter worker exec vitest run src/agent-runs/agent-run.module.test.ts --no-file-parallelism`：module 未暴露/注入 v4 resolver。 |
| `473bfd2` → `6d4fbac` | `DOCKER_API_VERSION=1.51 pnpm --filter domain exec vitest run src/job-discovery-schedules.integration.test.ts --no-file-parallelism`：无 Watchlist 的 v4 schedule 被拒绝。 |
| `c25aab2` → `1081d99` | `DOCKER_API_VERSION=1.51 pnpm --filter domain exec vitest run src/agent-run-processor.integration.test.ts --no-file-parallelism`：trusted runtime wrapper 未持久化/归因。 |
| `c70dfe2` → `10b874c` | `pnpm --filter worker exec vitest run src/agent-runs/minio-verified-job-evidence-store.test.ts src/agent-runs/greenhouse-trusted-source-adapter.test.ts src/agent-runs/agent-run.module.test.ts --no-file-parallelism`：production ports、MinIO evidence store、v4 processor injection 缺失。 |
| `e33db6b`/`4932852`/`ab0fa0d` → `6c368e2` | 串行 Red 命令依次为：`pnpm --filter api exec vitest run src/agent-runs/agent-runs.module.test.ts --no-file-parallelism`；`pnpm --filter worker exec vitest run src/agent-runs/agent-run.module.test.ts src/agent-runs/greenhouse-trusted-source-adapter.test.ts --no-file-parallelism`；`DOCKER_API_VERSION=1.51 pnpm --filter domain exec vitest run src/agent-run-processor.integration.test.ts --no-file-parallelism`；`DOCKER_API_VERSION=1.51 pnpm --filter domain exec vitest run src/job-discovery-schedules.integration.test.ts --no-file-parallelism`；`DOCKER_API_VERSION=1.51 pnpm --filter domain exec vitest run src/layered-public-job-discovery-workflow.test.ts --no-file-parallelism`。Red 分别暴露 strict config/生产 runtime、Greenhouse retry 与 owner object key、schedule/profile 语义，以及进程重建 pending Lead capability recovery 缺口；live search 变为 clean-zero 时旧实现确实返回 `clean_zero`。 |
| `5cf376f` → `0fab034` | `DOCKER_API_VERSION=1.51 pnpm --filter domain exec vitest run src/job-discovery-persistence.integration.test.ts --no-file-parallelism`：legacy insert 显式绑定两个 v4 `null` snapshot，SQL 参数为 34 而非 32。 |
| `91cf491` → `ae872e7` | 串行 Red 命令为：`pnpm --filter api exec vitest run src/agent-runs/agent-runs.module.test.ts --no-file-parallelism`；`pnpm --filter worker exec vitest run src/agent-runs/agent-run.module.test.ts --no-file-parallelism`。Red 表明 API/Worker 对称缺口：production/local 未拒绝 legacy E2E scenario，test 空白 source-health scenario 错选 greenhouse，malformed scenario 未返回稳定脱敏常量。 |
| `30f8a77` → `96224fc` | `pnpm --filter api exec vitest run src/agent-runs/agent-runs.module.test.ts --no-file-parallelism`：7 个 malformed/非法 E2E scenario 未被 API shared validator 拒绝；`pnpm --filter worker exec vitest run src/agent-runs/agent-run.module.test.ts src/agent-runs/job-discovery-adapter-resolver.test.ts --no-file-parallelism`：14 个 legacy/v3/v4 入口只解析各自 raw env，未共同拒绝另一 scenario map。 |

此前误启动的两套并发测试 PID（`83635/83658/83664` 与 `83796/83797/83819/83826`）以及后续两套重复 Worker full test（`93851/93872/93878` 与 `94078/94099/94107`）的证据全部作废；不以其结果作任何验收结论。其余 focused 与 domain 命令均按单进程串行运行。

## Runtime matrix

| 环境 | 允许配置 | execution mode |
| --- | --- | --- |
| production | 不允许 `PUBLIC_JOB_DISCOVERY_ADAPTER`、E2E scenario 或 provider/base override | `layered_public` |
| local | 仅 `PUBLIC_JOB_DISCOVERY_ADAPTER=greenhouse` 可选 v3 | `fake` / `greenhouse` |
| test | E2E scenario 与 transport/base 注入仅此处允许 | `fake` / `greenhouse` |

未知值、production fake/greenhouse、非 test 的 `E2E_AGENT_RUN_SCENARIOS`/`E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS`/provider base override 均稳定抛出 `JOB_DISCOVERY_RUNTIME_CONFIG_INVALID`，错误不包含配置值或 key；test 中空白 scenario 视为未配置。

## 关键边界

- pending Lead 恢复由 domain repository 以 owner/run/query/fingerprint/lead/claim/expiry 校验；Worker 仅在一次 extract 内取得布尔授权闭包，不能持有 repository 或跨进程 Map capability。
- AnySearch key 缺失不 checkpoint、不传输；可信 Greenhouse 成功仍可完成为带 source issue 的终态。
- v4 无 Watchlist 对 UI 报告 `executable: 0`，但 profile 缺失拒绝启用并在补全后可重试；既有 v3 Greenhouse 语义未改。
- Greenhouse v4 adapter 使用 `retry: "none"`；run attempt 仍是唯一重试权威。trusted 原始对象在 `accounts/{userId}/agent-runs/...` 下。

## 串行验证

- 早期 Slice focused 证据（旧阶段，非 Round 2 最终计数）：Worker 22 tests；API 7 tests；heartbeat 单例复现 1/1；Domain workflow/schedule/processor/Lead 94 tests、Lead repository integration 10 tests；Web 16 tests、Contracts 3 tests。
- Round 2 最终 focused 证据：API module 15/15；Worker module + resolver 40/40；Domain 12/12。
- Round 3：`pnpm --filter domain exec vitest run src/job-discovery-execution-mode.test.ts --no-file-parallelism` 为 1/1；`pnpm --filter api exec vitest run src/agent-runs/agent-runs.module.test.ts --no-file-parallelism` 为 22/22；`pnpm --filter worker exec vitest run src/agent-runs/agent-run.module.test.ts src/agent-runs/job-discovery-adapter-resolver.test.ts --no-file-parallelism` 为 54/54。
- 已执行 typecheck：`pnpm --filter contracts typecheck`、`pnpm --filter database typecheck`、`pnpm --filter domain typecheck`、`pnpm --filter source-access typecheck`、`pnpm --filter api typecheck`、`pnpm --filter worker typecheck`、`pnpm --filter web typecheck`；均通过。
- Round 3 相关 typecheck 严格串行命令：`pnpm --filter contracts typecheck && pnpm --filter domain typecheck && pnpm --filter source-access typecheck && pnpm --filter api typecheck && pnpm --filter worker typecheck`；均通过。`git diff --check` 亦通过。

第一次带日志全包链 `/tmp/issue30-slice8-acceptance.log` 因 Worker heartbeat Redis Testcontainers 端口绑定 10 秒超时停止：21/22 files、269 passed、1 skipped，exit 1；不增加 timeout。Docker 只读证据为 Docker Desktop 29.5.2、overlayfs、无遗留容器；单例 heartbeat 以 `DOCKER_API_VERSION=1.51` 复现通过。随后新的 Worker full 日志 `/tmp/issue30-worker-full.log` 通过 22/22 files、270/270 tests（90.19s）。

后续链 `/tmp/issue30-slice8-rest-acceptance.log` 通过：API 13/13 files、138/138 tests；Web 55/55 files、289/289 tests；Database 3/3 files、28/28 tests。Drizzle `check` 为 `Everything's fine`；`git diff --check 3a1a394..HEAD` 通过。

首个 Domain full `/tmp/issue30-slice8-domain.log` 为 27/28 files、347/348 tests，唯一失败是 `job-discovery-persistence.integration.test.ts` 的常数 SQL 参数断言（`34 > 32`）。固定基线 detached worktree `3a1a394` 的同一 focused 命令为 1/1 files、39/39 tests 通过，因此按门禁继续诊断而非标记既有失败。诊断确认测量窗口的最大 SQL 是 legacy Greenhouse `agent_runs` insert：v4 新增的 `profile_snapshot` 与 `watchlist_snapshot` 被显式绑定为两个 `null` 参数。Red `5cf376f` 固化 legacy insert 必须使用两列 `default` 的 SQL shape；Green `0fab034` 仅在 layered v4 run 写入这两列，保持旧 run 数据库默认 `NULL`、事务/owner/claim 语义不变。修复后 focused 39/39、Domain full `/tmp/issue30-slice8-domain-after-sql-fix.log` 28/28 files、348/348 tests 均通过。
