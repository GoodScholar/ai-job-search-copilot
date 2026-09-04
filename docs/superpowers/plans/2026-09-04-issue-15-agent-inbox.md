# Issue #15 Task-Control Home and Agent Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the workbench home into an honest account-level task control surface and extend Agent Inbox to durable unread, read, and resolved items linked to candidate facts, runs, sources, recommendation lists, and calibration proposals.

**Architecture:** Keep Agent Inbox as the materialized authoritative delivery record. Producers create owner-bound items in the same transaction as their source records, while a deep inbox module derives safe copy and allowlisted internal links from structured references. The workbench home remains a read model over source-of-truth tables and does not own duplicate recommendation, profile, run, source-health, calibration, application, or chat state.

**Tech Stack:** TypeScript, Zod, Drizzle ORM, PostgreSQL 17, NestJS/Fastify, Next.js App Router, React, Tailwind CSS, Vitest, Testcontainers, Playwright, axe-core.

**Spec:** GitHub Issue `GoodScholar/ai-job-search-copilot#15`; product constraints in `PRODUCT.md`, `CONTEXT.md`, and ADRs 0006, 0016, 0018, 0027, 0030, 0031.

## Global Constraints

- Implement from fixed baseline `5cafc4f71392d221f21cdaa035ff74f85cfaf7fa`, which contains the accepted work for blockers #4, #10, #29, #13, and #14.
- Do not implement Issue #19 application persistence. The application count remains the truthful literal `0`, and the UI labels the capability as not yet enabled.
- Agent Inbox is the authoritative in-product delivery record; chat history must not become business state.
- Candidate facts cannot be represented as verified profile evidence until confirmed by the user.
- Only approved calibration proposals create a recommendation rule version.
- All links exposed by Inbox are allowlisted relative application paths derived by the server from owner-bound structured records.
- Ordinary logs, audit metadata, telemetry, and Inbox projections must not contain raw career documents, contact details, recommendation notes, full job descriptions, or model inputs.
- All mutations are owner-scoped, idempotent, and safe under retries and concurrent requests.
- New behavior follows strict TDD: add a test, run it and observe the expected failure, implement the minimum behavior, then rerun it to green.
- Desktop and mobile behavior must retain keyboard operation, visible focus, 44px touch targets, reduced-motion behavior, no horizontal overflow, and no critical or serious axe violations.

---

### Task 1: Generalize Agent Inbox persistence and contracts

**Files:**
- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/migrations/0039_task_control_agent_inbox.sql`
- Modify: `packages/database/migrations/meta/_journal.json`
- Modify: `packages/database/src/migrate.integration.test.ts`
- Modify: `packages/contracts/src/agent-inbox.ts`
- Modify: `packages/contracts/src/agent-inbox.test.ts`

**Interfaces:**
- Produces: persisted lifecycle `unread | read | resolved`, nullable `readAt` and `resolvedAt`, and owner-bound optional references for `candidateFactId`, `watchlistItemId`, `recommendationListId`, and `calibrationProposalId` while retaining optional run provenance.
- Produces: `AgentInboxItem` with `status`, `basis`, `impact`, `suggestedAction`, `target`, `availableActions`, `createdAt`, `readAt`, and `resolvedAt`.
- Produces: `AgentInboxActionCommand` action union containing existing run actions plus `mark_read` and `dismiss`.

- [ ] **Step 1: Write failing contract and migration tests**

Add literal fixtures proving that an unread candidate-fact item, read source item, unread recommendation item, unread calibration item, and resolved run item parse; reject arbitrary URLs, cross-kind references, inconsistent timestamps, and old `open` status. Extend migration coverage to prove existing `open` rows become `unread` and existing `resolved` rows remain resolved.

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter @job-copilot/contracts exec vitest run src/agent-inbox.test.ts && pnpm --filter @job-copilot/database exec vitest run src/migrate.integration.test.ts --no-file-parallelism`

Expected: contract tests fail because the new lifecycle and references do not exist; migration test fails because migration 0039 does not exist.

