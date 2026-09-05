# Issue #51 统一运行前检查与快照 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在求职工作台和每一条 AgentRun 创建路径上统一评估当前画像证据、主求职目标、真实来源能力与健康、模型诊断及账户运行策略；阻塞时不创建运行，手动警告需用户确认，成功运行不可变保存实际启动时的检查快照。

**Architecture:** 新增 `@job-copilot/domain/run-preflight` 深模块：公开面只有一个 owner-bound 当前态查询，内部 evaluator 接受数据库/事务 seam，因此页面查询与启动事务复用同一套规则。所有运行创建者先取得账户 advisory lock、完成幂等重放判断，再在同一事务中重检并授权启动；`agent_runs.preflight_snapshot` 与账户策略修订/快照原子写入。API/BFF 传递严格的 409 检查报告，工作台按稳定动作枚举映射到现有修复页面；历史行用 `null` 明确表示当时尚未记录，而不反推历史状态。

**Tech Stack:** TypeScript、Zod、Drizzle/PostgreSQL、NestJS/Fastify、Next.js/React、Vitest、Testcontainers、Playwright。

**Spec:** GitHub Issue `GoodScholar/ai-job-search-copilot#51`；根级 `PRODUCT.md`、`CONTEXT.md`；`docs/adr/0006-use-durable-agent-runs.md`、`0018-budget-every-agent-run.md`、`0019-use-openai-responses-for-local-beta.md`、`0030-record-redacted-agent-run-audits.md`、`0031-use-agent-mission-control-as-home.md`、`0033-use-layered-verified-public-job-discovery.md`。

## Global Constraints

- #51 的直接 blockers #48、#49、#50 已关闭；Issue 为 OPEN、带 `ready-for-agent` 且已分配给 `GoodScholar`。实现不扩展 #52 首次推荐旅程、#53 一键推荐编排或 #54 计划运行与账户全局停止。
- “运行前检查”是当前权威领域状态的只读投影；查询不得自动触发模型诊断、来源抓取、来源健康检查或 AgentRun。账户策略 revision 0 仍按 #49 的现有规则惰性持久化。
- 深模块公开契约只返回 `blocking | warning | informational`，并聚合为 `blocked | ready_with_warnings | ready`。每项必须有稳定代码、中文摘要、结构化安全依据、影响、`retryable` 和有限建议动作。
- 安全依据只允许 ID、版本、计数、稳定状态/原因代码和时间；禁止返回画像事实内容、岗位/职业文本、来源 URL、allowed domain、配置指纹、密钥、供应商原始响应、模型输出或任意异常正文。
- 有效画像证据的最小判定是“至少一个当前有效的受信任画像事实”；不得发明技能数量、工作年限或完整度阈值。
- 账户必须有一个活动主求职目标；若请求了活动次目标且主目标存在，仍允许为次目标运行。工作台默认选择主目标，但不静默禁用次目标。
- 真实来源只计算已启用且服务端版本化声明满足所需能力的 Greenhouse 来源；AnySearch 是发现供应方，不得充当真实岗位来源。发现需 `active_discovery + read_details`，计划触发再需 `continuous_monitoring`；部分来源缺能力是警告，零个满足能力的真实来源才阻塞。
- 来源健康与来源能力分离：未检查是警告；`healthy`/`zero_valid_results` 是信息；`parser_degraded`/`rate_limited`/`hard_failed` 是警告而非阻塞，避免“必须先运行才能形成健康、却因无健康不能运行”的死锁。深度匹配不重新访问来源，能力与健康返回 `*_NOT_REQUIRED` 信息项。
- 模型诊断只读取当前部署配置指纹的稳定安全投影；`available` 为信息，`unverified | checking | failed | temporarily_unavailable` 均阻塞。已有 `available` 结果在配置指纹不变时保持可用，10 分钟只控制重新探测缓存，不被误作运行授权 TTL。
- 账户策略使用当前 effective 值：发现按实际 execution mode 读取 `fake` 或 `publicDiscovery` 预算，深度匹配读取 `deepMatch`；任一实际必需预算维度为 0 时阻塞。计划触发还校验实际启动时刻与 occurrence 的 `scheduledFor` 都位于 Asia/Shanghai 后台窗口；手动触发不受后台窗口限制。
- `warningFingerprint` 是 64 位小写 SHA-256，只覆盖契约版本、workflow、trigger、实际 targetId 以及按稳定顺序规范化后的警告代码/安全依据/影响/动作；排除 `checkedAt` 和中文展示文案。无警告时为 `null`，相同警告跨刷新稳定，警告集合或依据变化时必须变化。
- 手动启动若当前有警告，只有命令携带与事务内最新报告完全相同的 `warningFingerprint` 才能继续；缺少或过期确认返回带最新报告的 409。计划与自动子运行不等待交互确认，警告直接进入快照后继续；阻塞时均不创建 AgentRun。
- 所有创建者必须保持“账户锁 → 按 owner + idempotency key 查既有运行 → 当前态重检 → 插入”的顺序。已有运行的幂等重放必须先返回原运行，即使当前状态后来阻塞或命令未带警告确认。
- `agent_runs.preflight_snapshot` 对历史数据可空；所有经过新应用代码创建的运行必须非空且通过 `RunPreflightSnapshotSchema`。不得根据今天的状态伪造旧运行快照；UI 明示“该历史运行创建时尚未记录运行前检查快照”。
- 自动深度匹配在发现完成事务内被阻塞时只跳过子运行，不回滚已完成的发现结果；计划 occurrence 被阻塞时标记 `RUN_PREFLIGHT_BLOCKED` 且 `runId = null`。两者都不得写入虚假的 failed AgentRun。
- 检查快照解释历史启动条件，不构成持续授权。`effectiveAgentRunBudget`、运行 checkpoint 和分层来源收窄仍按“快照值与当前系统硬上限逐维取更严者”执行，并增加回归测试，不能被本 Issue 重写或放宽。
- 建议动作使用固定枚举；Web 唯一负责映射现有路由，不允许领域层保存或返回任意 href。至少映射画像、求职目标、Watchlist 来源能力/健康、模型连接和账户运行策略页面。
- 迁移仅新增 nullable JSONB 与对象 CHECK，并扩展计划 occurrence 的稳定 skip reason；不回填历史快照，不新增状态表，不把可派生检查结果拆成多张表。
- 测试命令只由唯一 `gpt-5.6-terra / high` Executor 串行执行。root 与 `gpt-5.6-sol / high` reviewer 只读，不得和 Executor 并发运行相同或重叠测试；若发生重叠，全部结果作废，先确认无遗留进程，再由 Executor 从零串行重跑并保留完整日志。
- 每个 Task 在定点测试与类型检查通过后独立提交，再交给新的 `gpt-5.6-sol / high` 只读审查；审查结论未关闭前不得进入下一 Task。最终再做独立 Standards/Spec 双轴审查和完整串行验收。
- 本设计没有引入新的跨模块基础设施选择，仍在 ADR 0006/0018/0019/0030/0031/0033 已决定的边界内，因此不新增 ADR；只在 `CONTEXT.md` 补充领域术语。

