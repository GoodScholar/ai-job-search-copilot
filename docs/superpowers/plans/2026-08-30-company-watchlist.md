# 目标公司 Watchlist 与来源偏好 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让登录用户在一个已确认求职目标下维护版本化的目标公司 Watchlist，以显式顺序表达来源优先级、以启用状态控制来源，并让后续 Agent 运行保存当时的来源范围快照。

**Architecture:** 每个求职目标最多对应一个 `company_watchlists` 聚合，当前协调版本保存在主表，完整条目数组保存在不可变 revision 中；新增、编辑、排序、启用和禁用都以聚合 `expectedVersion` 做原子 compare-and-swap。NestJS 提供认证命令 API，Next.js 在 `/profile/targets/[targetId]/watchlist` 提供响应式、键盘可操作页面。Agent 运行启动时按 Watchlist 顺序优先放入启用的公开招聘入口，排除用户明确禁用的同一来源，再追加未被明确禁用的既有公开来源，因此 Watchlist 提高优先级但不是全网发现白名单。

**Tech Stack:** TypeScript、Zod、Drizzle/PostgreSQL、NestJS/Fastify、Next.js 16/React 19、Vitest/Testcontainers、Playwright。

**Spec:** GitHub Issue `GoodScholar/ai-job-search-copilot#28`；实现基线为已完成 #10 的 `efdeaff971af6b568c091f22f13266fbf252ede3`；产品边界见 `PRODUCT.md`、`CONTEXT.md`、`docs/adr/0022-start-discovery-from-company-watchlists.md`、`docs/adr/0003-use-layered-job-sources.md`、`docs/adr/0005-ship-responsive-web-first.md` 与 `docs/adr/0006-use-durable-agent-runs.md`。

## Global Constraints

- 始终使用简体中文界面文案与 `CONTEXT.md` 术语；使用“目标公司 Watchlist”“求职目标”“岗位来源”，不称“公司收藏”或“招聘源列表”。
- 一个 Watchlist 只绑定一个当前账户拥有的求职目标；所有表、查询和命令按 `userId` 隔离，跨账户目标和条目表现为不存在。
- Watchlist 是一个聚合版本：不存在持久化记录时读取版本 `0` 和空条目；第一次新增要求 `expectedVersion: 0`，此后每次成功命令只递增一次版本并追加一个不可变 revision。
- 新增、编辑、排序、启用和禁用必须携带 `expectedVersion`；并发失败返回稳定的 409 版本冲突，绝不静默覆盖。
- 每个 Watchlist 最多 50 项；公司规范名称为去除首尾空白后的 1–200 字符，来源备注为 `null` 或最多 500 字符，允许域为 1–20 个唯一小写公开 DNS 名称。
- 公开招聘入口仅接受最长 2048 字符的 `http:` 或 `https:` URL；拒绝 URL userinfo、本地/保留 IP、`localhost`，并拒绝 `token`、`access_token`、`auth`、`session`、`password`、`secret`、`key`、`code` 等凭据型查询键。
- 公开招聘入口主机必须等于某个允许域，或是该允许域的子域；协议、路径、通配符、端口和凭据不能写入允许域。
- API 命令是 strict object；不定义用户名、密码、Cookie、Token、登录墙授权、验证码绕过或反检测字段，未知字段必须被 Zod 拒绝。
- 来源备注始终只是用户可见数据，不能改变 Adapter 工具、抓取权限、安全策略或 Agent 指令。
- 数组顺序就是来源优先级；`enabled` 项在运行来源快照中按顺序优先，`disabled` 项保留在 Watchlist 但不得进入新运行的来源范围。
- Watchlist 不构成其他公开来源白名单：未被 Watchlist 明确禁用的既有公开来源仍追加在启用 Watchlist 来源之后。
- Agent 运行保存 Watchlist 版本与最终来源顺序；求职目标停用后，现有 `AGENT_RUN_TARGET_INACTIVE` 门禁必须阻止任何新运行落库或入队。
- #28 只能最小扩展 #10 的不可变 `AgentRunExecutionSpec`：必须原样保留 target snapshot、workflow/rule/adapter/output schema versions、tool allowlist、`model: null`、完整预算快照，以及控制状态、usage、termination、恢复、checkpoint、心跳和审计不变量。
- 动态来源不能绕过 #10 的工具预算：`searchBatch`/`getDetail` 仍必须经过既有 before/after checkpoint、tool/source request 记账、claim 验证和 Adapter resolver。
- 本 Issue 不新增真实抓取、登录态、验证码、浏览器自动化、来源健康或 AnySearch 能力；这些分别属于后续 Adapter/Issue。
- 所有写入追加不含公司名称、URL、允许域、来源备注或凭据的脱敏审计元数据。
- Web 遵循 `apps/web/AGENTS.md`：实现前从 `apps/web/node_modules/next/dist/docs/` 阅读本任务涉及的 App Router 动态参数与 Route Handler 文档。
- 只修改 #28 直接需要的文件；不重构求职目标、岗位导入或 Agent 运行的无关代码。

