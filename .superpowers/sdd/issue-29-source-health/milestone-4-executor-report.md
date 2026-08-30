# Issue 29 — Milestone 4 Executor Report

## Scope and design

Implemented only Milestone 4: a strict source-health overview contract; owner-bound domain query; authenticated API and Web BFF; and Watchlist, run, and Inbox diagnostics. No Processor, persistence, migration, API scheduling, Playwright, GitHub, or Milestone 5 work was added.

Read before implementation: `AGENTS.md`, `PRODUCT.md`, `CONTEXT.md`, ADRs 0006/0018/0022/0024/0030/0031, the Issue 29 task contract (Global constraints, Agreed seams, Milestone 4), `apps/web/AGENTS.md`, and the applicable TDD, Vercel React best-practices, shadcn, and verification skills. Before Web edits, read local Next documentation: `01-app/01-getting-started/06-fetching-data.md`, server/client component guidance, route-handler guidance, and accessibility guidance. The shadcn CLI was attempted, but its local dependency graph failed on Node 24 with `ERR_PACKAGE_PATH_NOT_EXPORTED` for Zod v3; this change reuses existing primitives and adds no new shadcn dependency.

## AC mapping and changed files

- `packages/contracts/src/agent-runs.ts`, tests: `JobSourceHealthOverviewSchema` has strict `targetId`, `watchlistVersion`, and bounded current projections.
- `packages/domain/src/source-health.ts`, `package.json`, `company-watchlists.integration.test.ts`: current Watchlist-derived Greenhouse identities, owner-bound lookup, deterministic `checkedAt,id` ordering, disabled override, and enabled-unchecked projection.
- `apps/api/src/company-watchlists/source-health.controller.ts`, module/tokens, API integration: authenticated `GET /v1/job-targets/:targetId/source-health`; owner/foreign target maps to the established 404 Problem details response.
- `apps/web/lib/server/api-client.ts` plus tests, `lib/server/source-health.ts` plus tests, and `app/api/.../source-health/route.ts` plus tests: strict upstream/response parsing, safe 401/404/502 BFF mapping, `no-store`, and session redirects.
- Watchlist page/view and tests: server-side `Promise.all` for Watchlist plus health; `id="source-health"`; seven textual statuses, last-check fallback, impact, exact action labels, and existing enable/disable control reconciliation.
- `agent-run-panel.tsx`: `completed_with_source_issues` is “岗位发现部分完成”, with issue count and diagnostic link; normal completed text is unchanged.
- `agent-inbox-panel.tsx`: `source_attention` uses “查看来源诊断” and “保留来源，稍后重试”; other kinds preserve their labels.

## RED → GREEN evidence

1. Contract overview RED: `pnpm --filter @job-copilot/contracts test -- agent-runs.test.ts` failed with `Cannot read properties of undefined (reading 'parse')`; GREEN after the strict overview schema: contracts suite `11 files, 98 tests` passed.
2. Domain health projection RED: the initial integration fixture failed because the Watchlist URL host was not in `allowedDomains` (`must be a public URL hosted by an allowed domain`); GREEN used the real Greenhouse host plus API host and `pnpm --filter @job-copilot/domain exec vitest run --no-file-parallelism src/company-watchlists.integration.test.ts -t '来源健康查询'` passed (`1 passed, 5 skipped`). It covers owner isolation, enabled unchecked, disabled override, and current identities.
3. Web BFF/server/UI seams RED probes were added before the final runs: invalid UUID/no session/upstream error, invalid parsed response, page health loader mock, seven diagnostic states, partial run, and source-attention labels. The focused GREEN command passed: `6 files, 49 tests`; subsequent BFF/client/UI focused command passed: `4 files, 39 tests`.
4. API auth/owner/404 seam RED probe was added to the existing integration app; GREEN: `pnpm --filter api exec vitest run src/api.integration.test.ts -t '来源健康概览'` passed (`1 passed, 42 skipped`).

## Verification

- `pnpm --filter web test`: **54 files, 269 tests passed**.
- `pnpm --filter @job-copilot/contracts test`: **11 files, 98 tests passed**.
- `pnpm --filter @job-copilot/source-access test`: **1 file, 39 tests passed**.
- Focused domain/API/Web commands above passed.
- `pnpm --filter @job-copilot/contracts typecheck`, `@job-copilot/domain typecheck`, `api typecheck`, `web typecheck`, and root `pnpm typecheck`: **all exit 0**.
- `git diff --check`: **exit 0**.
- `pnpm lint:web` and `pnpm build:web`: **both exit 0**; production build lists the new dynamic BFF route `/api/job-targets/[targetId]/source-health`.
- Full `pnpm --filter api test`: **exit 1**, one pre-existing OpenAPI assertion expects `oneOf` while current generated schema uses `anyOf` (`publishes the protected contract and standard problem schema`); new source-health integration test passed within that run.
- Full `pnpm --filter @job-copilot/database test`: **exit 1**, Testcontainers PostgreSQL failed before test execution with `Timed out after 10000ms while waiting for container ports to be bound to the host` (22 tests skipped). Docker cleanup left no test container running.
- Full domain suite was attempted repeatedly; the environment interrupted the command after startup. The targeted PostgreSQL domain test passed. No code change was made for the environmental interruption.

## Risks / follow-up

The two full-suite failures above remain external/baseline verification concerns; do not treat them as green. The domain query intentionally exposes only current, supported Greenhouse public sources—the only v3 source identity frozen by the contract. A fresh environment should rerun full domain/database/API suites once the Testcontainers port bind issue and the existing OpenAPI `oneOf` expectation are resolved.

## Commit

`feature: add source health diagnostics`（最终本地 HEAD）