---

### Task 1: 锁定运行前检查、启动确认与历史快照契约

**Files:**
- Create: `packages/contracts/src/run-preflight.ts`
- Create: `packages/contracts/src/run-preflight.test.ts`
- Modify: `packages/contracts/src/agent-runs.ts`
- Modify: `packages/contracts/src/agent-runs.test.ts`
- Modify: `packages/contracts/src/recommendations.ts`
- Modify: `packages/contracts/src/recommendation-feedback.test.ts`
- Modify: `packages/contracts/src/job-discovery-schedules.ts`
- Modify: `packages/contracts/src/job-discovery-schedules.test.ts`
- Modify: `packages/contracts/package.json`

**Interfaces:**

```ts
export const RunPreflightWorkflowSchema = z.enum(["discovery", "deep_match"]);
export const RunPreflightTriggerSchema = z.enum(["manual", "schedule", "automatic"]);
export const RunPreflightSeveritySchema = z.enum(["blocking", "warning", "informational"]);
export const RunPreflightStatusSchema = z.enum(["blocked", "ready_with_warnings", "ready"]);
export const RunPreflightSuggestedActionSchema = z.enum([
  "review_profile",
  "review_job_targets",
  "review_source_capabilities",
  "review_source_health",
  "run_model_diagnostic",
  "review_account_run_policy",
]);
```

- `RunPreflightCheckCodeSchema` 固定包含：`PROFILE_EVIDENCE_MISSING | PROFILE_EVIDENCE_READY`、`PRIMARY_JOB_TARGET_MISSING | PRIMARY_JOB_TARGET_READY`、`REQUESTED_JOB_TARGET_MISSING | REQUESTED_JOB_TARGET_INACTIVE | REQUESTED_JOB_TARGET_READY`、`SOURCE_CAPABILITY_UNAVAILABLE | SOURCE_CAPABILITY_PARTIAL | SOURCE_CAPABILITY_READY | SOURCE_CAPABILITY_NOT_REQUIRED`、`SOURCE_HEALTH_UNCHECKED | SOURCE_HEALTH_DEGRADED | SOURCE_HEALTH_READY | SOURCE_HEALTH_NOT_REQUIRED`、`MODEL_DIAGNOSTIC_UNAVAILABLE | MODEL_DIAGNOSTIC_READY`、`ACCOUNT_RUN_POLICY_BLOCKED | ACCOUNT_RUN_POLICY_READY`。
- `RunPreflightEvidenceSchema` 是按 `kind` 判别的严格 union：`profile`、`job_target`、`source_capability`、`source_health`、`model_diagnostic`、`account_run_policy`。它只承载 Global Constraints 允许的 ID/版本/计数/状态/时间，所有对象 `.strict()`。
- `RunPreflightItemSchema = { code, severity, summary, evidence, impact, retryable, suggestedActions }`；`summary/impact` 为有长度上限的中文安全文案，动作最多 2 个且去重。
- `RunPreflightReportSchema = { version:"run-preflight-v1", workflow, trigger, targetId:uuid|null, status, items, warningFingerprint:hex64|null, checkedAt }`；superRefine 保证聚合状态与 item 严重级一致，且 `warningFingerprint` 当且仅当存在 warning。
- `RunPreflightSnapshotSchema` 直接复用同一严格结构；`RunPreflightProblemSchema = { code:"RUN_PREFLIGHT_BLOCKED" | "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED", message, preflight }`。
- `StartAgentRunCommandSchema` 增加 `warningFingerprint: hex64.nullable().default(null)`；`StartRecommendationReevaluationCommandSchema = { targetId, opportunityId, idempotencyKey, warningFingerprint }`。序列化后的命令始终显式含该字段。
- 所有 `AgentRunSummarySchema`、`AgentRunDetailSchema`、`StartAgentRunResponseSchema` 共用字段增加 `preflightSnapshot: RunPreflightSnapshotSchema.nullable()`；legacy 行合法，新创建非空由领域测试保证。
- `JobDiscoveryScheduleOccurrenceSchema.skipReason` 增加 `RUN_PREFLIGHT_BLOCKED`，保留全部旧 reason 以兼容已有记录。

- [ ] **Step 1: 写严格契约失败测试**

  在 `run-preflight.test.ts` 覆盖三种严重级、三种聚合状态、七类证据、固定代码/动作、中文文案长度、64 位小写 fingerprint、重复动作和未知键拒绝；加入下列核心不变量用例：

  ```ts
  expect(() => RunPreflightReportSchema.parse({
    ...readyReport,
    status: "ready",
    items: [warningItem],
    warningFingerprint: null,
  })).toThrow();

  expect(JSON.stringify(RunPreflightReportSchema.parse(safeReport))).not.toMatch(
    /factValue|careerText|jobText|careersUrl|allowedDomain|configurationFingerprint|apiKey|providerResponse|modelOutput/u,
  );
  ```

- [ ] **Step 2: 写 AgentRun、重评命令与 schedule 兼容失败测试**

  验证新启动命令省略确认时解析为 `warningFingerprint:null`、非法 hash 被拒绝；新运行响应必须能带快照，legacy 响应能带 `null`；深度匹配重评使用同一确认字段；schedule 新旧 skip reason 均可解析且 outcome 配对约束不变。

- [ ] **Step 3: 运行 contracts 定点测试，确认失败**

  Run: `pnpm --filter @job-copilot/contracts test -- src/run-preflight.test.ts src/agent-runs.test.ts src/recommendation-feedback.test.ts src/job-discovery-schedules.test.ts`

  Expected: FAIL，因为 `run-preflight` 导出、新命令字段、快照字段和新 skip reason 尚不存在。

- [ ] **Step 4: 实现最小严格契约**

  只增加上述 schema/type/export；证据使用固定字段而非 `z.record`，不加入通用规则 DSL、任意 metadata、URL 动作或未来 workflow。

- [ ] **Step 5: 串行验证 Task 1**

  Run: `pnpm --filter @job-copilot/contracts test -- src/run-preflight.test.ts src/agent-runs.test.ts src/recommendation-feedback.test.ts src/job-discovery-schedules.test.ts && pnpm --filter @job-copilot/contracts typecheck`

  Expected: PASS；legacy AgentRun/occurrence fixture 仍可解析，新 fixture 的快照与确认字段经过严格契约。

- [ ] **Step 6: 提交并交给 Sol 只读审查**

  Commit: `feat: define run preflight contracts`

  Review gate: 新的 `gpt-5.6-sol / high` reviewer 只读核对 Issue #51 字段覆盖、严格 union、安全依据白名单、状态/fingerprint 不变量、legacy 兼容与没有 #52/#53/#54 扩张；Terra 修复审查问题后串行重跑 Step 5 并追加修复提交。

### Task 2: 实现统一 run-preflight 深模块与稳定模型诊断投影

