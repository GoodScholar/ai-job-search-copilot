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
- 该 Slice 不改变生产 AnySearch/Greenhouse、URL policy、Gate、Lead/Attribution、预算或终态契约；也不启动 Task 11 全量验收。
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
