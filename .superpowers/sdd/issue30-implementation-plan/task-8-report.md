# Task 8 / Slice 7 报告：持久化 v4 分层工作流

固定最终审查基线：`3a1a3940773921a1a03c3b25ea7baa378c025e83`。
本次 closeout 起始提交：`d461a8f`；报告写入前 HEAD：`fddeacc`。

## 范围与边界

- Slice 7 已覆盖 v4 的 domain workflow seam、持久化 discovery diagnostics/source issues/results、独立 `discovery_attention`、v4 run detail 与最小 Home 精确落点。
- 本次只补强真实 PostgreSQL upgrade/constraint 与 v4 detail 查询回归，并使既有旧库 fixture 在 `0025`–`0027` 迁移链存在时仍准确构造 `0022`/`0023` 历史数据库。
- 没有进入 Slice 8：没有 Worker production resolver/config/schedule；没有进入 Slice 9：没有 Fake AnySearch local-runtime 或 Playwright；没有改写 v1–v3 adapter 输入输出、Execution Spec 或 source-health 语义。

## 本次补强

- `public-discovery-workflow.migrate.integration.test.ts` 从真实 `0024` 临时数据库升级到完整 `0025 → 0026 → 0027`，直接以 PostgreSQL `INSERT` 验证：provider/query/lead diagnostics 三种合法 shape、`UNIQUE NULLS NOT DISTINCT`、scope pair、provider/code/count、owner/run/lead FK；保留既有 `0024` Lead 和 `source_attention`；验证 `discovery_attention` kind/reason；验证 source issue 与 v4 result 的 owner、FK、unique、ordinal `1..5`；并验证 `0024..0027` snapshot `prevId` 与 journal 连续链。
- `agent-run-processor.integration.test.ts` 覆盖 v4 `get/latest/eventsAfter`：结果的内部 ordinal 顺序、`usage.results` 与实际 result 数量、diagnostic/source issue 顺序、owner 隔离，以及详情不投影外部 URL、标题或 provider body。v4 DTO 有意不暴露内部 `ordinal`，因此通过返回数组次序验证排序。
- 旧 migration fixture 不再假设 journal 尾部为 `0023/0024`；构造历史数据库时会同步裁掉后续 SQL、snapshot 与 journal entry，避免 `0025` 在不存在 `0024` Lead table 的旧库上执行。

## TDD / 真实执行证据

| 项目 | 命令与结果 |
| --- | --- |
| v4 PostgreSQL upgrade/constraint | `DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/database exec vitest run src/public-discovery-workflow.migrate.integration.test.ts` → **1 file / 4 tests passed**。这组回归测试首次加入时即绿：`0025`–`0027` 实现已在本次接管前存在，因此没有伪造 Red 或生产 Green。 |
| v4 detail projection | `DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain exec vitest run src/agent-run-processor.integration.test.ts` → **1 file / 47 tests passed**。初次运行先暴露测试夹具缺少 `queryFingerprint`，修正为冻结 query 的 `a×64`；随后发现 v4 公共 DTO 不含 `ordinal`，改为断言排序数组。二者都是测试夹具/契约理解修正，不是产品缺陷。 |
| 数据库完整回归 Red | `DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/database test` 首次为 **4 failed / 24 passed**：旧 `0022/0023` fixture 没裁掉 `0025`–`0027`，导致 `job_discovery_diagnostics_owner_lead_fk` 在无 `job_discovery_leads` 的历史库上失败；另有 journal 尾部硬编码失败。 |
| 数据库完整回归 Green | 同一命令 → **3 files / 28 tests passed**。 |

历史记录说明：`151bd01 fix(domain): retain discovery attention on budget terminal` 的 Red 是在隔离父提交后补做的复现，而不是该提交之前保留下来的原始先验 Red；本报告按此事实记录，不将其包装为严格的首次 test-first 证据。后续 `418f91a` 保留了 budget 与 discovery attention 并存的回归。

## 审查修复 round 1（A / B / C）

本轮接受 Spec I1、Spec I3 与 Standards I1；对 Spec I2 采用 brief 允许的 checkpoint/usage 复用方案，不新增 operation ledger。每组的 Red 提交都先于对应生产 Green 提交，未改写既有历史。

