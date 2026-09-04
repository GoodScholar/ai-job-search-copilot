# Task 10 / Slice 9 实施报告

基线：`0ed9933`（最终独立审查仍以 `3a1a3940773921a1a03c3b25ea7baa378c025e83` 为固定比较基点）。本 Slice 未推送、未创建 PR、未合并。

## TDD 提交与真实 Red

| Red → Green | 串行 Red 命令与真实失败 |
| --- | --- |
| `357e4a1` → `ca20092` | 分别串行运行 `pnpm --filter web exec vitest run scripts/e2e-runner.test.ts --no-file-parallelism`、`pnpm --filter domain exec vitest run src/job-discovery-execution-mode.test.ts --no-file-parallelism`、`node --test scripts/local-runtime.test.mjs`。Red 表明 runner 没有专用 AnySearch phase，shared runtime config 不接受版本化 test-only v4 phase，local runtime 也不会创建/清理 fixture server；因此无法由固定 phase 取得 v4。 |
| `f40aa92` → `8915c92` | `DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- anysearch-public-job-discovery.spec.ts --project="Desktop Chrome" --project="Mobile Safari"`。Red 是从正常 UI 创建 run 后，尚无完整 provider/page fixture、真实 fetch/gate/persistence 验收链；成功岗位、rejected Lead、归因、单一 attention 和结果去重均不成立。 |
| `fa0df6e` → `57ac9f3` | 串行 Red：`pnpm --filter domain exec vitest run src/job-discovery-execution-mode.test.ts --no-file-parallelism`（7 tests，缺 key phase 被拒绝为 config invalid）；`pnpm --filter web exec vitest run scripts/e2e-runner.test.ts --no-file-parallelism`（9 tests，runner 只选择旧 anysearch phase）；`node --test scripts/local-runtime.test.mjs`（38 tests，phase 未被识别）；`pnpm --filter worker exec vitest run src/agent-runs/agent-run.module.test.ts --no-file-parallelism`（36 tests，config invalid）。旧单 phase E2E 亦在 Desktop 的缺 key 断言中得到 `completed` 而非预期 `failed`，证明 key 仍被注入，因而不是浅层 fixture 404。 |

Green A 添加严格版本化 `fake-anysearch-public-job-v1`，并由 runner/local runtime 管理 fixture server 的启动、取消与清理；普通 phase 和 source-health phase 不选择该 spec。

Green B 只替换外部 AnySearch 与页面网络：Worker 仍经 preflight、`/extract`、`SecureJobPageFetcher`、canonical/final 验证和 Verified Gate；Playwright 以 Dev Auth/API/正常 UI 创建账户、target、profile 和 Watchlist，再由 Node-side PostgreSQL 只读核对事实。

Green C 添加第二个固定 phase `fake-anysearch-public-job-missing-key-v1`。shared config 只在 `APP_ENV=test` 接受两个精确枚举；runner 清除相互污染的 E2E/base/origin 变量并分别 grep `@configured` 与 `@missing-key`；local runtime 只对 configured phase 注入固定非秘密 key。缺 key 通过 adapter 的真实 `isConfigured=false` 在 provider search/extract 前短路，一次聚合 `ANYSEARCH_NOT_CONFIGURED`，而非用 fixture error 伪造。

## E2E 验收与 fixture 审计

完整、带 `pipefail` 的新日志：`/tmp/issue30-slice9-anysearch-e2e.log`。

```sh
set -o pipefail
DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- anysearch-public-job-discovery.spec.ts --project="Desktop Chrome" --project="Mobile Safari" 2>&1 | tee /tmp/issue30-slice9-anysearch-e2e.log
```

该唯一串行命令 exit 0。runner 先执行 configured phase（Desktop Chrome 一例、Mobile Safari 一例，合计 **2/2**），再独立启动 missing-key phase（Desktop Chrome 一例、Mobile Safari 一例，合计 **2/2**）；same spec 合计 **4/4**。

- configured 固定 audit 顺序包含六次 `search`（general、rate-limited platform、unavailable platform、两次 duplicate platform、target-company），每个可取证 candidate 均为 `extract` 后才为 `page`；policy candidate 仅 extract、没有 page；页面链接不触发额外 URL。
- configured run 为 `completed_with_source_issues`，rate-limit 根因一条；冻结 query plan 为 general、四个 site-constrained、一个 target-company，共 6 个且每个 `resultLimit <= 5`。一条 verified Lead 产生一份官方 Source Posting/Version、Attribution、Opportunity、Result；五种页面/policy 原因留下 rejected Lead，均无下游版本/归因/机会/结果。UI 断言一项结果、run-detail attention href、44px target、无横滚与 axe 无违规。
- missing-key phase 的 fixture provider audit 为 `[]`（reset/audit control 不计 provider transport）；每个 run 为 `failed`，一条 `ANYSEARCH_NOT_CONFIGURED` source issue（affectedCount 1）和一条 run attention，Lead/Attribution/Posting/Version/Opportunity/Result 均为 0，且结果序列化不含固定测试 key。

