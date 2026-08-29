# Task 3 report — shared public source access

## RED / GREEN evidence

1. RED: `pnpm --filter @job-copilot/source-access test`
   - Before `src/index.ts` existed, Vitest failed with `Cannot find module './index.js'` and ran zero tests.
2. GREEN: `pnpm --filter @job-copilot/source-access test`
   - `Test Files 1 passed`, `Tests 13 passed`.
3. RED: `pnpm --filter api test -- job-page-fetcher.test.ts`
   - The added delegated-network test failed under `PUBLIC_SOURCE_NETWORK_MODE=disabled` before the fetcher delegated to source access.
4. GREEN: `pnpm --filter api test -- job-page-fetcher.test.ts`
   - `Test Files 12 passed`, `Tests 154 passed`.
5. Final focused verification:
   - `pnpm --filter @job-copilot/source-access typecheck` — exit 0.
   - `pnpm --filter api typecheck` — exit 0.
   - `pnpm typecheck` — all seven workspace projects exited cleanly.
   - `git diff --check` — clean.

## Network-zero evidence

`packages/source-access/src/index.test.ts` uses only a controlled loopback fixture or injected lookup/transport seam. It asserts `lookups === 0` and `transports === 0` for HTTP, credential-bearing, capability-mismatch, and missing/cross-call authorization rejections. The test-mode-without-origin case asserts `PUBLIC_SOURCE_NETWORK_DISABLED` before DNS. No test resolves or connects to a recruitment website.

## Files

- Added `packages/source-access/`: public `get` interface; exact-host capability intersection; DNS pinning and IP rejection; limits, timers, response-size/content policy, redirects, bounded retry, abort and stable error metadata.
- Updated `apps/api/src/job-imports/job-page-fetcher.ts`: retains the existing page classification and stable `JobPageFetchError` mapping while delegating transport security to the new module.
- Updated package dependency/lockfile and fetcher regression test.

## Self-review

- `allowedDomains` is an exact host intersection with immutable factory `exactHosts`; neither parent/suffix nor subdomain can expand capability.
- Policy rejection occurs before lookup/transport; the only HTTP exception is a fully exact controlled `testOrigin` for local fixtures.
- Redirects must remain on the same exact host, keeping the existing fetcher’s three-hop behavior.
- No URL/body/credential values are placed in errors. `PublicSourceAccessError` exposes only stable `code`, `retryable`, and `attemptCount`.
- The module does not contain a Greenhouse adapter, scheduling, worker, lifecycle, UI, or API changes.

## Concern

`pnpm test` and the direct Worker integration command were started, but their long-running worker/domain portions did not produce a completed result within this task window. Focused source-access and API fetcher suites plus whole-workspace typecheck are green.

## Fix Round 1

### RED / GREEN

- RED: the existing source-access test suite demonstrated that the old root factory accepted `appEnv`, `testOrigin`, lookup and transport arguments, and that private attempt/final-URL metadata was required by the fetcher.
- GREEN: `pnpm --filter @job-copilot/source-access test` reports 14 passing tests. It now includes a production-factory override regression: a cast-at-runtime `testOrigin`/transport payload still rejects loopback before any supplied transport runs.
- GREEN: `pnpm --filter api exec vitest run src/job-imports/job-page-fetcher.test.ts` reports 23 passing tests.
- GREEN: source-access and API `typecheck`, plus `git diff --check`, pass.

### Changes and self-review

- Root `@job-copilot/source-access` now exposes only `{ exactHosts }`. Test-only lookup/transport/sleep configuration is exported from `@job-copilot/source-access/testing`; its HTTP test-origin exception additionally requires the real `process.env.APP_ENV === "test"`.
- `SecureJobPageFetcher` has no operative network override: its local fixture authorization comes only from the real test environment variables.
- Acquiring the per-host semaphore is now inside a `try/finally` that always releases the already-acquired global permit on abort/throw.
- Successful responses declare `finalUrl` and cumulative `attemptCount`; retry counts are reset per redirect hop, while errors retain typed stable metadata. The former `__attemptCount` and `__finalUrl` protocol is removed.

### Concern

The broad API command starts Testcontainers and failed during reaper port binding in this environment; the focused fetcher suite required for this slice passed with `pnpm --filter api exec vitest run src/job-imports/job-page-fetcher.test.ts`.

## Fix Round 2

### RED / GREEN

