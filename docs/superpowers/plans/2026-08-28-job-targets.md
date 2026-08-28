# 求职目标确认 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让登录用户从已确认画像证据获得候选岗位方向，并确认一个主目标、最多两个次目标及独立资格约束和版本。

**Architecture:** 新增独立的 `job-targets` 深模块：contracts 定义唯一跨层协议，PostgreSQL 保存目标当前状态与不可变修订，domain 负责证据建议、主次限制、账户隔离和并发控制，NestJS 暴露认证 REST API，Next.js 在 `/profile/targets` 提供可访问交互。候选方向由确定性画像规则即时生成，不持久化；只有用户提交后才创建求职目标。

**Tech Stack:** TypeScript、Zod、Drizzle/PostgreSQL、NestJS/Fastify、Next.js 16/React 19、Vitest/Testcontainers、Playwright。

**Spec:** GitHub Issue `GoodScholar/ai-job-search-copilot#6`；上位规格为 Issue `#1` 的“求职画像 and 求职目标”部分。

## Global Constraints

- 始终使用简体中文界面文案与领域术语；使用“求职目标”，不称“搜索条件”或“用户偏好”。
- 只有当前有效的画像事实可以成为候选方向依据；候选方向不是画像事实，也不能在读取时自动持久化。
- 一个账户同时最多一个 active primary、两个 active secondary；每个目标独立版本化。
- 并发修改必须携带 `expectedVersion`，不允许 last-write-wins；创建数量也必须在账户级锁内检查。
- 未知约束显式保留为空值或空集合，不填充推断默认值。
- 薪资使用“金额范围 + `month|year` + ISO 货币代码”，界面默认显示 CNY，但只有用户提交后保存。
- 停用通过追加修订完成；停用目标不得出现在供后续岗位发现读取的 active 查询中。
- 所有读取和写入按 `userId` 隔离，跨账户资源对调用方表现为不存在。
- 画像证据建议使用确定性规则；本票据不新增模型 Adapter，也不调用 OpenAI。
- 测试只落在已确认 seam：Zod 契约、domain commands/queries + 真实 PostgreSQL、认证 REST、用户可见浏览器流程。
- 只修改 #6 所需文件；不得顺手重构现有简历导入或画像审核模块。

---

### Task 1: 建立求职目标契约与持久化结构

**Files:**
- Create: `packages/contracts/src/job-targets.ts`
- Create: `packages/contracts/src/job-targets.test.ts`
- Modify: `packages/contracts/package.json`
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/migrations/0011_job_targets.sql`
- Create/Modify: `packages/database/migrations/meta/0011_snapshot.json`
- Modify: `packages/database/migrations/meta/_journal.json`
- Modify: `packages/database/src/migrate.integration.test.ts`

**Interfaces:**
- Produces: `JobTargetOverviewSchema`, `JobTargetSchema`, `JobTargetSuggestionSchema`, `CreateJobTargetCommandSchema`, `ReviseJobTargetCommandSchema`, `DeactivateJobTargetCommandSchema`.
- Produces database tables `jobTargets` and `jobTargetRevisions`.

- [ ] **Step 1: Write failing contract tests**

Cover strict parsing for this public shape:

```ts
type JobTargetConstraints = {
  roleFamily: string;
  seniority: string | null;
  locations: string[];
  workModes: Array<"onsite" | "hybrid" | "remote">;
  relocation: "unknown" | "not_willing" | "willing" | "conditional";
  salary: null | {
    minimum: number | null;
    maximum: number | null;
    period: "month" | "year";
    currency: string;
  };
  industries: string[];
  dealBreakers: {
    excludedCompanies: string[];
    excludedIndustries: string[];
    excludeOutsourcing: boolean;
    excludeDispatch: boolean;
    excludeHeadhunter: boolean;
    other: string[];
  };
};

type JobTarget = {
  targetId: string;
  version: number;
  priority: "primary" | "secondary";
  state: "active" | "inactive";
  constraints: JobTargetConstraints;
  createdAt: string;
  updatedAt: string;
};