此前 Green C 的 E2E 工具响应在 missing-key phase 截断，不能作为验收证据；以上 `/tmp/issue30-slice9-anysearch-e2e.log` 是从零开始的替代完整日志。Green C 的首次 Worker 聚焦运行曾在构造无 key adapter 时错误触发 `ANYSEARCH_TEST_TRANSPORT_DISABLED`：原因是注入的 resolver environment 与 adapter 的全局 test guard 不同，而该路径永不请求 provider。最小修复为只在已有 key 的 fake phase 传入本地 base；随后 Worker 36/36 Green。该中间失败未被作为通过证据。

Slice 8 曾误启动的并发/重复 PID 测试及其结果均不作为本 Slice 9 证据；本报告列出的所有命令均单进程串行。

## 本次最终串行验证

```sh
pnpm --filter domain exec vitest run src/job-discovery-execution-mode.test.ts src/layered-public-job-discovery-workflow.test.ts --no-file-parallelism
pnpm --filter web exec vitest run scripts/e2e-runner.test.ts --no-file-parallelism
node --test scripts/local-runtime.test.mjs
pnpm --filter worker exec vitest run src/agent-runs/agent-run.module.test.ts --no-file-parallelism
pnpm --filter api exec vitest run src/agent-runs/agent-runs.module.test.ts --no-file-parallelism
pnpm --filter source-access exec vitest run src/job-page-fetcher.test.ts src/index.test.ts --no-file-parallelism
```

结果依次为 domain 2 files/18 tests、Web runner 1/9、local runtime 38、Worker 1/36、API 1/22、source-access 2/125，全部通过。

```sh
pnpm --filter domain typecheck
pnpm --filter api typecheck
pnpm --filter worker typecheck
pnpm --filter web typecheck
pnpm --filter source-access typecheck
pnpm --filter database exec drizzle-kit check --config=drizzle.config.ts
git diff --check 0ed9933..HEAD
git status --short
```

五个 typecheck 均通过；Drizzle 输出 `Everything's fine`；diff check 通过。E2E 和 Web typecheck 生成的 `apps/api/dist`、`apps/worker/dist` 已以精确 `git clean -fd -- apps/api/dist apps/worker/dist` 清理，未纳入提交。

## 已知边界

- Fake AnySearch、provider base、page origin 与固定占位 key 只能在精确 test phase 由 local runtime 注入；local/production 的 test knob 由共享 validator 稳定脱敏地 fail closed。
- 除最初 Fake AnySearch 运行时组装外，本 Slice 的 review-driven 生产语义已经包含：canonical 跨 query 的 Lead/Attribution 去重处理、已完成 v4 duplicate delivery 返回 `stale`、以及同 version 的公开 Opportunity replay 不更新其快照。Task 10 后续 audit/MinIO 变更仅在精确 Fake AnySearch test phase 启用审计与只读证据投影，不改变生产 AnySearch/Greenhouse、URL policy、Gate、预算或终态契约；也不启动 Task 11 全量验收。
- 进入下一阶段前必须进行独立 Standards/Spec 审查；本报告不是审查结论。

## Review Fix Round 2 — canonical dedup、Opportunity 与重复 delivery

本返工以 `dc47036539fe802d5c626d548004ea0305e40b9f` 为起点，未创建 worktree、分支、PR 或远端操作；Green 实现提交为 `4481b3ab8d5eb893e60bd3cc3439d8a7fd1b3b1b`。

### 严格 Red → Green 证据

| 阶段 | 提交 | 串行命令与结果 | 完整日志 |
| --- | --- | --- | --- |
| canonical-dedup Red | `044eb1e1275702647a8e49cf6be64f0b0ef6b63c` | `DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- anysearch-public-job-discovery.spec.ts --project="Desktop Chrome" --project="Mobile Safari"` exit 1；Desktop Chrome 与 Mobile Safari 均在真实数据库断言中得到 1 条 verified Lead，而 Red 要求 2 条。 | `/tmp/issue30-slice9-canonical-dedup-red.log` |
| duplicate-delivery Red | 未单独提交（在上述 Red 提交之后、Green 前执行的同一垂直测试补强） | `pnpm --filter domain exec vitest run src/agent-run-processor.integration.test.ts --no-file-parallelism` exit 1；61 个测试中 1 个失败，已完成的 v4 run 的第二次 delivery 返回 `completed`，而 Red 要求 `stale`。 | `/tmp/issue30-slice9-duplicate-delivery-red.log` |
| Green | `4481b3ab8d5eb893e60bd3cc3439d8a7fd1b3b1b` | 域集成测试 61/61 Green；完整 Fake AnySearch E2E 串行运行 configured phase（Desktop Chrome、Mobile Safari 各 1）与 missing-key phase（各 1），合计 4/4 Green。 | `/tmp/issue30-slice9-duplicate-delivery-green.log`、`/tmp/issue30-slice9-canonical-dedup-green.log` |

Green 中 fixture 的 `general` 返回安全的 alias URL，`target_company` 返回安全的 canonical URL；alias 由同 host HTTP 302 指向 canonical URL。`/extract` 审计保留 alias discriminator，页面 transport 审计先记录 alias 后记录 canonical，真实 `SecureJobPageFetcher` 和 redirect policy 仍执行。两个 query-bound verified Lead 与两个 Attribution 分别保留，但共同指向一个 Source Posting、一个 Source Posting Version、一个 Opportunity 和一个 AgentRunResult。

