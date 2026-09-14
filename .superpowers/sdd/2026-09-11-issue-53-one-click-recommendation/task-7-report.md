# Task 7 report

状态：DONE（HTTP 验收已补齐；等待 root 基于 `bb245cb..HEAD` 的独立双轴审查）

## 实现

- `packages/domain/src/recommendation-runs.ts`：新增账户锁事务内的 `latestPublished`，按 owner-bound result 的 `createdAt DESC, id DESC` 选择 root 并使用同事务私有投影；不改变 `latest`。
- `apps/api/src/recommendation-runs/`：认证 preparation/start/latest/latest-result/get/control 边界；复用 `RECOMMENDATION_RUN_COMMANDS`，所有模块响应（含 guard 拒绝）使用 `Cache-Control: no-store`。
- `apps/web/app/api/recommendation-runs/` 与 `apps/web/lib/server/api-client.ts`：同源 BFF、严格命令/响应解析和安全错误折叠。
- `packages/domain/src/recommendation-queries.ts` 与 recommendations API/BFF：按 owner + target + list id 精确读取，不回退 latest；Recommendations API module 现对 controller 路由统一设置 `Cache-Control: no-store`。

## RED / GREEN 证据

- 无实现探测 RED（不计业务 RED）：`task-7-domain-latest-published-red.log`，exit 1，`latestPublished is not a function`。
- 业务 RED：`task-7-domain-latest-published-business-red.log`，exit 1；最小 null 实现未能返回已发布 root。
- 领域 GREEN：`task-7-domain-latest-published-green.log`、`task-7-domain-final.log`，exit 0。
- API 旧窄 GREEN：`task-7-api-controller-green.log`、`task-7-exact-list-api-green.log`、`task-7-api-final.log`，exit 0；其 controller 级结果不替代下列真实模块 HTTP 验收。
- Web GREEN：`task-7-web-start-green.log`、`task-7-exact-list-bff-green.log`、`task-7-api-client-green.log`、`task-7-web-final.log`，exit 0。
- 类型检查：`task-7-domain-typecheck.log`、`task-7-api-typecheck-green.log`、`task-7-web-typecheck.log`，均 exit 0。

所有日志的绝对目录：`/Users/shen/.codex/worktrees/ae6c/AI Job Search Copilot/.superpowers/sdd/2026-09-11-issue-53-one-click-recommendation/test-logs/`。

## HTTP 验收补充（真实 NestFastify 模块）

- 新增 `apps/api/src/recommendation-runs/recommendation-runs.module.test.ts`：以 `Test.createTestingModule`、真实 `RecommendationRunsModule` / `RecommendationsModule`、`NestFastifyApplication`、`configureApiApplication`、应用的 Zod pipe/serializer/filter 与真实 `SessionGuard` 启动，再通过 `app.inject` 断言 HTTP 合约。
- 可替换边界仅为 `ACCOUNT_SESSIONS`（让真实 guard 认证受控 token）、数据库、队列和领域 command/query ports；没有覆盖 guard。模块导入、路由装配、静态/动态匹配、认证、Zod、serializer、filter 与 middleware 均为真实实现。
- `task-7-http-red.log`：exit 1；精确清单路由的 404/401 缺 `Cache-Control: no-store`。最小修复为 `RecommendationsModule` 对自身 controller 路由设置该头。
- `task-7-http-green.log`：exit 0，5 个 HTTP 测试通过。`task-7-http-exact-list-success-red.log`：exit 1，合法清单期望 200 时受控查询端口返回 null 导致 404；`task-7-http-exact-list-success-green.log`：exit 0，补齐严格合法 fixture 后通过。

## 真实 AC 矩阵

| 验收点 | 实际证据 |
| --- | --- |
| `latestPublished` owner-bound 读取与最新 root 语义 | `task-7-complete-final-domain.log`，34/34，exit 0 |
| 真实 RecommendationRuns 模块、静态 preparation/latest/latest-result 路由和动态 `:runId` 顺序 | module HTTP test，成功 200 且 `latest-result` 返回严格 run 响应 |
| start 首建 201、复用 200、额外 `userId`/`targetId` 400 且 command 不执行 | module HTTP test，真实 HTTP 状态/响应与命令计数断言 |
| owner-hidden 404；control 200、状态冲突/command-id 冲突/账户停止 409；blocked/warning 最新报告 | module HTTP test，全部响应同时断言安全 code/中文文案或合法 preflight |
| 401、成功、400/404/409/未知 500 的 `no-store`，未知异常不反射 sentinel | module HTTP test；未知错误为 `INTERNAL_ERROR` / `服务暂时不可用` |
| exact-list owner/target/list 三元传递、合法 200、错配 404、无 latest fallback、401 与缓存头 | module HTTP test；`getLatestList` 是会抛错的哨兵，错配来自受控 `getList -> null` |
| 六个 recommendation BFF、exact-list BFF 与 server api client | `task-7-complete-final-web.log`，8 files / 55 tests，exit 0 |

## 最终串行回归

- `task-7-complete-final-domain.log`：`recommendation-runs.integration.test.ts`，1 file / 34 tests，exit 0。
- `task-7-complete-final-api.log`：RecommendationRuns controller/module 与 Recommendations controller，3 files / 11 tests，exit 0。
- `task-7-complete-final-web.log`：Task7 的 six recommendation BFF、exact-list BFF 与 api-client，8 files / 55 tests，exit 0。
- `task-7-complete-final-domain-typecheck.log`、`task-7-complete-final-api-typecheck.log`、`task-7-complete-final-web-typecheck.log`：三包 typecheck，均 exit 0。
- `task-7-complete-final-diffcheck.log`：回归前的 `bb245cb..HEAD` 与工作树 `git diff --check`，均 exit 0；`task-7-http-postcommit-diffcheck.log`：最终 `bb245cb..HEAD`，exit 0。

所有日志目录：`/Users/shen/.codex/worktrees/ae6c/AI Job Search Copilot/.superpowers/sdd/2026-09-11-issue-53-one-click-recommendation/test-logs/`。

## 限制

- HTTP module test 是受控领域端口验收，不主张它是数据库 E2E；真实 `SessionGuard` 仍走受控会话服务。
- exact-list 的错配 404 来自受控领域 `getList` 返回 null，并验证 API 不调用 `getLatestList`；owner/target 的真实数据库读取隔离由既有 domain integration tests 覆盖。