## Acceptance Criteria 与验证证据

| Issue #28 Acceptance criterion | 实现任务 | 必须提供的验证证据 |
|---|---|---|
| 添加、编辑、排序、启用和禁用 Watchlist 项 | Task 1、2、5 | contract 命令测试、PostgreSQL 聚合测试、组件测试、Playwright 完整操作 |
| 保存公司规范名称、公开招聘入口、允许域和可见备注；不接受凭据 | Task 1、2、3、5 | strict Zod 拒绝测试、revision reload 测试、API 400 测试、页面重载断言 |
| 设置优先来源和禁用来源；不能授权绕过登录墙或验证码 | Task 1、4、5 | 顺序/状态契约、Agent `sourceScope` 顺序与排除测试、无授权字段与固定安全提示 |
| 与一个求职目标绑定；目标停用后不产生新计划运行 | Task 1、2、4 | 所有权 FK/跨账户测试、停用目标启动运行失败且 `agent_runs`/队列均无新增 |
| 并发编辑使用版本冲突 | Task 2、3、5 | 双写 PostgreSQL 测试、API 409、客户端保留原数据并显示刷新提示 |
| 空状态、校验错误、移动端和键盘操作 | Task 5 | 组件可访问名称/状态测试、44px 控件、Mobile Safari 无溢出、Axe |
| Playwright 覆盖添加公司、调整优先级、禁用来源和重新加载 | Task 5 | `company-watchlist.spec.ts` 在 Desktop Chrome 与 Mobile Safari 通过 |

## Rulings

- **Ruling 1 — 基线组合：** #28 固定从 `efdeaff971af6b568c091f22f13266fbf252ede3` 开始；`9e3a624` 与原计划提交已重放为 `bd6a344`、`57b4257`。若此判断错误，代价是丢失 #10 的运行控制、预算、恢复和审计能力，因此每次最终审查都以 `efdeaff` 为固定点。
- **Ruling 2 — 迁移编号：** #10 已占用 `0018` 与 `0019`，Watchlist 使用 `0020_company_watchlists.sql` 和 `0020_snapshot.json`。若编号冲突，迁移 journal 与生产升级顺序会不可组合。
- **Ruling 3 — Fake 来源标识：** 保留 #10 的 `fake:aurora-careers`、`fake:orbit-careers` 常量，不把它们改写成 URL。Watchlist 招聘入口以 URL 字符串加入 ordered sources；Fake Adapter 对未知 URL 返回零结果，既有 Fake 来源作为未明确禁用的公开来源继续追加。这样避免为 #28 改写 #10 fixture 身份；若此判断错误，代价只限于 Fake 环境中自定义 URL 无结果，不会产生越权网络访问。
- **Ruling 4 — 执行规格边界：** `AgentRunSourceScopeSchema` 只增加 `watchlistVersion` 并放宽 `sources` 为有序唯一字符串数组；`AgentRunExecutionSpecSchema` 的其他 #10 字段和不变量不变。若此判断错误，代价是已有运行无法恢复或预算/工具边界失真，因此 Task 4 必须以完整 execution spec、控制、预算、恢复和审计回归测试作为门禁。
- **Ruling 5 — Drizzle 元数据连续性：** #10 的 journal 已登记 `0019_agent_inbox_action_ownership`，但仓库没有独立 `0019_snapshot.json`。#28 生成 `0020` 时必须让新 snapshot 表示应用 0019 后再加入 Watchlist 的最终 schema，且 `0020` SQL 不得重复或撤销 0019 的 outcome constraint。若处理错误，代价是空库迁移与 schema snapshot 分叉。
- **Ruling 6 — Agent Run 启动锁顺序：** #10 的真实实现是在事务内先获取账户 advisory lock，再查询同账户 idempotency existing；原计划将两者顺序误写为相反。Task 4 必须保留 #10 的实际顺序，在该锁内、通过幂等复用检查之后读取当前 Watchlist revision 并构造新运行快照，不得为了贴合旧计划文字重排控制流程。若处理错误，代价是改变 #10 已验证的并发与幂等语义。
- **Ruling 7 — 最终 lint 门禁的相邻基线修复：** #10 基线中的 `apps/web/app/(workbench)/profile/targets/page.tsx` 在 #28 开始前已触发 `react-hooks/error-boundaries`，且文件在 Task 5 前后内容未变；但 Task 6 明确要求全量 `pnpm lint` 成功。允许在 Task 5 修复波次中只把数据 await 移出 JSX 构造的 `try/catch`，保持页面成功、控制流重抛与固定失败态行为不变。若不修复，代价是无法满足 #28 的强制全仓验收门禁。

