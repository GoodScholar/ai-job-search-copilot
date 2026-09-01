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

Task 9: complete (commits `4473524..0ed9933`; final independent Standards and Spec reviews both `0/0/0`; report `task-9-report.md`).

Task 10: Slice 9 Red/Green A–C 与串行验收已完成（`357e4a1..57ac9f3`；报告 `task-10-report.md`）；等待独立 Standards/Spec 审查。
Task 10: fix round 2/5 (6 addressed, 4 open — duplicate behavior lacked committed Red; fixed site/company assertions; canonical/final identity evidence; complete-run secret assertion; commits `dc47036..49f21bb`).
Task 10: Ruling: fix round 3 remains load-bearing and has a concrete non-guess path — dispatch a fresh `gpt-5.6-terra/high` implementer because project model authority forbids changing implementation to sol; obtain a committed behavior Red by temporarily restoring the old completed outcome, then restore stale Green. Cost if wrong: two extra audit-only commits remain in history, but production HEAD retains the approved stale semantics and the TDD evidence becomes reproducible.
Task 10: fix round 3/5 (4 addressed, 1 open — three new public assertions lacked independent mutation Red; commits `49f21bb..ec4fa53`).
Task 10: fix round 4/5 (query and canonical mutation Reds addressed; secret mutation Red still leaks adjacent relative run-detail href in Playwright source context; commits `ec4fa53..fad239e`).
Task 10: fix round 5/5 (secret mutation Red isolated in neutral helper; Standards and Spec both 0/0/0; commits `fad239e..8e7af1b`).
Task 10: full-slice review fix round 1 — accepted: recovered-candidate fixture base fail-closed, lockfile minimization, shared test phase policy. Ruling: a lexically unsafe provider URL that cannot produce `SafeNormalizedPublicJobUrl` must not be persisted as a Lead; the existing safe candidate rejected at cross-host fetch is the required unsafe-page rejected Lead. Ruling: authentic raw HTML evidence preserves page links; the binding capability rule forbids following/expanding them, not storing a faithful raw page. Cost if wrong: the reviewer may continue to interpret the derived Task 10 audit brief more strictly than the direct product/security decisions, requiring explicit supervisor adjudication.
Task 10: fix round 4/5 (3 addressed — query discriminator、canonical/final identity、complete run secret exclusion 均取得各自 committed mutation Red→Green；旧 secret Red `d8fe6ac..e64a260` 因 Playwright 相邻源码上下文含完整 placeholder 而 INVALID/SUPERSEDED 且其日志已删除，替代安全 pair `7d953c2..84e4e59`；报告 `task-10-report.md`)。
Task 10: fix round 5/5（最后的缺 key mutation Red 页面链接泄漏已修复；`7d953c2..84e4e59` INVALID/SUPERSEDED，替代 pair `842835e..b2d6519`，Red 禁词扫描 0 行，configured/missing-key Desktop/Mobile 4/4；报告 `task-10-report.md`）。
Task 10: audit/MinIO/phase regressions complete（`008418a..d68fe7e`；chain audit、page-only MinIO projection、ordinary/source-health Desktop+Mobile 回归均已记录；报告 `task-10-report.md`）。
Task 10: full-slice review fix round 1 complete（recovered fixed-base Red/Green `46f7510..7f2a61f`，shared phase-policy Red/Green `32e15ec..bb9b423`，minimal lockfile `1857a02`，direct ruling E2E clarification `a86515f`；报告 `task-10-report.md`）。
Task 10: recovered-base behavior evidence correction（`46f7510..7f2a61f` 仅 structural seam，committed mutation Red/Green `7190212..2bf3209` 以受控 extract transport 证明旧回退与 fixed-origin Green；报告 `task-10-report.md`）。
Task 10: full-slice review fix round 2 complete（独立审查 Standards `0/0/0`、Spec `0/1/0` 的唯一 lexical-unsafe provider diagnostic 问题；committed Red/Green `0101e65..1440394`，Adapter→Worker→workflow 仅传递有界拒绝计数并记录 query diagnostic；报告 `task-10-report.md`）。
Task 10: full-slice review fix round 2 boundary correction（committed Red/Green `2b53df2..b92f675`；冻结契约要求 query diagnostic ≤5，Worker/domain/aggregation 已收紧为5，provider/source issue 保持≤10；报告 `task-10-report.md`）。
Task 11: Final Review Fix Round 1 findings 1–7 implementation complete (`b7383f5..ebd4f30`); recovery initial Red invalid/superseded by committed mutation pair `5600757..53292b2`; report `task-11-report.md`. Scoped final acceptance pending fresh serial command log.