**Files:**
- Create: `packages/domain/src/run-preflight.ts`
- Create: `packages/domain/src/run-preflight.integration.test.ts`
- Create: `packages/domain/src/testing/run-preflight.ts`
- Modify: `packages/domain/src/model-diagnostics.ts`
- Modify: `packages/domain/src/model-diagnostics.integration.test.ts`
- Modify: `packages/domain/package.json`

**Interfaces:**

```ts
export type RunPreflightInput = {
  userId: string;
  targetId?: string;
  workflow: "discovery" | "deep_match";
  trigger: "manual" | "schedule" | "automatic";
  scheduledFor?: Date;
};

export type RunPreflightEvaluation = {
  report: RunPreflightReport;
  policy: { revisionNumber: number; snapshot: AccountRunPolicySettings };
};

export type RunPreflightDatabase = Pick<Database, "select" | "insert" | "execute">;

export type RunPreflightEvaluator = {
  evaluate(db: RunPreflightDatabase, input: RunPreflightInput): Promise<RunPreflightEvaluation>;
};

export function createRunPreflightEvaluator(deps: {
  capabilityAdapter: SourceCapabilityAdapter;
  modelDiagnosticReader: ModelDiagnosticProjectionReader;
  discoveryExecutionMode: JobDiscoveryExecutionMode;
  id: () => string;
  clock: () => Date;
}): RunPreflightEvaluator;

export function createRunPreflightQueries(deps: {
  db: Database;
  evaluator: RunPreflightEvaluator;
}): { get(input: RunPreflightInput): Promise<RunPreflightReport> };

export function authorizeRunPreflight(input: {
  evaluation: RunPreflightEvaluation;
  warningFingerprint: string | null;
}): void;
```

- `RunPreflightDatabase` 只暴露 evaluator 所需 `select/insert/execute` 结构，允许绑定现有 transaction；公开 `createRunPreflightQueries().get()` 自己开启短事务再调用 evaluator。`authorizeRunPreflight` 根据报告抛 `RunPreflightRejectedError(code, report)`，仅 `manual` 警告要求 fingerprint，`schedule/automatic` 警告直接通过。
- `ModelDiagnosticProjectionReader = { get(db:Pick<Database,"select"|"execute">, now:Date):Promise<ModelDiagnosticPublicResponse> }`；`createModelDiagnosticProjectionReader({ configurationFingerprint })` 复用 #50 当前稳定投影规则，并以现有 fingerprint advisory lock 的非阻塞探测识别跨实例 `checking`，永不调用 Adapter、不返回配置指纹。`createModelDiagnostics()` 也复用该 reader，避免两套“当前状态”解释。
- `packages/domain/src/testing/run-preflight.ts` 提供显式 `createReadyRunPreflightEvaluator()`，只给与本 Issue 无关的旧领域 fixture 注入；生产 API/Worker 不得 import 此 helper。

- [ ] **Step 1: 写模型投影与 evaluator 的失败测试**

  用真实 PostgreSQL fixture 覆盖：当前配置无记录为 `unverified`；失败/暂不可用/检查中映射阻塞；配置指纹不同不误用旧结果；同指纹旧 `available` 仍返回 available 且不触发 Adapter。断言 `createModelDiagnostics().get()` 与 projection reader 对同一行给出相同安全状态。

- [ ] **Step 2: 写领域规则矩阵失败测试**

  为两个账户建立隔离 fixture，逐项覆盖：

  - 无当前有效 ProfileFact 阻塞；存在任意一个 active fact 即通过，removed 的最新修订不计数。
  - 无活动主目标阻塞；有活动主目标时，活动次目标可作为 requested target；缺失/停用 requested target 分别稳定阻塞。
  - enabled Greenhouse 声明完整能力通过；disabled 不计数；零个真实来源阻塞；AnySearch 单独存在仍阻塞；部分声明缺能力警告；schedule 比 manual 多要求 `continuous_monitoring`。
  - 健康未检查警告；healthy/zero-valid 信息；parser-degraded/rate-limited/hard-failed 警告但不阻塞；只取 owner/target/watchlist item/source 的最新检查。
  - discovery/deep_match 均检查画像、主目标、模型和策略；deep_match 的来源能力/健康是 informational not-required。
  - relevant budget 为零阻塞；schedule 当前时刻或 `scheduledFor` 越出后台窗口均阻塞；manual 同一时刻不受窗口限制。
  - 未传 targetId 时使用活动主目标并返回实际 `targetId`；没有主目标时 `targetId:null`。

- [ ] **Step 3: 写 fingerprint、安全投影和授权失败测试**

  同一安全警告在不同 `checkedAt` 得到相同 hash；改变健康计数、代码、target、workflow 或 trigger 必须改变 hash。结果 item 顺序固定为画像、主目标、requested target、来源能力、来源健康、模型、策略；相同数据库状态跨查询 JSON 稳定。扫描序列化结果，确认测试哨兵职业文本、URL、密钥、配置指纹和原始错误均不存在。

  授权矩阵必须精确覆盖：

  ```ts
  expect(() => authorizeRunPreflight({ evaluation: blocked, warningFingerprint: null }))
    .toThrowError("RUN_PREFLIGHT_BLOCKED");
  expect(() => authorizeRunPreflight({ evaluation: manualWarnings, warningFingerprint: null }))
    .toThrowError("RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED");
  expect(() => authorizeRunPreflight({ evaluation: manualWarnings, warningFingerprint: staleHash }))
    .toThrowError("RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED");
  expect(() => authorizeRunPreflight({ evaluation: manualWarnings, warningFingerprint: currentHash }))
    .not.toThrow();
  expect(() => authorizeRunPreflight({ evaluation: scheduledWarnings, warningFingerprint: null }))
    .not.toThrow();
  ```

- [ ] **Step 4: 运行 domain 定点测试，确认失败**

  Run: `pnpm --filter @job-copilot/domain test -- src/run-preflight.integration.test.ts src/model-diagnostics.integration.test.ts`

  Expected: FAIL，因为 evaluator、reader、授权错误和查询尚不存在。

- [ ] **Step 5: 实现最小 evaluator、fingerprint 与 reader**

  evaluator 在传入 db seam 上一次性读取当前 profile facts、primary/requested target、当前 Watchlist/服务端能力声明、最新 source health、稳定 model diagnostic 和 effective policy。用 canonical JSON（对象键排序、数组按稳定字段排序）计算警告 SHA-256；中文文案由稳定代码的 exhaustiveness switch 生成。禁止把原始表行或自由文本放进 evidence。

- [ ] **Step 6: 串行验证 Task 2**

  Run: `pnpm --filter @job-copilot/domain test -- src/run-preflight.integration.test.ts src/model-diagnostics.integration.test.ts && pnpm --filter @job-copilot/domain typecheck`

  Expected: PASS；跨账户查询看不到另一账户事实/目标/来源/健康，模型 reader 调用计数保持 0 个外部请求。

- [ ] **Step 7: 提交并交给 Sol 只读审查**

  Commit: `feat: evaluate unified run preflight`

  Review gate: 新的 Sol reviewer 只读检查单一规则源、事务 seam、真实来源与 AnySearch 边界、健康非阻塞理由、模型稳定投影、策略窗口/预算、fingerprint 确定性和敏感字段负面证明；修复后由 Terra 串行重跑 Step 6。