E2E 还结构性校验一条 general、四条携带 `site:zhipin.com` / `site:liepin.com` / `site:zhaopin.com` / `site:mp.weixin.qq.com` 的 site-constrained query，以及一条带完整公司 discriminator 的 target-company query；`batchSize=5`、`resultLimit=5`、`maxVerificationCandidates=10`，fixture durable audit 只记录固定 discriminator 与 bounded count。重复 BullMQ `discover-jobs` 使用同一 `runId`/`userId` 的独立 delivery，实际 return value 为 `stale`；前后全部可见持久化事实 ID/count 一致，并在随后 reload 中再次确认一个可见结果。

本波次变更文件：

- `apps/web/e2e/anysearch-public-job-discovery.spec.ts`
- `apps/worker/src/agent-runs/fake-anysearch-fixture-transport.ts`
- `packages/domain/src/agent-run-processor.ts`
- `packages/domain/src/agent-run-processor.integration.test.ts`
- `scripts/fake-anysearch-fixture-server.mjs`

最终串行验证：

```sh
pnpm --filter domain exec vitest run src/agent-run-processor.integration.test.ts --no-file-parallelism
DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- anysearch-public-job-discovery.spec.ts --project="Desktop Chrome" --project="Mobile Safari"
pnpm --filter domain typecheck
pnpm --filter worker typecheck
pnpm --filter web typecheck
pnpm --filter database exec drizzle-kit check --config=drizzle.config.ts
git diff --check 0ed9933..HEAD
```

以上均通过；E2E 生成的 `apps/api/dist` 与 `apps/worker/dist` 已用精确路径清理，未进入提交。先前 Slice 8 的并发/重叠命令结果仍一律作废；本返工波次每次测试前均确认无遗留 `pnpm`、Vitest、Playwright、`tsc`、Drizzle、E2E runner 或 local-runtime 进程，并且测试命令全程单进程串行。未发现阻塞性 concern；未开始 MinIO 或普通 source-health 后续审计。

## Review Fix Round 2 — 第二次复审返工闭环

本节取代上一节中“duplicate-delivery Red 未单独提交”的旧证据结论。新增 Red 均先独立提交、再以单进程命令实际失败；随后才提交对应 Green。

| Red → Green | 行为与结果 | 日志 |
| --- | --- | --- |
| `1f1bddc` → `e42fb72` | 真实 UI/队列的重复 delivery 快照要求 `runUsage`；Red 为安全布尔断言 `false`，Green 查询并比较 run usage 及 Lead/Attribution/Posting/Version/Opportunity/Result 的稳定 ID、关联与 count。重复 job 返回 `stale` 后 `toEqual` 前后完整安全快照。 | `/tmp/issue30-slice9-round2-public-snapshot-red.log`、`/tmp/issue30-slice9-round2-public-snapshot-green.log` |
| `38f6c43` → `2904e8a` | 同 public dedup identity 的同 version replay 原会改写 Opportunity `updatedAt`（Red 1/361 failed）；Green 只在 source posting version 变化时更新 current Opportunity。该集成测试同时覆盖：同 version 仅 1 Opportunity/1 source link；同 canonical 的新 version 复用 Opportunity、更新 current version、每 version 一个 link；identity 不同分离；旧六字段哈希兼容。 | `/tmp/issue30-slice9-round2-opportunity-red.log`、`/tmp/issue30-slice9-round2-opportunity-green.log` |
| `290e2a2` → `e772761` | v4 Red 因无 AnySearch attribution 被 provenance gate 拒绝（1/362 failed）；Green 建立已验证、owner/run/query-bound Lead 与 Attribution，证明其 source version 映射到 1 Opportunity、1 source evidence link、1 RunResult，来源身份仍为 Greenhouse 而非 AnySearch。 | `/tmp/issue30-slice9-round2-v4-mapping-red.log`、`/tmp/issue30-slice9-round2-v4-mapping-green.log` |

安全证据：旧 `/tmp/issue30-slice9-canonical-dedup-red.log` 曾因 `toHaveLength` 展开 Lead（含 normalized URL），不可作为安全证据；在上述新脱敏 Red/Green 日志写入后已于本轮精确删除。新 E2E `persistedFacts` 只读稳定 ID、状态、枚举、哈希、布尔、bounded count 与 run usage；不查询 normalized URL、raw content、source identity 或 raw object reference。查询 plan 断言同样改为布尔/固定枚举；fixture durable audit 仅有固定 operation/fixture/count。`resultLimit` 现逐条精确为 `5`；实际 verification 使用 fixture 的 `extract` audit，固定为 7 且 `<= 10`，不再以 Lead 数代替。

本轮最终串行命令：domain persistence **361/361**、v4 processor **362/362**；完整 E2E configured Desktop/Mobile **2/2** 加 missing-key Desktop/Mobile **2/2**，合计 **4/4**（`/tmp/issue30-slice9-round2-e2e-final-green.log`）；`pnpm typecheck` 全 workspace 通过；`git diff --check 0ed9933..HEAD` 通过。E2E 生成的 `apps/api/dist`、`apps/worker/dist` 均按精确路径清理。

