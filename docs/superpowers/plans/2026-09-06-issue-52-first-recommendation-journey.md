# Issue #52 First Recommendation Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在求职工作台交付由权威领域状态动态推导、可跨设备恢复且在首个可信推荐结果后永久完成的首次推荐旅程。

**Architecture:** 新增一个深的首次推荐旅程领域模块，把动态投影、交互状态更新和永久完成记录藏在三个小接口后；工作台首页只消费投影，可信推荐发布器只调用内部完成接口。可变交互与不可变完成事实分表，统一运行前检查继续是画像、目标、来源、模型和策略就绪性的唯一判定来源。

**Tech Stack:** TypeScript、Zod、Drizzle ORM、PostgreSQL 17、NestJS/Fastify、Next.js 16 App Router、React 19、Vitest、Testing Library、Playwright、Axe。

**Spec:** `docs/superpowers/specs/2026-09-06-issue-52-first-recommendation-journey-design.md`

## Global Constraints

- 不保存会与真实领域状态漂移的步骤完成布尔值。
- 只持久化提示关闭、最后访问步骤和首个可信结果形成的不可变完成事实。
- 历史非空推荐清单追溯完成、历史空清单保持未完成是待用户确认假设；若否决，只删除迁移回填 SQL 与对应断言。
- 普通空数组、失败运行、未发布结果和关闭提示都不能完成旅程。
- 完成后条件退化只形成现有维护事项，不重新打开首次旅程。
- #53 的一键推荐编排与完整“暂无推荐”证据不在本 Issue 实现；本 Issue 只提供可信发布器可复用的内部完成接口。
- 使用 `CONTEXT.md` 的领域词汇和结果导向中文，不向页面暴露 Agent、队列、Adapter、API Key 或数据库术语。
- 工作台保持响应式、键盘可达、可见焦点、44px 触控目标、非颜色唯一状态和 `prefers-reduced-motion`。
- Supervisor 与 Executor 不得并发运行相同或重叠测试；所有验收命令单进程串行执行并保留完整日志。

---

### Task 1: 定义首次推荐旅程契约

**Files:**
- Modify: `packages/contracts/src/workbench.ts`
- Create: `packages/contracts/src/workbench.test.ts`

**Interfaces:**
- Produces: `FirstRecommendationJourneyStepIdSchema`、`FirstRecommendationJourneySchema`、`FirstRecommendationJourneyInteractionCommandSchema`、`FirstRecommendationJourneyInteractionSchema` 及对应类型。
- Consumes: 现有 `WorkbenchHomeSchema`；不引入数据库或 Web 类型。

- [ ] **Step 1: 写严格契约红测**

  覆盖六个稳定步骤 ID、四种步骤状态、`active|dismissed|completed` 旅程状态、严格中文展示字段、站内 `href`、`currentStepId` 一致性、`visit_step|dismiss` 判别命令、非负 `expectedVersion`、未知字段拒绝，以及 `WorkbenchHomeSchema` 必须包含 `firstRecommendationJourney`。

  核心样例：

  ```ts
  const firstStep = {
    id: "career_materials",
    title: "准备可用职业资料",
    status: "needs_action",
    stateLabel: "需要处理",
    impact: "系统需要从真实职业资料建立可追溯来源。",
    action: { label: "导入职业资料", href: "/profile" },
  };
  expect(FirstRecommendationJourneyStepSchema.parse(firstStep)).toEqual(firstStep);
  expect(() => FirstRecommendationJourneyInteractionCommandSchema.parse({
    action: "visit_step", stepId: "career_materials", expectedVersion: 0, userId: crypto.randomUUID(),
  })).toThrow();
  ```

- [ ] **Step 2: 运行契约测试确认失败**

  Run: `pnpm --filter @job-copilot/contracts exec vitest run src/workbench.test.ts src/contracts.test.ts`

  Expected: FAIL，缺少首次推荐旅程 schema 或首页字段。