### Task 3: 持久化快照并接入手动岗位发现启动事务

**Files:**
- Create: `packages/database/migrations/0047_agent_run_preflight_snapshot.sql`
- Modify: `packages/database/migrations/meta/_journal.json`
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/migrate.integration.test.ts`
- Modify: `packages/domain/src/agent-run-control.ts`
- Modify: `packages/domain/src/agent-run-control.integration.test.ts`
- Modify: `packages/domain/src/agent-run-queries.ts`
- Modify: `packages/domain/src/agent-runs.test.ts`
- Modify: `packages/domain/src/agent-runs.integration.test.ts`
- Modify: `packages/domain/src/agent-inbox.integration.test.ts`
- Modify: `packages/domain/src/company-watchlists.integration.test.ts`
- Modify: `packages/domain/src/job-discovery-persistence.integration.test.ts`
- Modify: `packages/domain/src/recommendation-feedback.integration.test.ts`

**Interfaces:**

- Migration 添加 `agent_runs.preflight_snapshot jsonb null` 和 `agent_runs_preflight_snapshot_object` CHECK：值为 null 或 `jsonb_typeof(...) = 'object'`；不回填旧行。同步把 occurrence skip CHECK 加入 `RUN_PREFLIGHT_BLOCKED`。
- `CommandDependencies` 增加必需的 `runPreflight: RunPreflightEvaluator`；`AgentRunStarter.command` 使用完整 `StartAgentRunCommand`，不再手写两字段类型。
- `summary()`、`detail()` 从数据库读取 `preflightSnapshot`，用 `RunPreflightSnapshotSchema` 解析非空值后投影；禁止将当前检查替代 null 历史值。

- [ ] **Step 1: 写迁移失败测试**

  断言迁移后列 nullable、null legacy 行仍合法、对象合法、数组/字符串/数字被 CHECK 拒绝；`RUN_PREFLIGHT_BLOCKED` occurrence 合法且 `run_id` 必须为空。迁移 journal 的 idx/tag 精确为 `47/0047_agent_run_preflight_snapshot`。

- [ ] **Step 2: 运行 database 定点测试，确认失败**

  Run: `pnpm --filter @job-copilot/database test -- src/migrate.integration.test.ts`

  Expected: FAIL，因为 0047、schema 列和 CHECK 尚不存在。

- [ ] **Step 3: 实现最小迁移与 Drizzle schema**

  SQL 只新增上述列/约束；schema 把 `preflightSnapshot` 放在账户策略快照旁。不要生成或伪造旧 snapshot JSON，不改写已有迁移。

- [ ] **Step 4: 写启动事务失败测试**

  在 `agent-run-control.integration.test.ts` 用真实 evaluator/数据库构造 ready、warning、blocked 三态，覆盖：

  - blocked 返回 `RunPreflightRejectedError(RUN_PREFLIGHT_BLOCKED)`，`agent_runs/steps/events` 均为 0。
  - warning 无/旧 fingerprint 返回 `RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED` 和事务内最新报告，无 AgentRun；当前 fingerprint 创建成功。
  - 页面先读 ready，提交前删除画像事实或停用 target/source、改变模型诊断/策略，启动事务重新检查后拒绝，证明不信任页面缓存。
  - 账户锁等待期间警告变化，锁获得后按新 fingerprint 拒绝；快照 `checkedAt`、target、items、fingerprint 与该次重检一致。
  - 成功行同时保存 evaluator 返回的 `policy.revisionNumber`、`policy.snapshot` 和 `preflightSnapshot`；失败回滚 policy 之外的 AgentRun 写入。
  - 同一 idempotency key 首次成功后再把账户改成 blocked，并以无 fingerprint 重放，仍先返回同一 runId/reused，数据库只有一条运行和一份原快照。
  - 另一账户不能用相同 targetId、warning fingerprint 或 idempotency key 读取/复用当前账户运行。

- [ ] **Step 5: 运行 domain 启动定点测试，确认失败**

  Run: `pnpm --filter @job-copilot/domain test -- src/agent-run-control.integration.test.ts src/agent-runs.test.ts src/agent-runs.integration.test.ts`

  Expected: FAIL，因为启动器尚未在事务中调用 evaluator，查询也未投影快照。

- [ ] **Step 6: 实现事务重检、原子写入与查询投影**

  在现有账户 advisory lock 后保留 idempotency lookup 第一优先；仅新意图调用 `runPreflight.evaluate(transaction, { workflow:"discovery", trigger, targetId, scheduledFor })` 和 `authorizeRunPreflight`。后续 target/source/execution snapshot 仍在同一事务内生成，并直接复用 evaluation 的 policy，删除重复的 policy 读取；insert 显式写 `preflightSnapshot:evaluation.report`。

- [ ] **Step 7: 给无关旧 fixture 注入显式 ready evaluator**

  只在不验证 #51 的旧 domain 测试装配处注入 `createReadyRunPreflightEvaluator()`；不得给 Task 3 的启动规则测试使用 fake gate。更新所有被必需依赖影响的精确测试文件，避免把生产依赖改成 optional 或默认放行。

- [ ] **Step 8: 增加硬上限持续生效回归**

  在 `agent-runs.integration.test.ts` 构造一个带有高于当前系统硬上限的历史 preflight/policy 快照，断言 checkpoint 的 effective budget 与来源范围仍取当前硬上限；检查快照原文保持不变，且不能恢复旧快照中的较宽额度。

- [ ] **Step 9: 串行验证 Task 3**

  Run: `pnpm --filter @job-copilot/database test -- src/migrate.integration.test.ts && pnpm --filter @job-copilot/domain test -- src/agent-run-control.integration.test.ts src/agent-runs.test.ts src/agent-runs.integration.test.ts src/agent-inbox.integration.test.ts src/company-watchlists.integration.test.ts src/job-discovery-persistence.integration.test.ts src/recommendation-feedback.integration.test.ts && pnpm --filter @job-copilot/database typecheck && pnpm --filter @job-copilot/domain typecheck`

  Expected: PASS；每个新手动发现运行快照非空，legacy 详情为 null，blocked/warning 未确认路径没有运行副作用。

- [ ] **Step 10: 提交并交给 Sol 只读审查**

  Commit: `feat: bind preflight snapshot to discovery runs`

  Review gate: 新的 Sol reviewer 只读检查迁移兼容、幂等顺序、锁内重检、快照/策略同事务一致性、历史 null 语义和当前硬上限不被快照绕过；修复后由 Terra 串行重跑 Step 9。

### Task 4: 覆盖计划派发、手动/自动深度匹配和 Worker 创建路径

**Files:**
- Modify: `packages/domain/src/job-discovery-schedules.ts`
- Modify: `packages/domain/src/job-discovery-schedules.integration.test.ts`
- Modify: `packages/domain/src/deep-match-agent-runs.ts`
- Modify: `packages/domain/src/deep-match-trigger.test.ts`
- Modify: `packages/domain/src/deep-match-persistence.integration.test.ts`
- Modify: `packages/domain/src/agent-run-processor.ts`
- Modify: `packages/domain/src/agent-run-processor.integration.test.ts`
- Modify: `apps/worker/src/agent-runs/agent-run.module.ts`
- Modify: `apps/worker/src/agent-runs/agent-run.module.test.ts`
- Modify: `apps/worker/src/agent-runs/agent-run.integration.test.ts`
- Modify: `apps/worker/src/agent-runs/agent-run-scheduler.test.ts`
- Modify: `apps/worker/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- `ensureDeepMatchRunInTransaction` 增加 `runPreflight` 与 `warningFingerprint?:string|null`，返回判别 union：`{ kind:"created"; run; reused } | { kind:"blocked"; preflight }`。只有 automatic 可把 blocker 转成 `blocked` 返回；manual 使用 `RunPreflightRejectedError` 交给 API。
- `createDeepMatchRunStarter.start()` 的 manual input 使用 `StartRecommendationReevaluationCommand`；automatic caller 不传确认。所有成功 deep-match insert 显式写 `preflightSnapshot` 与同一次 evaluation 的 policy。
- `AgentRunProcessorDependencies` 增加必需 `runPreflight`，使事务内 `afterCompleted` 和事务外恢复触发都复用同一个 evaluator。
- Worker 用与 API 相同的运行配置构造 ModelDiagnostic adapter/reader 和 `createRunPreflightEvaluator`。test 环境 Fake fingerprint seed 改为稳定部署值 `job-copilot-test-deployment-v1`，API/Worker 才能读取同一诊断行；生产仍由真实配置生成指纹。