---

### Task 1: 定义 Watchlist 契约与版本化持久化

**Files:**
- Create: `packages/contracts/src/company-watchlists.ts`
- Create: `packages/contracts/src/company-watchlists.test.ts`
- Modify: `packages/contracts/package.json`
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/migrations/0020_company_watchlists.sql`
- Create/Modify: `packages/database/migrations/meta/0020_snapshot.json`
- Modify: `packages/database/migrations/meta/_journal.json`
- Modify: `packages/database/src/migrate.integration.test.ts`

**Interfaces:**
- Produces `CompanyWatchlistOverviewSchema`, `CompanyWatchlistItemSchema`, `AddCompanyWatchlistItemCommandSchema`, `ReviseCompanyWatchlistItemCommandSchema`, `ReorderCompanyWatchlistCommandSchema`, `SetCompanyWatchlistItemStateCommandSchema` and inferred types.
- Produces database tables `companyWatchlists` and `companyWatchlistRevisions`.

- [ ] **Step 1: Write failing strict contract tests**

Cover this exact public shape:

```ts
type CompanyWatchlistItem = {
  itemId: string;
  canonicalCompanyName: string;
  careersUrl: string;
  allowedDomains: string[];
  sourceNote: string | null;
  state: "enabled" | "disabled";
  position: number;
};

type CompanyWatchlistOverview = {
  target: {
    targetId: string;
    targetVersion: number;
    targetState: "active" | "inactive";
    roleFamily: string;
  };
  version: number;
  items: CompanyWatchlistItem[];
};
```

Commands are strict objects:

```ts
type AddCompanyWatchlistItemCommand = {
  expectedVersion: number;
  canonicalCompanyName: string;
  careersUrl: string;
  allowedDomains: string[];
  sourceNote: string | null;
};

type ReviseCompanyWatchlistItemCommand = AddCompanyWatchlistItemCommand;
type ReorderCompanyWatchlistCommand = { expectedVersion: number; orderedItemIds: string[] };
type SetCompanyWatchlistItemStateCommand = { expectedVersion: number; state: "enabled" | "disabled" };
```

Assert the Global Constraints bounds, unique contiguous positions, unique item IDs, URL host/allowed-domain relationship, URL userinfo/credential query rejection, and strict rejection of fields named `username`, `password`, `cookie`, `captchaBypass` and `loginWallAuthorization`.

- [ ] **Step 2: Run contract tests and verify RED**

Run: `pnpm --filter @job-copilot/contracts test -- company-watchlists.test.ts`

Expected: fail because the module/export does not exist.

- [ ] **Step 3: Implement minimal Zod contracts and package export**

Keep URL/domain validation in exported pure helpers only if both contract parsing and Web field feedback need the same rule. Do not add credential or Adapter configuration types.

- [ ] **Step 4: Run contract tests and verify GREEN**

Run: `pnpm --filter @job-copilot/contracts test -- company-watchlists.test.ts`

- [ ] **Step 5: Write a failing migration integration test**

Assert:

```text
company_watchlists:
  id, user_id, target_id, version, created_at, updated_at
  UNIQUE(user_id, target_id)
  UNIQUE(user_id, id)
  owner+target FK -> job_targets(user_id, id)
  version >= 1

company_watchlist_revisions:
  id, user_id, watchlist_id, target_id, version, items JSONB, created_at
  UNIQUE(watchlist_id, version)
  owner+watchlist FK -> company_watchlists(user_id, id)
  owner+target FK -> job_targets(user_id, id)
  version >= 1
  jsonb_typeof(items) = 'array'
