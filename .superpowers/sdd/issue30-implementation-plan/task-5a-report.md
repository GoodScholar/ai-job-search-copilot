# Task 5a：Worker teardown flaky 修复报告

## 已确认的生命周期问题（非唯一根因结论）

第一轮确认了 Career consumer 与 heartbeat 的长期连接必须由 Nest lifecycle 释放，但独立 `useValue` context 断言不能证明生产 factory 拓扑的关闭顺序。

复审进一步确认以下可稳定复现的独立条件：

- Nest 11 对同一 module 的 provider destroy hook 使用并发 `Promise.all`。CareerImportModule 原先把 consumer 和 database 分别作为 hook owner，因此 database 可以在活跃 consumer 完全关闭前开始 `$client.end()`；
- Career worker close、Redis quit 或 heartbeat quit 发生 pending/reject 时没有有界 deadline 和 disconnect fallback，可能永久阻塞或遗留 Redis 连接。

## 真实 Red → Green

Round 1 使用真实 `CareerImportModule` 的 `useFactory` provider wiring，并把底层 BullMQ、Redis 与 database client 替换为可观测 double：

- Red：在 worker close gate 未释放时，旧拓扑记录 `database-start` 与 `consumer-start` 并发；worker/quit pending 在 5 秒后仍未进入 fallback，拒绝会让 close reject；
- Green：CareerImportModule 成为唯一 production lifecycle owner，明确按 consumer → database 收敛；consumer provider 与 WorkerDatabase 不再各自注册 destroy hook。Career/heartbeat 在 deadline 或 reject 后继续 Redis cleanup，最终 disconnect，并由同一 `closePromise` 保证重复调用不启动第二轮。

没有增加 Vitest hook timeout、任意真实 sleep、活跃容器手工清理或 AnySearch 产品改动。deadline 后的 catch 只在 Redis 已 quit 或已 disconnect 后返回，避免遗留活跃连接。

## 已完成验证与历史 full 证据

- Round 1：`pnpm --filter worker typecheck`、`git diff --check` 通过；focused lifecycle 为 2 个文件、5/5（0.53 秒）；
- 曾有连续两次 fresh Worker full 通过：临时 lifecycle 文件版为 20/20、250/250、87.72 秒；整理回既有文件后为 18/18、250/250、87.65 秒；
- 这些 happy-path 结果不证明上述 owner issue 是 afterAll timeout 的唯一根因，也不代表当前 baseline 已完全确定性。

## Round 2 验证与诊断记录

Round 2 的 scoped lifecycle Red → Green、typecheck 与 diff check 已通过：2 个文件、8/8 测试通过（0.51 秒）。WorkerDatabase 使用 postgres-js `end({ timeout: 5 })`，这是数据库 driver 的强制释放边界；consumer 与 database 发生同步/异步 close failure 时，module 仍在 finally 中尝试 database cleanup，并稳定收敛。

Round 2 首次 fresh Worker full 仍复现原 afterAll 问题：19/20 文件通过、256/256 业务测试通过、146.36 秒，唯一失败为 `src/agent-runs/agent-run.integration.test.ts:138` 的 60 秒 hook timeout。因此最终 fresh acceptance 仍待后续重新执行。

随后一次仅诊断的 fresh full 带临时 stderr 阶段标记，未进入原 afterAll timeout，而是在 `beforeAll` 发生独立的 Testcontainer 端口绑定失败：

- 发生阶段：`src/agent-runs/agent-run.integration.test.ts` 的 `beforeAll`，PostgreSQL container 启动后，`RedisContainer("redis:7-alpine").start()` 等待端口绑定；
- 精确错误：`Timed out after 10000ms while waiting for container ports to be bound to the host`；
- 堆栈：`inspectContainerUntilPortsExposed` → `IntervalRetry.retryUntil` → `RedisContainer.startContainer` → `RedisContainer.start` → `agent-run.integration.test.ts:89`；
- 结果：19/20 文件通过，247 通过、9 个 AgentRun 测试跳过，26.93 秒；不是业务断言或 teardown hook timeout；
- 临时标记显示本次 afterAll 已执行至 `context.close`、`queue.close`、`queueRedis.quit`、`database.end`、MinIO/Redis/PostgreSQL container stop 的全部 start/done；标记已撤销且不会提交；
- 监督只读观察：Docker client/server 均为 29.5.2；当前没有活跃测试容器，仅发现一个约 5 天前的无关 exited MySQL 容器，未作任何清理。

该次环境启动失败不用于推断或掩盖原 teardown flaky；临时标记已全部撤销。Round 2 数据库 deadline/finally fix 已基于 focused 验证提交，但最终 fresh acceptance 仍待后续重新执行。

## 最终 fresh acceptance

在 HEAD `215204858cca88c42593732e095383b9055e32e4`、clean worktree、无并发测试进程且未手工清理 Docker/Testcontainers 资源的固定环境中，串行执行：

`DOCKER_API_VERSION=1.51 pnpm --filter worker test`

结果为 **20/20 test files、256/256 tests passed**，退出码 0，Vitest duration 87.01 秒。原 `agent-run.integration.test.ts` afterAll timeout 与独立 Redis Testcontainer 端口绑定失败均未复现；本次结果作为 Task 5a 最终 full 验收证据，但不改写前述历史诊断边界。

## 提交

第一轮实现提交：`24c9c7c5ce51ad67fb9b16ee228174982d1f6014`（`fix(worker): close lifecycle-owned resources`）。

Round 1 修复提交：`31894f5cc10e8b80591c61c9188334b49dbba1a0`（`fix(worker): serialize career import teardown`）。

Round 2 修复提交：`8e061f4c1916eca2140f139703c13bd5d741a57c`（`fix(worker): bound career database teardown`）。