- RED: a test-only `https://127.0.0.1` origin could still pass the old testing factory when the real environment was production; the restored fetcher timeout/DNS tests also no longer exercised the previous constructor wiring.
- GREEN: `pnpm --filter @job-copilot/source-access test` — 15 tests passing, including production HTTPS loopback rejection with `transport=0`.
- GREEN: `pnpm --filter api exec vitest run src/job-imports/job-page-fetcher.test.ts` — 26 tests passing, including restored slow-body total timeout, DNS timeout, and redirect shared-deadline coverage.
- GREEN: source-access/API typecheck and `git diff --check` pass.

### Changes

- The testing factory now removes test origin and injected-transport capability unless the real `process.env.APP_ENV` is `test`; no call parameter can enable the loopback/private-IP exception in production.
- #8 fetcher uses the test-only factory only under real test mode and keeps consuming `JOB_PAGE_FETCHER_TEST_ORIGIN` through its module provider. Production uses the root factory.
- The fetcher’s legacy `appEnv` constructor field remains accepted for source compatibility but is intentionally not authoritative; actual environment controls test capability.
- Restored timeout/DNS redirect-budget behavior uses the testing seam only under real test mode; stable `JobPageFetchError` mappings remain covered.

## Fix Round 3

### RED / GREEN

- RED: the testing factory had a partial production mode, so a production caller could still construct it with injected dependencies.
- GREEN: `pnpm --filter @job-copilot/source-access test` — 16 passing tests. New rows cover construction-time `PUBLIC_SOURCE_TESTING_DISABLED` with injected lookup/transport at zero calls, JSON success content type, and pure-private DNS rejection in addition to the existing mixed-DNS/pinning, retry, size, type, UA, and abort rows.
- GREEN: `pnpm --filter api exec vitest run src/job-imports/job-page-fetcher.test.ts` — 26 passing tests; both package typechecks and diff check pass.

### Change

`@job-copilot/source-access/testing` now immediately throws `PUBLIC_SOURCE_TESTING_DISABLED` unless the real process environment is test. It never constructs the internal client in production, so test origin, timeout, sleep, lookup, and transport cannot run there.

## Fix Round 4

### TDD RED / GREEN evidence

- RED — `pnpm --filter @job-copilot/source-access test` 在补齐矩阵后失败 2 项：缺失调用级 allowlist 抛出了内部 `TypeError`（而非稳定的 `PUBLIC_SOURCE_TARGET_REJECTED`）；`/slow-headers` 在 20ms connect/header 预算内仍错误成功。失败位置分别为 `index.test.ts:301` 与 `:403`。
- GREEN — 最小生产修复后同一命令通过：`1` test file、`31` tests。`isAuthorizedUrl` 对空/缺失/畸形 allowlist 失败关闭；node transport 的 connect timer 现在持续到收到 response headers，因此 TCP 建连但不返回 headers 也会超时。
- 本轮新测试中，DNS pinning、排队/在途 abort 与错误脱敏在当前实现上首次即为 GREEN；没有为制造 RED 而回退已存在的正确安全行为。它们仍是独立的可回归行为证据。

### 安全矩阵与结果

- A（预网络 exact policy）：`rejects $name before DNS or transport`（`packages/source-access/src/index.test.ts:243-304`）六个 `it.each` rows：HTTP、带 credential HTTPS、immutable capability mismatch、empty allowlist、missing allowlist、仅 `greenhouse.io` 父域。每行均断言 `lookup === 0`、`transport === 0`；GREEN。
- B（DNS）：`rejects %s answers before transport`（`:306-328`）分别覆盖 pure-private 与 mixed public/private，均断言 lookup 为 1、transport 为 0；`pins the first approved DNS answer without a rebinding lookup`（`:330-351`）断言第二次若返回私网也不会被查询，transport 只获得首个已批准的 `93.184.216.34`；GREEN。
- C（redirect/retry）：`allows exactly three redirects and rejects a fourth redirect`（`:353-377`）断言 `maxRedirects=3` 的 3 跳成功、第 4 跳拒绝且 `attemptCount=4`；`uses a per-hop retry budget and reports a cumulative typed attempt count`（`:379-400`）断言首 hop retry→redirect、次 hop retry→success 的累计 count 为 4；既有 `allows only exact-host redirects within its per-call authorization`（`:126-132`）保留同 host 成功/跨 host 拒绝；GREEN。
- D（timeout/abort/concurrency）：`separates first-response timeout from slow-body total timeout`（`:402-407`）分别用慢 headers 与先 body 后结束证明两个计时器；`removes three consecutively aborted queued requests so another host reaches global concurrency two`（`:409-440`）覆盖连续三次 global queue abort 并在另一个 host 仍被占用时使第三 host 达到 global=2；`forwards an in-flight abort to transport and releases host and global permits`（`:442-475`）断言 transport 收到 signal、不同 host 能启动、相同 host 能复用 permit；既有 pre-queue abort（`:148-155`）和单 queued abort（`:220-241`）仍 GREEN。
- E（content/redaction）：既有 `accepts application/json only with its declared content type`（`:121-124`）及 HTML wrong type/2MiB+1（`:110-119`）保持；`redacts URL, body, allowlist, and transport secrets from a stable public error`（`:477-507`）以 credential/query URL、secret response body、extra allowlist 与恶意 lookup/transport message 逐个实际触发错误，断言 enumerable fields、message、cause、stack 无敏感值，只得到稳定的 code/retryable/attemptCount；GREEN。
- F（既有回归）：2MiB+1、HTML wrong content-type、429/5xx bounded retry、Retry-After 30s cap、固定 UA（`:110-146`）；same/cross-host redirect（`:126-132`）；total timeout 与 abort（`:148-155`）；global=2/per-host=1（`:186-205`）均在本轮 31 tests 中 GREEN。

