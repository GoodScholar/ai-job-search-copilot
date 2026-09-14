# Task 7 HTTP 验收报告

状态：DONE（仅代表本 HTTP 子段；Task7 整体仍待 root 独立审查）

## 实现与边界

- 新增 `apps/api/src/recommendation-runs/recommendation-runs.module.test.ts`，真实启动 RecommendationRunsModule 与 RecommendationsModule，并经 `app.inject` 验证实际 HTTP。
- 保留真实 `SessionGuard`，只覆盖其调用的 `ACCOUNT_SESSIONS` 服务；同样保留真实路由、Zod pipe/serializer、异常过滤器和应用配置。数据库、队列与领域 command/query ports 为受控替身，避免外部队列与网络。
- RED 暴露 RecommendationsModule 的 exact-list 401/404 无 `Cache-Control: no-store`；最小生产修复仅在该 module 对 RecommendationsController 路由加 no-store middleware。

## 结果

- `task-7-http-red.log`：exit 1，`cache-control` 为 undefined，预期 no-store。
- `task-7-http-green.log`：5 tests，exit 0。
- `task-7-http-exact-list-success-red.log`：exit 1，严格合法 list 期望 200 而受控 query null 返回 404。
- `task-7-http-exact-list-success-green.log`：5 tests，exit 0。
- `task-7-complete-final-api.log`：3 files / 11 tests，exit 0。
- `task-7-http-postcommit-diffcheck.log`：最终 `bb245cb..HEAD` 的 `git diff --check`，exit 0。

覆盖：静态 latest-result 匹配；preparation/latest/latest-result 成功；start 201/200/严格 400；owner-hidden 404；control 200、状态冲突和 command-id 冲突 409、账户停止 409；blocked/warning report 投影；401/成功/400/404/409/500 no-store；未知异常不泄露 sentinel；exact-list 的成功 200、owner/target/list 传递、受控错配 404、无 latest fallback、401 和 no-store。

## 限制

这是模块 HTTP 验收，不是数据库 E2E。exact-list 的错配通过受控 `getList -> null` 表示，测试明确不冒称它验证真实数据库所有权查询；该读取层由既有 domain integration tests 覆盖。
