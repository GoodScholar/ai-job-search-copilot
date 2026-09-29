# Issue #61 PR Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update PR #67 onto the latest `origin/main` without importing local Issue #71 or recovery-branch work, while preserving the reviewed production job-normalization behavior.

**Architecture:** Merge the remote base into the existing feature branch instead of rebasing or rebuilding its reviewed commits. Resolve overlap by composing the mainline Alpha/instrumentation behavior with Issue #61's versioned normalization, evidence, budget, cancellation, and discovery-persistence boundaries; any newly discovered behavioral defect must follow RED-GREEN-REFACTOR before its fix.

**Tech Stack:** pnpm workspace, TypeScript, NestJS, Drizzle/PostgreSQL, BullMQ/Redis, Vitest, Playwright, OpenAI Responses adapter.

**Spec:** GitHub Issue #61 (`https://github.com/GoodScholar/ai-job-search-copilot/issues/61`), plus `PRODUCT.md`, `CONTEXT.md`, and `docs/adr/0017-use-one-model-provider-adapter-in-v1.md`, `docs/adr/0018-budget-every-agent-run.md`, `docs/adr/0019-use-openai-responses-for-local-beta.md`, `docs/adr/0023-use-two-stage-job-ranking.md`, `docs/adr/0024-separate-source-postings-from-job-opportunities.md`, `docs/adr/0028-isolate-untrusted-career-content.md`, `docs/adr/0029-gate-model-changes-with-evaluations.md`, `docs/adr/0030-record-redacted-agent-run-audits.md`, and `docs/adr/0033-use-layered-verified-public-job-discovery.md`.

## Global Constraints

- Use `origin/main`, never the locally ahead `main`, as the PR baseline.
- Keep commit `b1b21b3` and branch `codex/recover-mixed-main-2026-09-29` out of PR #67.
- Update the existing branch `codex/issue-61-production-job-normalizer` and PR #67; do not create a replacement PR.
- Preserve Fake as the default test seam and require explicit credentials/command for the real Responses adapter.
- Treat job content as untrusted data; unknown fields remain unknown and usable normalized fields retain immutable source evidence.
- Run overlapping tests serially; no Supervisor/Executor test overlap is valid evidence.

## Review Focus

- A normalized field whose evidence path/value does not match the current source snapshot must be rejected before qualification or matching.
- Cancellation, timeout, rate limit, unknown usage, and exhausted budget must keep stable redacted terminal/retry semantics.
- Trusted ATS/company pages, URL imports, Markdown imports, and text imports must share the same normalization contract without Fake-only inferred fields.
- Mainline journey metrics, run-control, and Alpha acceptance behavior must survive the merge unchanged.
- Migration ordering and journal entries must remain deterministic when mainline and Issue #61 both add migrations after the old merge base.

---

### Task 1: Reconcile PR #67 with the latest remote base

**Files:**
- Modify: `apps/web/e2e/one-click-recommendation.spec.ts`
- Modify: `apps/worker/src/agent-runs/agent-run.module.ts`
- Modify: `apps/worker/src/agent-runs/job-discovery-adapter-resolver.test.ts`
- Modify: `packages/contracts/package.json`
- Modify: `packages/database/migrations/meta/_journal.json`
- Modify: `packages/domain/src/job-discovery-persistence.ts`
- Verify: every other auto-merged file in `git diff origin/main...HEAD`

**Interfaces:**
- Consumes: `origin/main@a6236ca` Alpha integration and PR head `c831bde` production normalizer behavior.
- Produces: one conflict-free branch containing both sets of behavior, with no ancestry from local Issue #71 or the recovery branch.

- [x] **Step 1: Record the pre-merge safety evidence**

Run: `git status --short --branch && git merge-base --is-ancestor b1b21b3 HEAD`
Expected: clean Issue #61 branch and a non-zero ancestry check for `b1b21b3`.

- [x] **Step 2: Merge `origin/main` without committing and resolve only the six reported conflicts**