```

Also assert that a cross-account target cannot be bound and two current Watchlists cannot exist for the same account/target.

- [ ] **Step 6: Add Drizzle schema and generate migration artifacts**

Use the repository's existing Drizzle generation workflow. Because `0019` is journaled without a standalone snapshot, verify the generated `0020_snapshot.json` contains the post-0019 `agent_inbox_item_actions_outcome_check` (`pending`, `applied`, `no_change`, `failed`) while `0020_company_watchlists.sql` contains only the Watchlist delta and does not replay or undo 0019. Do not create mutable item rows—the immutable revision JSON array is the aggregate state.

- [ ] **Step 7: Run database verification**

Run: `DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/database test`

Run: `pnpm --filter @job-copilot/contracts typecheck && pnpm --filter @job-copilot/database typecheck`

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/contracts packages/database
git commit -m "feat: define versioned company watchlists (#28)"
```

---

### Task 2: 实现 Watchlist 聚合命令、查询和审计

**Files:**
- Create: `packages/domain/src/company-watchlists.ts`
- Create: `packages/domain/src/company-watchlists.integration.test.ts`
- Modify: `packages/domain/src/audit-trail.ts`
- Modify: `packages/domain/src/audit-trail.integration.test.ts`
- Modify: `packages/domain/package.json`

**Interfaces:**
- Consumes Task 1 contracts and tables.
- Produces `createCompanyWatchlistQueries({ db }).get({ userId, targetId })`.
- Produces `createCompanyWatchlistCommands({ db, auditTrail, id, clock })` with `addItem`, `reviseItem`, `reorder`, `setItemState`.
- Produces stable errors `COMPANY_WATCHLIST_TARGET_NOT_FOUND`, `COMPANY_WATCHLIST_TARGET_INACTIVE`, `COMPANY_WATCHLIST_ITEM_NOT_FOUND`, `COMPANY_WATCHLIST_VERSION_CONFLICT`, `COMPANY_WATCHLIST_LIMIT`, `COMPANY_WATCHLIST_DUPLICATE_COMPANY`, `COMPANY_WATCHLIST_DUPLICATE_SOURCE`.

- [ ] **Step 1: Write failing empty/add/reload integration tests**

With a real PostgreSQL container, seed an owned active job target and assert `get` returns version `0` with `[]`. Add the first item using `expectedVersion: 0`; assert version `1`, generated item ID, position `1`, enabled state, normalized domains, and an immutable revision. Reload through a fresh query object and compare the full persisted fields.

- [ ] **Step 2: Implement the minimal target lookup and first revision**

Under `acquireAccountAdvisoryLock`, verify target ownership and active state, re-read the current Watchlist, require version `0`, insert current row and revision in one transaction, and append only this metadata:

```ts
{
  targetId,
  action: "item_added",
  version: 1,
  itemId,
  itemCount: 1,
}
```

- [ ] **Step 3: Write failing edit/reorder/state tests**

Create three items and assert:

- revising item 2 preserves its `itemId`, `position` and `state` while replacing only the editable fields;
- reorder accepts exactly one permutation of all current IDs and rewrites positions to `1..N`;
- disabling and re-enabling preserve all source fields and position;
- each successful command increments once and adds one revision; old revisions remain byte-for-byte unchanged;
- duplicate case-insensitive company names, duplicate normalized URLs, missing IDs, malformed permutations and the 51st item fail without a new revision.

- [ ] **Step 4: Implement a single aggregate mutation helper**

The helper must:

```ts
type Mutation = (items: CompanyWatchlistItem[]) => CompanyWatchlistItem[];
```

1. acquire the account advisory lock;
2. verify the target belongs to the user and is active;
3. load the current aggregate or virtual version `0`;
4. compare `expectedVersion` before applying the mutation;
5. validate the complete next overview through `CompanyWatchlistOverviewSchema`;
6. conditionally update `company_watchlists` on `(userId, targetId, version)` or insert the first row;
7. append one revision and one redacted audit event in the same transaction.

- [ ] **Step 5: Write failing stale-write and ownership tests**

Run two commands from the same version and assert exactly one succeeds. Assert stale edit/reorder/state commands leave both current state and revision count unchanged. Assert another account sees `COMPANY_WATCHLIST_TARGET_NOT_FOUND` for the target and `COMPANY_WATCHLIST_ITEM_NOT_FOUND` is not usable to enumerate another account's IDs.

