# SDD ledger — plan: docs/superpowers/plans/2026-09-05-issue-50-model-diagnostics.md

- Approved: user confirmed conversation implementation_plan on 2026-09-05.
- Base: 5447917bfe3b87e5935b2b278cf25e8340b99e55; branch codex/issue-50-model-diagnostics.
- Original checkout documents tracked by /tmp/issue50-original-doc-hashes.json; leave them unchanged.
- Baseline complete: runtime 40 + workspace 1698 tests passed, exit 0. Logs /tmp/issue50-baseline-install.log and /tmp/issue50-baseline-tests.log. Only baseline Terra executed tests and confirmed no residual processes.

## Pre-flight scan
| Tasks | Shared file/interface | Check and ruling |
| --- | --- | --- |
| 1 / 2 | ModelDiagnosticProbeResult and database persistence | Four individual check statuses were absent in draft; add fixed checks object to DTO and persisted states. |
| 1 / 3 | ModelDiagnosticResponse and page | Safe response must include four check results; never expose fingerprint/model identifiers. |
| 2 / 3 | get()/run() and polling | GET must reflect active shared lock as checking; no external call on GET. |
| 1 | API type vs contract tests | Add passed/failed/not_verified statuses as approved; only mark passed from complete evidence. |
| 2 | API input and persistence | Reject nonempty POST body; no-store header on both methods; checks object is allowed stable state. |
| 3 | Final tests vs concurrency constraint | Replace root pnpm test with runtime + recursive workspace-concurrency=1 sequence; only designated Terra executes all tests. |

Ruling: retain fixed 20s overall deadline and no redirects/retries; each diagnosis makes at most two synthetic calls. Small probe reasoning none and max_output_tokens 256 are verified against official model docs and included in fingerprint.
Ruling: implementation remains diagnostics only; no production conversion of existing Fake career/deep-match business flows.
Ruling: final delivery follows #49 precedent: local main fast-forward with original user documents preserved, record acceptance and close #50, no push.

## Task 1 review round 1
- Fix: raw Responses HTTP success must parse `output[].content[]` output text/refusal instead of an SDK-only convenience shape.
- Fix: mixed results must aggregate each check from evidence across both model probes; absence or contradiction stays `not_verified`.
- Fix: measure elapsed time and expose all non-timeout latency buckets.
- Fix: an already-aborted caller signal makes zero external requests and returns a stable timeout result.
- Fix: stable non-retryable 4xx maps to `MODEL_DIAGNOSTIC_FAILED`; add raw Error redaction coverage.
- Root finding: restore unrelated `pnpm-lock.yaml` peer-resolution churn and keep only the new workspace importer needed by Task 1.
- Ruling on reviewer item 5: no rename to `overall`. The approved public contract and Task 1 brief use `status`; “overall” described the semantic overall state, not a literal second field. Adding or renaming it would create an unapproved duplicate and break the plan's strict DTO.

## Task 1 review round 2
- Open: any authentication failure dominates all later check evidence; `modelAvailability`, `structuredOutput`, and `timeout` must be `not_verified` even when the sibling request returns another failure.
- Open: a completed raw Responses payload may contain reasoning items alongside one message/output-text item; accept exactly one valid output-text part across the output collection, reject any refusal or conflicting/multiple output-text parts, and do not require `output.length === 1` or `content.length === 1`.

Task 1: complete — commits `70e0dfc`, `ce4e8a2`, `ead3b47`; focused final evidence: contracts 4, model-access 39, two typechecks and diff-check passed. Sol task review approved after two fix rounds.

## Task 2 review round 1
- Fix: enforce the 20-second boundary in the domain coordinator itself so a non-cooperative Adapter cannot hold the transaction/advisory lock forever.
- Fix: add deployment configuration for both model IDs and pass it to the production Adapter so those changes alter the fingerprint and invalidate cache.
- Fix: set `Cache-Control: no-store` before guards/handler failures, including authenticated 400 and unauthenticated 401 responses.
- Fix tests required by the brief: non-cooperative Adapter timeout, success resetting failure backoff, every effective configuration dimension, unauthenticated POST, error no-store, all stable Chinese projections, and sensitive sentinel response/log scanning.
- Minor accepted for this fix: limit failure-history reads to the six records needed by the capped backoff.
- Test incident: two overlapping domain test commands were terminated and their results invalidated. Root confirmed no residual processes; the executor identified an ambiguous command completion as the cause and thereafter used one synchronous process at a time. Fresh accepted evidence so far: database 26, domain/runtime 9, API 56.

## Task 2 review round 2
- Implementation findings from round 1 are addressed; remaining blockers are test credibility and required security coverage.
- Fix the lock-release test by advancing the clock through retryAt, using another database connection, and proving a second Adapter call returns available.
- Add a testing-only diagnostic-version input to the internal Adapter factory so the fingerprint behavior across probe-version changes is observable without changing the production constructor.
- Add API response and captured-logger sentinel scans that prove secrets cannot be hidden in otherwise allowed response fields.
- Replace generic “contains Chinese” assertions with an exact expected mapping for every reason code: summary, impact, and suggested actions.