type JobTargetSuggestion = {
  suggestionId: string;
  roleFamily: string;
  rationale: string;
  evidence: Array<{ factId: string; revisionId: string; label: string }>;
};

type JobTargetOverview = {
  suggestions: JobTargetSuggestion[];
  targets: JobTarget[];
};
```

Commands are strict objects: create has `priority` and `constraints`; revise has `expectedVersion`, `priority` and `constraints`; deactivate has only `expectedVersion`. Bounds: trimmed user strings 1–200 characters, arrays max 20 and deduplicated, currency exactly three uppercase ASCII letters, non-negative integer amounts, and minimum may not exceed maximum.

- [ ] **Step 2: Run the contract test and verify RED**

Run: `pnpm --filter @job-copilot/contracts test -- job-targets.test.ts`

- [ ] **Step 3: Implement the minimal schemas and package export**

Use Zod transforms/refinements only at the public boundary; export inferred TypeScript types alongside schemas.

- [ ] **Step 4: Run the contract test and verify GREEN**

Run: `pnpm --filter @job-copilot/contracts test -- job-targets.test.ts`

- [ ] **Step 5: Write the failing migration test**

Assert both tables exist, revisions carry `version`, `constraints` JSONB and ownership FKs, and only one active primary row per account is permitted by a partial unique index. Assert revision `(target_id, version)` uniqueness and positive versions.

- [ ] **Step 6: Generate and complete the migration**

Model current mutable coordination fields on `job_targets` (`user_id`, `version`, `priority`, `state`, timestamps) and immutable snapshots on `job_target_revisions` (`user_id`, `target_id`, `version`, `priority`, `state`, `constraints`, timestamp). Add composite ownership keys/FKs and checks matching the contracts.

- [ ] **Step 7: Run database and type checks**

Run: `DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/database test`

Run: `pnpm --filter @job-copilot/contracts typecheck && pnpm --filter @job-copilot/database typecheck`

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/contracts packages/database
git commit -m "feat: define versioned job targets (#6)"
```

---

### Task 2: 实现证据候选方向与目标领域命令

**Files:**
- Create: `packages/domain/src/job-targets.ts`
- Create: `packages/domain/src/job-targets.test.ts`
- Create: `packages/domain/src/job-targets.integration.test.ts`
- Modify: `packages/domain/package.json`

**Interfaces:**
- Consumes: Task 1 contracts and `jobTargets`/`jobTargetRevisions`.
- Produces: `createJobTargetQueries({ db })` with `getOverview({ userId })` and `getActive({ userId })`.
- Produces: `createJobTargetCommands({ db, auditTrail, id, clock })` with `create`, `revise`, `deactivate`.
- Produces: stable `JobTargetError` codes `JOB_TARGET_NOT_FOUND`, `JOB_TARGET_VERSION_CONFLICT`, `JOB_TARGET_PRIMARY_LIMIT`, `JOB_TARGET_SECONDARY_LIMIT`.

- [ ] **Step 1: Write a failing pure suggestion test**

Given current trusted facts mentioning React/TypeScript, AI 应用 and Agent workflow, expect 3–5 ranked suggestions drawn from the MVP catalog `前端工程师`, `全栈工程师`, `AI 应用工程师`, `Agent 工程师`. Every returned suggestion must contain at least one actual current fact/revision identifier and a non-empty Chinese rationale. With no current trusted facts, expect no suggestion rather than invented evidence.

- [ ] **Step 2: Implement the minimal deterministic suggestion function**

Match normalized text from `name`/`summary`/language values against a small role catalog. Rank keyword matches deterministically; suggestions may reuse relevant evidence, but must not write to any table. Keep the function private to the module and test it through `getOverview` or a deliberately exported pure public function, not private-state mocking.

- [ ] **Step 3: Write one failing PostgreSQL integration test for creation limits**

Seed one account and confirmed profile facts, create one primary and two secondary targets, then assert a second primary and third secondary fail without writing revisions. Confirm suggestions are not persisted before `create` is called.

- [ ] **Step 4: Implement creation under the account advisory lock**