## Review Fix Round 3 — 重复 delivery 行为 Red 与公开 seam 完整性

本轮以 `49f21bbbbef4423558ee758e15362b04263f0d0e` 为起点。Round 2 的 `1f1bddc` 失败未到达重复 processor/queue delivery，故其“duplicate behavior Red”证据无效；本节以新的可复现 Red 取代该项证据。所有命令在启动前确认无遗留 pnpm、Vitest、Playwright、tsc、Drizzle、E2E runner 或 local-runtime 进程，并且严格单进程串行。

| Red → Green | 行为与结果 | 完整日志 |
| --- | --- | --- |
| `3760e25cd8d3281628abdf1140880139fe813fa5` → `376c9f3f8d7038adfd918ca947a5e1c45918f7b1` | Red 临时恢复 completed run 的旧返回值；同一公开 UI→BullMQ duplicate delivery 在 Desktop Chrome 与 Mobile Safari 都安全地观察到 `Expected: "stale"`、`Received: "completed"`，各自仅在实际 duplicate return value 处失败。Green 恢复既有 v4 `stale` 语义，使用同一完整命令验证 configured 两浏览器 **2/2** 与 missing-key 两浏览器 **2/2**，合计 **4/4**。 | `/tmp/issue30-slice9-round3-duplicate-behavior-red.log`、`/tmp/issue30-slice9-round3-e2e-green.log` |

公开 E2E seam 现在以独立字面量断言四个 structured site domains 恰为 `zhipin.com`、`liepin.com`、`zhaopin.com`、`mp.weixin.qq.com`，且每条匹配 query 都含对应完整 `site:` token；target company 恰一条、名称数组恰为固定单值、query 含完整固定 discriminator，并保留两条批准 Greenhouse domains、`resultLimit=5`、batch/candidate 上限和无 raw-query 持久化。SQL 只投影 `canonical_matches` 与 `final_matches` 布尔值（expected URL 参数化），不选择、返回或记录 canonical/final 原值；同时断言固定 SHA-256 source identifier 与 official flag。缺 key journey 以 `JSON.stringify({ run, facts }).includes(key) === false` 覆盖完整返回 run 和安全 persisted facts，失败只会输出布尔值。

本轮最终串行验证：`pnpm --filter domain exec vitest run src/agent-run-processor.integration.test.ts --no-file-parallelism` 为 **62/62**（`/tmp/issue30-slice9-round3-agent-run-processor-green.log`）；`pnpm --filter domain typecheck`、`pnpm --filter worker typecheck`、`pnpm --filter web typecheck` 均通过（`/tmp/issue30-slice9-round3-domain-typecheck.log`、`/tmp/issue30-slice9-round3-worker-typecheck.log`、`/tmp/issue30-slice9-round3-web-typecheck.log`）；Drizzle check 输出 `Everything's fine`（`/tmp/issue30-slice9-round3-drizzle-check.log`）；`git diff --check 0ed9933..HEAD` 和工作树 diff check 均通过（`/tmp/issue30-slice9-round3-final-diff-check.log`）。E2E 生成的 `apps/api/dist`、`apps/worker/dist` 已用精确路径清理，未纳入提交。

## Review Fix Round 4 — 三组公开断言的独立 mutation Red

本轮以 `ec4fa535d4be62e110f890031ee6ef2997dda570` 为起点。每个有效 Red 都在保持其余前置断言 Green 的情况下，到达对应的公开断言；每次测试前确认无遗留 pnpm、Vitest、Playwright、tsc、Drizzle、E2E runner 或 local-runtime 进程，命令严格单进程串行。

| Red → Green | 安全 mutation 与实测结果 | 完整日志 |
| --- | --- | --- |
| `218a8f2` → `620bb34` | Red 仅把 E2E Watchlist 的固定 test fixture company 改为 `Fake AnySearch Mutation`；真实 run 完成后，Desktop Chrome 与 Mobile Safari 均在 `targetCompanyNames` 的独立固定字面量断言失败。Green 恢复 `Fake AnySearch Fixture`。 | `/tmp/issue30-slice9-round4-query-red.log`、`/tmp/issue30-slice9-round4-query-green.log` |
| `14ca7ab` → `96e5fe3` | Red 将同 host、已允许的固定 verified fixture path 改为另一个静态路径，且 transport 仍映射到同一 verified 页面，所以 Gate 与持久化均可达；新拆出的 canonical/final 布尔投影在两个浏览器均为 `false`，先于 SHA-256 断言失败。Green 恢复批准 canonical path，并保留独立安全布尔断言。 | `/tmp/issue30-slice9-round4-canonical-red.log`、`/tmp/issue30-slice9-round4-canonical-green.log` |
| `d8fe6ac` → `e64a260` | **INVALID / SUPERSEDED**：虽在完整 `{ run, facts }` 的 boolean 断言失败，但 Playwright 的相邻源码上下文打印了完整 fixed placeholder；该 Red 不再作为安全证据，旧日志已精确删除。 | 不再引用 `/tmp/issue30-slice9-round4-secret-exclusion-red.log` |
| `7d953c2` → `84e4e59` | **INVALID / SUPERSEDED**：该 Red 的 Playwright 相邻源码帧仍输出相对运行详情页面链接，故不再作为安全证据；其日志已在 Round 5 精确删除。 | 不再引用 `/tmp/issue30-slice9-round4-secret-exclusion-red-safe.log` |

