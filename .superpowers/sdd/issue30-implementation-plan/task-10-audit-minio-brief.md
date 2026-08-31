# Task 10 / Slice 9 — Chain Audit, MinIO Evidence, and Phase Regressions

You are the sole fresh `gpt-5.6-terra/high` Executor for the final implementation slice before whole-Slice-9 review. Work in the existing detached worktree from clean HEAD `8e7af1bbd50107c05c6c19a07af86cdd23fd63a3`. Do not create a worktree, branch, PR, push, merge, task, or sub-agent.

Read root `AGENTS.md`, Task 10 briefs/report, the current E2E spec/fixture server/local runtime, `layered-public-job-discovery-workflow`, `SecureJobPageFetcher`, Verified Gate, MinIO evidence store, and existing ordinary/source-health Playwright specs/config. Before every command confirm no other test/build process exists; all tests are strictly serial.

## Scope and public seams

Only three groups are in scope. Preserve all approved production behavior and existing Slice 9 0/0/0 fix evidence.

### A. Full validation-order and capability audit

At the Fake AnySearch public E2E seam, add a real failing Red first, then minimal Green test instrumentation that proves for each candidate which reaches verification:

1. safe candidate preflight occurs before `/extract`;
2. `/extract` occurs before local secure fetch;
3. local fetch reaches final/canonical validation before the Verified Gate persists the verified Lead/Attribution/source version;
4. an unsafe/policy-rejected candidate never reaches fetch/Gate;
5. links in provider search/extract text and in the HTML page cannot create additional provider requests, page requests, capabilities, Leads, or sources.

Use fixed test-only audit enums/IDs/fingerprints/counts only. Never record raw query, candidate/page URL, page link, user facts, provider title/snippet/extract text, credentials, or source identity JSON. Do not add non-official fields to the AnySearch request payload. Do not bypass the real preflight/fetch/Gate.

The order evidence must include explicit stable operations equivalent to `preflight → extract → fetch → final_canonical_validated → gate_persisted`, not merely infer `extract → page` from HTTP request order. Instrument only approved public/test seams and keep production runtime behavior unchanged.

### B. Real MinIO page-only evidence

From the E2E Node side, read the real MinIO object referenced by the verified Source Posting Version created by the journey. Use the local runtime's actual test MinIO configuration/env; if the Web package directly imports the MinIO client, add an explicit package dependency/devDependency rather than relying on a transitive or cross-package require.

The test may query/parse `raw_object_reference` internally only to locate the object, but failure output and durable audit must not expose its raw key/reference. Read the object and project safe booleans/hashes/counts proving:

- the stored evidence contains fixed text that exists only in the locally fetched verified job page;
- provider search title/snippet and `/extract` auxiliary text do not appear;
- anonymous credential fields/values (`username`, `password`, `api_key`) and the fixed test key do not appear;
- malicious links from search/extract/page do not appear as fetched source evidence or trigger extra requests;
- the official Source Posting/Version raw content remains page-derived and AnySearch remains attribution only.

Create a real committed Red that fails because the current E2E lacks/read path or page-only projection, then the minimal Green. Keep logs safe: failed assertions output booleans/counts/hashes only. Do not serialize the raw object or external text into logs.

### C. Phase regression and report truth

After A/B Green, run the existing ordinary phase and source-health phase focused Playwright regressions using the repo's actual versioned runner/config, Desktop Chrome and Mobile Safari as required. Prove:

- ordinary remains Fake v1 and does not select the AnySearch spec;
- source-health remains fixed v3 and does not select the AnySearch spec;
- AnySearch configured/missing-key phases still select only their tagged tests.

These phase-regression runs are validation, not new feature work; do not rewrite old adapters/specs.

Correct `task-10-report.md`: remove/replace the stale claim that Slice 9 made no production semantic changes. Accurately list the review-driven production changes already present (canonical cross-query Lead/Attribution dedup handling, v4 completed duplicate delivery returning `stale`, public Opportunity same-version replay not updating its snapshot) and distinguish them from test-only runtime changes. Record every invalid/overlapped/port-conflicted run as not evidence.

## TDD and deliverable

1. Commit Red A/B before Green implementation; run them and save complete safe logs. One combined Red is acceptable only if both audit and MinIO failures are independently observed without one masking the other.
2. Commit minimal Green; do not implement future features.
3. Strictly serial: configured/missing-key E2E 4/4, ordinary focused E2E, source-health focused E2E, relevant Web/Worker/Domain tests/typechecks, Drizzle, `git diff --check 0ed9933..HEAD`, and clean status. Never overlap Supervisor/Executor tests.
4. Append exact hashes, commands, browser counts, log paths, safe audit semantics, MinIO proof, phase-selection proof, invalid runs, changed files, and concerns to `.superpowers/sdd/issue30-implementation-plan/task-10-report.md`; commit the progress ledger and report.
5. Return only DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED, hashes, concise test summary, report path, concerns.

## Superseding direct product/security ruling — Full Review Fix Round 1

本说明中的“恶意链接不得出现在 fetched source evidence”不要求改写真实已抓取页面的 raw HTML。若页面原始 HTML 含 page link，Version 的 raw evidence 必须忠实保留；该 link 不得被跟随、不得扩展 capability，且不得出现在 visible text 或 provider-derived evidence。provider search/extract links 必须同时不在 raw/visible evidence 中。

若 provider URL 在 lexical preflight 时无法形成 `SafeNormalizedPublicJobUrl`，它不能形成 Lead、extract/fetch capability 或下游事实；仅保留 provider/query diagnostic。已安全规范化、但在跨 host redirect/fetch 时被拒绝的候选仍是唯一应持久化的 `POLICY_REJECTED` Lead，且没有下游。以上直接裁决优先于本 brief 的历史概述。
