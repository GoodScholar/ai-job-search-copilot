# Task 1 report — contracts, migration, and terminology

## Scope

- Added strict daily-check schedule and occurrence contracts.
- Added exact-host Greenhouse source classification and Public v2 execution/batch contracts while preserving the Fake v1 schemas and batch array.
- Added only migration `0021_scheduled_public_job_discovery.sql`, its Drizzle snapshot/journal entry, schedule/occurrence ownership constraints, and lifecycle availability fields/indexes.
- Added the required domain term to `CONTEXT.md`.
- Did not alter old run JSON, domain services, Worker, Adapter, HTTP/API, or UI.

## RED evidence

```text
$ pnpm --filter @job-copilot/contracts exec vitest run src/agent-runs.test.ts src/job-discovery-schedules.test.ts
FAIL src/job-discovery-schedules.test.ts
Error: Cannot find module './job-discovery-schedules'
FAIL agent run contracts > ... accepting a discriminated public v2 scope
Invalid input: expected "fake"
FAIL agent run contracts > ... public v2 batch success
TypeError: Cannot read properties of undefined (reading 'parse')
```

```text
$ pnpm --filter @job-copilot/database exec vitest run src/migrate.integration.test.ts
FAIL ... daily schedules, occurrence ledger, and lifecycle availability
expected tables to contain job_discovery_schedules and job_discovery_schedule_occurrences
FAIL ... upgrades a 0020 snapshot ...
ENOENT: .../0021_scheduled_public_job_discovery.sql
```

## GREEN and final verification

```text
$ pnpm --filter @job-copilot/contracts test
Test Files  11 passed (11)
Tests  91 passed (91)

$ pnpm --filter @job-copilot/database test
Test Files  1 passed (1)
Tests  18 passed (18)

$ pnpm typecheck
Scope: 6 of 7 workspace projects; all typecheck commands completed.

$ git diff --check
exit 0

$ git merge-base --is-ancestor dfab6bafb3b32ce4f9693f1937e9309c4a997af9 HEAD
exit 0
```

## Migration review

`0021` contains only additions relative to `0020`: two new schedule tables, five lifecycle columns, their foreign keys/checks/indexes, and no writes to `agent_runs`. PostgreSQL applies non-null `open` defaults and non-null timestamp defaults to existing posting/version/opportunity rows; the 0020-upgrade integration test verifies those values and exact preservation of the prior `source_scope` JSON.