Round 4 的 query/canonical Red→Green 和相关回归仍保留；secret-exclusion 证据、其旧 Green 4/4 及安全扫描结论全部由下述 Round 5 取代。相关回归 `pnpm --filter domain exec vitest run src/agent-run-processor.integration.test.ts --no-file-parallelism` 为 **62/62**（`/tmp/issue30-slice9-round4-agent-run-processor-green.log`）；domain、worker、web typecheck 全通过（`/tmp/issue30-slice9-round4-domain-typecheck.log`、`/tmp/issue30-slice9-round4-worker-typecheck.log`、`/tmp/issue30-slice9-round4-web-typecheck.log`）；Drizzle check 为 `Everything's fine`（`/tmp/issue30-slice9-round4-drizzle-check.log`）。E2E 生成的 `apps/api/dist` 与 `apps/worker/dist` 已按精确路径清理，未纳入提交。

## Review Fix Round 5 — 隔离缺 key Red 的失败代码帧

本轮以 `fad239e19fdc2388d4b996e4960d98497eb6ff34` 为起点。根因是 `7d953c2` 的正确布尔断言与运行详情链接断言相邻，Playwright 失败代码帧会连同该页面链接输出。新建的 test-only `e2e/support/assert-false.ts` 仅含中性的 `assertFalse(value)` 和 `expect(value).toBe(false)`；固定非秘密占位片段仍由分段构造，Red 仅注入安全 persisted-facts 内存副本，未写入数据库、页面或生产运行时。

| Red → Green | 行为与结果 | 完整日志 |
| --- | --- | --- |
| `842835ee5a72b5a44d02a28abf09b5a4621eeb23` → `b2d6519a27bfc5d0ecf9defe3ed7c149b77268cd` | Red 提交后运行缺 key phase；Desktop Chrome 与 Mobile Safari 均在独立 helper 的同一行失败，且仅输出 `Expected: false`、`Received: true` 与中性 helper 名。Green 删除内存 probe，并以相同 helper 检查真实完整 `{ run, facts }`。 | `/tmp/issue30-slice9-round5-secret-exclusion-red.log`、`/tmp/issue30-slice9-round5-secret-exclusion-green-configured.log`、`/tmp/issue30-slice9-round5-secret-exclusion-green-missing-key.log` |

Red 完整日志的禁词扫描覆盖完整固定占位片段、候选页面域、`normalized_url`、`source_identity`、`raw query`、`/home`、`runId`、`#agent-run` 与 `href`。扫描先显式排除匹配 `^[0-9]+:\\[WebServer\\]` 的 14 条本地 WebServer 路由/启动基础设施日志；它们不是页面或候选链接。其余扫描结果为 **0 行**（`/tmp/issue30-slice9-round5-secret-red-safety-scan.log`）。

Green 严格单进程串行运行 configured Desktop/Mobile **2/2**（`/tmp/issue30-slice9-round5-secret-exclusion-green-configured.log`）与 missing-key Desktop/Mobile **2/2**（`/tmp/issue30-slice9-round5-secret-exclusion-green-missing-key.log`），合计 **4/4**。missing-key Green 的前两次尝试均在 Playwright 断言前被 Docker `55420` 端口短暂占用阻断；无测试执行结果被采纳，端口释放后从零重跑通过。旧 Round 4 safe Red 日志已精确移入废纸篓，不影响其余有效 query/canonical/duplicate Red 日志。

## Task 10 / Slice 9 — Chain Audit、真实 MinIO 证据与 phase 回归

本轮以 `8e7af1bbd50107c05c6c19a07af86cdd23fd63a3` 为起点。提交的 Red 为 `008418a`，Green 为 `d68fe7e`；没有创建 worktree、分支、PR、push 或 merge。

| 阶段 | 串行命令与结果 | 完整日志 |
| --- | --- | --- |
| Red | `DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- anysearch-public-job-discovery.spec.ts --project="Desktop Chrome" --project="Mobile Safari"` exit 1。Desktop Chrome 与 Mobile Safari 都在中性 `expectTrue` helper 各自独立得到两次 `Expected: true` / `Received: false`：一项为尚无 `preflight → extract → fetch → final_canonical_validated → gate_persisted` 证据，另一项为尚无 MinIO page-only 投影；后者没有被前者遮蔽。 | `/tmp/issue30-slice9-task10-audit-minio-red.log` |
| Green | 同一命令从零运行；runner 先选 exact configured phase，再选 exact missing-key phase。configured Desktop/Mobile **2/2**、missing-key Desktop/Mobile **2/2**，合计 **4/4**。 | `/tmp/issue30-slice9-task10-audit-minio-green-rerun.log` |
| ordinary phase | `DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- scheduled-job-discovery.spec.ts --project="Desktop Chrome" --project="Mobile Safari"`；ordinary 只选 Fake v1，未选 AnySearch spec，Desktop/Mobile **2/2**。 | `/tmp/issue30-slice9-task10-ordinary-phase.log` |
| source-health phase | `DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- source-health.spec.ts --project="Desktop Chrome" --project="Mobile Safari"`；source-health 只选固定 v3，未选 AnySearch spec，Desktop/Mobile **2/2**。 | `/tmp/issue30-slice9-task10-source-health-phase.log` |