Run: `git merge --no-ff --no-commit origin/main`
Expected: conflicts only in the six files listed above; combine rather than discard independently reviewed behavior.

- [x] **Step 3: Verify the reconciled seams**

Run: `pnpm --filter @job-copilot/contracts test && pnpm --filter worker exec vitest run src/agent-runs/job-discovery-adapter-resolver.test.ts src/agent-runs/run-preflight.test.ts src/agent-runs/job-posting-normalizer-resolver.test.ts --no-file-parallelism && pnpm --filter @job-copilot/domain exec vitest run src/job-discovery-persistence.integration.test.ts src/discovery-job-normalization.test.ts src/trusted-job-normalization.test.ts --no-file-parallelism`
Expected: all selected regression suites pass serially.

- [x] **Step 4: Commit the merge and plan**

Run: `git add <resolved files> docs/superpowers/plans/2026-09-29-issue-61-pr-refresh.md && git commit`
Expected: one merge commit whose second parent is `origin/main@a6236ca`.

### Task 2: Review the complete Issue #61 branch and repair blocking findings

**Files:**
- Modify: only files required by Critical/Important review findings.
- Test: add the smallest regression test beside the affected production seam before each behavioral fix.

**Interfaces:**
- Consumes: Task 1's merged branch and GitHub Issue #61 acceptance criteria.
- Produces: separate Standards and Spec findings, with every Critical/Important finding fixed through observed RED then GREEN.

- [x] **Step 1: Run the Standards and Spec reviews independently against `origin/main...HEAD`**

Run: two fresh review agents using the repository standards/smell baseline and Issue #61 respectively.
Expected: separate reports with file/hunk evidence and no cross-axis reranking.

- [x] **Step 2: For each blocking finding, add a failing regression test**

Run: the narrowest affected Vitest/Playwright command before changing production code.
Expected: FAIL for the reviewed defect, not for setup or syntax.

- [x] **Step 3: Apply the minimal fix and rerun the affected suite**

Run: the same narrow command followed by its owning package suite.
Expected: GREEN with no warnings or unrelated failures introduced.

- [x] **Step 4: Commit the review fix pass**

Run: `git commit -m "fix: address issue 61 review findings"` when changes exist.
Expected: one focused fix commit; no commit when both axes are clean.

### Task 3: Complete serial acceptance and update the existing PR

**Files:**
- Modify: PR #67 body/status only as needed to reflect fresh evidence.
- Modify: Issue #61 labels/state only after acceptance is complete.

**Interfaces:**
- Consumes: Task 2's reviewed branch.
- Produces: fresh full-suite evidence, a pushed PR #67 with a clean merge state, and Issue #61 closure linked to that PR.

- [ ] **Step 1: Run the repository's full deterministic acceptance serially**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: every command exits 0; if infrastructure causes an unrelated failure, preserve the complete log, diagnose it, and rerun only after confirming no overlapping process remains.

- [ ] **Step 2: Run the production-normalizer evaluation boundary**

Run: `pnpm --filter @job-copilot/contracts test -- job-normalizer-evaluation && pnpm --filter @job-copilot/model-access test -- job-normalizer`
Expected: the versioned evaluation contract and production adapter tests pass; the credentialed live command remains explicit and is not silently substituted by Fake.

- [ ] **Step 3: Prove branch isolation and push the existing branch**

Run: `git merge-base --is-ancestor b1b21b3 HEAD; git merge-base --is-ancestor codex/recover-mixed-main-2026-09-29 HEAD; git push origin codex/issue-61-production-job-normalizer`
Expected: both ancestry checks are non-zero and the existing remote branch advances without force-push.

- [ ] **Step 4: Refresh PR #67 and close Issue #61 only after GitHub reports the PR mergeable**

Run: `gh pr view 67 --repo GoodScholar/ai-job-search-copilot --json mergeable,mergeStateStatus,statusCheckRollup,url`
Expected: PR #67 is mergeable with fresh verification summarized; Issue #61 is closed with a completion comment and no duplicate PR is created.