Task 2 review round 2: complete pending Sol review — `store:false` and testing-only diagnostic-version fingerprint seam added; cross-connection timeout/lock release, exact Chinese projection mapping, and API response/logger secret sentinel coverage added. Fresh serial evidence: model-access 40, domain/runtime 11, API 56; all exited 0 with no residual test processes before each command.

## Task 2 final review
- Approved by the designated Sol reviewer after the API integration test proved all nine secret classes traverse the real Nest/domain paths and remain absent from every response and captured initialization/runtime log.
- Task 2 complete — commits `de900ce`, `fe30224`, `b5633ec`, `708f5b4`; latest focused evidence: model-access 40, domain/runtime 11, API integration 54, database 26, relevant typechecks and diff-check passed.

## Task 2 review round 3
- Reviewer found the prior API sentinel test still used the test Fake Adapter, so neither its `configurationFingerprint` nor raw provider error reached the domain coordinator; the high-model sentinel also was not independently scanned.
- TDD RED: the real HTTP POST returned Fake `available` where the strengthened test required safe `MODEL_DIAGNOSTIC_FAILED` (API focused test exit 1). GREEN: TestingModule-only `MODEL_DIAGNOSTICS` override constructs the real domain coordinator around an Adapter that persists the actual fingerprint sentinel and throws a raw provider-response sentinel. The test proves the error path, one Adapter invocation, and the persisted fingerprint before scanning all nine independent sentinels across authenticated GET/POST, 400, 401, and captured application logs.
- Fresh serial evidence: API focused 54/54 exit 0; domain typecheck exit 0; API typecheck exit 0; `git diff --check` exit 0. A pre/post `ps` check found no residual vitest/pnpm test process. Earlier overlapping results remain invalid and are not cited.

## Task 2 review round 3 follow-up
- Reviewer found the first round-3 test Adapter was fixed and logger capture started only after compile, so configuration sentinels and initialization logging were not credible coverage.
- TDD RED: after authenticated POST, the strengthened test observed `diagnosticAdapterInput === undefined` (API focused exit 1). GREEN: `MODEL_DIAGNOSTICS` now uses a TestingModule-only factory injected with `DATABASE` and `RUNTIME_CONFIG`; it feeds all six real runtime configuration fields into the throwing Adapter and its exception, while preserving the independent persisted fingerprint. `.setLogger` before compile and the Fastify logger use the same completed capture double, so the nine-sentinel scan covers initialization plus request logs and all HTTP paths.
- Fresh serial evidence: API focused 54/54 exit 0, API typecheck exit 0, diffcheck exit 0, with `ps` showing no residual vitest/pnpm test process before and after. Earlier overlapping results remain invalid.

## Task 3 executor

- RED：新增 web server client、BFF、server page、client view 和首页入口测试，目标集因实现文件不存在和入口缺失退出 1；实现后的相同目标集 GREEN，73 files / 388 tests，exit 0。
- 补充 TDD：卸载时 POST 请求未 abort 的单测 RED（exit 1）；保存 request controller 并在 cleanup abort 后 GREEN，73 files / 389 tests，exit 0。
- 安全与测试运行时：BFF 严格解析 public DTO、所有响应 no-store、POST 只接受空 body；test runtime 清除 `OPENAI_*`，并且只有 `APP_ENV=test` 能选择受控 model-diagnostics Fake scene。
- UI：增加模型连接中文页、最多 25 次的 1 秒轮询、停止提示、timer/AbortController cleanup、四项检查与退避状态；首页运行设置新增入口。页面不暴露任何供应商或配置敏感信息。
- lint 复核修复：渲染期 `Date.now()` 和 effect 同步 setState 分别被 lint 拦截；退避状态改由定时回调更新的过期 retryAt 标记控制，最终无 warning/error。
- 视觉：Impeccable context 已运行。detector 仅运行一次；唯一 `side-tab` warning 来自既有 `globals.css:1283`，本次 UI 目标无发现。桌面和 390px 移动成功/失败/暂不可用截图在 `/tmp/issue50-validation-20260905/`，人工确认无横向溢出、可见焦点与文字状态。
- 最终串行证据：web 73 files/389 tests exit 0；目标 E2E 三个 test-only Fake phase、Desktop Chrome + Mobile Safari 全部 passed；runtime 40 passed exit 0；`DOCKER_API_VERSION=1.51 pnpm -r --workspace-concurrency=1 --if-present test` exit 0；typecheck/build/lint 均 exit 0。所有测试命令前后 `ps` 确认无残留，不存在重叠测试。