- [ ] **Step 3: Implement the minimum schema and contract**

Use a discriminated `target` contract so callers never construct free-form links:

```ts
type AgentInboxTarget =
  | { type: "candidate_fact"; candidateFactId: string; href: string }
  | { type: "agent_run"; runId: string; href: string }
  | { type: "job_source"; watchlistItemId: string; targetId: string; href: string }
  | { type: "recommendation_list"; recommendationListId: string; targetId: string; href: string }
  | { type: "calibration_proposal"; proposalId: string; targetId: string; href: string };
```

Database checks must encode valid lifecycle timestamps and valid reference combinations for each kind. Add partial unique indexes for one fact item per candidate fact, one recommendation item per list, one calibration item per proposal, and one source item per run/source pair.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run the same two commands and require exit code 0.

- [ ] **Step 5: Commit**

```bash
git add packages/database packages/contracts
git commit -m "feat: generalize task control inbox records (#15)"
```

### Task 2: Deepen the Inbox lifecycle and projection module

**Files:**
- Modify: `packages/domain/src/agent-inbox.ts`
- Modify: `packages/domain/src/agent-inbox.integration.test.ts`
- Modify: `apps/api/src/agent-inbox/agent-inbox.controller.ts`
- Modify: `apps/api/src/agent-inbox/agent-inbox.tokens.ts`
- Modify: `apps/api/src/api.integration.test.ts`
- Modify: `apps/web/lib/server/agent-inbox.ts`
- Modify: `apps/web/lib/server/agent-inbox.test.ts`
- Modify: `apps/web/app/api/agent-inbox/route.ts`
- Modify: `apps/web/app/api/agent-inbox/[itemId]/actions/route.ts`
- Modify: corresponding route tests

**Interfaces:**
- Consumes: Task 1 lifecycle and typed targets.
- Produces: `list({ userId, status?: "unread" | "read" | "resolved" | "pending" })` where `pending` returns unread plus read items in stable newest-first order.
- Produces: idempotent `mark_read`, existing run actions, and `dismiss` through the existing action endpoint.

- [ ] **Step 1: Write failing domain and HTTP tests**

Cover owner isolation, unread-to-read, read-to-resolved, repeated action IDs, conflicting action reuse, resolved immutability, pending listing, stable ordering, server-derived allowlisted targets, and the presence of non-sensitive `basis`, `impact`, and `suggestedAction` for every kind.

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter @job-copilot/domain exec vitest run src/agent-inbox.integration.test.ts --no-file-parallelism && pnpm --filter api exec vitest run src/api.integration.test.ts && pnpm --filter web exec vitest run lib/server/agent-inbox.test.ts app/api/agent-inbox/route.test.ts app/api/agent-inbox/'[itemId]'/actions/route.test.ts`

Expected: failures identify the missing lifecycle, projections, query filter, and action behavior.

- [ ] **Step 3: Implement the minimum deep module and adapters**

Keep callers on two operations only:

```ts
type AgentInbox = {
  list(input: { userId: string; status: "unread" | "read" | "resolved" | "pending" }): Promise<AgentInboxList>;
  act(input: { userId: string; requestId: string; itemId: string; command: AgentInboxActionCommand }): Promise<AgentInboxActionResponse>;
};
```

Projection copy must be derived from structured reason codes and immutable/source records, never from user notes or raw content. Preserve existing restart/resume/cancel semantics.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run the same commands and require exit code 0.

- [ ] **Step 5: Commit**

```bash
git add packages/domain apps/api apps/web/lib/server apps/web/app/api/agent-inbox
git commit -m "feat: add durable inbox reading lifecycle (#15)"
```

### Task 3: Materialize and resolve fact, source, recommendation, and calibration items

**Files:**
- Modify: `packages/domain/src/career-imports.ts`
- Modify: relevant career import integration test
- Modify: `packages/domain/src/profile-review.ts`
- Modify: `packages/domain/src/profile-review.integration.test.ts`
- Modify: `packages/domain/src/job-discovery-persistence.ts`
- Modify: relevant discovery persistence integration test
- Modify: `packages/domain/src/deep-match-persistence.ts`
- Modify: `packages/domain/src/deep-match-persistence.integration.test.ts`
- Modify: `packages/domain/src/recommendation-feedback.ts`
- Modify: `packages/domain/src/recommendation-feedback.integration.test.ts`
- Modify: existing agent-run inbox producers and their focused tests as required by Task 1 constraints

**Interfaces:**
- Consumes: Task 1 persistence and Task 2 lifecycle.
- Produces: one durable unread item for each new pending candidate fact, each attention-requiring source check, each published recommendation list, and each created calibration proposal.
- Produces: atomic resolution when a candidate fact or calibration proposal reaches a terminal user decision.

- [ ] **Step 1: Write failing producer integration tests**

Prove creation is same-transaction, retry-safe, and owner-bound. Prove profile confirm/correct/reject and calibration approve/reject resolve the corresponding item, while calibration revision/rebase does not resolve it. Prove source issues are per affected Watchlist source and recommendation publication creates only one item per immutable list.

- [ ] **Step 2: Run tests to verify RED**

Run the named domain integration test files serially with `--no-file-parallelism` and observe missing Inbox rows or unresolved lifecycle assertions.

- [ ] **Step 3: Implement minimal transactional writes**

Insert Inbox rows inside existing transactions, using `onConflictDoNothing()` only where the matching unique constraint defines replay identity. Update only the owner-bound Inbox reference when a source object reaches a terminal user decision.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run all modified domain integration files serially and require exit code 0.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat: deliver structured work items to inbox (#15)"
```