- [ ] **Step 3: 实现最小严格 schema**

  `FirstRecommendationJourneySchema` 使用判别联合：`completed` 分支要求 `steps: []`、`currentStepId: null`、非空 `completedAt`；`active|dismissed` 分支要求六个按固定顺序且 ID 唯一的步骤。命令定义为：

  ```ts
  export const FirstRecommendationJourneyInteractionCommandSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("visit_step"), stepId: FirstRecommendationJourneyStepIdSchema, expectedVersion: z.int().nonnegative() }).strict(),
    z.object({ action: z.literal("dismiss"), expectedVersion: z.int().nonnegative() }).strict(),
  ]);
  ```

- [ ] **Step 4: 运行契约测试确认通过**

  Run: `pnpm --filter @job-copilot/contracts exec vitest run src/workbench.test.ts src/contracts.test.ts && pnpm --filter @job-copilot/contracts typecheck`

  Expected: PASS。

- [ ] **Step 5: 提交契约切片**

  ```bash
  git add packages/contracts/src/workbench.ts packages/contracts/src/workbench.test.ts
  git commit -m "feat: define first recommendation journey contract (#52)"
  ```

### Task 2: 持久化可变交互与不可变完成事实

**Files:**
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/migrate.integration.test.ts`
- Create: `packages/database/migrations/0048_first_recommendation_journey.sql`
- Modify: `packages/database/migrations/meta/_journal.json`
- Create: `packages/database/migrations/meta/0048_snapshot.json`

**Interfaces:**
- Produces: `firstRecommendationJourneyInteractions` 与 `firstRecommendationJourneyCompletions` Drizzle 表。
- Consumes: `jobAccounts`、`recommendationLists`、`recommendationListItems`。

- [ ] **Step 1: 写迁移与约束红测**

  在迁移测试中先只应用到 0047，插入三个账户：账户 A 有历史非空推荐清单，账户 B 有历史空清单，账户 C 无清单；再应用 0048 并断言：

  ```ts
  expect(await completionFor(accountA)).toMatchObject({ resultKind: "recommendation_list", resultId: nonEmptyListId });
  expect(await completionFor(accountB)).toBeNull();
  expect(await completionFor(accountC)).toBeNull();
  await expect(client.query("update first_recommendation_journey_completions set completed_at = now() where user_id = $1", [accountA]))
    .rejects.toThrow(/FIRST_RECOMMENDATION_JOURNEY_COMPLETION_IMMUTABLE/u);
  await expect(client.query("delete from first_recommendation_journey_completions where user_id = $1", [accountA]))
    .rejects.toThrow(/FIRST_RECOMMENDATION_JOURNEY_COMPLETION_IMMUTABLE/u);
  ```

  同时测试交互版本非负、步骤枚举、完成类型枚举、账户所有权和每账户唯一完成事实。

- [ ] **Step 2: 运行迁移测试确认失败**

  Run: `pnpm --filter @job-copilot/database exec vitest run src/migrate.integration.test.ts --no-file-parallelism`

  Expected: FAIL，0048 或新表不存在。

- [ ] **Step 3: 增加 Drizzle 表并生成迁移骨架**

  ```bash
  pnpm --filter @job-copilot/database exec drizzle-kit generate --config=drizzle.config.ts --name first_recommendation_journey
  ```

  将生成文件稳定命名为 `0048_first_recommendation_journey.sql`，保留生成的 journal/snapshot；表约束必须与契约枚举一致。

- [ ] **Step 4: 在迁移中加入不可变触发器与历史回填**

  回填只选择每账户最早的非空清单：

  ```sql
  insert into first_recommendation_journey_completions (user_id, result_kind, result_id, completed_at)
  select distinct on (lists.user_id)
    lists.user_id, 'recommendation_list', lists.id, lists.created_at
  from recommendation_lists as lists
  where exists (
    select 1 from recommendation_list_items as items
    where items.user_id = lists.user_id and items.recommendation_list_id = lists.id
  )
  order by lists.user_id, lists.created_at, lists.sequence, lists.id;
  ```

  创建 `reject_first_recommendation_journey_completion_mutation()`，在完成表 `BEFORE UPDATE OR DELETE` 抛出 `FIRST_RECOMMENDATION_JOURNEY_COMPLETION_IMMUTABLE`。

- [ ] **Step 5: 运行数据库验证**

  Run: `pnpm --filter @job-copilot/database exec vitest run src/migrate.integration.test.ts --no-file-parallelism && pnpm --filter @job-copilot/database typecheck`

  Expected: PASS。

- [ ] **Step 6: 提交数据库切片**

  ```bash
  git add packages/database/src/schema.ts packages/database/src/migrate.integration.test.ts packages/database/migrations
  git commit -m "feat: persist first recommendation journey state (#52)"
  ```

### Task 3: 实现动态旅程投影与交互命令

**Files:**
- Create: `packages/domain/src/first-recommendation-journey.ts`
- Create: `packages/domain/src/first-recommendation-journey.integration.test.ts`
- Modify: `packages/domain/package.json`
- Modify: `packages/domain/src/workbench-home.ts`
- Modify: `packages/domain/src/workbench-home.integration.test.ts`

**Interfaces:**
- Consumes: `RunPreflightEvaluator`、`careerImports`、`agentRuns`、两张旅程表，以及 Task 1 契约。
- Produces: `createFirstRecommendationJourneyReader`、`createFirstRecommendationJourneyCommands`、`recordFirstRecommendationJourneyCompletion`；扩展 `createWorkbenchHome` 以注入 reader 并返回旅程投影。

- [ ] **Step 1: 写领域投影红测**

  使用真实 PostgreSQL 与确定性运行前检查 Adapter，逐次建立状态并断言：

  - 空账户当前步骤为 `career_materials`。
  - `queued|processing` 导入显示 `in_progress`；失败导入不完成；`completed` 导入完成第一步。
  - 当前有效画像证据、活动主求职目标和至少一个可执行启用来源分别完成对应步骤。
  - 来源部分能力不足但 `capableSourceCount > 0` 时来源步骤完成，运行前检查警告保留在就绪步骤影响中。
  - 模型或策略阻塞使 `run_readiness` 为 `needs_action`，入口由建议动作白名单映射。
  - 活动运行使 `first_result` 为 `in_progress`；失败运行不完成。
  - 普通空推荐清单不完成；只有内部完成接口记录的可信结果完成。
  - 完成后删除画像事实、停用目标和来源仍返回 `completed`。
  - 其他账户状态不能影响当前账户。

- [ ] **Step 2: 写交互与并发红测**

  断言缺省版本 0；访问步骤后版本 1 且刷新恢复；关闭后版本 2 且状态为 `dismissed`；陈旧版本返回 `VERSION_CONFLICT`；完成插入并发调用只保留第一个 `resultId`；完成表不可变错误不能被模块吞掉。

- [ ] **Step 3: 运行领域红测**

  Run: `pnpm --filter @job-copilot/domain exec vitest run src/first-recommendation-journey.integration.test.ts src/workbench-home.integration.test.ts --no-file-parallelism`

  Expected: FAIL，领域模块和首页字段不存在。

- [ ] **Step 4: 实现深模块**

  保持三条小接口；内部用 `RunPreflightEvaluator.evaluate` 计算 `discovery/manual` 报告，用固定函数映射步骤文案和站内入口。`updateInteraction` 在账户存在且未完成时按 `expectedVersion` 插入或更新，只修改命令对应字段。完成接口：

  ```ts
  export async function recordFirstRecommendationJourneyCompletion(
    transaction: Pick<Database, "insert">,
    input: { userId: string; result: { kind: "recommendation_list" | "no_recommendations"; resultId: string }; completedAt: Date },
  ): Promise<void> {
    await transaction.insert(firstRecommendationJourneyCompletions).values({
      userId: input.userId,
      resultKind: input.result.kind,
      resultId: input.result.resultId,
      completedAt: input.completedAt,
    }).onConflictDoNothing({ target: firstRecommendationJourneyCompletions.userId });
  }
  ```

  该函数不由 HTTP 导出；可信发布器负责在自身事务中先完成结果校验和持久化。

- [ ] **Step 5: 把投影接入工作台首页**

  `createWorkbenchHome` 新增 `firstRecommendationJourney` 依赖，与摘要查询并行读取；返回结构由 `WorkbenchHomeSchema.parse` 在领域测试中验证。不要把已有摘要计数改写为旅程状态。

- [ ] **Step 6: 运行领域验证**

  Run: `pnpm --filter @job-copilot/domain exec vitest run src/first-recommendation-journey.integration.test.ts src/workbench-home.integration.test.ts --no-file-parallelism && pnpm --filter @job-copilot/domain typecheck`

  Expected: PASS。

- [ ] **Step 7: 提交领域切片**

  ```bash
  git add packages/domain/package.json packages/domain/src/first-recommendation-journey.ts packages/domain/src/first-recommendation-journey.integration.test.ts packages/domain/src/workbench-home.ts packages/domain/src/workbench-home.integration.test.ts
  git commit -m "feat: derive first recommendation journey (#52)"
  ```

### Task 4: 在可信非空推荐发布事务中冻结完成事实

**Files:**
- Modify: `packages/domain/src/deep-match-persistence.ts`
- Modify: `packages/domain/src/deep-match-persistence.integration.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `recordFirstRecommendationJourneyCompletion`。
- Produces: 非空推荐清单、Inbox、运行完成回调与旅程完成在同一事务中的原子结果。