- [ ] **Step 6: Implement optimistic conflict and audit schemas minimally**

Add audit action literals `item_added`, `item_revised`, `reordered`, `item_enabled`, `item_disabled`; metadata may include IDs, version, position and item count, but never company/source fields.

- [ ] **Step 7: Run domain and audit verification**

Run: `DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain test -- company-watchlists audit-trail`

Run: `pnpm --filter @job-copilot/domain typecheck`

- [ ] **Step 8: Commit Task 2**

```bash
git add packages/domain
git commit -m "feat: manage target company watchlists (#28)"
```

---

### Task 3: 暴露认证 Watchlist REST API 与 Web API client

**Files:**
- Create: `apps/api/src/company-watchlists/company-watchlists.tokens.ts`
- Create: `apps/api/src/company-watchlists/company-watchlists.controller.ts`
- Create: `apps/api/src/company-watchlists/company-watchlists.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/api.integration.test.ts`
- Modify: `apps/web/lib/server/api-client.ts`
- Modify: `apps/web/lib/server/api-client.test.ts`

**Interfaces:**
- Produces authenticated endpoints:
  - `GET /v1/job-targets/:targetId/company-watchlist`
  - `POST /v1/job-targets/:targetId/company-watchlist/items`
  - `POST /v1/job-targets/:targetId/company-watchlist/items/:itemId/revisions`
  - `POST /v1/job-targets/:targetId/company-watchlist/items/:itemId/state-changes`
  - `POST /v1/job-targets/:targetId/company-watchlist/reorders`
- Produces API client methods with matching names and validated `CompanyWatchlistOverview` responses.

- [ ] **Step 1: Write a failing authenticated API integration test**

Exercise empty read, add, edit, reorder, disable, enable and reload through Fastify injection. Assert 200 read, 201 writes, 400 for invalid URL/domain and any credential/bypass field, 409 for stale version/duplicate/limit, 404 for missing or cross-account target/item, and fixed problem bodies that do not echo company name, URL, domain, note or submitted unknown fields.

- [ ] **Step 2: Implement module/controller/tokens**

Follow the existing `job-targets` controller pattern with `SessionGuard`, `createZodDto`, `ZodResponse`, request IDs and `ApiException`. Map only the stable domain codes; let Zod request errors use the common 400 filter.

- [ ] **Step 3: Extend OpenAPI assertions**

Assert all five paths, bearer security, strict request schemas and the shared `CompanyWatchlistOverview` response schema.

- [ ] **Step 4: Write failing Web API client tests**

Assert exact HTTP methods, paths, authorization, JSON bodies, response validation and error mapping for all five operations. An invalid 2xx payload must become `ApiClientError("invalid_response")`.

- [ ] **Step 5: Implement minimal API client methods**

Parse every successful body through `CompanyWatchlistOverviewSchema`; reuse existing request/problem handling without creating a second HTTP abstraction.

- [ ] **Step 6: Run API and client verification**

Run: `DOCKER_API_VERSION=1.51 pnpm --filter api test -- api.integration.test.ts`

Run: `pnpm --filter web test -- api-client.test.ts`