Green 仅在精确 Fake AnySearch phase 以固定 `operation`/`fixture` 枚举写入本地 fixture audit，任何 URL、query、用户事实、provider 文本、凭据或 source identity 都不越过该 seam。两条实际 verified candidate 的有序审计均为 `preflight → extract → fetch → final_canonical_validated → gate_persisted`；因此 `/extract` 在本地 `SecureJobPageFetcher` 前，且 Gate 成功返回（真实事务完成）后才记录持久化。页面/提取中的链接不会创建额外 provider 或 page request；policy redirect 仅记录到 `preflight`、`extract`、`fetch`，没有 final validation/gate-persisted，unsafe fixture 仅在 provider 的已有 lexical preflight 被拒绝，不会获得 extract/page/audit capability。普通、source-health、configured 和 missing-key phase 的选择仍由 versioned runner/config 分开管理。

Node-side E2E 现在只读查询 verified Source Posting Version 的 `raw_object_reference` 以定位其两件真实 MinIO 对象，然后仅返回安全布尔/计数/哈希投影：对象数恰为 2，raw/visible hash 均对应 Version；只存在于本地已抓取 verified 页面中的固定文本存在；provider search title/snippet、extract auxiliary text、`username`/`password`/`api_key`、固定 test key 以及可见文本中的恶意链接均不存在。raw/visible content 和 object key/reference 从不写入失败输出或 durable audit。SQL 另证明官方 Source Posting 的 `company_careers` 身份、两条 AnySearch Attribution，以及页面 Version/Opportunity/RunResult 的既有关联；AnySearch 未成为 source identity。

本轮相关聚焦验证均在每条命令前确认无遗留 pnpm、Vitest、Playwright、tsc、Drizzle、E2E runner 或 local-runtime 进程，且未并发：`pnpm --filter domain exec vitest run src/layered-public-job-discovery-workflow.test.ts --no-file-parallelism` **11/11**，`pnpm --filter worker exec vitest run src/agent-runs/agent-run.module.test.ts --no-file-parallelism` **36/36**，`pnpm --filter web exec vitest run scripts/e2e-runner.test.ts --no-file-parallelism` **10/10**，以及 domain/worker/web typecheck 与 Drizzle check（`Everything's fine`）均通过。

`/tmp/issue30-slice9-task10-audit-minio-green.log` 不作为验证证据：首次 Green 因 test-only audit fixture map 漏掉已存在 policy redirect 的固定枚举而使两个 configured run 失败；已在无重叠进程后以最小 map 修复并从零重跑上述 rerun。所有先前报告中明确标为 invalid、overlapped 或端口冲突的运行仍一律不作为证据。

变更文件：`apps/web/e2e/anysearch-public-job-discovery.spec.ts`、`apps/web/e2e/support/assert-true.ts`、`apps/web/package.json`、`pnpm-lock.yaml`、`scripts/fake-anysearch-fixture-server.mjs`、`apps/worker/src/agent-runs/agent-run.module.ts`、`apps/worker/src/agent-runs/fake-anysearch-fixture-transport.ts`、`packages/domain/src/layered-public-job-discovery-runtime.ts`、本报告和 progress ledger。最终 `git diff --check 0ed9933..HEAD` 及 `git status --short` 均为空；没有未解决 concern。

## Full Review Fix Round 1 — recovered base、最小 lockfile、共享 phase 与证据裁决

本轮从 `175d8ff` 接续，未创建 worktree、分支、PR、push 或 merge。`46f7510` → `7f2a61f` 是 recovered helper 的 structural seam Red/Green，不能单独证明旧 recovery path 会回退默认 provider base。取代它的行为证据为 committed mutation Red `7190212` → Green `2bf3209`；shared-policy Red `32e15ec` → Green `bb9b423`；最小 lockfile 为 `1857a02`，两条直接裁决的 E2E 说明为 `a86515f`。

恢复路径的 structural Red 在 Worker module seam 以新鲜 AnySearch adapter（即无进程内 issued-candidate Map）重建一条 claim-bound v4 candidate；它仅因 helper 尚不存在而失败（`/tmp/issue30-slice9-fix1-recovered-red.log`），不作为默认-base 行为证明。行为 mutation Red `7190212` 临时令 recovery adapter 忽略已验证 fixture origin；同一空 Map、claim-bound authorization 和受控 fetch 确实到达一次 extract transport，固定-origin 布尔为 false，因而失败（`/tmp/issue30-slice9-fix1-recovered-behavior-red.log`）。该 Red 不输出 key、候选 URL 或 provider origin，且 transport 是 test stub，绝不访问真实网络。Green `2bf3209` 恢复当前 fixture-origin wiring，以同一命令通过 **37/37**（`/tmp/issue30-slice9-fix1-recovered-behavior-green.log`），transport 仍恰一次且固定-origin 布尔为 true。Green 只把已经由 domain runtime config 验证的 fixed base 交给 exact configured phase 的首个与恢复 adapter；missing-key、local 与 production 不获得测试 base，恢复授权仍仅是单 candidate/claim-bound 闭包。