- [ ] **Step 1: 写发布红测**

  扩展现有原子发布测试：非空 `accepted` 记录 `recommendation_list` 完成；零 `accepted` 即使有空清单或排除记录也不完成；重试发布或并发发布不覆盖首个完成 `resultId`；在 `onPublished` 抛错回滚时清单、Inbox 和完成事实全部不可见。

- [ ] **Step 2: 运行定点红测**

  Run: `pnpm --filter @job-copilot/domain exec vitest run src/deep-match-persistence.integration.test.ts --no-file-parallelism`

  Expected: FAIL，非空发布尚未记录完成。

- [ ] **Step 3: 在发布事务内调用完成接口**

  只在 `accepted.length > 0` 且推荐项目已插入后调用：

  ```ts
  if (accepted.length > 0) {
    await recordFirstRecommendationJourneyCompletion(transaction, {
      userId: input.userId,
      result: { kind: "recommendation_list", resultId: list.id },
      completedAt: deps.clock(),
    });
  }
  ```

  不把 `result.items.length === 0` 解释成可信“暂无推荐”。

- [ ] **Step 4: 运行发布与领域回归**

  Run: `pnpm --filter @job-copilot/domain exec vitest run src/deep-match-persistence.integration.test.ts src/first-recommendation-journey.integration.test.ts --no-file-parallelism && pnpm --filter @job-copilot/domain typecheck`

  Expected: PASS。