Run: `pnpm --filter api typecheck && pnpm --filter web typecheck`

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/api apps/web/lib/server
git commit -m "feat: expose company watchlist API (#28)"
```

---

### Task 4: 将来源优先级和禁用状态写入 Agent 运行快照

**Files:**
- Modify: `packages/contracts/src/agent-runs.ts`
- Modify: `packages/contracts/src/agent-runs.test.ts`
- Modify: `packages/domain/src/agent-run-control.ts`
- Modify: `packages/domain/src/agent-runs.integration.test.ts`
- Modify: `apps/worker/src/agent-runs/fake-job-discovery-adapter.test.ts`
- Modify: `apps/worker/src/agent-runs/agent-run.integration.test.ts`
- Modify only if required by a failing test: `packages/domain/src/agent-run-processor.ts`

**Interfaces:**
- Extends the existing #10 `AgentRunSourceScopeSchema` with `watchlistVersion: nonnegative integer` and changes only `sources` from the fixed two-item tuple to an ordered, unique array of 0–52 source identifiers.
- Keeps `kind: "company_watchlist"`, `adapter: "fake"`, `adapterVersion: "fake-job-discovery-v1"` and both existing `FAKE_JOB_DISCOVERY_SOURCE_IDS` unchanged.
- Keeps the complete #10 `AgentRunExecutionSpecSchema` shape unchanged outside `sourceScope`: `targetSnapshot`, `workflowVersion`, `ruleVersion`, `adapter`, `adapterVersion`, `outputSchemaVersion`, `toolAllowlist`, `model`, `budget`.
- Keeps #10 run control states/events, usage counters, termination facts, claim/recovery behavior, Adapter resolver and redacted budget/control audit behavior unchanged.

- [ ] **Step 1: Write failing compositional source-scope contract tests**

Only the nested source scope changes:

```ts
type AgentRunSourceScope = {
  kind: "company_watchlist";
  adapter: "fake";
  adapterVersion: "fake-job-discovery-v1";
  watchlistVersion: number;
  sources: string[];
};
```

Require unique strings of 1–2048 characters, maximum 52, and allow `[]` when every currently available source is explicitly disabled. In the same tests, parse a complete execution spec and assert all #10 fields remain exact:

```ts
{
  sourceScope,
  targetSnapshot,
  workflowVersion: "job-discovery-workflow-v1",
  ruleVersion: "fake-job-discovery-rules-v1",
  adapter: "fake",
  adapterVersion: "fake-job-discovery-v1",
  outputSchemaVersion: "job-discovery-result-v1",
  toolAllowlist: ["job_discovery.search_batch", "job_discovery.get_detail"],
  model: null,
  budget: {
    maxActiveDurationMs: 60_000,
    maxAttempts: 3,
    maxToolCalls: 10,
    maxResults: 5,
    maxModelCalls: 0,
    maxTokens: 0,
  },
}
```

- [ ] **Step 2: Run contracts to verify RED**

Run: `pnpm --filter @job-copilot/contracts test -- agent-runs.test.ts`

- [ ] **Step 3: Implement only the nested contract extension**

Do not replace `AgentRunExecutionSpecSchema`, budget constants, tool allowlist, rule version or run event/state schemas. Increase `DiscoverySearchInputSchema`, `DiscoveryDetailInputSchema` and `DiscoverySearchSummarySchema` source ID bounds to 2048 only because Watchlist URLs can now be source identifiers.

- [ ] **Step 4: Write failing Agent Run start integration tests**

Create Watchlist revisions through the Task 2 public domain commands, then start runs through `createAgentRunCommands`. Assert the persisted `sourceScope`, query projection and `executionSpec.sourceScope` all carry the same ordered sources and Watchlist version.

The construction rule inside the existing `agent-run-control.ts` start transaction is:


```ts
const disabled = new Set(items.filter((item) => item.state === "disabled").map((item) => item.careersUrl));
const enabled = items.filter((item) => item.state === "enabled").sort(byPosition).map((item) => item.careersUrl);
const sources = unique([...enabled, ...FAKE_JOB_DISCOVERY_SOURCE_IDS.filter((source) => !disabled.has(source))]);
```

Persist the current Watchlist version, or `0` when no aggregate exists. Do not include source notes in the run snapshot.

- [ ] **Step 5: Implement dynamic scope in the existing #10 start transaction**

Read the current Watchlist revision under the account advisory lock already held by `start`. Preserve the actual #10 order: acquire the account advisory lock, query and reuse the idempotent existing run, check the owned active target, read the current Watchlist revision, insert the immutable target/execution snapshot, create the step/event and redacted audit, then perform the post-commit recoverable queue wakeup. Change only the local `sourceScope` value used for the new row.

- [ ] **Step 6: Verify priority, disable, immutability and target deactivation**

Assert an active target with ordered enabled items snapshots those URLs first, duplicate identifiers appear once, a disabled source is absent, unspecified Fake defaults remain, and subsequent Watchlist edits do not mutate an existing run. Then deactivate the target and assert a new idempotency key returns `AGENT_RUN_TARGET_INACTIVE`, inserts no `agent_runs` row and enqueues no job.

- [ ] **Step 7: Run #10 invariant-focused processor and Worker tests**

Add/adjust tests so the Fake Adapter returns fixtures only for the unchanged `fake:*` source IDs and safely returns no matches for arbitrary Watchlist URL identifiers. Verify batch result order still follows `sourceScope.sources`.

Do not alter processor control flow unless a new failing test proves it necessary. Re-run existing tests that prove Adapter resolution from immutable metadata, before/after checkpoints, tool/source request accounting, pause/cancel, active-duration and attempt budgets, heartbeat, stale claims, retry recovery, terminal facts and audit/inbox projection.

Run: `DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain test -- agent-runs`

Run: `DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain test -- agent-run-control agent-run-processor agent-run-state`

Run: `DOCKER_API_VERSION=1.51 pnpm --filter worker test -- agent-run fake-job-discovery-adapter job-discovery-adapter-resolver`

Run: `pnpm --filter @job-copilot/contracts typecheck && pnpm --filter @job-copilot/domain typecheck && pnpm --filter worker typecheck`

- [ ] **Step 8: Commit Task 4**

```bash
git add packages/contracts packages/domain apps/worker
git commit -m "feat: prioritize watchlist discovery sources (#28)"
```

---

### Task 5: 交付 Watchlist 页面、同源命令路由与 Playwright 验收

**Files:**
- Create: `apps/web/lib/server/company-watchlists.ts`
- Create: `apps/web/lib/server/company-watchlists.test.ts`
- Create: `apps/web/app/(workbench)/profile/targets/[targetId]/watchlist/page.tsx`
- Create: `apps/web/app/(workbench)/profile/targets/[targetId]/watchlist/page.test.tsx`
- Create: `apps/web/app/api/job-targets/[targetId]/company-watchlist/route.ts`
- Create: `apps/web/app/api/job-targets/[targetId]/company-watchlist/items/route.ts`
- Create: `apps/web/app/api/job-targets/[targetId]/company-watchlist/items/[itemId]/revisions/route.ts`
- Create: `apps/web/app/api/job-targets/[targetId]/company-watchlist/items/[itemId]/state-changes/route.ts`
- Create: `apps/web/app/api/job-targets/[targetId]/company-watchlist/reorders/route.ts`
- Create: `apps/web/components/workbench/company-watchlist-view.tsx`
- Create: `apps/web/components/workbench/company-watchlist-view.test.tsx`
- Modify: `apps/web/components/workbench/job-targets-view.tsx`
- Modify: `apps/web/components/workbench/job-targets-view.test.tsx`
- Modify: `apps/web/app/globals.css`
- Create: `apps/web/e2e/company-watchlist.spec.ts`

**Interfaces:**
- Produces authenticated RSC page `/profile/targets/[targetId]/watchlist`.
- Produces same-origin browser command routes mirroring Task 3.
- Adds a “维护目标公司 Watchlist” link to each target card.

- [ ] **Step 1: Read the installed Next.js 16 docs before writing route code**

Read the relevant files under `apps/web/node_modules/next/dist/docs/` for App Router dynamic `params`, Server Components and Route Handlers. Record the exact files read in the Task 5 report.

- [ ] **Step 2: Write failing server/page tests**

Assert every read authenticates via `readSessionToken`, missing session redirects to `/login?returnTo=` with the exact encoded dynamic path, the validated overview reaches `CompanyWatchlistView`, Next control-flow errors rethrow, and recoverable API failures render a fixed Chinese retry state without leaking internal URLs or problem details.

- [ ] **Step 3: Implement server read, page shell and same-origin routes**

Parse dynamic UUID parameters before forwarding. Each mutation route must validate its exact command schema, re-authenticate through the existing server API client, preserve upstream 409/404/400 status, and return only validated success or sanitized problem JSON.

- [ ] **Step 4: Write failing component tests for every user-visible state**

Cover:

- empty state with target role and “添加目标公司” action;
- add form fields for company规范名称、公开招聘入口、允许域、来源备注 and the fixed notice “不要填写账号、密码、Cookie、验证码或绕过登录限制的说明。”;
- client-side field errors for missing name, bad URL, host/domain mismatch and credential-shaped URL;
- successful add uses `expectedVersion: 0`, renders priority 1 and version 1;
- edit preserves item identity and sends current aggregate version;
- “上移/下移” native buttons send a complete ID permutation and update visible priority only after validated success;
- disable/enable sends current version, retains source fields and exposes state in text rather than color only;
- a 409 keeps existing list/form data and shows “Watchlist 已在其他位置更新，请刷新后重试。”;
- all controls have accessible names, visible focus styling through existing CSS, native keyboard behavior and `workbench-touch-target`/44px sizing.

- [ ] **Step 5: Implement the minimal controlled view and target-page entry**

Use one add/edit form plus an ordered list. Do not add drag-and-drop: up/down buttons satisfy ordering, keyboard and mobile requirements with less state. Parse every success response with `CompanyWatchlistOverviewSchema`; never optimistically reorder or hide a failed command.

- [ ] **Step 6: Write and run the Playwright tracer bullet**

Create an isolated account through Dev Auth, seed/confirm a job target through public APIs, open its Watchlist page and assert:

1. empty state;
2. add `曙光云图` with `https://careers.aurora.example/jobs`, allowed domain `careers.aurora.example`, and visible note;
3. add `星轨智造` with `https://careers.orbit.example/jobs`;
4. move the second item to priority 1;
5. disable its source and verify the explicit disabled state;
6. reload and verify both full records, order, state, note and version persist;
7. create a stale write through the API and verify the visible 409 conflict;
8. verify keyboard focus/action, every actionable control height at least 44px, no horizontal overflow, and Axe has no violations.