- [ ] **Step 1: 写计划派发失败测试**

  把 `dispatchReason` 收窄为启用 schedule 时提供即时反馈的 `validateScheduleConfiguration`，不再用于派发授权；派发一律以 `runs.start()` 的统一事务重检为权威。覆盖 ready 派发、warning 自动继续并存快照、blocked occurrence 标记 `RUN_PREFLIGHT_BLOCKED` 且无 run、页面读取后状态变化在派发时阻塞、既有 idempotent run 仍回填 dispatched，以及跨账户隔离。

- [ ] **Step 2: 写深度匹配全部入口失败测试**

  覆盖 recommendation 手动重评 ready/warning/blocked/过期 fingerprint；发现完成后的自动 child warning 继续并存快照；自动 child blocked 返回 `kind:"blocked"` 且父发现结果/完成事件仍提交；事务内 afterCompleted、事务外补偿触发和恢复重放均只创建一个 child。验证 automatic 不需要交互 fingerprint，manual 必须确认当前 warning。

- [ ] **Step 3: 写 Worker 装配失败测试**

  断言 scheduler commands 与 processor automatic child 都注入同一类 evaluator；API/Worker 在 test 配置下的 model diagnostic reader 使用相同稳定 fingerprint；生产缺 API key 时读取当前未验证状态而非构造“ready” fake。现有 Worker 测试仍不得发真实 OpenAI 请求。

- [ ] **Step 4: 运行 domain/worker 定点测试，确认失败**

  Run: `pnpm --filter @job-copilot/domain test -- src/job-discovery-schedules.integration.test.ts src/deep-match-trigger.test.ts src/deep-match-persistence.integration.test.ts src/agent-run-processor.integration.test.ts && pnpm --filter worker test -- src/agent-runs/agent-run.module.test.ts src/agent-runs/agent-run.integration.test.ts src/agent-runs/agent-run-scheduler.test.ts`

  Expected: FAIL，因为 schedule/deep-match/processor/Worker 尚未接入统一 evaluator，automatic blocked 尚会抛错或回滚父运行。

- [ ] **Step 5: 实现计划、深度匹配与 Worker 最小接线**

  所有 insert 前调用同一 `authorizeRunPreflight`；automatic blocker 在明确边界转成无 child 的成功父事务结果，禁止吞掉其他错误。Worker 新增 `@job-copilot/model-access` 仅用于构造与 API 同配置指纹的 reader，不运行诊断；不要复制 evaluator 规则到 Worker 或 scheduler。

- [ ] **Step 6: 串行验证 Task 4**

  Run: `pnpm --filter @job-copilot/domain test -- src/job-discovery-schedules.integration.test.ts src/deep-match-trigger.test.ts src/deep-match-persistence.integration.test.ts src/agent-run-processor.integration.test.ts && pnpm --filter worker test -- src/agent-runs/agent-run.module.test.ts src/agent-runs/agent-run.integration.test.ts src/agent-runs/agent-run-scheduler.test.ts && pnpm --filter @job-copilot/domain typecheck && pnpm --filter worker typecheck`

  Expected: PASS；代码库中 `rg -n '\.insert\(agentRuns\)' packages apps` 只剩两处领域 insert，且两处前方都执行统一 evaluator/authorization；所有 API、schedule、processor 入口最终都收敛到这两处。

- [ ] **Step 7: 提交并交给 Sol 只读审查**

  Commit: `feat: gate every agent run creation path`

  Review gate: 新的 Sol reviewer 只读核对手动/计划/automatic 完整调用图、计划警告语义、automatic blocker 不回滚父发现、恢复/幂等唯一性、API/Worker 指纹一致且无外部诊断调用；修复后由 Terra 串行重跑 Step 6。

### Task 5: 暴露认证查询并端到端保留结构化 409 报告

**Files:**
- Create: `apps/api/src/run-preflight/run-preflight.tokens.ts`
- Create: `apps/api/src/run-preflight/run-preflight.module.ts`
- Create: `apps/api/src/run-preflight/run-preflight.controller.ts`
- Create: `apps/api/src/run-preflight/run-preflight.controller.test.ts`
- Modify: `apps/api/src/model-diagnostics/model-diagnostics.tokens.ts`
- Modify: `apps/api/src/model-diagnostics/model-diagnostics.module.ts`
- Modify: `apps/api/src/model-diagnostics/model-diagnostics.controller.test.ts`
- Modify: `apps/api/src/agent-runs/agent-runs.module.ts`
- Modify: `apps/api/src/agent-runs/agent-runs.controller.ts`
- Modify: `apps/api/src/agent-runs/agent-runs.module.test.ts`
- Modify: `apps/api/src/recommendations/recommendations.module.ts`
- Modify: `apps/api/src/recommendations/recommendations.controller.ts`
- Create: `apps/api/src/recommendations/recommendations.controller.test.ts`
- Modify: `apps/api/src/common/api-problem.filter.ts`
- Modify: `apps/api/src/common/api-problem.filter.test.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/api.integration.test.ts`
- Modify: `apps/web/lib/server/api-client.ts`
- Modify: `apps/web/lib/server/api-client.test.ts`
- Create: `apps/web/lib/server/run-preflight.ts`
- Create: `apps/web/lib/server/run-preflight.test.ts`
- Create: `apps/web/app/api/run-preflight/route.ts`
- Create: `apps/web/app/api/run-preflight/route.test.ts`
- Modify: `apps/web/app/api/agent-runs/route.ts`
- Modify: `apps/web/app/api/agent-runs/route.test.ts`
- Modify: `apps/web/app/(workbench)/recommendations/actions.ts`
- Modify: `apps/web/app/(workbench)/recommendations/actions.test.ts`

