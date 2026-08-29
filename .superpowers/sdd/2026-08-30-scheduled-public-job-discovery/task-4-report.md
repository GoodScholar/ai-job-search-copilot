## Task 4 report — Greenhouse public Job Board Adapter

Base: `a891f21e896fc20e9e26e0a14874196d1515dee1`

### RED / GREEN

- RED: 新增 Adapter 契约测试先失败，因为 Worker 未声明 `@job-copilot/source-access` 依赖且 `greenhouse-job-discovery-adapter` 不存在。
- GREEN: Adapter、受控 `/testing` client fixture tests、resolver/Fake/module 回归和 Worker TypeScript 检查均通过。

### Fixed fixtures and network evidence

- 全部 fixture 是虚构的 Fictional Labs 岗位：完整列表、详情、更新详情、空列表、不完整列表位于 `apps/worker/src/agent-runs/fixtures/greenhouse/`。
- 契约测试证明列表 JSON 不能通过详情 schema；列表只产生最多 5 个候选和未截断的 6 个 `observedDetailIds`，详情 `first_published`/`application_deadline` 只来自精确详情 GET。
- 列表 URL 固定为 `/v1/boards/{encodedToken}/jobs?content=true`；详情 URL 固定为 `/v1/boards/{encodedToken}/jobs/{encodedJobId}`，无 questions/pay query，redirects 为 0，也不读取 `absolute_url`。
- source scope 仍被 Adapter 复核。没有精确 `boards-api.greenhouse.io` 授权时返回 `GREENHOUSE_API_HOST_NOT_ALLOWED`，测试的 DNS lookup 为 0；每次请求只传精确交集 `['boards-api.greenhouse.io']`。
- 429 fixture transport 稳定执行 2 次 HTTP attempt，但仅一次 `searchBatch` 业务调用；预算预占仍归 Processor Task 6，未在 Adapter 复制。

### Resolver and scope

- Fake v1 保留给 local/test；production 拒绝 Fake。
- Greenhouse v2 在 production 可解析；local 必须显式 `PUBLIC_JOB_DISCOVERY_ADAPTER=greenhouse`；test 一律拒绝，避免 Playwright/CI 实网。
- 为让 v1/v2 Adapter 都满足单一接口，最小扩展 `JobDiscoveryAdapter.searchBatch` 的输入/返回联合；现有 Fake v1 不变。

### Verification

`pnpm --filter worker typecheck` → success.

`APP_ENV=test pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/greenhouse-job-discovery-adapter.test.ts src/agent-runs/job-discovery-adapter-resolver.test.ts src/agent-runs/agent-run.module.test.ts src/agent-runs/fake-job-discovery-adapter.test.ts` → 4 files / 26 tests passed.

`git diff --check` → success.

## Fix Round 3/5

Base: `8a737b078f6a4c02a5afeff74dab66e9b546079e`

### RED / GREEN

- RED: 合法 scope 加 `targetSnapshot:null` 时，旧实现会通过 source 校验并进入 public client，而不是在 Adapter 入口稳定失败。
- GREEN: 新增单一严格 Zod `GreenhouseBatchSearchInputSchema`，覆盖整个 Public v2 batch input（target snapshot、constraints、scope、source 字段与未知字段）。解析失败一律在任何 classifier/DNS/transport 前返回 `GREENHOUSE_SOURCE_UNSUPPORTED`。

### Evidence

- 表驱动 whole-input 测试覆盖 `targetSnapshot:null`、`constraints:null`、错误 locations 类型、unknown input field 与 unknown target field；每行断言 stable non-retryable result 和 lookup/transport 均为 0。

### Fix verification

`APP_ENV=test pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/greenhouse-job-discovery-adapter.test.ts src/agent-runs/job-discovery-adapter-resolver.test.ts src/agent-runs/agent-run.module.test.ts src/agent-runs/fake-job-discovery-adapter.test.ts` → 4 files / 59 tests passed.

`pnpm --filter worker typecheck` → success.

`git diff --check` → success.

## Fix Round 2/5

Base: `a32ae14de8e72dcbdd4a81e8aa2e6ad9908f2eb2`

### RED / GREEN

- RED: `allowedDomains: null` 会穿透 Adapter 并在 classifier 抛出 TypeError。
- GREEN: `searchBatch` 对 source scope 做运行时严格结构验证；null allowlist、非法 careers URL、unknown field、错误 source identity 都稳定映射 `GREENHOUSE_SOURCE_UNSUPPORTED`、不可重试，且 lookup/transport 均为 0。

### Stable-error matrix

- list logical-call 表驱动实际覆盖 malformed、401、403、404、429、5xx、timeout、too-large、redirect、invalid JSON、schema mismatch；429/5xx/timeout 以受控 source-access transport 证明 bounded 两 HTTP attempts。
- detail logical-call 表驱动实际覆盖 401、403、404、429、5xx、timeout、too-large、redirect、invalid JSON、schema mismatch、ID mismatch；每个失败同一 detail ID 的下一调用都重新精确 GET 并可从成功 fixture 返回，证明没有缓存失败。
- 所有错误断言仅包含稳定 code/retryable，并检查结果序列化不含 fixture secret、URL/域名或 stack；所有网络使用 `/testing` transport。

### Fix verification

`APP_ENV=test pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/greenhouse-job-discovery-adapter.test.ts src/agent-runs/job-discovery-adapter-resolver.test.ts src/agent-runs/agent-run.module.test.ts src/agent-runs/fake-job-discovery-adapter.test.ts` → 4 files / 54 tests passed.

`pnpm --filter worker typecheck` → success.

`git diff --check` → success.

### Self-review / concerns

- 没有调度 API/UI、生命周期持久化或 Worker scheduler 改动；详情失败只以稳定 Adapter error 返回，让现有 Processor 重试边界处理。
- 全部 Adapter 契约网络通过 source-access `/testing` transport 和固定 fixtures，不访问真实招聘站。
- `pnpm --filter worker test` 全量命令在本任务剩余窗口内没有完成输出；已运行的 focused module + typecheck 作为本切片证据。

## Fix Round 1/5

Base: `19473c4be630372e982de94383fd6165558a7c0e`

### RED / GREEN

- RED: 多 source 测试证明旧实现会在发现第二个 parent-only source 前已 DNS/transport 第一个 source；success→empty/failed batch 也会继续返回上一 generation 的 cached detail，更新 fixture 未重新读取。
- GREEN: `searchBatch` 首先清空 active generation/cache，并纯校验所有 sources；只有严格 scope 与全部列表都成功后才原子替换 source/candidate state。缺少精确 API host 的第二 source 现在返回 `GREENHOUSE_API_HOST_NOT_ALLOWED`，lookup 与 transport 都为 0。

### State and cache evidence

- successful→empty、successful→第二 source 5xx、重复 success 均不会让旧或半成品 candidate 进入 `getDetail`。
- 详情失败不写 cache；同 ID 下次成功会再次 GET；成功详情在同一 generation 被复用；新 batch generation 清空成功 cache，`updated-job-detail.json` 的 title/deadline 得到新值。

### Fix verification

`APP_ENV=test pnpm --filter worker exec vitest run --no-file-parallelism src/agent-runs/greenhouse-job-discovery-adapter.test.ts src/agent-runs/job-discovery-adapter-resolver.test.ts src/agent-runs/agent-run.module.test.ts src/agent-runs/fake-job-discovery-adapter.test.ts` → 4 files / 29 tests passed.

`pnpm --filter worker typecheck` → success.

`git diff --check` → success.