- [ ] **Step 5: 提交发布集成切片**

  ```bash
  git add packages/domain/src/deep-match-persistence.ts packages/domain/src/deep-match-persistence.integration.test.ts
  git commit -m "feat: complete journey on trusted recommendations (#52)"
  ```

### Task 5: 暴露认证 API 并保持工作台单一读入口

**Files:**
- Modify: `apps/api/src/workbench/workbench.tokens.ts`
- Modify: `apps/api/src/workbench/workbench.module.ts`
- Modify: `apps/api/src/workbench/workbench.controller.ts`
- Create: `apps/api/src/workbench/workbench.controller.test.ts`
- Modify: `apps/api/src/api.integration.test.ts`
- Modify: `apps/api/src/api-documentation.ts`

**Interfaces:**
- Consumes: Task 1 命令/响应 schema、Task 3 reader/commands、现有 `RUN_PREFLIGHT_EVALUATOR`。
- Produces: `GET /v1/workbench/home` 的旅程投影和 `PUT /v1/workbench/first-recommendation-journey` 交互更新。

- [ ] **Step 1: 写控制器红测**

  覆盖认证账户注入、命令 DTO 严格拒绝 `userId`/未知字段、`visit_step` 与 `dismiss` 转发、401、账户不存在 404、陈旧版本 409、响应 `Cache-Control: no-store` 和 OpenAPI schema。

