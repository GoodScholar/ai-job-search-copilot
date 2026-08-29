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