Validate contracts, acquire `acquireAccountAdvisoryLock`, count current active priorities, insert current row plus revision version 1 in one transaction, append a redacted audit event, then return the current overview.

- [ ] **Step 5: Write failing revision/deactivation/concurrency tests**

Assert revision with the current expected version appends version 2, stale version writes nothing, cross-account IDs return `JOB_TARGET_NOT_FOUND`, and deactivation appends a final inactive revision. Assert `getActive` omits inactive targets while `getOverview` retains them for history.

- [ ] **Step 6: Implement revision and deactivation minimally**

Use the account lock and conditional update on `(userId, targetId, version = expectedVersion)`. Recheck main/secondary counts when priority changes. Never update an existing revision.

- [ ] **Step 7: Run domain tests and typecheck**

Run: `DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain test -- job-targets`

Run: `pnpm --filter @job-copilot/domain typecheck`

- [ ] **Step 8: Commit Task 2**

```bash
git add packages/domain
git commit -m "feat: manage evidence-based job targets (#6)"
```

---

### Task 3: 暴露认证求职目标 REST API

**Files:**
- Create: `apps/api/src/job-targets/job-targets.tokens.ts`
- Create: `apps/api/src/job-targets/job-targets.controller.ts`
- Create: `apps/api/src/job-targets/job-targets.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/api.integration.test.ts`
- Modify: `apps/web/lib/server/api-client.ts`
- Modify: `apps/web/lib/server/api-client.test.ts`

**Interfaces:**
- Consumes: Task 2 queries/commands.
- Produces authenticated endpoints `GET /v1/job-targets`, `POST /v1/job-targets`, `POST /v1/job-targets/:targetId/revisions`, `POST /v1/job-targets/:targetId/deactivations`.
- Produces API client methods `getJobTargetOverview`, `createJobTarget`, `reviseJobTarget`, `deactivateJobTarget`.

- [ ] **Step 1: Write a failing authenticated API integration test**

Through Fastify injection, create confirmed profile facts, read candidate directions, create primary/secondary targets, revise constraints, reload and deactivate. Assert 201 for writes, 200 for reads, stable 409 problems for version/limit conflicts, 404 for hidden cross-account IDs, and no sensitive constraint value in error bodies.

- [ ] **Step 2: Implement module/controller/tokens minimally**

Use `SessionGuard`, `createZodDto`, `ZodResponse` and `ApiException` in the existing controller style. Map invalid request to 400, version/count errors to 409, missing/cross-account to 404. Register the module in `AppModule`.

- [ ] **Step 3: Extend the OpenAPI assertion**

Assert all four paths exist, carry bearer security and expose the same Zod response schema.

- [ ] **Step 4: Write failing API client tests**

Assert exact method/path/body/auth headers and invalid-response rejection for the new methods.

- [ ] **Step 5: Implement API client methods minimally**

Validate every successful response through `JobTargetOverviewSchema`; reuse existing `ApiClientError` handling.

- [ ] **Step 6: Run API/Web server tests and typechecks**

Run: `DOCKER_API_VERSION=1.51 pnpm --filter api test -- api.integration.test.ts`

Run: `pnpm --filter web test -- api-client.test.ts`