- [ ] **Step 2: 写真实 API 集成红测**

  两个 Dev Auth 账户分别更新交互，断言账户 A 无法读取或覆盖 B 的状态；重新登录后同一账户读回关闭状态；首页仍只通过 `/v1/workbench/home` 返回摘要与旅程。

- [ ] **Step 3: 运行 API 红测**

  Run: `pnpm --filter api test -- src/workbench/workbench.controller.test.ts src/api.integration.test.ts`

  Expected: FAIL，PUT 接口与依赖注入尚不存在。

- [ ] **Step 4: 接入 Nest 模块与错误映射**

  `WorkbenchModule` 导入 `RunPreflightModule`，注入 `RUN_PREFLIGHT_EVALUATOR` 创建 reader；为 commands 增加独立 token。控制器使用 `createZodDto`，只从 `request.authenticatedAccount.userId` 取 owner。`VERSION_CONFLICT` 延续现有 problem filter 409 语义。

- [ ] **Step 5: 运行 API 验证**

  Run: `pnpm --filter api test -- src/workbench/workbench.controller.test.ts src/api.integration.test.ts && pnpm --filter api typecheck`

  Expected: PASS。

- [ ] **Step 6: 提交 API 切片**

  ```bash
  git add apps/api/src/workbench apps/api/src/api.integration.test.ts apps/api/src/api-documentation.ts
  git commit -m "feat: expose first recommendation journey API (#52)"
  ```

### Task 6: 增加 Web BFF 与服务端契约校验

**Files:**
- Modify: `apps/web/lib/server/api-client.ts`
- Modify: `apps/web/lib/server/api-client.test.ts`
- Modify: `apps/web/lib/server/workbench.ts`
- Modify: `apps/web/lib/server/workbench.test.ts`
- Create: `apps/web/app/api/workbench/first-recommendation-journey/route.ts`
- Create: `apps/web/app/api/workbench/first-recommendation-journey/route.test.ts`

**Interfaces:**
- Consumes: Task 1 的首页、命令和交互响应 schema；Task 5 API。
- Produces: `updateFirstRecommendationJourneyInteraction(sessionToken, command)` 与同源 `PUT /api/workbench/first-recommendation-journey`。

- [ ] **Step 1: 写服务端和 BFF 红测**

  覆盖上游首页旅程严格解析、未知字段拒绝、认证 Cookie 缺失 401、非法 JSON/命令 400、上游 401/404/409 原样收窄转发、其他失败 502、成功响应 `no-store`，且客户端不能注入用户 ID。

- [ ] **Step 2: 运行 Web 服务红测**

  Run: `pnpm --filter web test -- lib/server/api-client.test.ts lib/server/workbench.test.ts app/api/workbench/first-recommendation-journey/route.test.ts`

  Expected: FAIL，新方法和 route 不存在。

- [ ] **Step 3: 实现最小代理**

  BFF 读取 `job_copilot_session`，用 `FirstRecommendationJourneyInteractionCommandSchema.safeParse` 校验请求，再调用 server-only 客户端。任何错误响应不得回显上游原始正文。

- [ ] **Step 4: 运行 Web 服务验证**

  Run: `pnpm --filter web test -- lib/server/api-client.test.ts lib/server/workbench.test.ts app/api/workbench/first-recommendation-journey/route.test.ts && pnpm --filter web typecheck`

  Expected: PASS。

- [ ] **Step 5: 提交 Web 服务切片**

  ```bash
  git add apps/web/lib/server apps/web/app/api/workbench/first-recommendation-journey
  git commit -m "feat: proxy first recommendation journey state (#52)"
  ```

### Task 7: 在工作台呈现可恢复旅程

**Files:**
- Create: `apps/web/components/workbench/first-recommendation-journey.tsx`
- Create: `apps/web/components/workbench/first-recommendation-journey.test.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.test.tsx`
- Modify: `apps/web/app/(workbench)/home/page.tsx`
- Modify: `apps/web/app/(workbench)/home/page.test.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/globals.test.ts`

