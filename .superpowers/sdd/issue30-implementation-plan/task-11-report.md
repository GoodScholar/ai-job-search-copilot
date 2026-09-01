# Task 11 — Final Review Fix Round 1

Baseline: `3a1a3940773921a1a03c3b25ea7baa378c025e83`. Reviewer initial counts: Standards `0C/2I/1M`; Spec `0C/6I/0M`.

| Finding | Red → Green | Evidence |
| --- | --- | --- |
| Extract provider URL identity | `b7383f5` → `a7182c4` | Adapter mismatch result failed as safe boolean, then 91/91 passed. |
| Canonical posting identity | `dfbd845` → `2dce12b` | Same-origin alias initially conflicted; Gate 21/21 passed after canonical identity with observed final evidence. |
| Aggregator Opportunity version | `9e0e0db` → `8f41061` | Aggregator new version left current pointer stale; lifecycle 41/41 passed. |
| Heartbeat control abort | `dac507c` → `01b4aef` | Pause/cancel both failed safe abort boolean, then Processor 64/64 passed. |
| Recovery order | initial `2182ee0` pre-mutation run was INVALID (Postgres accidentally returned target order); `5600757` → `53292b2` | Reversed committed sort failed IDs-only assertion; restored `createdAt,id`, Leads 11/11 passed. |
| Failure output safety | `14524a4` → `9d95bd9` | Source-safety mutation failed with count 1 only; provider authorization, fixture value and attention destination assertions now use neutral boolean projections. |
| Close deadline dedup | `257e94a` → `b9dbc8d` | Architecture mutation failed safe boolean; three consumers import one helper. Fake timers cover resolve, reject, deadline and timer clear. |

Safe logs: `/tmp/issue30-task11-*-red.log`, `/tmp/issue30-task11-*-green.log`, workspace typecheck and static Drizzle check logs. Final evidence: workspace typecheck passed; static Drizzle check reported `Everything's fine`; configured and missing-key Fake AnySearch ran Desktop/Mobile 4/4. Invalid runs: wrong `@ai-job-search/worker` package filter; one Testcontainers port-binding timeout before test body; recovery initial behavior run lacked a valid Red and is superseded by `5600757`; two `db:migrate` attempts are INVALID because they are connection/migration commands, not the required static Drizzle check.

Remaining final commands are recorded in the ledger. No URL, credential, provider body, or candidate facts were emitted in accepted Red evidence.

## Final Review Fix Round 2

Review counts for this round: Standards `0C/1I/0M`; Spec `0C/4I/0M`.

| Finding | Red → Green | Actual behavior evidence |
| --- | --- | --- |
| Authorization 精确性 | `ebbfc41` → `31937eb`（Red INVALID/SUPERSEDED） | 该 Green 保留为回归基础；旧 Red 的失败 frame 含 query，已由 Round 3 的安全 pair 替代。 |
| Gate source identity 无 candidate alias | `3d84dac` → `a4f71da` | 同源 candidate alias 与真实 final 分离时，旧 identity 包含 alias 的 boolean 失败；Green 仅写 taxonomy、canonical 和稳定排序真实 final 集合，并兼容读取旧 observed map。 |
| 同 Lead conflicting final replay | `d1f4db3` → `fda38e0`（Red INVALID/SUPERSEDED） | Posting 级 final 集合不能区分 A→B→A 后的 Lead replay；该旧证据已由 Round 3 的 Lead-bound fact pair 替代。 |
| Opportunity legacy 兼容 | `04c4a67` → `bdaf9dc` | legacy nonofficial 的新来源版本错误改写 current pointer/updatedAt；Green 仅允许 official 或带 `dedupIdentity` 的公开来源更新 current，source link 仍写入。 |
| Heartbeat 控制终态 | `5dd4b24` → `8e88e5f` | pause/cancel 请求后，取消型 provider outcome 与 stale interruption 都先错误落为 failed；Green 在 renewal 的 select/update 竞态后回读控制状态，复用同一 AbortSignal，并以 checkpoint 确认后持久化 paused/cancelled。 |

Round 2 safe logs:

- `/tmp/issue30-task11-r2-auth-green.log`（旧 Red 已删除且不作证据）
- `/tmp/issue30-task11-r2-source-identity-red.log`, `/tmp/issue30-task11-r2-source-identity-green.log`
- `/tmp/issue30-task11-r2-final-replay-green.log`（旧 Red 已删除且不作证据）
- `/tmp/issue30-task11-r2-legacy-opportunity-red.log`, `/tmp/issue30-task11-r2-legacy-opportunity-green.log`
- `/tmp/issue30-task11-r2-heartbeat-control-red.log`, `/tmp/issue30-task11-r2-heartbeat-control-green.log`
- `/tmp/issue30-task11-r2-adapter-focused.log`, `/tmp/issue30-task11-r2-domain-typecheck.log`, `/tmp/issue30-task11-r2-worker-typecheck.log`, `/tmp/issue30-task11-r2-drizzle-check.log`