Run: `pnpm --filter web test:e2e -- company-watchlist.spec.ts --project="Desktop Chrome" --project="Mobile Safari"`

- [ ] **Step 7: Run focused Web verification**

Run: `pnpm --filter web test -- company-watchlist-view.test.tsx company-watchlists.test.ts page.test.tsx job-targets-view.test.tsx`

Run: `pnpm --filter web lint && pnpm --filter web typecheck`

- [ ] **Step 8: Commit Task 5**

```bash
git add apps/web
git commit -m "feat: maintain company watchlist in workbench (#28)"
```

---

### Task 6: 双轴审查、完整验收与 Issue 关闭

**Files:**
- Review all changes since the pinned #10 baseline `efdeaff971af6b568c091f22f13266fbf252ede3`.
- Modify only files required to resolve valid findings.
- Remove only implementation scratch reports created by this plan; retain this implementation plan as delivery evidence.

- [ ] **Step 1: Run task-level reviews throughout implementation**

After each Task 1–5 implementation, use `subagent-driven-development` review packages and require both task spec compliance and code quality verdicts. Fix every Critical/Important or confirmed spec gap before moving to the next task; record minor findings and rulings in the plan ledger.

- [ ] **Step 2: Run final Standards and Spec reviews in parallel**

Fixed point: `efdeaff971af6b568c091f22f13266fbf252ede3`.

