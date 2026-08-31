# SDD ledger — plan: .superpowers/issue30-implementation-plan.md

Baseline: `3a1a3940773921a1a03c3b25ea7baa378c025e83`
Spec authority: GitHub Issue #30, parent Issue #1, root `AGENTS.md`, `PRODUCT.md`, `CONTEXT.md`, relevant ADRs, and supervisor approval messages dated 2026-08-30.
Model authority: `gpt-5.6-sol/high` for planning/final review; `gpt-5.6-terra/high` for implementation/tests/fixes.

## Pre-flight consistency scan

| Scope | Producer → consumer | Finding |
| --- | --- | --- |
| Task 1 | ADR/CONTEXT/tracked plan agree internally | Consistent: domain concepts remain implementation-free; the ADR alone carries the capability decision. |
| Task 2 | v4 contract tests → immutable exported unions | Consistent: additive v4 only; explicit v1–v3 compatibility tests match the code requirement. |
| Task 3 | query-plan behavior tests → deterministic snapshots | Consistent: all limits and privacy exclusions have independent literal expectations. |
| Task 4 | source-access tests → shared verifier/API adapter | Consistent: the public seam owns safety/classification while API remains a thin consumer. |
| Task 5 | adapter tests → AnySearch boundary | Consistent: official HTTP status classification and strict envelope parsing do not require message matching. |
| Task 6 | migration/repository tests → Lead/Attribution persistence | Consistent: transaction/constraint requirement matches owner-bound association tests. |
| Task 7 | domain/integration tests → verified persistence gate | Consistent: only VerifiedJobPage crosses the gate; rejection assertions cover all downstream absence. |
| Task 8 | processor/workflow tests → durable v4 workflow | Consistent: physical-call budgets, partial failure, cancellation and replay requirements share one public run seam. |
| Task 9 | runtime integration tests → resolver/scheduler wiring | Consistent: v4 production wiring remains additive and preserves legacy fake/v3 phases. |
| Task 10 | Playwright acceptance → Fake AnySearch runtime | Consistent: only the external provider is faked; end-to-end assertions exercise user-observable run behavior. |
| Task 11 | full commands + independent review → acceptance | Consistent: review baseline is fixed and every severity must be zero on both axes. |
| Task 12 | evidence + status → Issue close | Consistent: external mutation is delayed until all objective gates pass. |
| Tasks 1 → 2–10 | approved vocabulary/capability → all implementation seams | No conflict: later tasks must use the frozen names and single-URL/single-validation authority. |
| Tasks 2 → 3, 5–10 | v4 contracts → planner/adapter/persistence/workflow/runtime/E2E | No conflict: contracts are additive and downstream tasks consume v4 without modifying v1–v3. |
| Tasks 3 → 8–10 | query snapshots → workflow/runtime/E2E | No conflict: versioned fixed allowlist and caps are the shared boundary. |
| Tasks 4 → 7–10 | shared verifier → persistence gate/workflow/runtime/E2E | No conflict: local safe fetch remains authoritative after untrusted extract. |
| Tasks 5 → 8–10 | AnySearch adapter → workflow/runtime/E2E | No conflict: each adapter request exposes one physical-call hook and stable redacted error. |
| Tasks 6 → 7, 8, 10 | Lead/Attribution repository → gate/workflow/E2E | No conflict: the transaction owns normalized Lead state and verified Attribution linkage. |
| Tasks 7 → 8, 10 | verified persistence gate → workflow/E2E | No conflict: workflow can persist only through this bridge. |
| Tasks 8 → 9, 10 | durable workflow → runtime/E2E | No conflict: runtime wiring selects the already-tested workflow rather than duplicating it. |
| Tasks 9 → 10 | Fake runtime wiring → Playwright | No conflict: dedicated phase preserves existing ordinary/source-health phases. |
| Tasks 2–10 → 11 | implementation + focused evidence → whole-branch verification | No conflict: Task 11 re-runs fresh suites and reviews the cumulative fixed-baseline diff. |
| Tasks 1–11 → 12 | complete implementation/review → GitHub evidence | No conflict: clean worktree and issue closure are terminal gates only. |

Provider-contract gate: CLEARED by official AnySearch API Reference. HTTP 402 is authoritative quota classification; HTTP 429 is authoritative rate-limit classification. JSON symbol field location remains unspecified and must not be guessed. `message` is never a classifier.

Task 1: complete (commits `3a1a394..cefdca1`, review clean)

Task 2: fix round 1/5 (7 addressed, 2 open — encoded URL value bypass; HTTP 402/429 reverse binding; commits `07b1628..4fe7f36`)
Task 2: fix round 2/5 (3 addressed, 0 open — URL value policy; HTTP reverse binding; dead schema; commit `4768e5c`)
Task 2: complete (commits `cefdca1..4768e5c`, review clean)

Task 3: Ruling: max-500 company query discriminator conflict — use supervisor A′: retain full role/company, then only whole site tokens that fit; structured domains are local candidate-host enforcement, never an AnySearch provider filter. Cost if wrong: recall may lose some `site:` hints at maximum input lengths, while local safety and attribution remain enforced.
Task 3: fix round 1/5 (6 addressed, 0 open — domain cap/fingerprint, Watchlist identity, fixed policy isolation, max-length A′, UUIDv8, behavior Red; commit `1ef0f87`)
Task 3: complete (commits `4768e5c..1ef0f87`, review clean)

Task 4: fix rounds 1–9 complete (hidden inline CSS/cascade, conservative detail-vs-list classification, canonical safety, regression migration; commits `dd10962..809fea4`)
Task 4: complete (commits `1ef0f87..809fea4`, independent review Critical/Important/Minor `0/0/0`)

Task 5: fix rounds 1–4 complete (lexical preflight, serializable/recoverable capability, immutable URL policy, deterministic batch issuance, strict public PSL/private-tenant boundary, manual redirect, explicit durable decisions, `.arpa` exclusion; commits `2d0fb68..0dfe028`)
Task 5: complete (commits `809fea4..0dfe028`, independent review Critical/Important/Minor `0/0/0`)

Task 6: complete (commits `f59e2a8..b56c3f1`; fix round 1 closed 3 Important / 2 Minor; independent Standards and Spec reviews both `0/0/0`)

Acceptance baseline note: Task 5a lifecycle repair received an independent 0/0/0 code review. A final fresh serial run at HEAD `2152048` with `DOCKER_API_VERSION=1.51 pnpm --filter worker test` passed 20/20 files and 256/256 tests in 87.01 seconds. The earlier afterAll timeout and independent Testcontainer port-binding failure remain recorded as historical diagnostics; no timeout increase or manual resource cleanup was used. Task 6 may proceed.

Task 8: complete (commits `768b8c6..4473524`; final independent Standards and Spec reviews both `0/0/0`)

Task 9: in progress from clean Slice 7 HEAD `4473524`; execution brief: `task-9-brief.md`
