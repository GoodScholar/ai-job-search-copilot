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
```

## Fresh 验收

以下命令按包串行执行；Testcontainers 命令设置 `DOCKER_API_VERSION=1.51`：

```text
domain:        DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain test      → 27 files / 318 tests passed
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

`git diff --check 768b8c6..HEAD` 与工作区 `git diff --check` 在报告提交前均退出 0；报告提交后会再执行一次最终检查。未 push、未创建 PR、未 merge。

## 后续门槛

本 Slice 完成实现与验收收口，但按 issue workflow，进入 Slice 8 前仍须由独立 `gpt-5.6-sol/high` 进行 Standards/Spec 双轴审查并达到 `0/0/0`。