Focused totals: Gate 22/22; Opportunity lifecycle 41/41; Processor 66/66; Adapter plus source-safety 92/92. Domain and Worker typechecks passed; static Drizzle check reported `Everything's fine`. Fresh configured/missing-key Desktop/Mobile 4/4 evidence is the accepted Round 1 run and was intentionally not duplicated because this round changes no browser-visible path.

Invalid attempts: an initial source-identity Green shell wrapper assigned zsh's read-only `status`, so it did not execute a test; it was immediately rerun with a different variable. The first source-identity Green attempt also exposed an invalid fixture whose requested/final relation violated Gate input validation; it was corrected before the accepted Green run. No invalid attempt is used as evidence. The historical two `db:migrate` commands remain INVALID; this round used only the required static Drizzle check.

## Final Review Fix Round 3

Review Round 2 counts: Standards `0C/2I/0M`; Spec `0C/1I/0M`.

| Finding | Red → Green | Actual behavior evidence |
| --- | --- | --- |
| Authorization failure-frame safety | `b37c618` → `5b7254f` | 完整 header 等值与 expect 迁入无 query/URL/key/token/header 实值的 helper；同长度错误 credential 令 helper boolean 失败，Red scan 为 `forbidden=0`。 |
| Lead-bound fetched final fact | `2599ad9` → `d64bf38`，projection regression `f562bc8` | A final A、B final B 可复用同 Posting/Version；A replay B 的 stable conflict boolean 在 Red 为 false、Green 为 true，A/A 与 B/B replay 保持幂等。`0028` 以 owner-bound Attribution→Version→Posting joins 回填 `verified_final_url`，无 final 的 verified row fail closed；public lead projection 保持不含该内部字段。 |

The Round 2 files `/tmp/issue30-task11-r2-auth-red.log` and `/tmp/issue30-task11-r2-final-replay-red.log` were deleted after review because their failure frames exposed forbidden context. They are INVALID/SUPERSEDED and are not evidence.

Round 3 safe evidence:

- `/tmp/issue30-task11-r3-auth-red.log`, `/tmp/issue30-task11-r3-auth-red-scan.log`, `/tmp/issue30-task11-r3-auth-green.log`
- `/tmp/issue30-task11-r3-lead-final-red.log`, `/tmp/issue30-task11-r3-lead-final-red-scan.log`, `/tmp/issue30-task11-r3-lead-final-green.log`
- `/tmp/issue30-task11-r3-domain-focused.log`, `/tmp/issue30-task11-r3-migration-focused.log`, `/tmp/issue30-task11-r3-migrate-application.log`
- `/tmp/issue30-task11-r3-database-typecheck.log`, `/tmp/issue30-task11-r3-domain-typecheck.log`, `/tmp/issue30-task11-r3-worker-typecheck.log`, `/tmp/issue30-task11-r3-adapter-focused.log`, `/tmp/issue30-task11-r3-drizzle-check.log`

Counts: Gate plus Lead repository 34/34; migration-focused 7/7; migration application 22/22; Adapter/source-safety 92/92. Database, Domain, and Worker typechecks passed; static Drizzle reported `Everything's fine`. Source identity remains taxonomy/canonical/verified-final-only and remains free of candidate aliases; public lead facts continue to omit `verified_final_url`.

## Final Review Fix Round 4

This round fixes only `0028_lead_verified_final` historical recovery. The old identity could map each requested alias to a different fetched final while its scalar final held only the first value. Recovery now follows the owner-bound Attribution → Version → Posting join and uses the verified Lead's own legacy alias lookup; a missing mapping or a multi-final legacy shape without a unique mapping fails closed.

| Finding | Red → Green | Actual behavior evidence |
| --- | --- | --- |
| Per-Lead legacy final recovery | `7ac7cd3` → `1b6bc89` | Two verified Leads sharing one Posting/Version recover their own final facts rather than both receiving the scalar first value. The migrated identity retains the verified final set only. |
| Recovered-final safety | `1b6bc89` → `7e264fd`; application pair `139500b` → `651f56d` | The accepted table-driven migration application test rejects non-HTTPS, userinfo, fragment, sensitive query names and non-scalar JSON values. Recovery accepts only the approved canonical public-URL shape; the matching table constraint prevents independent later writes. |
| Missing/ambiguous history | `7b69d7b` → `f906fd9` | A missing alias mapping and an ambiguous multi-final legacy shape mutate to an unsafe scalar fallback and fail safe boolean; Green restores null recovery and migration failure. |
| Legacy alias-map removal | `a5e4b31` → `cc2e473` | A mutation retaining the legacy map fails the exact four-key identity projection; Green writes only taxonomy policy, canonical URL, scalar stable final and stable final set. |
| Public-host parity | `c1294cf` → `ab4bff8` | Reserved suffix and local-only host recovery initially passed the migration check; Green aligns schema, snapshot and migration rejection with the runtime public-host policy. |