| 组别 | 裁决与实现 | 真实 TDD 证据 |
| --- | --- | --- |
| A：成功语义 | `LayeredPublicWorkflowOutcome` 改为必填严格 `branchOutcome`，删除 `hasTrustedSuccess`、可选 `branchSuccess` 与四路 OR。可信来源明确成功（可为零岗位）及 AnySearch 真零候选成功；有候选但全 extract/fetch/gate 失败会依 diagnostic retryability 重试/失败；有一个 verified 且存在部分问题仍成功。 | Red `7fa1ec8`：`layered-public-job-discovery-workflow.test.ts` 运行 **8 tests / 6 failed**；Green `806abea`：同文件 **8 passed**，`agent-run-processor.integration.test.ts` **47 passed**，domain typecheck 通过。 |
| B：lease / deadline 围栏 | heartbeat `renew=false` 或异常会立即 abort v4 的同一 `AbortController`，deadline 也会 abort；`record_pending`、`gate_reject`、`gate_verify` 在写入前使用不 reserve 的 checkpoint 围栏，物理请求保留既有 reserve。 | Red `8b5e0a2`：工作流 focused test **8 tests / 1 failed**；Green `70d5853`：工作流 **8 passed**、processor **48 passed**、domain typecheck 通过。后续 `4ef7051` 加入 old fetch 挂起→lease takeover→heartbeat abort→旧返回零 Lead/Attribution 副作用→新 attempt completed 的 barrier 回归，并验证全链 signal identity。 |
| C：中断前诊断 | 引入严格 typed `LayeredPublicWorkflowInterruption` 与 partial outcome；pause/cancel/budget/stale 在停止前已聚合的脱敏 diagnostics 会以 max 幂等持久化，且不提前写 source issue / `discovery_attention`。请求前 reserve 与请求返回后的无 reserve claim 围栏同时构成计费/完成边界；`NOT_CONFIGURED` 仍不调用 beforeRequest。 | Red `63f083e`：工作流 **9 tests / 1 failed**；Green `a17e110`：workflow + processor focused **2 files / 58 passed**、domain typecheck 与 diff check 通过。回归还覆盖 provider failure 后第二操作 stop、detail 可见历史 diagnostic、无 provider body 泄漏及重放幂等。 |

审查结论记录：历史 Slice 的首次 test-first 证据并不完整（尤其 `151bd01` 的事实如上），不能在本报告中宣称“原 Slice 完全 test-first”。本轮 A/B/C 具备独立、不可逆的 Red→Green 提交证据；是否据此接受流程发现并关闭，仍请独立 Reviewer 判断。

迁移命名审查项（Standards Minor）技术驳回：仓库全部 Drizzle migration 均采用自动生成名，`0027` 沿用该既有风格；重命名会制造与本 Issue 无关的历史噪音，故不改名。

## 审查修复 round 2

- A：`2194e65` 先使 v4 workflow 必须传递 claim mutation authority（Red），`6f7010c` 在 Lead 的 account-lock transaction 和 Gate verify/reject 的同一 account-lock transaction 内校验 owner/run/running/claim token/未过期；旧 API 没有 token 时保持兼容。claim stale 会被工作流转换为 `stale` interruption。
- B：伪造 resolver 的 plain `interruption` 不再被 Processor 信任：`7aa241a` 只接受 workflow 私有 marker 产生的 interruption，伪造值按普通失败路径处理。focused processor **49 passed**，domain typecheck 通过。
- C：`948ebfb` 为 extract URL mismatch 建立 Red（**9 tests / 1 failed**）；`79ee9c4` 在拒绝 Lead 后聚合 `JOB_PAGE_URL_INVALID` lead diagnostic 与 AnySearch source issue，focused workflow **9 passed**、domain typecheck 通过。

本轮提交：`2194e65`、`6f7010c`、`948ebfb`、`79ee9c4`、`7aa241a`。

后续 round 2 证据：`b6382c1` 的真实 pause checkpoint 覆盖与实现同提交，未保留独立 Red；`e23250e`（Red）→`251c29c`（Green）拒绝 resolver 直接伪造 stop throw；`552da3d` 首次运行即绿，覆盖真实 cancel、budget 与 stale checkpoint terminal（processor focused **54 passed**），不将其表述为 Red→Green。

TOCTOU 补强均为 `6f7010c` 后新增、首跑即绿的真实数据库回归：`3116563` 覆盖 stale claim 的 `recordPending`（0 Lead）；`8e07114` 覆盖 `verify`（0 object put/Posting/Version/Attribution，new claim 成功）；`fea62f1` 覆盖 `reject`（old claim 后 Lead 仍 pending，new claim 成功 rejected）。这些回归没有保留独立 Red。尚未把 no-reserve checkpoint continue 本身嵌入此三场景，不能将它们描述为完整 checkpoint-before-takeover 证明。

最终 TOCTOU 串联回归 `b5e367b` 使用真实 `createAgentRunCheckpoint.check`（old claim、无 reserve）先断言 `continue`，再切换至 new claim，并在同一运行中依次证明：old `recordPending` 为 `JOB_DISCOVERY_CLAIM_STALE` 且目标 query 为 0 Lead；old `verify` 为 `VERIFIED_JOB_SOURCE_CLAIM_STALE` 且 EvidenceStore 0 put、Source Posting/Version/Attribution 均为 0；old `reject` 为 stale 且 Lead 保持 pending；new claim 对三项 mutation 均成功。该测试最初因遗漏测试文件的 `and` 导入而报错；修正夹具后首个可执行产品断言运行即绿（focused **1 file / 18 tests passed**），没有生产 Green，也没有可保留的功能 Red。

## 提交链（`768b8c6..HEAD`，报告提交前）

