# 每日检查公开公司招聘页与 ATS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. 每个实现切片由 `gpt-5.6-terra / high` 完成 TDD、测试和修复；每个切片结束后由 `gpt-5.6-sol / high` 分别执行规格审查与质量审查，未通过不得进入下一切片。

**Goal:** 从固定累计基线 `dfab6bafb3b32ce4f9693f1937e9309c4a997af9` 交付 GitHub Issue #11：用户可为活动求职目标配置每日检查计划或立即检查，Worker 通过经过安全审核的 Greenhouse 公共 Job Board GET Adapter 发现、版本化并维护岗位生命周期，同时保持 #10 与 #28 的运行控制、预算、恢复、Watchlist 优先级和迁移连续性。

**Architecture:** PostgreSQL 是每日检查计划、到期 occurrence、Agent Run、来源发布记录与岗位机会的唯一事实源；Worker 的计划扫描器只物化到期 occurrence，并把 occurrence UUID 作为现有 `AgentRunCommands.start` 的幂等键，因此手动与计划触发共享同一运行创建边界，BullMQ 继续只负责可恢复唤醒。生产公共流程使用版本化 Greenhouse v2 执行规格：每个 board 的列表 GET 形成不受结果上限截断的完整扫描事实，随后仅为最多 5 个候选执行详情 GET；测试与 Playwright 保留 Fake v1。公共 HTTP 访问由一个共享深模块封装 DNS 固定、用户允许域与 Adapter 固定 host 的双重授权、并发、超时、退避、大小、重定向和诚实身份策略。

**Tech Stack:** TypeScript、Zod、PostgreSQL 17、Drizzle ORM、NestJS/Fastify、BullMQ/Redis、MinIO、Next.js 16/React 19、Vitest、Testcontainers、Playwright。

