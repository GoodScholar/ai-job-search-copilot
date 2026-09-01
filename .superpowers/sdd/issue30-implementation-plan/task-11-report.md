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
| Authorization 精确性 | `ebbfc41` → `31937eb` | 同长度错误 token 令中性 boolean 断言失败；Green 以隔离 helper 精确比较完整 Bearer 值，Adapter/source-safety 92/92。 |
| Gate source identity 无 candidate alias | `3d84dac` → `a4f71da` | 同源 candidate alias 与真实 final 分离时，旧 identity 包含 alias 的 boolean 失败；Green 仅写 taxonomy、canonical 和稳定排序真实 final 集合，并兼容读取旧 observed map。 |
| 同 Lead conflicting final replay | `d1f4db3` → `fda38e0` | 去除 verified-Lead final 围栏后，冲突 boolean 为 false；Green 拒绝该 replay，而另一 pending Lead 可以复用同 Posting/Version 归因。 |
| Opportunity legacy 兼容 | `04c4a67` → `bdaf9dc` | legacy nonofficial 的新来源版本错误改写 current pointer/updatedAt；Green 仅允许 official 或带 `dedupIdentity` 的公开来源更新 current，source link 仍写入。 |
| Heartbeat 控制终态 | `5dd4b24` → `8e88e5f` | pause/cancel 请求后，取消型 provider outcome 与 stale interruption 都先错误落为 failed；Green 在 renewal 的 select/update 竞态后回读控制状态，复用同一 AbortSignal，并以 checkpoint 确认后持久化 paused/cancelled。 |

Round 2 safe logs:

- `/tmp/issue30-task11-r2-auth-red.log`, `/tmp/issue30-task11-r2-auth-green.log`
- `/tmp/issue30-task11-r2-source-identity-red.log`, `/tmp/issue30-task11-r2-source-identity-green.log`
- `/tmp/issue30-task11-r2-final-replay-red.log`, `/tmp/issue30-task11-r2-final-replay-green.log`
- `/tmp/issue30-task11-r2-legacy-opportunity-red.log`, `/tmp/issue30-task11-r2-legacy-opportunity-green.log`
- `/tmp/issue30-task11-r2-heartbeat-control-red.log`, `/tmp/issue30-task11-r2-heartbeat-control-green.log`
- `/tmp/issue30-task11-r2-adapter-focused.log`, `/tmp/issue30-task11-r2-domain-typecheck.log`, `/tmp/issue30-task11-r2-worker-typecheck.log`, `/tmp/issue30-task11-r2-drizzle-check.log`

Focused totals: Gate 22/22; Opportunity lifecycle 41/41; Processor 66/66; Adapter plus source-safety 92/92. Domain and Worker typechecks passed; static Drizzle check reported `Everything's fine`. Fresh configured/missing-key Desktop/Mobile 4/4 evidence is the accepted Round 1 run and was intentionally not duplicated because this round changes no browser-visible path.

Invalid attempts: an initial source-identity Green shell wrapper assigned zsh's read-only `status`, so it did not execute a test; it was immediately rerun with a different variable. The first source-identity Green attempt also exposed an invalid fixture whose requested/final relation violated Gate input validation; it was corrected before the accepted Green run. No invalid attempt is used as evidence. The historical two `db:migrate` commands remain INVALID; this round used only the required static Drizzle check.
