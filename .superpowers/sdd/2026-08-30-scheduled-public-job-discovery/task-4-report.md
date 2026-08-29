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

### Self-review / concerns

- 没有调度 API/UI、生命周期持久化或 Worker scheduler 改动；详情失败只以稳定 Adapter error 返回，让现有 Processor 重试边界处理。
- 全部 Adapter 契约网络通过 source-access `/testing` transport 和固定 fixtures，不访问真实招聘站。
- `pnpm --filter worker test` 全量命令在本任务剩余窗口内没有完成输出；已运行的 focused module + typecheck 作为本切片证据。