**Interfaces:**

- `GET /v1/run-preflight?workflow=discovery&trigger=manual&targetId=<optional uuid>` 受 `SessionGuard` 保护并返回 `RunPreflightReportSchema`；query schema 禁止 `scheduledFor` 由浏览器伪造，设置 `Cache-Control:no-store`。
- `RunPreflightModule` 提供并导出 `RUN_PREFLIGHT_EVALUATOR` 与 `RUN_PREFLIGHT_QUERIES`。它注入 ModelDiagnosticsModule 导出的 `MODEL_DIAGNOSTIC_PROJECTION_READER`，并用 `GreenhouseSourceCapabilityAdapter` 与 API 当前 execution mode 组装一次 evaluator。
- AgentRuns/Recommendations controller 捕获 `RunPreflightRejectedError`，统一映射为 HTTP 409：`code/message/preflight/requestId`。`ApiException.details` 增加严格 `preflight?:RunPreflightReport`，filter 不序列化 Error、stack 或其他字段。
- `ApiClientError.problem` union 增加 `RunPreflightProblem`；专用 `readRunPreflightProblem` 仅删除 API envelope 的 `requestId` 后严格解析。普通 `ApiProblemSchema` 不为此放宽。
- BFF `GET /api/run-preflight` 只接受 `targetId`，内部固定 discovery/manual；`POST /api/agent-runs` 在 409 时原样返回严格解析后的安全 problem，其他未知响应仍降为 502。
- `requestRecommendationReevaluationAction` 返回 `{kind:"started"} | {kind:"blocked";preflight} | {kind:"warning_confirmation_required";preflight}`，从 FormData 读取可空 fingerprint；只识别严格 run-preflight 409，其余错误继续抛出。

- [ ] **Step 1: 写 API controller/filter 失败测试**

  覆盖 query 未认证 401、无 targetId 自动主目标、有 targetId owner-bound、no-store、未知 query 400；发现与深度匹配 blocked/warning 均为 409 且报告严格一致；ready 创建为 201、reused 为 200。扫描响应和捕获日志，确认无职业文本、URL、配置指纹、密钥、原始异常和 stack。

- [ ] **Step 2: 写 API integration 失败测试**

  真实数据库旅程覆盖两个账户：账户 A 的页面报告不能访问 B 的 target/source/health；A 先 GET warnings，再改变来源健康后用旧 fingerprint POST 得到新 409；用新 fingerprint 成功且 GET run detail 返回相同 snapshot/policy revision；legacy fixture 返回 `preflightSnapshot:null`。对 recommendations/runs 重复同一 warning 确认语义。

- [ ] **Step 3: 写 ApiClient/BFF/server action 失败测试**

  覆盖 query URL 编码、认证重定向、成功 schema、invalid response、网络错误；409 必须保留完整 preflight，不能被现有空 body BFF 丢失。server action blocked/warning 返回判别结果并保留 idempotency key，成功才返回 started。

- [ ] **Step 4: 运行 API/Web server 定点测试，确认失败**

  Run: `pnpm --filter api test -- src/run-preflight/run-preflight.controller.test.ts src/recommendations/recommendations.controller.test.ts src/common/api-problem.filter.test.ts src/model-diagnostics/model-diagnostics.controller.test.ts src/agent-runs/agent-runs.module.test.ts src/api.integration.test.ts && pnpm --filter web test -- lib/server/api-client.test.ts lib/server/run-preflight.test.ts app/api/run-preflight/route.test.ts app/api/agent-runs/route.test.ts app/'(workbench)'/recommendations/actions.test.ts`

  Expected: FAIL，因为查询模块、结构化 409、BFF 与 action 判别结果尚不存在。

- [ ] **Step 5: 实现 Nest 模块、错误投影和 Web server 边界**

  ModelDiagnosticsModule 把 adapter 和 projection reader 注册为独立 provider，诊断 service 与 run-preflight 共用同一 fingerprint。Controllers 只映射已知 `RunPreflightRejectedError`；BFF 必须先用 `RunPreflightProblemSchema` 校验 409 body 再返回，防止透传任意上游内容。

- [ ] **Step 6: 串行验证 Task 5**

  Run: `pnpm --filter api test -- src/run-preflight/run-preflight.controller.test.ts src/recommendations/recommendations.controller.test.ts src/common/api-problem.filter.test.ts src/model-diagnostics/model-diagnostics.controller.test.ts src/agent-runs/agent-runs.module.test.ts src/api.integration.test.ts && pnpm --filter web test -- lib/server/api-client.test.ts lib/server/run-preflight.test.ts app/api/run-preflight/route.test.ts app/api/agent-runs/route.test.ts app/'(workbench)'/recommendations/actions.test.ts && pnpm --filter api typecheck && pnpm --filter web typecheck`

  Expected: PASS；认证、no-store、跨账户隐藏、刷新后重检和严格 409 在 API 到 Next 边界不丢字段。

- [ ] **Step 7: 提交并交给 Sol 只读审查**

  Commit: `feat: expose run preflight and typed conflicts`

  Review gate: 新的 Sol reviewer 只读检查认证/owner scope、GET 无副作用、API/Worker 同指纹、错误白名单、BFF 不空吞 409、controller 无规则复制和敏感字段扫描；修复后由 Terra 串行重跑 Step 6。

### Task 6: 完成工作台交互、用户旅程、领域术语与最终验收

**Files:**
- Modify: `apps/web/app/(workbench)/home/page.tsx`
- Modify: `apps/web/app/(workbench)/home/page.test.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.test.tsx`
- Create: `apps/web/components/workbench/run-preflight-panel.tsx`
- Create: `apps/web/components/workbench/run-preflight-panel.test.tsx`
- Modify: `apps/web/components/workbench/agent-run-panel.tsx`
- Modify: `apps/web/components/workbench/agent-run-panel.test.tsx`
- Modify: `apps/web/app/(workbench)/recommendations/reevaluate-button.tsx`
- Modify: `apps/web/app/(workbench)/recommendations/reevaluate-button.test.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/globals.test.ts`
- Create: `apps/web/e2e/run-preflight.spec.ts`
- Modify: `apps/web/e2e/agent-runs.spec.ts`
- Modify: `apps/web/e2e/scheduled-job-discovery.spec.ts`
- Modify: `apps/web/e2e/recommendations.spec.ts`
- Modify: `scripts/local-runtime.mjs`
- Modify: `scripts/local-runtime.test.mjs`
- Modify: `CONTEXT.md`

**Interfaces:**