**Interfaces:**
- Consumes: `home.firstRecommendationJourney` 与 Task 6 BFF。
- Produces: `FirstRecommendationJourneyPanel`，只接收投影和 `onAuthoritativeRefresh`。

- [ ] **Step 1: 写页面与模块红测**

  断言页面把首页旅程原样传给工作台；工作台在导语后、摘要前显示旅程；区域读取失败只显示局部错误。模块测试六个结果导向中文标题、文本状态、影响、当前步骤 `aria-current="step"`、有序列表和白名单入口。

- [ ] **Step 2: 写交互红测**

  使用 `userEvent` 覆盖：

  - 点击入口发送 `{ action: "visit_step", stepId, expectedVersion }`，使用 `keepalive: true`，无论保存成功或失败都保留原始可导航 `href`。
  - 点击“暂时关闭引导”成功后隐藏并宣布状态；409 调用 `router.refresh()`；网络失败保留卡片和可重试中文提示。
  - `dismissed` 或 `completed` 投影不渲染旅程。
  - 动态新 props 到达时清除旧乐观状态，显示权威步骤变化。

- [ ] **Step 3: 运行 UI 红测**

  Run: `pnpm --filter web test -- app/'(workbench)'/home/page.test.tsx components/workbench/first-recommendation-journey.test.tsx components/workbench/workbench-home-view.test.tsx app/globals.test.ts`

  Expected: FAIL，模块和样式不存在。

- [ ] **Step 4: 实现语义化旅程模块**

  使用 `<section>`、`<ol>`、`<li>`、文本状态和真正的 `<Link>`。入口点击只异步记录访问，不阻止链接默认导航；关闭按钮等待 2xx 后隐藏。不要在客户端重新计算步骤完成条件。

- [ ] **Step 5: 增加响应式样式**

  沿用现有 `workbench-ledger`、`workbench-touch-target` 和焦点 token；新增类只负责旅程布局。桌面可使用轨迹列，`max-width: 720px` 以下切成单列；状态同时有文字和图形；不新增动画。

- [ ] **Step 6: 运行 UI 验证**

  Run: `pnpm --filter web test -- app/'(workbench)'/home/page.test.tsx components/workbench/first-recommendation-journey.test.tsx components/workbench/workbench-home-view.test.tsx app/globals.test.ts && pnpm --filter web typecheck && pnpm --filter web lint`

  Expected: PASS。

- [ ] **Step 7: 提交工作台切片**

  ```bash
  git add apps/web/components/workbench apps/web/app/'(workbench)'/home apps/web/app/globals.css apps/web/app/globals.test.ts
  git commit -m "feat: show first recommendation journey (#52)"
  ```

### Task 8: 完成真实 Playwright 旅程与最终验收

**Files:**
- Create: `apps/web/e2e/first-recommendation-journey.spec.ts`
- Modify: `apps/web/playwright.config.ts` only if the existing glob does not already include the new spec.

**Interfaces:**
- Consumes: 正式 Web、API、Worker、PostgreSQL、Redis、MinIO、Fake 模型与 Fake 来源 Adapter。
- Produces: Desktop Chrome 与 Mobile Safari 的首次推荐旅程验收证据。

- [ ] **Step 1: 写初始、中断和关闭红测**

  新建 Dev Auth 账户，从 `/home` 断言初始当前步骤；依次通过正式 API/UI 创建完成职业资料导入、有效画像证据、活动主求职目标、启用来源和模型诊断，每次返回工作台确认步骤变化。点击中间步骤后刷新、退出再登录并创建新浏览器上下文，确认最后访问步骤与关闭提示均从服务端恢复。

- [ ] **Step 2: 写永久完成红测**

  复用现有确定性岗位导入、资格门槛、发现和深度匹配链路产生一个非空推荐清单；返回工作台确认旅程隐藏。随后移除画像事实、停用目标或来源并刷新，旅程仍不重新出现，现有维护区域继续显示问题。

- [ ] **Step 3: 写负向完成红测**

  使用独立账户分别产生失败运行和零推荐项目的现有空清单，确认旅程不完成；不要直接写完成表或伪造前端响应。