Run: `pnpm --filter api typecheck && pnpm --filter web typecheck`

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/api apps/web/lib/server
git commit -m "feat: expose job target API (#6)"
```

---

### Task 4: 交付求职目标页面与浏览器验收

**Files:**
- Create: `apps/web/lib/server/job-targets.ts`
- Create: `apps/web/lib/server/job-targets.test.ts`
- Create: `apps/web/app/(workbench)/profile/targets/page.tsx`
- Create: `apps/web/app/(workbench)/profile/targets/page.test.tsx`
- Create: `apps/web/app/api/job-targets/route.ts`
- Create: `apps/web/app/api/job-targets/[targetId]/revisions/route.ts`
- Create: `apps/web/app/api/job-targets/[targetId]/deactivations/route.ts`
- Create: `apps/web/components/workbench/job-targets-view.tsx`
- Create: `apps/web/components/workbench/job-targets-view.test.tsx`
- Modify: `apps/web/components/workbench/profile-import-view.tsx`
- Modify: `apps/web/components/workbench/profile-import-view.test.tsx`
- Modify: `apps/web/components/workbench/workbench-navigation.tsx`
- Modify: `apps/web/components/workbench/workbench-navigation.test.tsx`
- Modify: `apps/web/app/globals.css`
- Create: `apps/web/e2e/job-targets.spec.ts`

**Interfaces:**
- Consumes: Task 3 API client.
- Produces: authenticated RSC page `/profile/targets` and same-origin browser mutation routes.

- [ ] **Step 1: Write failing server/page tests**

Assert session redirect uses `/login?returnTo=%2Fprofile%2Ftargets`, authenticated first read passes the complete overview to `JobTargetsView`, and recoverable API failures show a fixed Chinese retry state without leaking internals.

- [ ] **Step 2: Implement server read and page shell minimally**

Follow the existing `/profile` RSC/error pattern and metadata style.

- [ ] **Step 3: Write failing component tests for the user flow**

Cover: 3–5 evidence-labelled candidate cards; select one as primary and up to two as secondary; manually replace the role family; enter seniority, locations, work modes, relocation, salary, industries and all deal-breaker types; save and render version; revise; deactivate; map 409 to “目标已在其他位置更新，请刷新后重试。”; reload-ready initial data; keyboard labels and 44px actionable controls.

- [ ] **Step 4: Implement same-origin mutation routes and `JobTargetsView`**

Candidate cards only prefill a controlled form. Saving calls the same-origin route and replaces local overview with the validated response. Manual target entry uses the same form. Do not introduce optimistic state that hides a failed write.

- [ ] **Step 5: Add a profile-page entry and nested navigation state**

When trusted profile facts exist, render a clear link “确认求职目标” to `/profile/targets`. Treat `/profile/targets` as part of the active “画像” navigation destination.

- [ ] **Step 6: Write and run the Playwright tracer bullet**

Create an isolated account through Dev Auth, seed trusted facts through the public profile API, open `/profile/targets`, select a primary and secondary direction, complete hard constraints, reload, revise, create a stale write through API, verify visible conflict, deactivate, and verify responsive/no-horizontal-scroll plus Axe on Desktop Chrome and Mobile Safari.

Run: `pnpm --filter web test:e2e -- job-targets.spec.ts`

- [ ] **Step 7: Run focused and full verification**

Run: `pnpm --filter web test -- job-targets-view.test.tsx job-targets.test.ts page.test.tsx`

Run: `pnpm typecheck`

Run: `DOCKER_API_VERSION=1.51 pnpm test`

Run: `pnpm --filter web test:e2e -- job-targets.spec.ts`

- [ ] **Step 8: Commit Task 4**

```bash
git add apps/web
git commit -m "feat: confirm primary and secondary job targets (#6)"
```

---

### Task 5: 完成双轴审查与分支验证

**Files:**
- Review all changes since merge-base with `origin/main`.
- Modify only files required to resolve review findings.

- [ ] **Step 1: Run `/code-review` Standards and Spec axes in parallel**

Fixed point: `origin/main`. Spec source: GitHub Issue #6 and its parent #1 target section. Standards sources: root `AGENTS.md`, `apps/web/AGENTS.md`, `PRODUCT.md`, `CONTEXT.md`, relevant ADRs, plus the code-review smell baseline.

- [ ] **Step 2: Resolve every Critical/Important or spec finding with focused tests**

Do not merge or close the issue. Append fixes as new commits on the feature branch.

- [ ] **Step 3: Run final branch verification**

Run: `pnpm typecheck`

Run: `DOCKER_API_VERSION=1.51 pnpm test`

Run: `pnpm --filter web test:e2e -- job-targets.spec.ts`

- [ ] **Step 4: Report branch as ready for user-approved merge**

Report commit list, files, public call chain, test counts, review findings and any rulings. Do not push, merge or close #6 without a separate user request.