### Final verification

- `pnpm --filter @job-copilot/source-access test` — 31/31 passed.
- `pnpm --filter @job-copilot/source-access typecheck` — exit 0.
- `pnpm --filter api exec vitest run src/job-imports/job-page-fetcher.test.ts` — 26/26 passed.
- `pnpm --filter api typecheck` — exit 0.
- `git diff --check` — clean.

### Scope / concern

- 仅修改 `packages/source-access` 的策略代码和测试；没有修改 Greenhouse adapter、API fetcher、Worker 或 UI。
- 测试只使用受控 loopback fixture 或 injected lookup/transport，未访问真实招聘网站。

## Fix Round 5

### TDD / mutation evidence

- 新增 JSON 错误 content-type 与公开 enumerable surface 断言后，现有实现首次即为 GREEN，记录为既有正确行为的回归证据；JSON controlled response 使用 `text/html` 和 `json-body-secret` body，稳定得到 `PUBLIC_SOURCE_CONTENT_TYPE_INVALID`、`attemptCount: 1`，且错误对象、message、cause、stack 均不含 body。
- per-host queued-abort 回归以单一 `host-a.test` holder 占用 host A/global permit 1 为起点；每轮只启动一个同 host waiter，先由 lookup gate 放行，使其取得 global permit 2 后卡在 host A semaphore。一个独立 probe 在 abort 前不能进入 transport，证明第二个 global permit 已被该 waiter 占用。该 waiter 与 probe abort 并稳定退出后，holder 仍运行时才启动 host B，host B 必须在 100ms 内进入 transport。该序列连续三轮执行。
- RED (mutation): 临时把 `internal.ts` 的 `finally { globalRelease(); }` 回退为只有取得 host release 时才释放全局 permit；focused test 失败：`host B did not start in round 0`（1 failed, 33 skipped）。恢复无条件 `globalRelease()` 后，focused test 通过（1 passed, 33 skipped）。这证明新测试会抓住 per-host queued abort 的 global permit 泄漏。

### Security-matrix additions

- D: `releases the global permit after each of three per-host queued aborts` 证明同 host 排队阶段的 abort 不会泄漏全局容量；不使用两个不同 holder 预占 global capacity，也不把被测 waiter 留在 global queue。
- E: `rejects JSON responses with a non-JSON content type without exposing their body` 覆盖 `accept: application/json` 配合受控 `text/html` response，精确 error code、attempt count 与 body redaction。
- E: `exposes only stable enumerable fields for policy and transport failures` 分别实际触发 credential-bearing policy rejection 与 transport failure，并精确断言 `Object.keys(error).sort()` 仅为 `attemptCount`、`code`、`retryable`；message/cause/stack 无 policy/transport secrets。

### Final verification

- `pnpm --filter @job-copilot/source-access test` — 34/34 passed.
- `pnpm --filter api exec vitest run src/job-imports/job-page-fetcher.test.ts` — 26/26 passed.
- `pnpm --filter @job-copilot/source-access typecheck` — exit 0.
- `pnpm --filter api typecheck` — exit 0.
- `git diff --check` — clean.

### Scope / concern

- 最终生产实现没有扩大改动；无条件释放 global permit 已正确存在，本轮只补足可突变验证的回归证据与另外两项缺失的安全矩阵断言。
- 测试继续只使用受控 loopback fixture 或 injected lookup/transport，未访问真实招聘网站。
