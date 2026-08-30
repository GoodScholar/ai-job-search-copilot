# Task 5a：Worker teardown flaky 修复报告

## 根因

第一轮确认了 Career consumer 与 heartbeat 的长期连接必须由 Nest lifecycle 释放，但独立 `useValue` context 断言不能证明生产 factory 拓扑的关闭顺序。

复审进一步确认两个独立条件：

- Nest 11 对同一 module 的 provider destroy hook 使用并发 `Promise.all`。CareerImportModule 原先把 consumer 和 database 分别作为 hook owner，因此 database 可以在活跃 consumer 完全关闭前开始 `$client.end()`；
- Career worker close、Redis quit 或 heartbeat quit 发生 pending/reject 时没有有界 deadline 和 disconnect fallback，可能永久阻塞或遗留 Redis 连接。

## 真实 Red → Green

Round 1 使用真实 `CareerImportModule` 的 `useFactory` provider wiring，并把底层 BullMQ、Redis 与 database client 替换为可观测 double：

- Red：在 worker close gate 未释放时，旧拓扑记录 `database-start` 与 `consumer-start` 并发；worker/quit pending 在 5 秒后仍未进入 fallback，拒绝会让 close reject；
- Green：CareerImportModule 成为唯一 production lifecycle owner，明确按 consumer → database 收敛；consumer provider 与 WorkerDatabase 不再各自注册 destroy hook。Career/heartbeat 在 deadline 或 reject 后继续 Redis cleanup，最终 disconnect，并由同一 `closePromise` 保证重复调用不启动第二轮。

没有增加 Vitest hook timeout、任意真实 sleep、活跃容器手工清理或 AnySearch 产品改动。deadline 后的 catch 只在 Redis 已 quit 或已 disconnect 后返回，避免遗留活跃连接。

## 验证

- `pnpm --filter worker typecheck`：通过。
- focused lifecycle：2 个文件、5/5 通过（0.53 秒）。
- fresh full：`DOCKER_API_VERSION=1.51 pnpm --filter worker test`，20/20 文件、253/253 测试通过，87.09 秒。
- `git diff --check`：通过。

## 提交

第一轮实现提交：`24c9c7c5ce51ad67fb9b16ee228174982d1f6014`（`fix(worker): close lifecycle-owned resources`）。

Round 1 修复提交：`31894f5cc10e8b80591c61c9188334b49dbba1a0`（`fix(worker): serialize career import teardown`）。