Standards sources: root `AGENTS.md`, `apps/web/AGENTS.md`, `PRODUCT.md`, `CONTEXT.md`, relevant ADRs, `docs/agents/*.md`, plus the `code-review` smell baseline.

Spec source: GitHub Issue #28 plus this plan's Global Constraints and Acceptance Criteria table.

Use `gpt-5.6-sol / high` for both final axes as required by the repository model split. Resolve every valid finding through a `gpt-5.6-terra / high` fix task, then run one scoped re-review.

- [ ] **Step 3: Run fresh full verification**

Run in this order and save exact exit codes/test counts for the GitHub acceptance record:

```bash
pnpm lint
pnpm typecheck
DOCKER_API_VERSION=1.51 pnpm test
pnpm build
pnpm --filter web test:e2e -- company-watchlist.spec.ts --project="Desktop Chrome" --project="Mobile Safari"
```

Also inspect `git diff --check`, `git status --short`, the commit list, migration ordering and OpenAPI path assertions.

- [ ] **Step 4: Verify every Acceptance criterion line-by-line**

For each row in the table above, cite at least one automated test file and its fresh command result. Explicitly verify that the target-deactivation test observed no new database row and no queue job, and that credential/bypass unknown fields were rejected rather than ignored.

- [ ] **Step 5: Publish the GitHub acceptance record and close #28**

Post one concise comment containing:

- baseline and final commit IDs;
- delivered behavior and public route/API list;
- all seven Acceptance criteria with test evidence;
- Standards and Spec verdicts plus fixes/rulings;
- lint/typecheck/test/build/E2E commands and counts;
- explicit statement that no push, PR or merge was performed.

Write the acceptance record to the task workspace, publish it with `gh issue comment 28 --repo GoodScholar/ai-job-search-copilot --body-file <acceptance-record>`, then run `gh issue close 28 --repo GoodScholar/ai-job-search-copilot` and verify it is `CLOSED` by a fresh `gh issue view`.

- [ ] **Step 6: Stop after #28**

Report the next recommended ready, unblocked Issue only; do not implement it in this task. A new Issue must start in a brand-new Codex task with `/implement #<number>`.
