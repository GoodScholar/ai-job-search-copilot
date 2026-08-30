# Task 5a：Worker teardown flaky 修复报告

## 根因

`AppModule` 中有两个 factory provider 持有长期连接，但没有实现 Nest 的 `OnModuleDestroy`：

- `CareerImportConsumer` 持有 BullMQ `Worker` 与其 Redis 连接；
- `RedisHeartbeatAdapter` 持有 heartbeat Redis 连接。

因此 `ApplicationContext.close()` 不会调用它们的 `close()`，在重复创建/关闭 Worker context 的 suite 中遗留连接与 consumer。两者的关闭方法也没有共享同一个 close promise，不能保证并发/重复关闭只触发一次底层操作。

## 真实 Red → Green

先在现有 integration 文件中添加仅使用资源状态 double 的生命周期断言：由 Nest factory provider 承载实例、两次调用 `context.close()` 后，Career consumer 必须按 `worker → redis` 释放一次，heartbeat 必须释放 Redis 一次。

- Red：当前基线分别得到 `expected [] to deeply equal ["worker", "redis"]` 和 `expected [] to deeply equal ["redis"]`；证明 Nest 未调用 owner close。
- Green：两者实现 `OnModuleDestroy`，并以 `closePromise` 复用首次关闭；上述 focused lifecycle 测试 2/2 通过。

没有增加 hook timeout、任意 sleep、活跃容器手工清理或吞掉 teardown 错误；未修改 Issue #30 产品逻辑。

## 验证

- `pnpm --filter worker typecheck`：通过。
- focused lifecycle：2 个文件、2/2 通过（4.78 秒）。
- fresh full：`DOCKER_API_VERSION=1.51 pnpm --filter worker test`，18/18 文件、250/250 测试通过，87.65 秒。
- `git diff --check`：通过。

## 提交

待本次变更提交后补充。