- Home page 与 summary/targets/run/inbox 一起加载默认主目标的 discovery/manual preflight；`UnavailableSection` 增加 `preflight`，失败只降级检查卡，不隐藏其他成功区域。
- `RunPreflightPanel` props 为 `{ report:RunPreflightReport|null; unavailable:boolean; onReportChange:(report:RunPreflightReport)=>void }`。动作 href 固定映射：`review_profile→/profile`、`review_job_targets→/profile/targets`、来源能力/健康→`/profile/targets/{targetId}/watchlist#source-capabilities|source-health`、模型→`/profile/model-connection`、策略→`/profile/run-policy`。
- `AgentRunPanel` 接收当前 report；target 变化时 GET `/api/run-preflight?targetId=...`，用 request sequence/AbortController 防止旧响应覆盖新选择。start 总在 POST 时由服务端重检。
- 首次点击有 warning 时不 POST，显示警告摘要和“我已了解，仍要启动”按钮；确认后发送当前 fingerprint。收到 409 时用响应内最新 report 更新卡片、清空确认态但保留当前用户意图 idempotency key；只有成功读取新 run detail 后才轮换 key。
- 运行详情显示创建时 `preflightSnapshot` 的状态、检查时间、警告/信息与账户策略 revision；`null` 显示固定历史兼容文案，不用当前 report 填充。
- `ReevaluationForm` 对 action 的 warning 判别结果展示安全报告与明确确认按钮，把 fingerprint 放入 hidden field；blocked 只展示修复动作，不显示继续按钮；成功后才轮换 idempotency key。
- E2E runtime 显式使用 Fake model diagnostic，但 API/Worker 共享稳定 deployment fingerprint；fixture 通过现有模型连接 API 产生 `available`，绝不绕过 run-preflight 或访问真实 OpenAI。
- `CONTEXT.md` 增加五个术语：
  - **来源能力**：一个版本化岗位来源声明原则上支持的动作集合；与某次运行得到的来源健康分离。_Avoid_: 来源健康、抓取成功率。
  - **模型连接诊断**：使用固定合成且不含个人信息的输入，对部署级模型鉴权、模型可用性、结构化输出和超时进行的受控检查。_Avoid_: 用户模型配置、真实求职内容试跑。
  - **账户运行策略**：求职账户可收紧的来源范围、运行预算和后台时间窗口；最终生效值不得突破系统硬上限。_Avoid_: 订阅额度、系统硬上限替代品。
  - **运行前检查**：针对一次拟启动的 Agent 运行，根据当前权威领域状态返回阻塞、警告和信息的判定。_Avoid_: 页面校验、后台健康检查。
  - **运行前检查快照**：运行实际启动时保存的不可变检查结果；用于解释历史，不构成绕过未来系统硬上限的持续授权。_Avoid_: 当前运行许可、长期授权。
- 不新增 ADR；最终 Spec reviewer 必须明确确认本实现未形成需长期记录的新架构决策。

- [ ] **Step 1: 写工作台服务端加载与局部失败测试**

  覆盖默认主目标报告传入 view、无主目标 blocked 报告、preflight 单独失败时其余四区保留、invalid runId 不影响检查查询；初始 HTML 不出现任何安全白名单外 evidence。

- [ ] **Step 2: 写检查卡与 AgentRunPanel 失败测试**

  覆盖三种聚合状态、三种严重级标题/文案、依据/影响/重试资格、所有固定动作链接、无 target 时来源动作降级到 `/profile/targets`、`aria-live`、键盘焦点和不依赖颜色。交互覆盖 target 快切防竞态、ready 直接 POST、warning 两步确认、stale 409 刷新并要求再次确认、blocked 禁用启动、网络失败保留最后成功报告、成功后详情显示相同 snapshot。

- [ ] **Step 3: 写历史与重评表单失败测试**

  对新运行断言“本次启动条件”显示 snapshot 而不是当前 report；当前状态后来改变，历史仍不变。legacy null 显示“该历史运行创建时尚未记录运行前检查快照”。重评表单覆盖 warning 确认、blocked 动作、过期 fingerprint 更新、失败保留 key、成功轮换 key。

- [ ] **Step 4: 运行 Web 组件定点测试，确认失败**

  Run: `pnpm --filter web test -- app/'(workbench)'/home/page.test.tsx components/workbench/workbench-home-view.test.tsx components/workbench/run-preflight-panel.test.tsx components/workbench/agent-run-panel.test.tsx app/'(workbench)'/recommendations/reevaluate-button.test.tsx app/globals.test.ts`

  Expected: FAIL，因为初始查询、检查卡、动态刷新、确认交互与历史快照展示尚不存在。

- [ ] **Step 5: 实现最小可访问 UI**

  复用 workbench ledger/Button/链接/焦点样式；检查卡放在 AgentRunPanel 启动控制之前。桌面和移动都使用纵向可读的 item 列表，不做新导航或通用规则编辑器。所有 fetch 响应先严格 parse，未知结果显示局部错误但不误标 ready。

- [ ] **Step 6: 串行验证 Task 6**

  Run: `pnpm --filter web test -- app/'(workbench)'/home/page.test.tsx components/workbench/workbench-home-view.test.tsx components/workbench/run-preflight-panel.test.tsx components/workbench/agent-run-panel.test.tsx app/'(workbench)'/recommendations/reevaluate-button.test.tsx app/globals.test.ts && pnpm --filter web typecheck && pnpm --filter web lint`

  Expected: PASS；警告必须经过两次明确用户动作，blocked 没有可继续入口，历史 null 与 snapshot 均有可读解释。

- [ ] **Step 7: 写 Playwright 失败旅程**

  `run-preflight.spec.ts` 覆盖 Desktop Chrome 与 Mobile Chrome：

  - 新账户依次看到画像、主目标、真实来源、模型诊断 blocker，并能通过固定链接逐项到达现有页面。
  - 完成画像/主目标/真实来源并运行模型诊断后，来源未检查 warning 需“我已了解，仍要启动”才创建；运行 detail 显示相同 warning fingerprint/checkedAt 与 policy revision。
  - GET 报告后在数据库 fixture 中改变健康或策略，旧确认 POST 得 409；页面显示新报告并要求再次确认，证明页面过期后重检。
  - 停用全部真实来源或让模型失败时按钮不可启动且数据库无新 AgentRun；账户 B 看不到账户 A 的 target/evidence。
  - 刷新历史新运行仍显示原 snapshot；注入 pre-0047 legacy 行显示兼容文案。
  - 关键检查卡和确认按钮键盘可达、焦点可见、axe 无 critical/serious 问题、移动视口无横向溢出。

- [ ] **Step 8: 扩展既有三条运行旅程**

  `agent-runs.spec.ts` 保留 ready 手动发现与幂等重放；`scheduled-job-discovery.spec.ts` 覆盖 warning 自动继续、blocker occurrence skip/no run；`recommendations.spec.ts` 覆盖手动深匹配 warning 确认与自动 child blocker 不回滚父发现。所有旅程先通过正式模型诊断入口准备状态，不直接写伪造 ready gate。

- [ ] **Step 9: 运行 E2E 定点旅程，确认失败**

  Run: `pnpm --filter web test:e2e -- run-preflight.spec.ts agent-runs.spec.ts scheduled-job-discovery.spec.ts recommendations.spec.ts`

  Expected: 首次 FAIL；保存完整日志，失败应精确指出尚未接好的 fixture、交互或历史投影，不得用 skip 掩盖。