shared test-runtime policy 是唯一的 `.mjs` 模块，由 E2E runner、Playwright config、local runtime 与 fixture server 的兼容 re-export 共同消费；domain 保持不可变 public enum，并以 focused parity test 阻止两组精确值漂移。policy Red 缺模块失败（`/tmp/issue30-slice9-fix1-phase-policy-red.log`），Green **11/11**（`/tmp/issue30-slice9-fix1-phase-policy-green.log`）；runner **10/10**（`/tmp/issue30-slice9-fix1-runner-policy-green.log`），local runtime **40/40**（`/tmp/issue30-slice9-fix1-local-runtime-policy-rerun.log`）。首次 local-runtime policy 运行仅因一个源码断言仍要求 config 内联字面量而失败；该断言已改为检查 shared-policy import，故该失败不是验收证据（`/tmp/issue30-slice9-fix1-local-runtime-policy-green.log`）。

`pnpm-lock.yaml` 相对 `8e7af1b` 仅保留 `apps/web` 的 direct `minio@8.0.6` importer；MinIO 已在既有 graph 中，无新 package graph 条目。`pnpm install --lockfile-only --frozen-lockfile` 在 pnpm `11.5.2` 下输出 `Already up to date`（`/tmp/issue30-slice9-fix1-lockfile-check.log`）。

直接产品/安全裁决已由真实 configured E2E 覆盖：无法 lexical-normalize 的 provider fixture 没有 extract/page audit capability；可观察事实保持 **7** Leads、**7** extracts、其中 **5** rejected、**2** Attributions、**1** Posting/Version，说明它没有形成额外 Lead 或下游。安全规范化而在 cross-host fetch 被拒绝的 candidate 仍是唯一 `POLICY_REJECTED` rejected Lead。对真实 MinIO Version，safe projection 只返回 booleans/hashes/counts：page link 在 raw HTML 中为真、在 visible text 中为假；provider search/extract links 在 raw/visible 两者中均为假；audit、Lead、Source/Version count 均未增加。没有 raw key、raw HTML、URL 或 provider 文本进入失败输出或 durable audit。

本轮每条命令前确认无遗留测试/构建进程，全部串行。最终 E2E：configured Desktop/Mobile **2/2** 加 missing-key Desktop/Mobile **2/2**，合计 **4/4**（`/tmp/issue30-slice9-fix1-anysearch-e2e.log`）；ordinary Fake v1 scheduled Desktop/Mobile **2/2**（`/tmp/issue30-slice9-fix1-ordinary-scheduled-phase.log`）；source-health v3 Desktop/Mobile **2/2**（`/tmp/issue30-slice9-fix1-source-health-phase.log`）。额外 ordinary auth 运行 **10/10**，不替代 scheduled 证据（`/tmp/issue30-slice9-fix1-ordinary-phase.log`）。E2E 生成的 `apps/api/dist`、`apps/worker/dist` 均以精确路径清理，未提交。

最终相关聚焦测试为 Worker **37/37**（`/tmp/issue30-slice9-fix1-worker-final-rerun.log`）、domain **22/22**（`/tmp/issue30-slice9-fix1-domain-final.log`）、Web runner **10/10**（`/tmp/issue30-slice9-fix1-runner-final.log`）、local runtime **40/40**（`/tmp/issue30-slice9-fix1-local-runtime-final.log`）。Worker/domain/Web typecheck 均通过（Worker rerun：`/tmp/issue30-slice9-fix1-worker-typecheck-rerun.log`；domain：`/tmp/issue30-slice9-fix1-domain-typecheck.log`；Web：`/tmp/issue30-slice9-fix1-web-typecheck-final.log`），Drizzle 输出 `Everything's fine`（`/tmp/issue30-slice9-fix1-drizzle-check.log`）。首次 Worker typecheck 仅因新 test callback 的 proceed 被推断为宽泛 string 而失败（`/tmp/issue30-slice9-fix1-worker-typecheck.log`）；以 as const 收窄后从零重跑通过，该初次失败不作成功证据。

## Full Review Fix Round 2 — 词法不安全 provider 结果的 query diagnostic

本轮从 `411908d6fc02d4b694bcfe401f09b6cd8c369724` 开始。独立审查结论为 Standards **0/0/0**、Spec **0/1/0**；唯一 Important 是词法不安全的 provider search outcome 虽不会形成 Lead、capability 或下游事实，却在 Worker search bridge 被完全丢弃，因而没有已批准的脱敏 provider/query diagnostic。未创建 worktree、分支、PR、push 或 merge。

