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