- [ ] **Step 10: 实现最小 E2E runtime fixture 与领域术语**

  local runtime 仅固定 test deployment fingerprint 并继续删除全部继承的 `OPENAI_*`；更新 runtime 自测证明真实密钥不能进入 E2E。按上述精确定义插入 `CONTEXT.md` 相邻术语区域，不重排或重写其他领域语言。

- [ ] **Step 11: 串行验证 Task 6 的完整定点范围**

  Run: `pnpm test:runtime && pnpm --filter web test:e2e -- run-preflight.spec.ts agent-runs.spec.ts scheduled-job-discovery.spec.ts recommendations.spec.ts`

  Expected: PASS；桌面/移动均覆盖 blockers、warnings、过期重检、快照解释、schedule、manual/automatic deep-match 和跨账户隔离；测试进程未访问 OpenAI。

- [ ] **Step 12: 提交并完成 Task 6 的 Sol 只读切片审查**

  Commit: `feat: complete run preflight workbench journey`

  Review gate: 新的 `gpt-5.6-sol / high` reviewer 只读检查动态 target 刷新竞态、页面过期后 409 重检、警告知情继续、blocked 可达修复页、历史不被当前态污染、E2E 证据、移动/键盘/ARIA、领域术语与未新增产品范围；修复后由 Terra 串行重跑 Step 6 与 Step 11，并追加修复提交。

- [ ] **Step 13: 做最终 Standards/Spec 双轴只读审查**

  并行派发两个全新 `gpt-5.6-sol / high` 只读 reviewer，但两者都禁止运行测试：

  - **Standards 轴**：对本 Issue 全部 commits/diff 检查根级 AGENTS、代码风格、模块边界、安全/隐私、迁移兼容、并发/事务、测试质量和无无关改动。
  - **Spec 轴**：逐条核对 Issue #51 acceptance criteria、已批准方案、PRODUCT/CONTEXT/ADR、所有 AgentRun 创建调用图、#52/#53/#54 非目标和“不需要新 ADR”的判断。

  两轴问题由唯一 Terra Executor 修复；每批修复先运行受影响的最小串行命令并提交 `fix: address run preflight review`。修复完成后重新派发未通过轴的全新 Sol reviewer，只读复核到两轴均无阻塞发现。

- [ ] **Step 14: 清除测试并发风险并执行完整串行验收**

  先运行只读进程检查：`pgrep -af 'vitest|playwright|e2e-runner|pnpm.*test'`。

  Expected: 没有遗留测试进程；若存在，先停止对应 Executor/测试会话并再次确认，不在重叠进程下采信任何结果。

  然后由唯一 Terra Executor 顺序运行并保留每条完整日志：

  ```bash
  pnpm test:runtime &&
  pnpm --filter @job-copilot/contracts test &&
  pnpm --filter @job-copilot/model-access test &&
  pnpm --filter @job-copilot/source-access test &&
  pnpm --filter @job-copilot/database test &&
  pnpm --filter @job-copilot/domain test &&
  pnpm --filter api test &&
  pnpm --filter worker test &&
  pnpm --filter web test &&
  pnpm --filter web test:e2e &&
  pnpm -r --workspace-concurrency=1 --if-present typecheck &&
  pnpm -r --workspace-concurrency=1 --if-present build &&
  pnpm -r --workspace-concurrency=1 --if-present lint
  ```

  Expected: 全部 PASS；记录各包测试数量、Playwright desktop/mobile 数量、命令退出码与总耗时。任何失败修复后从该完整命令第一行重新串行执行，不拼接旧结果。

- [ ] **Step 15: 最终差异/术语/占位符自检并交付**

  Run: `git status --short && git diff --check && ! rg -n '[T]ODO|[T]BD|[P]LACEHOLDER|similar[[:space:]]+to|同[[:space:]]*上|稍后[[:space:]]*补' packages apps scripts CONTEXT.md docs/superpowers/plans/2026-09-05-issue-51-run-preflight.md && rg -n '\.insert\(agentRuns\)' packages apps --glob '!**/*.test.ts' --glob '!**/*.integration.test.ts'`

  Expected: worktree 只有本 Issue 的预期文件；`git diff --check` 无输出；无实现占位符；两处 AgentRun insert 均受同一 evaluator 保护。确认 `CONTEXT.md` 五个新术语存在、`docs/adr/` 无新增文件、全仓无 #52/#53/#54 实现。

  最后在 GitHub Issue #51 留下实现摘要、两轴审查结论、完整串行验收命令/数量与迁移说明后关闭 Issue；不主动 push。下一 Issue 必须新建 Codex 任务并发送对应 `/implement #<number>`，不得在本任务续做。

## Success Criteria Traceability

- 公开领域查询与 blocking/warning/informational：Task 1–2、Task 5。
- 画像、主目标、真实来源能力/健康、模型、策略完整覆盖：Task 2。
- 稳定代码、中文摘要、安全依据、影响、重试与有限动作：Task 1–2、Task 6。
- 工作台动态结果与可达修复页面：Task 5–6。
- 手动/计划启动前重检、警告知情继续：Task 3–6。
- 所有 AgentRun 创建路径和自动 child：Task 3–4。
- 快照与账户策略修订原子绑定、历史兼容：Task 1、Task 3、Task 6。
- 当前系统硬上限继续收紧历史运行：Task 3。
- 领域/API/Playwright 的阻塞、警告、页面过期、解释性与跨账户隔离：Task 2–6。

## Plan Self-Review

- **Spec coverage:** Issue #51 八条 acceptance criteria 均映射到具体 Task、测试和成功断言；手动发现、计划发现、手动重评、自动 child、事务内 afterCompleted、事务外补偿/恢复均有明确入口覆盖。
- **File coverage:** 计划列出新契约、深模块、模型 projection、0047 迁移、两处 AgentRun insert、schedule、processor、API/Worker 装配、BFF、工作台/重评 UI、E2E、runtime 与 CONTEXT；没有使用通配文件、“相关文件”或未定路径。
- **Type consistency:** `workflow/trigger/status/severity/code/action/evidence/problem/snapshot` 在 contracts→domain→database→API→BFF→React 使用同一 Zod 派生类型；`warningFingerprint` 全链路为 `hex64|null`，历史 `preflightSnapshot` 全链路为 nullable、新创建由领域保证非空。
- **TDD discipline:** 每个 Task 都先写失败测试、给出精确命令和预期失败，再实现最小代码、串行绿测、独立 commit 与 Sol 只读 gate；最终双轴审查与完整验收分离。
- **Placeholder scan:** 计划没有未决标记、省略实现、回指前文或留待后补的指令；代码骨架、接口、文件名、命令、错误码、迁移号和提交信息均已确定。
- **Scope control:** 明确不新增 ADR，不回填历史，不触发外部诊断，不创建规则 DSL/新导航，不实现首次推荐旅程、一键推荐编排或账户全局停止，不修改 #52/#53/#54 范围。