### Task 4: Build the account-level workbench home read model

**Files:**
- Modify: `packages/contracts/src/workbench.ts`
- Modify: `packages/contracts/src/contracts.test.ts`
- Modify: `packages/domain/src/workbench-home.ts`
- Modify: `packages/domain/src/workbench-home.integration.test.ts`
- Modify: `apps/api/src/workbench/*`
- Modify: `apps/api/src/api.integration.test.ts`
- Modify: `apps/web/lib/server/workbench.ts`
- Modify: `apps/web/lib/server/workbench.test.ts`

**Interfaces:**
- Produces summary counts `todayRecommendations`, `pendingFacts`, `activeAgentRuns`, `failedAgentRuns`, `sourceFailures`, `pendingDecisions`, and literal `applications: 0` with `applicationsAvailable: false`.
- Uses an injected clock and `Asia/Shanghai` calendar date for deterministic daily recommendation counting.

- [ ] **Step 1: Write failing read-model tests**

Seed two accounts, multiple targets, old/current list sequences, source checks with newer replacements, active/failed/completed runs, unread/read/resolved Inbox items, and pending/resolved calibration. Assert only owner-bound current data contributes. Assert zero-valid-results and disabled sources do not count as failures.

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter @job-copilot/contracts exec vitest run src/contracts.test.ts && pnpm --filter @job-copilot/domain exec vitest run src/workbench-home.integration.test.ts --no-file-parallelism`

Expected: new fields and real counts are absent.

- [ ] **Step 3: Implement the read model**

Use bounded aggregate queries and validate every database count as a non-negative safe integer. Do not query or create an application table.

- [ ] **Step 4: Run focused contract, domain, API, and BFF tests**

Require all focused commands to exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/domain apps/api/src/workbench apps/web/lib/server/workbench*
git commit -m "feat: aggregate the task control home (#15)"
```

### Task 5: Render the task-control home with partial failure and offline recovery