Round 4 safe evidence:

- `/tmp/issue30-task11-r4-migration-red.log`, `/tmp/issue30-task11-r4-migration-green.log`
- `/tmp/issue30-task11-r4-migration-safety-red.log`, `/tmp/issue30-task11-r4-migration-safety-red-scan.log`
- `/tmp/issue30-task11-r4-failclosed-red.log`, `/tmp/issue30-task11-r4-failclosed-green.log`
- `/tmp/issue30-task11-r4-unsafe-application-red.log`, `/tmp/issue30-task11-r4-unsafe-application-green.log`
- `/tmp/issue30-task11-r4-identity-rewrite-red.log`, `/tmp/issue30-task11-r4-identity-rewrite-green.log`
- `/tmp/issue30-task11-r4-host-policy-red.log`, `/tmp/issue30-task11-r4-host-policy-green.log`
- `/tmp/issue30-task11-r4-final2-database-migrations.log`, `/tmp/issue30-task11-r4-final2-gate-leads.log`
- `/tmp/issue30-task11-r4-final2-database-typecheck.log`, `/tmp/issue30-task11-r4-final2-domain-typecheck.log`, `/tmp/issue30-task11-r4-final2-drizzle-check.log`

Accepted red scans report `forbidden=0`; failed assertions expose only a boolean/count. Migration-focused application coverage is 15/15; the final combined migration run is 39/39; Gate plus Lead coverage is 34/34. Database and Domain typechecks passed, and static Drizzle reported `Everything's fine`.

Invalid attempt: the first outer non-object JSON fixture was rejected by a pre-0028 object constraint before the migration began, so it was not migration evidence. Its raw log was deleted, and the accepted table uses a non-scalar value inside an otherwise valid historical object. Temporary unfiltered Testcontainers logs were also removed; only the listed safe logs remain. No product/API projection changed: the internal final fact stays absent from public Lead output.

## Final Review Fix Round 5

Repository history confirms that the fixed baseline contains neither `0024`, `0027`, nor `0028`; the only local ref is the detached review chain and no tag or published branch contains these migrations. The reviewer description called `0027` the Lead-table creation point, but the actual creation point is `0024`. Therefore this round changes only the unreleased Issue #30 chain by putting the final field and state/length constraints into `0024`, removing `0028` and its snapshot/journal entry. No fixed-baseline migration was rewritten.

| Finding | Red → Green | Actual behavior evidence |
| --- | --- | --- |
| Fresh-chain final fact | `247e35f` → `96f11df` | A temporary fresh chain with `0028` omitted lacked the final column and failed only a neutral boolean assertion. Green creates it directly in the original unreleased Lead-table migration. |
| One URL-policy authority | same Green | The database regex constraint and all recovery parsing are gone. Runtime keeps the shared contract schema and Gate validation in the verify-and-attribute transaction. Contract coverage includes port zero, an ICANN Unicode host and a percent-decoded identity value. |
| Requested/final/canonical origin | existing Gate seam rerun | The Gate integration's full chain test rejects a foreign requested, final or canonical URL before facts are written; it remains transaction-bound and does not rely on a database URL regex. |
| Recovery fixture duplication | same Green | Removed the obsolete recovery/application fixtures and retained compact additive migration checks plus the fresh-chain application seam. |

Round 4's `0028` recovery implementation and logs are SUPERSEDED, not accepted final-schema evidence, because the entire migration was unreleased and removed. The Lead-bound runtime fact, replay behavior, owner-bound FK, length/state constraints, and public Lead projection remain covered; no legacy database recovery path exists in the final chain.

Round 5 safe evidence:

- `/tmp/issue30-task11-r5-fresh-chain-red.log`, `/tmp/issue30-task11-r5-migration-green.log`
- `/tmp/issue30-task11-r5-database-migrations.log`, `/tmp/issue30-task11-r5-contracts-url-policy-final.log`, `/tmp/issue30-task11-r5-gate-leads.log`
- `/tmp/issue30-task11-r5-database-typecheck.log`, `/tmp/issue30-task11-r5-contracts-typecheck.log`, `/tmp/issue30-task11-r5-domain-typecheck.log`, `/tmp/issue30-task11-r5-drizzle-check.log`

Counts: database migration/application 28/28; contracts URL policy 8/8; Gate plus Lead 34/34. Database, Contracts and Domain typechecks passed; static Drizzle reported `Everything's fine`. The Red scan reported `forbidden=0`. No invalid test attempt in this round.