```text
7c9fa22 feat(domain): add v4 layered workflow seam
f4dca4e feat(database): persist v4 discovery snapshots and diagnostics
3e9e413 feat(discovery): add run-level discovery attention
7d02bca feat(web): route discovery attention to exact run
60c4ecd feat(web): read selected agent run safely
f615857 feat(domain): orchestrate durable v4 public discovery
8799730 fix(domain): harden v4 discovery workflow boundary
7497f42 fix(domain): distinguish v4 branch outcomes
9e3c300 fix(domain): validate durable v4 resolver outcomes
58fd2fb fix(domain): preserve retryable page failure codes
078b614 fix(domain): persist v4 no-success discovery facts
8cb4975 fix(domain): defer v4 attention until final delivery
72f0f3f fix(domain): derive v4 attention from retry decision
250c13d test(domain): cover v4 retry attention lifecycle
2540668 fix(domain): make v4 discovery fact replays idempotent
4702569 fix(domain): aggregate v4 source issues deterministically
151bd01 fix(domain): retain discovery attention on budget terminal
418f91a test(domain): cover budget and discovery attention coexistence
e56256e fix(domain): aggregate v4 diagnostics deterministically
7ab6fc9 test(domain): cover v4 provider issue aggregation
ce5e992 test(domain): lock v4 terminal issue aggregation
395a5fb fix(domain): preserve v4 branch and URL capability semantics
795a444 fix(domain): carry issued discovery capability through workflow
9c79446 refactor(domain): export v4 candidate capability proof
6ce7ac2 fix(domain): stop v4 verification at global candidate cap
1d9b794 fix(domain): recover stable v4 result ordinals
e23bc91 fix(domain): require official trusted v4 results
f938936 test(domain): lock v4 completed delivery idempotency
b791fdf test(domain): cover v4 physical checkpoint stops
f57e6b8 test(domain): cover v4 checkpoint terminal stops
a7cdeff test(domain): account trusted v4 physical calls
e7f7405 test(domain): cover v4 claim takeover recovery
d461a8f test(database): lock v4 result migration constraints
622aa62 test(database): exercise v4 migration upgrade constraints
46cdccc test(domain): cover v4 run detail projections
f84ec27 test(database): preserve legacy migration fixtures
fddeacc test(domain): narrow v4 detail projection
7fa1ec8 test(domain): define v4 branch outcome semantics
806abea fix(domain): require explicit v4 branch outcome
8b5e0a2 test(domain): require v4 claim fences before writes
70d5853 fix(domain): abort stale v4 claims before writes
63f083e test(domain): preserve diagnostics on v4 interruption
a17e110 fix(domain): retain v4 diagnostics across interruption
4ef7051 test(domain): cover v4 lease takeover barrier
b6382c1 fix(domain): persist real checkpoint interruption diagnostics
e23250e test(domain): reject forged v4 stop throws
251c29c fix(domain): trust only processor v4 stop throws
552da3d test(domain): cover real v4 interruption terminals
3116563 test(domain): reject stale claim lead mutations
8e07114 test(domain): reject stale claim gate verification
fea62f1 test(domain): reject stale claim gate rejection
6cf637d docs(sdd): record v4 claim mutation barriers
b5e367b test(domain): cover checkpoint claim takeover mutations
```

## Fresh 验收

以下命令在本次报告提交前按包严格串行执行，任一时刻只有一个 test/typecheck 进程；所有命令均为 **exit 0**。Testcontainers 命令设置 `DOCKER_API_VERSION=1.51`：

```text
domain:        DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain test      → 27 files / 333 tests passed
database:      DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/database test    → 3 files / 28 tests passed
contracts:     pnpm --filter @job-copilot/contracts test                            → 12 files / 108 tests passed
web:           pnpm --filter web test                                                → 55 files / 289 tests passed
source-access: pnpm --filter @job-copilot/source-access test                         → 2 files / 125 tests passed
worker:        pnpm --filter worker test                                              → 20 files / 256 tests passed

typecheck: pnpm --filter @job-copilot/contracts typecheck
           pnpm --filter @job-copilot/database typecheck
           pnpm --filter @job-copilot/domain typecheck
           pnpm --filter @job-copilot/source-access typecheck
           pnpm --filter worker typecheck
           pnpm --filter web typecheck                                                → 均 exit 0

Drizzle: pnpm --filter @job-copilot/database exec drizzle-kit check --config=drizzle.config.ts
         → Everything's fine
```

完整输出捕获说明：domain 全量运行耗时 **38.67s**，前台工具流在 30 秒处截断，随后以同一单命令的 `tee` 进程会话取得最终摘要（**27 / 333, exit 0**）；worker 耗时 **86.64s**，通过同一串行进程的两次 wait 取得最终摘要（**20 / 256, exit 0**）。其余命令均直接返回完整最终摘要。没有将截断的中间输出当作通过证据。

报告提交后会再执行 `git diff --check 768b8c6..HEAD` 与 `git status --short` 最终确认；未 push、未创建 PR、未 merge。

## 后续门槛

本 Slice 完成实现与验收收口，但按 issue workflow，进入 Slice 8 前仍须由独立 `gpt-5.6-sol/high` 进行 Standards/Spec 双轴审查并达到 `0/0/0`。