| Red → Green | 行为与结果 | 完整日志 |
| --- | --- | --- |
| `0101e65bc2c90878e8f82ee5fb6d8417bde8e6c3` → `14403946ac7889a199fe8dc920ffeedf5ae4ff68` | committed Red 以真实 Fake AnySearch configured Desktop/Mobile UI journey 读取持久化 run detail 的安全投影。两个浏览器均到达 target-company query 的 query-scope 断言并得到空诊断数组，故实际因缺失 `ANYSEARCH_POLICY_REJECTED` 失败；失败只输出该稳定枚举、UUID、kind、bounded count 与 stable fingerprint。Green 让 Adapter 只以稳定 code 标注词法 preflight rejection，Worker 传递有界拒绝计数，workflow 绑定现有 queryId/kind/stableFingerprint 记录脱敏 diagnostic。 | `/tmp/issue30-slice9-round2-policy-diagnostic-red.log`、`/tmp/issue30-slice9-round2-policy-diagnostic-green.log` |

重复候选保持没有 policy code，故不会制造 query policy noise；已存在的“query policy diagnostic 同步 source issue”语义保持一致。query diagnostic 遵循冻结 contracts 上限 **5**，provider/source issue 仍可到 **10**。公开 E2E 对 target-company query 精确断言一条 query diagnostic；同一 journey 继续以固定 audit 枚举证明 unsafe fixture 没有 extract/page/audit，持久化 facts 保持 **7** Leads、**7** extracts、**5** rejected、**2** Attributions、**1** Posting/Version/Opportunity/Result，因而没有 unsafe Lead 或 downstream。

所有命令前均确认没有遗留 pnpm、Vitest、Playwright、tsc、Drizzle、E2E runner 或 local-runtime 进程，并且严格单进程串行：Adapter **90/90**（`/tmp/issue30-slice9-round2-policy-adapter-green.log`）、Worker module **37/37**（`/tmp/issue30-slice9-round2-policy-worker-green.log`）、domain workflow **12/12**（`/tmp/issue30-slice9-round2-policy-domain-green.log`）、processor integration **62/62**（`/tmp/issue30-slice9-round2-policy-processor-green.log`）；configured Desktop/Mobile **2/2** 与 missing-key Desktop/Mobile **2/2**，合计 E2E **4/4**（`/tmp/issue30-slice9-round2-policy-diagnostic-green.log`）。domain/worker/web typecheck 分别见 `/tmp/issue30-slice9-round2-policy-domain-typecheck.log`、`/tmp/issue30-slice9-round2-policy-worker-typecheck.log`、`/tmp/issue30-slice9-round2-policy-web-typecheck.log`；Drizzle 为 `Everything's fine`（`/tmp/issue30-slice9-round2-policy-drizzle-check.log`）。

### Full Review Fix Round 2 — query diagnostic 计数边界更正

复审确认上述 Green 仍错误地把 query-scope `affectedCount` 视为 10；冻结的 `DiscoveryDiagnosticSchema` 对 query 限制为 **5**，provider diagnostic 与 source issue 保持 **10**。Red `2b53df28e4c4f781df6fde64dfff671ed55decaf` 让同一 query/code 同时收到 bridge `rejectedCandidateCount=99` 与既有安全候选的 policy rejection，domain workflow **11/12**，唯一失败为安全计数 `Expected: 5` / `Received: 10`（`/tmp/issue30-slice9-round2-query-cap-red.log`）。这同时证明只修改 bridge 单点仍不足以阻止同 query 再累计超过 5。

Green `b92f675a55a4a83b145ebb574432059776d82a84` 把 Worker bridge、domain rejected-count 和按 scope 的 diagnostic aggregation 一并收紧为命名的 query 上限 5；provider diagnostic 及 source issue aggregation 维持 10。相同输入最终得到 query diagnostic **5**，source issue 按两次来源正确为 **6**（仍受 10 上限），并通过公共 `DiscoveryDiagnosticSchema` parse。最终单进程串行回归为 Worker module+Adapter **127/127**（`/tmp/issue30-slice9-round2-query-cap-worker-green.log`）、domain workflow+processor **74/74**（`/tmp/issue30-slice9-round2-query-cap-domain-processor-green.log`）、configured Desktop/Mobile 加 missing-key Desktop/Mobile E2E **4/4**（`/tmp/issue30-slice9-round2-query-cap-e2e-green.log`）；domain/worker/web typecheck 分别见 `/tmp/issue30-slice9-round2-query-cap-domain-typecheck.log`、`/tmp/issue30-slice9-round2-query-cap-worker-typecheck.log`、`/tmp/issue30-slice9-round2-query-cap-web-typecheck.log`；Drizzle 为 `Everything's fine`（`/tmp/issue30-slice9-round2-query-cap-drizzle-check.log`）。

首次 Green E2E 过度把全部 query 的 policy diagnostics 当作 target fixture；两条 site-constrained fixture 的安全但不批准域候选也正确产生已有的 query policy diagnostics，因此该运行不作为 Green 证据。断言收窄到实际 lexical-unsafe target query 后从零重跑通过。首次 Web typecheck 只因该 filter 没有静态收窄 discriminated union 而失败；改成显式 query-scope type guard 后从零重跑通过。E2E 生成的 `apps/api/dist` 与 `apps/worker/dist` 已精确清理，未提交；没有未解决 concern。