**Spec:** GitHub Issue `GoodScholar/ai-job-search-copilot#11`；产品与架构边界见 `PRODUCT.md`、`CONTEXT.md`、`docs/adr/0003-use-layered-job-sources.md`、`0006-use-durable-agent-runs.md`、`0009-use-modular-monolith.md`、`0014-use-constrained-agent-workflows.md`、`0018-budget-every-agent-run.md`、`0020-run-production-shaped-local-infrastructure.md`、`0022-start-discovery-from-company-watchlists.md`、`0024-separate-source-postings-from-job-opportunities.md`、`0028-isolate-untrusted-career-content.md` 与 `0030-record-redacted-agent-run-audits.md`。公共 ATS 契约依据 [Greenhouse Job Board API 官方文档](https://docs.greenhouse.io/job-board.html)：所有 GET endpoint 无需认证，列表和详情 endpoint 分别为 `/v1/boards/{board_token}/jobs` 与 `/v1/boards/{board_token}/jobs/{job_id}`。

## Global Constraints

- 当前 HEAD 必须从头到尾保留 `dfab6bafb3b32ce4f9693f1937e9309c4a997af9` 为祖先；不得 reset、回退、覆盖或丢失迁移 `0018`–`0020` 及 #10/#28 行为。
- 新迁移固定为 `0021_scheduled_public_job_discovery.sql` 和 `0021_snapshot.json`；SQL 只能表达相对 `0020` 的增量，journal 顺序必须保持 `0018 → 0019 → 0020 → 0021`。
- `CONTEXT.md` 中“运行计划”继续只表示一次 Agent 运行的受约束步骤序列；新调度聚合统一称为“每日检查计划”，避免把 schedule 与 execution plan 混为一谈。
- MVP 每个求职目标最多一个每日检查计划；用户配置启用状态与 `HH:mm` 检查时间，时区固定并持久化为 `Asia/Shanghai`。停机跨过多个时点时最多补一个 occurrence，不制造补跑风暴。
- 只有当前账户拥有且活动的求职目标可以启用计划或创建新运行；目标停用后保留计划与历史 occurrence，但计划扫描器不得创建新 Agent Run。
- 手动立即检查继续使用客户端稳定 UUID；计划 occurrence 使用 occurrence UUID。二者必须调用同一个 `AgentRunCommands.start`，并共同依赖 `agent_runs(user_id,idempotency_key)` 唯一约束。
- PostgreSQL occurrence 是调度事实，BullMQ repeatable job、cron 状态或 Redis key 不得成为权威计划账本。
- 遗留 Fake v1 Agent Run 必须继续可查询、恢复、控制和完成；新增 Greenhouse v2 执行规格通过判别式联合扩展，不直接改写旧 literal 或回填旧运行。
- `APP_ENV=test` 与默认 Playwright 只能解析 Fake v1；真实公共网络在测试环境 fail-closed。local 默认 Fake，只有显式 `PUBLIC_JOB_DISCOVERY_ADAPTER=greenhouse` 才启用公共 Adapter；production 禁止 Fake 并使用 Greenhouse v2。
- 首个生产 Adapter 只支持 `boards.greenhouse.io/{boardToken}` 与 `job-boards.greenhouse.io/{boardToken}` 形式的公开 Watchlist URL，且路径必须恰好只有一个非空 board token 段。运行快照 `allowedDomains` 还必须显式包含精确 `boards-api.greenhouse.io`；broad parent domain（例如 `greenhouse.io`）或 Adapter 内置 host 映射均不能代替用户授权。
- Greenhouse scope 只在 careers URL host/path 与精确 API host 授权同时成立时为 supported。非支持来源保留在 Watchlist，但不得进入可执行 v2 scope；缺少 API host 授权返回稳定 `GREENHOUSE_API_HOST_NOT_ALLOWED` policy code，并在计划 API/UI 显示可执行的“待接入：需允许 boards-api.greenhouse.io”，不能静默跳过或伪装已检查。
- Greenhouse 只允许 GET 列表和详情数据；不得实现申请提交、API key、登录、Cookie、验证码、浏览器自动化、反检测或从岗位正文跟随链接。
- 公共访问固定策略：HTTPS；Greenhouse client 的 immutable exact-host capability 固定为 `boards-api.greenhouse.io`；每次实际调用的用户授权参数只能传运行快照与固定 API host 的精确交集 `["boards-api.greenhouse.io"]`，不得把整个 `allowedDomains` 放大成网络 egress 权限。模块在 DNS/socket 前同时验证 capability host、调用级允许域与目标 URL host；全局并发 2、单 host 并发 1；连接 3 秒、每次请求总计 8 秒；响应上限 2 MiB；最多 2 次有界 GET 尝试；`Retry-After` 上限 30 秒；重定向数 0；User-Agent 为 `AI-Job-Search-Copilot/0.1 (+https://github.com/GoodScholar/ai-job-search-copilot)`，不得伪装浏览器。
- Greenhouse v2 的 `searchBatch` 对每个 board 发起一次 `?content=true` 列表 GET，以全量唯一岗位 ID 和 `meta.total` 形成 `observedDetailIds`/`complete`；`maxResults=5` 只限制进入详情阶段的候选，不得截断扫描事实。列表 fixture 不能满足最终 detail schema。
- 对最终选中的最多 5 个候选，`getDetail` 必须逐一调用精确的 `/v1/boards/{board_token}/jobs/{job_id}` 详情 GET，并从真实详情响应取得 `first_published`、`application_deadline` 与最终标准详情；只可缓存本次已成功取得的详情响应，不得声称这些字段来自列表 raw JSON，不得跟随正文或 `absolute_url`。
- Greenhouse v2 运行预算固定为：`maxActiveDurationMs=180000`、`maxAttempts=3`、`maxToolCalls=60`、`maxResults=5`、`maxModelCalls=0`、`maxTokens=0`。每个 board 列表是一个逻辑 tool/source request，每个选中岗位详情也是一个逻辑 tool/source request，均须在网络发生前预占；HTTP 层内部最多 2 次有界 GET 尝试属于同一逻辑调用，另记稳定 attempt 计数，不得伪装成额外或无限预算。
- 任何详情失败都沿现有 Agent Run 失败/重试边界处理；只有列表完整、全部选中详情成功且本次发现持久化事务成功时，才允许依据 `scans` 把此前 open、本次缺失的来源发布记录标为 closed。
- 来源发布记录当前状态为 `open | closed | expired`；最新完整扫描缺失产生 closed 版本，`application_deadline <= now` 产生 expired 版本，重新出现产生新的 open 版本。任何历史 posting/version/opportunity/evidence/run result 均不得删除或覆盖。
- 来源版本只与该来源发布记录的最新版本比较；`content_sha256`、`raw_content_sha256` 或 availability 任一变化时追加版本，相同最新事实才复用。这样 closed→open 即使正文未变也会保留重开历史。
- 岗位机会只有至少一个当前 open 且未过期的来源发布记录时为 open；closed/expired 机会不得写入新 `agent_run_job_results`，并为后续推荐查询提供数据库可过滤状态。
- Adapter、SSE、审计、Inbox 和普通日志只传稳定错误码与计数，不记录岗位正文、原始响应、允许域列表、对象存储 key、凭据、异常堆栈或模型输入。
- 默认 `pnpm test`、CI 和 Playwright 不允许真实 DNS/socket 请求；真实 smoke check 只能通过不属于默认验收命令的显式本地 opt-in 执行，本 Issue 不要求运行该 smoke check。
- 不 push、不创建 PR、不 merge。实现完成后发布 fresh verification GitHub 评论并关闭 #11，然后停止，不开始其他 Issue。

## 方案比较与决策

1. **推荐：PostgreSQL occurrence + 共享 Agent Run 创建边界。** 能在 API/Worker/Redis 重启后恢复，数据库唯一约束直接证明重复调度不重复运行，并与 ADR 0006/0020 一致。
2. **拒绝：BullMQ repeatable jobs。** `removeOnComplete` 与 Redis 重建会丢失计划事实，计划编辑和 occurrence 历史也难以与 PostgreSQL 原子组合。
3. **拒绝：部署 cron 直接 POST Agent Run。** 调度身份、幂等时点和账户所有权散落在部署层，无法在领域测试中证明重复触发与停机恢复。

公共 Adapter 选择 Greenhouse 而不是泛化 HTML 抓取或首期接入登录平台：官方文档明确 GET 数据公开无需认证，列表提供稳定岗位 ID 和 `meta.total`，详情提供 `first_published`、`application_deadline` 与 `absolute_url`，足以用固定 JSON fixtures 锁定完整扫描、详情、更新和过期语义。

## 条件批准修订账本（所有切片与最终审查强制核对）

| 修订项 | 绑定实现 | 必须保留的证据 |
|---|---|---|
| 列表与详情职责分离 | Task 1、4、6 | list fixture 不能通过 detail schema；全量 `observedDetailIds/meta.total` 不受 5 条候选限制；`first_published`/`application_deadline` 只来自 detail fixture |
| 逻辑预算与 HTTP attempt 分离 | Task 3、4、6 | 每 board 一次列表逻辑调用、每候选一次详情逻辑调用；内部最多 2 attempts，逻辑预算不重复扣减且 attempt 计数稳定 |
| 详情失败不得关闭历史岗位 | Task 4、6 | timeout/429/5xx/schema/persistence failure 均走既有失败/重试边界，数据库断言 lifecycle reconciliation 未提交 |
| 用户允许域与 Adapter host 双重授权 | Task 1、2、3、4、5 | careers host/path、精确 API host、parent-domain 不足、缺授权零 DNS/socket、API/UI 可执行 policy 提示测试 |

上述四行必须原样进入 SDD `progress.md` 的 preflight/review attention ledger；任何切片 reviewer 和最终 Standards/Spec reviewer 均不得以其他测试间接覆盖为由省略核对。

## Acceptance Criteria 与验证证据

| #11 Acceptance criterion | 实施切片 | Fresh verification 证据 |
|---|---|---|
| 活动求职目标可配置每日运行并从相同流程立即运行 | Task 1、2、5、7 | schedule 契约/数据库测试、认证 API、同一面板组件测试、Playwright 保存计划与立即检查 |
| 重复调度和 Worker 重试不重复 run/posting/opportunity | Task 1、2、6、7 | occurrence/run/source/opportunity 唯一约束、并发 dispatcher Testcontainers、重复 BullMQ delivery、E2E 数据库断言 |
| 首个真实公共 Adapter 输出标准搜索、详情、来源身份和稳定错误 | Task 3、4 | Greenhouse 固定 fixtures 契约测试、v2 Zod 严格解析、resolver 兼容 v1/v2 |
| Adapter 遵守允许域、并发、超时、退避、大小、重定向、诚实身份 | Task 1、3、4、5 | supported-source 双重授权契约、共享公共访问模块受控本地 server 测试、零网络 policy 拒绝、Adapter transport 测试与测试环境断网门禁 |
| 内容更新追加版本，关闭/过期停止新推荐且保留历史 | Task 1、6 | 迁移约束、完整/不完整扫描、更新/关闭/过期/重开、多来源机会状态集成测试 |
| Adapter 契约固定 fixtures；默认 CI/Playwright 不访问真实站点 | Task 3、4、7 | fixture-only 测试、`APP_ENV=test` fail-closed、Playwright Fake resolver、网络调用计数为零 |
| Playwright 通过 Fake 公共来源完成计划运行并显示新增岗位 | Task 7 | Desktop Chrome + Mobile Safari 定时 occurrence→run→SSE→新增岗位完整旅程 |

## 文件结构

**创建**

- `packages/contracts/src/job-discovery-schedules.ts` / `.test.ts`：每日检查计划、occurrence 与稳定状态契约。
- `packages/source-access/package.json`、`tsconfig.json`、`src/public-source-client.ts`、`src/public-source-client.test.ts`：公共只读 HTTP 深模块。
- `packages/database/migrations/0021_scheduled_public_job_discovery.sql` 与 `meta/0021_snapshot.json`。
- `packages/domain/src/job-discovery-schedules.ts` 与 `.integration.test.ts`：计划聚合、到期物化、pending occurrence 派发。
- `apps/api/src/job-discovery-schedules/*`：认证 REST module/controller/tokens。
- `apps/worker/src/agent-runs/greenhouse-job-discovery-adapter.ts` 与 `.test.ts`。
- `apps/worker/src/agent-runs/fixtures/greenhouse/list-jobs.json`、`job-detail.json`、`updated-job-detail.json`、`empty-list-jobs.json`、`invalid-list-jobs.json`；列表与详情 fixture 使用不同严格 schema。
- `apps/worker/src/agent-runs/agent-run-scheduler.ts` 与 `.test.ts`。
- `apps/web/lib/server/job-discovery-schedules.ts` 与 `.test.ts`。
- `apps/web/app/api/job-targets/[targetId]/discovery-schedule/route.ts` 与 `.test.ts`。
- `apps/web/components/workbench/discovery-schedule-panel.tsx` 与 `.test.tsx`。
- `apps/web/e2e/scheduled-job-discovery.spec.ts`。

**修改**

- `CONTEXT.md`：新增“每日检查计划”，明确避免与“运行计划”混用。
- `packages/contracts/package.json`、`packages/contracts/src/agent-runs.ts` / `.test.ts`：导出 schedule，加入 Fake v1/Public v2 联合执行规格、完整扫描事实和 public budget。
- `packages/database/src/schema.ts`、`src/index.ts`、`src/migrate.integration.test.ts`、migration journal：新增计划/occurrence 与来源/机会 lifecycle 字段和约束。
- `packages/domain/package.json`、`packages/domain/src/agent-run-control.ts`、`agent-run-processor.ts`、`agent-run-source-scope.ts`、`agent-run-queries.ts`、`agent-runs.ts`、相关测试：共享 run factory、v1/v2 快照、按完整扫描维护 lifecycle。
- `apps/api/package.json`、`apps/api/src/app.module.ts`、`api-documentation.ts`、`api.integration.test.ts`、`job-imports/job-page-fetcher.ts` / `.test.ts`、`agent-runs/agent-runs.module.ts`：接入 schedule API 与共享公共访问模块。
- `apps/worker/package.json`、`agent-runs/job-discovery-adapter-resolver.ts` / `.test.ts`、`agent-run.module.ts` / `.test.ts`、`agent-run.integration.test.ts`：Greenhouse resolver 与 schedule scanner。
- `apps/web/app/(workbench)/home/page.tsx` / `.test.tsx`、`components/workbench/agent-run-panel.tsx` / `.test.tsx`、`lib/server/api-client.ts`、`app/globals.css`、必要的 BFF 测试：同一流程展示计划和立即检查。
- `apps/web/playwright.config.ts` 与 `scripts/local-runtime.mjs`（仅当测试断网环境变量尚未传入 Worker）：固定 Fake、禁止公共网络。

---

### Task 1: 定义每日检查计划、公共执行规格与生命周期数据

**Files:** 上述 contracts、`CONTEXT.md`、database schema/migration/migration test。

**Interfaces:**

```ts
type JobDiscoverySchedule = {
  scheduleId: string;
  targetId: string;
  version: number;
  state: "enabled" | "disabled";
  dailyTime: `${number}${number}:${number}${number}`;
  timeZone: "Asia/Shanghai";
  nextRunAt: string | null;
  updatedAt: string;
};

type SetJobDiscoveryScheduleCommand = {
  expectedVersion: number;
  state: "enabled" | "disabled";
  dailyTime: string;
};

type JobDiscoveryScheduleOccurrence = {
  occurrenceId: string;
  scheduleId: string;
  targetId: string;
  scheduledFor: string;
  status: "pending" | "dispatched" | "skipped";
  runId: string | null;
  skipReason: "TARGET_INACTIVE" | "NO_SUPPORTED_SOURCE" | "SOURCE_POLICY_REQUIRED" | null;
};
```

- [ ] 写失败的契约测试：严格拒绝未知字段、非法 `HH:mm`、客户端时区、零/负版本；v1 Fake run 完整样例继续通过。v2 Greenhouse scope 必须携带 Watchlist item ID、公司规范名称、入口 URL、运行快照允许域、board token 与稳定 source ID；supported-source 判定必须同时要求合法 careers host/单段 path 和精确 `boards-api.greenhouse.io` 授权，parent domain 不足。
- [ ] 运行 `pnpm --filter @job-copilot/contracts exec vitest run src/agent-runs.test.ts src/job-discovery-schedules.test.ts`，预期因新导出/Schema 不存在失败。
- [ ] 最小实现 schedule schemas 和 Fake v1/Public v2 判别式联合；v2 batch success 形状固定为 `{ items, scans: [{ sourceId, observedDetailIds, complete }] }`，v1 形状不变。
- [ ] 在数据库测试中先断言迁移后存在 `job_discovery_schedules`、`job_discovery_schedule_occurrences`，以及 `(user_id,target_id)`、`(schedule_id,scheduled_for)`、occurrence/run owner FK、状态/时间/版本检查；断言 source posting/version/opportunity 新 lifecycle 字段和索引。
- [ ] 修改 schema 后用 Drizzle 生成 `0021`，人工核对 SQL 只含 0020 之后增量；为历史 posting/version/opportunity 回填 `open` 与安全时间值，不改历史 run JSON。
- [ ] 运行 database migration Testcontainers，预期空库迁移与从 0020 snapshot 连续升级均通过。
- [ ] 更新 `CONTEXT.md`，只新增领域定义：“每日检查计划：目标求职者为一个活动求职目标配置的每日公开来源检查时间与启用状态；它产生 Agent 运行，但不是运行计划。”
- [ ] 运行 contracts/database tests、`pnpm typecheck`、`git diff --check`。
- [ ] 提交 `feat: define scheduled public discovery data (#11)`；随后由 sol 执行本切片 Spec/Quality 双审，修复并复审通过。

### Task 2: 共享运行创建边界并实现计划 occurrence 幂等物化

**Files:** `packages/domain/src/job-discovery-schedules.ts`、`agent-run-control.ts`、`audit-trail.ts` 及集成测试。

**Interfaces:**

```ts
type AgentRunStarter = {
  start(input: {
    userId: string;
    requestId: string;
    command: { targetId: string; idempotencyKey: string };
    trigger?: { kind: "manual" } | { kind: "schedule"; occurrenceId: string; scheduledFor: Date };
  }): Promise<StartAgentRunResponse>;
};

function createJobDiscoverySchedules(deps: {
  db: Database;
  runs: AgentRunStarter;
  auditTrail: AuditTrail;
  id: () => string;
  clock: () => Date;
}): {
  get(input: { userId: string; targetId: string }): Promise<JobDiscoverySchedule | null>;
  set(input: { userId: string; targetId: string; requestId: string; command: SetJobDiscoveryScheduleCommand }): Promise<JobDiscoverySchedule>;
  materializeDue(input: { limit: number }): Promise<JobDiscoveryScheduleOccurrence[]>;
  dispatchPending(input: { limit: number }): Promise<void>;
};
```

- [ ] 写 Testcontainers 红测：创建/更新/禁用计划的 CAS、跨账户不可见、inactive 目标拒绝启用、`Asia/Shanghai` 下一个时点计算、停机多日只产生一个 occurrence。
- [ ] 写并发红测：两个 scanner 同时物化同一时点只能有一个 occurrence；同一 occurrence 两次派发返回同一 run；queue wake 失败仍保留可恢复 run；目标在物化后停用则 occurrence 变 `skipped/TARGET_INACTIVE`；缺少精确 API host 授权时不得创建 run，并稳定记录 `skipped/SOURCE_POLICY_REQUIRED`。
- [ ] 将 `agent-run-control.ts` 的事务性创建逻辑下沉为文件内共享 factory；保持 #10 的顺序：账户 advisory lock → 幂等复用 → 活动目标 → Watchlist revision → immutable execution spec → steps/events/audit → 提交后 best-effort queue。
- [ ] `materializeDue` 使用 `FOR UPDATE SKIP LOCKED` 与 occurrence 唯一键，在同一事务把 `next_run_at` 推到当前时刻之后；不直接调用 BullMQ。
- [ ] `dispatchPending` 以 `occurrenceId` 作为 `idempotencyKey` 调用同一 `start`；成功后 CAS 绑定 `runId`，重复调用只复用；inactive/无支持来源写稳定 skipped 原因。
- [ ] 审计只保存 schedule/occurrence/target/run 内部 ID、版本、时点与状态，不保存 URL、域或岗位正文。
- [ ] 运行 domain focused tests、既有 agent run control/budget/recovery tests、typecheck、diff check。
- [ ] 提交 `feat: materialize idempotent discovery schedules (#11)`；sol Spec/Quality 双审并复审。

### Task 3: 提取共享公共来源访问深模块

**Files:** `packages/source-access/**`，以及 #8 `job-page-fetcher` 的委托改造与原测试。

**Interface:**

```ts
interface PublicSourceClient {
  get(input: {
    url: URL;
    allowedDomains: readonly string[];
    accept: "text/html" | "application/json";
    maxRedirects: 0 | 3;
    retry: "none" | "bounded";
    signal?: AbortSignal;
  }): Promise<{ status: number; headers: Readonly<Record<string, string>>; body: Uint8Array }>;
}
```

- [ ] 将 client 构造边界固定为 `createPublicSourceClient({ exactHosts, ...transportDeps })`；调用级 `allowedDomains` 只能进一步收窄该 immutable capability，不能扩张它。Greenhouse 构造时 `exactHosts` 只能是 `["boards-api.greenhouse.io"]`，实际 GET 调用也只能传用户快照交集 `["boards-api.greenhouse.io"]`。
- [ ] 先写受控本地 HTTP/DNS 红测：非 HTTPS、凭据 URL、immutable exact host 不匹配、调用级允许域缺失、仅 parent domain、私网/混合 DNS、DNS rebinding、越域重定向、重定向超限、错误 content type、2 MiB+1、连接/总超时、429/5xx 有界退避、`Retry-After` 30 秒封顶、全局 2/单 host 1、固定 User-Agent、abort。所有 policy 拒绝断言 DNS/socket 调用计数为零。
- [ ] 运行 source-access tests，预期模块不存在失败。
- [ ] 实现小接口，把双重 host 授权、DNS pinning、IP 拒绝、并发 semaphore、request timers、大小、redirect/retry 与错误映射隐藏在模块内部；测试 transport 仅作为内部 seam，不导出到业务调用方。内部 retry 暴露稳定 attempt 计数供审计/预算证据，但一个业务 GET 始终只算一个逻辑 tool/source request。
- [ ] 让 `SecureJobPageFetcher` 委托该模块，保持 #8 的 `JobPageFetchError`、同 host 最多 3 次跳转、HTML 分类与全部既有 fixtures 行为不变。
- [ ] `APP_ENV=test` 只允许显式 `testOrigin`；没有该 origin 的真实 host 在 DNS/socket 前返回 `PUBLIC_SOURCE_NETWORK_DISABLED`。
- [ ] 运行 source-access、API job-page-fetcher、job import integration、typecheck 与 diff check。
- [ ] 提交 `refactor: centralize public source access policy (#11)`；sol Spec/Quality 双审并复审。

### Task 4: 实现 Greenhouse 公共 Job Board Adapter 与 v1/v2 resolver

**Files:** Greenhouse Adapter、fixtures、resolver、contracts tests、worker module tests。

**Interfaces:** Greenhouse Adapter 继续满足 `JobDiscoveryAdapter`；`searchBatch` 每个 board 发起一次列表 GET 并返回 v2 `{ items, scans }`，其中 `scans.observedDetailIds` 保存全量唯一 ID，`items` 最多 5 个；`getDetail` 为每个选中 ID 发起精确详情 GET，并从详情响应标准化最终字段。可复用已成功取得的真实详情响应，但列表 raw JSON 绝不能冒充详情；绝不发起 POST 或跟随正文/`absolute_url`。

- [ ] 添加严格区分的固定 JSON fixtures：完整列表、详情、更新后详情、空完整列表、非法/不完整列表；fixture 中只用虚构公司和岗位。明确断言 list fixture 本身因缺少 `company_name`、`first_published`、`application_deadline` 而不能满足 detail schema。
- [ ] 写红测锁定 supported-source 双重授权：只接受两个 Greenhouse careers host 与单段 board token，拒绝额外 path/query identity、非法 token、parent-domain-only 授权和缺少精确 API host 授权；policy 拒绝时 PublicSourceClient/DNS/socket 调用次数为零，精确 API host 授权才允许执行。
- [ ] 写红测锁定 URL：列表只能是 `https://boards-api.greenhouse.io/v1/boards/{encodedToken}/jobs?content=true`；详情只能是 `https://boards-api.greenhouse.io/v1/boards/{encodedToken}/jobs/{encodedJobId}`，不得附加 questions、跟随正文或 `absolute_url`。
- [ ] 写红测锁定标准输出：列表产生 `sourceId=greenhouse:{boardToken}`、最多 5 个 `detailId=String(id)` 候选，以及不受 `maxResults` 截断的全量 `observedDetailIds`；`scans.complete` 只在唯一 ID 数量等于 `meta.total` 时为 true。详情的 company/title/location/postedAt/deadline/sourceType/isOfficial/rawPayload 必须来自 `job-detail.json`，特别证明 `first_published`/`application_deadline` 不来自列表 fixture。
- [ ] 写预算红测：每个 board 一次列表逻辑 tool/source request，每个选中岗位一次详情逻辑 tool/source request；HTTP transport 的第二次有界 attempt 不增加逻辑调用计数，但稳定 attempt 计数为 2，且仍受总超时/Agent Run retry 边界约束。
- [ ] 写稳定错误红测：unsupported URL、401/403、404、429、5xx、timeout、too-large、redirect、invalid JSON、schema mismatch 映射到固定 `GREENHOUSE_*` code/retryable，不泄漏正文或 URL。
- [ ] 最小实现 Adapter；职位过滤只使用列表的确定性字段，最多返回 public budget 的 5 条候选，但 `observedDetailIds` 保留完整 board ID 集合。`getDetail` 只接受本次候选 ID，并从真实详情 GET 响应得到 `first_published`/`application_deadline`；只缓存成功详情。
- [ ] 详情 timeout、429/5xx、schema mismatch 等失败沿既有 Processor 失败/重试边界退出本次发现事务；失败尝试不得提交 scans lifecycle reconciliation。
- [ ] resolver 按 immutable run metadata 解析遗留 Fake v1 或 Greenhouse v2；test 环境拒绝 Greenhouse 网络解析，production 拒绝 Fake，local 默认 Fake 且仅显式配置启用 Greenhouse。
- [ ] 运行 fixture contract、resolver、Fake 回归、worker module、typecheck、diff check；确认测试网络调用计数为零。
- [ ] 提交 `feat: add reviewed Greenhouse discovery adapter (#11)`；sol Spec/Quality 双审并复审。

### Task 5: 暴露认证计划 API 并在同一工作台流程配置/立即检查

**Files:** API schedule module/controller、OpenAPI、Web server client/BFF、home page、schedule panel、agent run panel、CSS/tests。

**HTTP interface:**

```text
GET /v1/job-targets/:targetId/discovery-schedule
PUT /v1/job-targets/:targetId/discovery-schedule
  { expectedVersion, state, dailyTime }
POST /v1/agent-runs
  { targetId, idempotencyKey }   # 继续作为同一面板的“立即检查”
```

- [ ] 写 API 红测：认证、严格 DTO、跨账户 404、inactive 目标、版本 409、首次 `expectedVersion=0`、重复 PUT、OpenAPI response schema 与脱敏 problem；supported-source 响应区分 executable、unsupported URL 和 `SOURCE_POLICY_REQUIRED`，后者返回“需允许 boards-api.greenhouse.io”的稳定展示信息。
- [ ] 实现 domain token/module/controller，成功 GET 返回 schedule 或 `{schedule:null,target...}`，PUT 返回当前计划；不接受 userId/timeZone/adapter/URL 等客户端授权字段。
- [ ] 写 Web server/BFF 红测：HttpOnly session 转 Bearer、路径 UUID 校验、响应 Zod parse、Next control-flow error rethrow、内部错误不泄漏。
- [ ] 先阅读 `apps/web/node_modules/next/dist/docs/` 中本任务涉及的 Route Handlers、Server/Client Components 文档，再实现路由。
- [ ] 在现有 `AgentRunPanel` 内组合 `DiscoverySchedulePanel`：选择活动目标后显示支持来源数量、固定“北京时间（Asia/Shanghai）”、time input、启停按钮和现有“立即检查”；非法/不支持 Greenhouse URL 显示“待接入”，缺少精确 API host 授权显示“待接入：需允许 boards-api.greenhouse.io”，两者均不可启用公共计划且不能伪装已检查。
- [ ] 组件红测覆盖保存中、CAS 409、网络失败、inactive、键盘顺序、44px 触控、状态不只依赖颜色；立即检查仍保留当前 retry-stable UUID 行为。
- [ ] 运行 API/Web focused tests、现有 agent run/watchlist/home 回归、lint、typecheck、diff check。
- [ ] 提交 `feat: configure daily checks from the workbench (#11)`；sol Spec/Quality 双审并复审。

### Task 6: 原子维护来源版本、关闭/过期与机会可用状态

**Files:** 创建 `packages/domain/src/job-discovery-persistence.ts` 与 `packages/domain/src/job-discovery-persistence.integration.test.ts`；修改 `packages/domain/src/agent-run-processor.ts`、`packages/domain/src/job-opportunity-persistence.ts` 及相关 schema tests、domain/worker integration tests。

**Interface:**

```ts
async function persistSuccessfulDiscovery(input: {
  run: ClaimedAgentRun;
  details: DiscoveryDetail[];
  scans: Array<{ sourceId: string; observedDetailIds: string[]; complete: boolean }>;
  storedObjects: StoredDiscoveryObject[];
  now: Date;
}): Promise<{ resultCount: number; cleanupObjectKeys: string[] }>;
```

- [ ] 写红测证明：重复 Worker delivery 不新增 posting/version/opportunity/result；相同最新内容复用；正文更新追加版本；完整空扫描关闭；不完整列表、任何详情失败或持久化事务失败均不关闭；deadline 过期；closed→open 追加新版本；历史对象/证据/run result 保留。
- [ ] 写多来源红测：一个机会有两条来源，关闭一条仍 open，全部关闭才 closed；任一来源 expired 且无 open 时机会 expired/closed 映射确定；official 最新 open 版本继续作为 current evidence。
- [ ] 修正机会身份：同一 source posting 的内容更新必须沿用既有 opportunity，不再仅用可变标题/地点/日期重新 dedup；跨来源仍沿用现有高置信度 dedup，不扩大自动合并范围。
- [ ] 只比较 latest source version；availability、normalized hash、raw hash 任一变化追加版本。完整 scan 缺失复用上一 raw object reference 并追加 closed lifecycle version，不伪造新岗位正文对象。
- [ ] 在同一账户锁/完成事务内持久 details、reconcile 完整 scans、重算 opportunity availability、仅为 open 未过期详情写 run results、完成步骤/run/event/audit。
- [ ] v2 `searchBatch` 在每个 board 列表 GET 前预占一个逻辑 tool/source request；每个选中候选的 `getDetail` 在详情 GET 前再预占一个逻辑 tool/source request。HTTP 内部 retry 只增加稳定 attempt 计数，不重复消耗逻辑预算；v1 预算与现有所有控制/暂停/取消/心跳/重试语义不变。
- [ ] 运行 domain/worker integration、迁移、#10 全部 control/budget/recovery、#28 Watchlist scope 回归、typecheck、diff check。
- [ ] 提交 `feat: preserve public posting lifecycle history (#11)`；sol Spec/Quality 双审并复审。

### Task 7: Worker 计划扫描与 Fake Playwright 纵切

**Files:** `agent-run-scheduler.ts`、worker module/integration、Playwright spec/config/runtime test。

- [ ] 写 scheduler 红测：module init 先扫描后定时；扫描不重入；销毁停止；scan/dispatch 超时返回稳定 reporter code；同一 occurrence 重复扫描只产生同一 run；inactive/unsupported occurrence 被跳过。
- [ ] 实现独立 `AgentRunScheduler`，复用现有 `AGENT_RUN_SCAN_INTERVAL_MS` 或清晰的新固定 1 秒测试/local 扫描周期；PostgreSQL queries 有 deadline，destroy 等待 in-flight 有界结束。
- [ ] Worker Testcontainers 红测串起 schedule→occurrence→Agent Run→Fake Adapter→MinIO/PostgreSQL；重复 schedule scan、queue wake、Worker delivery 后断言 run/posting/version/opportunity/result 唯一。
- [ ] 新增 Playwright：通过 Dev Auth/API 建活动求职目标与 Watchlist；在同一工作台选择每日时间并启用；测试夹具只把 `next_run_at` 快进到当前时点，不直接插 run；等待 Worker 物化 occurrence；通过 latest/SSE 显示完成与新增 Fake 岗位。
- [ ] Playwright 再触发同一 occurrence/重复 delivery，断言页面结果不重复，并检查移动端、键盘、axe、44px、无横向溢出。
- [ ] 固定 `APP_ENV=test`、Fake resolver 和 `PUBLIC_SOURCE_NETWORK_MODE=disabled`；测试若尝试真实 DNS/socket 必须立即失败。
- [ ] 运行 Desktop Chrome 与 Mobile Safari focused E2E、worker integration、现有 agent-runs/company-watchlist E2E 回归、typecheck、build、diff check。
- [ ] 提交 `test: verify scheduled Fake job discovery (#11)`；sol Spec/Quality 双审并复审。

### Task 8: 固定基线双轴审查、完整验收与关闭 Issue

**Fixed review point:** `dfab6bafb3b32ce4f9693f1937e9309c4a997af9`，不得用中间 commit 或 `HEAD^` 替代。

- [ ] 由独立 `gpt-5.6-sol / high` Standards reviewer 审查 `git diff dfab6bafb3b32ce4f9693f1937e9309c4a997af9...HEAD`，依据 root/Web AGENTS、PRODUCT、CONTEXT、相关 ADR、迁移规范、安全边界和代码质量。审查账本必须单列：列表/详情字段来源、逻辑调用与 HTTP attempt 计数、详情失败不提交关闭、双重 host 授权与零网络拒绝。
- [ ] 由另一独立 `gpt-5.6-sol / high` Spec reviewer 审查同一固定 diff，逐条核对 Issue #11 七项 AC、本计划 Global Constraints、上述四项修订账本与禁止范围。
- [ ] 将全部发现逐项验证；由 `gpt-5.6-terra / high` 修复所有有效发现，运行受影响测试；两位 reviewer 对修复后的固定 diff 复审至无有效发现。
- [ ] fresh verification 顺序执行：

```bash
git merge-base --is-ancestor dfab6bafb3b32ce4f9693f1937e9309c4a997af9 HEAD
pnpm lint
pnpm typecheck
PUBLIC_SOURCE_NETWORK_MODE=disabled DOCKER_API_VERSION=1.51 pnpm test
PUBLIC_SOURCE_NETWORK_MODE=disabled DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- scheduled-job-discovery.spec.ts agent-runs.spec.ts company-watchlist.spec.ts --project="Desktop Chrome" --project="Mobile Safari"
pnpm build
git diff --check
git status --short
```

- [ ] 验收中额外查询数据库，记录 duplicate schedule scan、Worker retry、内容更新、closed、expired、reopen 的 run/posting/version/opportunity/result 计数与历史保留证据；记录测试断网门禁与 fixture 文件名。
- [ ] 若 lint 有基线遗留问题，必须用固定基线对比证明不是本次新增；所有本次新增 lint 问题必须修复。
- [ ] 在 GitHub #11 发布验收评论：固定起点/最终 commit、7 项 AC 对应证据、命令及结果、双轴审查结论、无真实招聘站访问、未 push/PR/merge。
- [ ] 仅在 fresh verification 全绿且 GitHub 评论成功后执行 `gh issue close 11 --repo GoodScholar/ai-job-search-copilot`。
- [ ] 确认 Issue 已关闭、工作树状态清楚，然后停止并提示推荐的下一个 ready Issue；不得在本任务开始它。

## 计划自审结论

- 7 项 Acceptance criteria 均映射到实现切片和 fresh verification 证据。
- 计划保留 Fake v1 与迁移 0018–0020，不要求回填或重写历史运行。
- 关闭推断只来自完整 Greenhouse board 扫描，不受 `maxResults=5` 截断影响。
- 列表只形成全量扫描事实；`first_published`、`application_deadline` 与最终详情只来自最多 5 个候选的详情 GET，详情失败不得提交关闭事务。
- Greenhouse 网络访问同时要求用户快照精确授权和 Adapter immutable exact-host capability；仅 parent domain 或内置映射均在 DNS/socket 前拒绝。
- 外部网络、调度、运行、来源 lifecycle 四类副作用各自具有数据库/固定 fixture/Worker 证据；默认测试无真实网络。
- 不包含 AnySearch、其他 ATS、登录平台、推荐排序、模型调用、外部投递或后续 Issue。