- [ ] **Step 4: 加入响应式与无障碍断言**

  两个项目都检查 44px 目标、无水平滚动和 Axe 零违规；桌面用 Tab/Enter 操作当前步骤与关闭按钮，移动端用 tap。断言状态文字存在，不能只检查颜色或 CSS 类。

- [ ] **Step 5: 运行新 E2E 确认失败**

  Run: `pnpm --filter web test:e2e -- first-recommendation-journey.spec.ts`

  Expected: 首次 FAIL，失败点必须来自尚未接好的旅程行为，不得 skip。

- [ ] **Step 6: 根据 E2E 结果做最小修复并重跑**

  Run: `pnpm --filter web test:e2e -- first-recommendation-journey.spec.ts`

  Expected: Desktop Chrome 与 Mobile Safari 全部 PASS。

- [ ] **Step 7: 运行分层回归（单进程串行）**

  ```bash
  pnpm --filter @job-copilot/contracts exec vitest run src/workbench.test.ts src/contracts.test.ts
  pnpm --filter @job-copilot/database exec vitest run src/migrate.integration.test.ts --no-file-parallelism
  pnpm --filter @job-copilot/domain exec vitest run src/first-recommendation-journey.integration.test.ts src/workbench-home.integration.test.ts src/deep-match-persistence.integration.test.ts --no-file-parallelism
  pnpm --filter api test -- src/workbench/workbench.controller.test.ts src/api.integration.test.ts
  pnpm --filter web test -- lib/server/api-client.test.ts lib/server/workbench.test.ts app/api/workbench/first-recommendation-journey/route.test.ts app/'(workbench)'/home/page.test.tsx components/workbench/first-recommendation-journey.test.tsx components/workbench/workbench-home-view.test.tsx app/globals.test.ts
  pnpm --filter @job-copilot/contracts typecheck
  pnpm --filter @job-copilot/database typecheck
  pnpm --filter @job-copilot/domain typecheck
  pnpm --filter api typecheck
  pnpm --filter web typecheck
  pnpm --filter web lint
  pnpm --filter web test:e2e -- first-recommendation-journey.spec.ts
  ```

  Expected: 全部 PASS，且无并发重叠测试进程。

- [ ] **Step 8: 执行双轴代码审查并修复**

  按仓库 `code-review` 流程分别审查：Standards 轴检查 AGENTS、术语、最小 diff、测试纪律和安全；Spec 轴逐条核对 Issue #52 验收标准与本设计。任何发现先修复，再从受影响的最小测试开始串行重跑，最终重跑 Step 7。

- [ ] **Step 9: 提交 E2E 与审查修复**

  ```bash
  git add apps/web/e2e/first-recommendation-journey.spec.ts apps/web/playwright.config.ts
  git commit -m "test: verify first recommendation journey (#52)"
  ```

- [ ] **Step 10: 完成 Issue 交付**

  在 Issue #52 评论中记录提交、测试命令、Desktop/Mobile/Axe 结果、历史兼容行为和双轴审查结论；移除 `ready-for-agent`，关闭 Issue。由于当前是 Codex 管理的 detached worktree，只提交本地变更，不自行创建分支或推送；交给 App 的原生“Create branch”或 handoff 流程继续。

## 计划自审

- **规格覆盖：** 六个动态来源、无漂移布尔值、中文状态/影响/动作、跨设备交互恢复、可信两类结果接口、空/失败/未发布拒绝、永久完成、Desktop/Mobile/无障碍均有对应任务。
- **范围控制：** 不实现 #53 编排或完整空结果证据，不新增通用 onboarding 引擎、导航或外部行动。
- **类型一致性：** 六个步骤 ID、四种步骤状态、两种完成来源和两个交互命令在契约、数据库、领域、API 与 Web 中使用同一名称。
- **待确认替换点：** 若不追溯历史非空清单，只删除 Task 2 Step 1/4 的回填样例与断言，并把设计中的历史兼容段改为“仅从本版本后的可信发布开始完成”；其余任务不变。