**Files:**
- Modify: `apps/web/app/(workbench)/home/page.tsx`
- Modify: `apps/web/app/(workbench)/home/page.test.tsx`
- Modify: `apps/web/app/(workbench)/home/loading.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.test.tsx`
- Modify: `apps/web/components/workbench/agent-inbox-panel.tsx`
- Modify: `apps/web/components/workbench/agent-inbox-panel.test.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: Task 2 Inbox list/actions and Task 4 workbench summary.
- Produces: independent section availability, explicit stale/offline state, and automatic `router.refresh()` on reconnection.

- [ ] **Step 1: Read the applicable frontend design, shadcn, and React performance skill instructions**

Record any binding implementation constraints in the SDD report before editing.

- [ ] **Step 2: Write failing component and page tests**

Cover the decision-first heading, all summary facts, unavailable applications copy, unread/read/resolved filters, basis/impact/action/rejection copy, honest empty state, one rejected parallel read without hiding successful sections, auth redirect preservation, offline banner, online refresh, semantic landmarks, focus restoration after an action, and reduced-motion-safe styling.

- [ ] **Step 3: Run tests to verify RED**

Run: `pnpm --filter web exec vitest run app/'(workbench)'/home/page.test.tsx components/workbench/workbench-home-view.test.tsx components/workbench/agent-inbox-panel.test.tsx app/globals.test.ts`

Expected: the existing ledger-oriented view lacks the new task-control behavior.

- [ ] **Step 4: Implement the minimum UI**

Use `Promise.allSettled` or an equivalent typed result at the page composition seam. Preserve successful server data when a sibling read fails. Use native semantic controls and existing visual tokens before adding new CSS. Do not add a conversation input, message table, or free-form action URL.

- [ ] **Step 5: Run focused tests to verify GREEN**

Run the same command and require exit code 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat: complete the task control home (#15)"
```

### Task 6: Add authenticated desktop and mobile acceptance journeys

**Files:**
- Create: `apps/web/e2e/workbench-inbox.spec.ts`
- Modify: existing E2E support only when required for deterministic fixtures

**Interfaces:**
- Consumes: public Web, BFF, API, Worker, PostgreSQL, Redis, and MinIO seams from Tasks 1-5.
- Produces: one deterministic Fake-backed acceptance suite for Issue #15.

- [ ] **Step 1: Write the Playwright journeys**

Create three independent owner-scoped scenarios that start on `/home`: resolve one candidate fact, defer or disable one failed source, and reject one calibration proposal while proving the active rule remains unchanged. Include unread/read/resolved transitions, no-pending state, keyboard flow, mobile tap flow, 44px touch targets, no horizontal overflow, reduced motion, and axe critical/serious checks.

- [ ] **Step 2: Run the new tests and observe RED**

Run Desktop Chrome first and confirm failures correspond to missing or incorrectly integrated behavior rather than fixture errors.

- [ ] **Step 3: Make only fixture or integration corrections required by the public journey**

Do not add test-only production endpoints or public network access.

- [ ] **Step 4: Run Desktop Chrome and Mobile Safari to GREEN**

Run: `DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- workbench-inbox.spec.ts --project 'Desktop Chrome' --project 'Mobile Safari'`

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e apps/web
git commit -m "test: cover task control inbox journeys (#15)"
```

### Task 7: Full verification and issue delivery

**Files:**
- Modify only files required to fix failures reproduced by a failing test.

**Interfaces:**
- Consumes: all Issue #15 implementation commits.
- Produces: fresh verification evidence and a clean fixed-baseline review package.

- [ ] **Step 1: Run full verification**

Run, serializing container-heavy suites where the project requires it:

```bash
DOCKER_API_VERSION=1.51 pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm --filter @job-copilot/database exec drizzle-kit check --config=drizzle.config.ts
git diff --check 5cafc4f71392d221f21cdaa035ff74f85cfaf7fa..HEAD
git status --short
```

- [ ] **Step 2: Run broad Standards and Spec review**

Review the entire fixed-baseline range against repository standards and every Issue #15 acceptance criterion. Fix each Critical or Important finding through a tested fix round and scoped re-review.

- [ ] **Step 3: Record delivery**

After every gate passes, add an Issue comment containing the fixed baseline, final HEAD, review verdicts, acceptance evidence, exact command outcomes, and confirmation that no push, PR, or merge occurred. Close Issue #15.
