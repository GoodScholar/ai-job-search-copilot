# Issue #50 模型连接诊断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为两档业务模型提供不含职业资料与个人信息的连接诊断，并向已认证用户展示可缓存、可重试、脱敏的中文结果。

**Architecture:** 新增 `@job-copilot/model-access`，用一个共享 Adapter 契约承载 OpenAI Responses 生产探针和确定性 Fake；领域服务按部署配置指纹协调缓存、跨实例互斥、退避和持久化，Nest API 只返回安全投影。Next.js 在画像下提供模型连接页，并从工作台“运行设置”区域进入；现有 Fake 业务模型调用保持不变。

**Tech Stack:** TypeScript、Zod、Node `fetch`/Web Crypto、NestJS、Drizzle/PostgreSQL、Next.js/React、Vitest、Playwright。

**Spec:** GitHub Issue `GoodScholar/ai-job-search-copilot#50`；同时遵守根级 `CONTEXT.md`、`docs/adr/0019-use-openai-responses-for-local-beta.md`、原工作区尚未提交的 `docs/adr/0040-keep-runtime-service-credentials-outside-job-accounts.md`。

## Global Constraints

- 只探测 `gpt-5.6-luna` 与 `gpt-5.6-terra` 两档现有业务模型；不是通用模型平台，也不增加多供应商或用户 API Key 管理。
- 一轮诊断最多发出两个外部请求，每档模型一个；整个诊断共用 20 秒总截止时间，不做 Adapter 或 SDK 自动重试。
- 请求正文必须是源码内固定的合成输入，不含求职账户、职业资料、岗位、请求正文或其他 PII；严格输出格式也必须是固定常量。
- Responses 请求使用 `text.format={type:"json_schema",name,schema,strict:true}`；schema 对象 `additionalProperties:false`，所声明字段全部 required；固定 `reasoning:{effort:"none"}` 和小而充足的输出上限（256）。
- 拒绝 `response.status === "incomplete"`、refusal、缺失输出文本、无效 JSON 或不匹配 schema；401 映射鉴权失败，403 映射访问受限而不是密钥错误，404 映射模型不可用，429/5xx 映射暂不可用。
- `fetch` 必须受同一个 `AbortSignal` 约束并禁用重定向（`redirect:"error"`）；Adapter 主动丢弃响应正文、原始异常和请求对象，避免以后日志序列化泄漏。
- 配置指纹覆盖诊断版本、端点、组织、项目、两档 model id、探针常量和密钥；只在服务端内部使用，任何 API 或浏览器数据不得包含它。任一配置或密钥变化立即转到新指纹。
- 成功结果复用 10 分钟；失败按同一指纹的连续稳定失败记录计算 `30s, 60s, 120s, 240s, 480s, 600s` 上限退避，退避期返回真实失败状态而不伪装成功。
- 跨实例用 PostgreSQL `pg_try_advisory_xact_lock` 竞争当前指纹；未获得锁立即返回 `checking`，不等待连接池排队。持锁实例二次读取缓存，完成探针并写入稳定结果；其他实例随后读缓存。
- 数据库仅持久化总体状态、四项固定检查状态、稳定原因代码、检查时间、延迟区间和配置指纹；`checks` JSONB 的键和值由 schema/CHECK 固定，不得保存密钥、完整输入、原始响应、供应商账户信息、模型输出或求职账户标识。
- GET/POST 诊断入口都必须通过 `SessionGuard` 并设置 `Cache-Control: no-store`；POST 接受无正文或空对象，拒绝任何非空输入。API 仅返回总体状态、四项检查状态、稳定原因的中文摘要、影响、建议动作、检查时间、延迟区间和可安全重试时间。
- 初始或当前指纹从未完成诊断时显示 `unverified`；锁争用时显示 `checking`；稳定结果只使用 `available | failed | temporarily_unavailable`。
- 所有默认测试显式清除 OpenAI 相关环境变量并强制注入 Fake；真实 OpenAI 冒烟检查不进入默认 CI。
- 测试命令始终由唯一 `gpt-5.6-terra / high` Executor 串行运行；root 与 `gpt-5.6-sol / high` 只读审查，不与 Executor 并发执行测试。
- 每个 Task 完成后由 `gpt-5.6-sol / high` 做只读切片审查，再进入下一 Task；最终另做 Standards/Spec 双轴独立审查和完整验收。

---

### Task 1: 共享诊断契约、OpenAI Adapter 与 Fake Adapter

**Files:**
- Create: `packages/contracts/src/model-diagnostics.ts`
- Create: `packages/contracts/src/model-diagnostics.test.ts`
- Modify: `packages/contracts/package.json`
- Create: `packages/model-access/package.json`
- Create: `packages/model-access/tsconfig.json`
- Create: `packages/model-access/src/index.ts`
- Create: `packages/model-access/src/internal.ts`
- Create: `packages/model-access/src/testing.ts`
- Create: `packages/model-access/src/model-diagnostics.contract.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- `ModelDiagnosticStatus = "unverified" | "checking" | "available" | "failed" | "temporarily_unavailable"`。
- `ModelDiagnosticReasonCode` 固定包含：`MODEL_DIAGNOSTIC_AVAILABLE`、`MODEL_DIAGNOSTIC_CONFIGURATION_MISSING`、`MODEL_DIAGNOSTIC_AUTHENTICATION_FAILED`、`MODEL_DIAGNOSTIC_ACCESS_RESTRICTED`、`MODEL_DIAGNOSTIC_LOW_COST_MODEL_UNAVAILABLE`、`MODEL_DIAGNOSTIC_HIGH_QUALITY_MODEL_UNAVAILABLE`、`MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED`、`MODEL_DIAGNOSTIC_TIMEOUT`、`MODEL_DIAGNOSTIC_RATE_LIMITED`、`MODEL_DIAGNOSTIC_PROVIDER_UNAVAILABLE`、`MODEL_DIAGNOSTIC_FAILED`。
- `ModelDiagnosticLatencyBucket = "under_1s" | "1_to_5s" | "5_to_10s" | "10_to_20s" | "timeout"`。
- `ModelDiagnosticCheckStatus = "passed" | "failed" | "not_verified"`，`ModelDiagnosticChecks = { authentication; modelAvailability; structuredOutput; timeout }`，四个属性都使用该枚举且不得增减键。
- `ModelDiagnosticProbeResult = { status: "available" | "failed" | "temporarily_unavailable"; checks: ModelDiagnosticChecks; reasonCode: ModelDiagnosticReasonCode; latencyBucket: ModelDiagnosticLatencyBucket }`。
- `ModelDiagnosticAdapter = { readonly configurationFingerprint: string; diagnose(input:{ signal: AbortSignal }): Promise<ModelDiagnosticProbeResult> }`。
- 生产入口 `createOpenAiModelDiagnosticAdapter(config)` 只接受运行时配置；`./testing` 导出 `createFakeModelDiagnosticAdapter(scenario)` 和受控 transport seam。生产入口不接受测试 transport。

- [ ] **Step 1: 写共享 Zod 契约测试**

  锁定全部状态/原因/延迟枚举、`authentication/modelAvailability/structuredOutput/timeout` 四项检查的 `passed/failed/not_verified` 严格对象解析，以及公开响应中不存在 `configurationFingerprint`、`apiKey`、`providerResponse`、模型原始输出等字段。

- [ ] **Step 2: 运行 contracts 定点测试，确认失败**

  Run: `pnpm --filter @job-copilot/contracts test -- src/model-diagnostics.test.ts`
  Expected: FAIL，因为新模块与导出尚不存在。

- [ ] **Step 3: 实现最小共享契约与包导出**

  增加上述类型、Zod schema 和 API 安全响应 schema；只定义本 Issue 使用的诊断接口，不抽象通用聊天、提示词或供应商注册表。

- [ ] **Step 4: 写 Adapter 契约测试**

  用同一测试矩阵验证 OpenAI 受控 transport 与 Fake：成功、401、403、两档任一 404、严格结构输出不兼容、`incomplete`、refusal、超时、429、5xx；逐项断言可证实的检查，鉴权失败时其余三项必须为 `not_verified`，不得从未执行阶段推断通过。另断言固定请求不含测试账户/职业文本，最多两次请求，20 秒信号取消，`redirect:"error"`，无重试，抛出的原始响应正文和原始 Error 不进入结果或错误可枚举字段。

- [ ] **Step 5: 运行 Adapter 定点测试，确认失败**

  Run: `pnpm --filter @job-copilot/model-access test -- src/model-diagnostics.contract.test.ts`
  Expected: FAIL，因为生产与 Fake Adapter 尚不存在。

- [ ] **Step 6: 实现最小生产与 Fake Adapter**

  每档发一个固定 Responses 请求；共享总截止并并发收敛两个结果，只有两档都通过严格结构解析才返回 `available`。总体与四项检查按证据聚合：任一已验证失败使总体为失败或暂不可用；某项只有两档相关验证均通过才为 `passed`，无充分证据则为 `not_verified`。用确定性优先级聚合失败原因，先保留鉴权/访问限制，再保留模型可用性、结构输出、超时与临时供应方错误；只返回稳定结果。

- [ ] **Step 7: 串行验证 Task 1**

  Run: `pnpm --filter @job-copilot/contracts test -- src/model-diagnostics.test.ts && pnpm --filter @job-copilot/model-access test && pnpm --filter @job-copilot/contracts typecheck && pnpm --filter @job-copilot/model-access typecheck`
  Expected: PASS；测试未访问公网。

- [ ] **Step 8: 提交并交给 Sol 只读审查**

  Commit: `feat: add model diagnostic adapters`
  Review gate: 核查 Responses 严格输出、20 秒总截止、两次请求上限、无重定向/重试、敏感数据丢弃和公开契约最小性。

### Task 2: PostgreSQL 缓存、领域协调与认证 API

**Files:**
- Create: `packages/database/migrations/0046_model_diagnostic_results.sql`
- Modify: `packages/database/migrations/meta/_journal.json`
- Create or modify generated snapshot files only as required by the repository's existing Drizzle migration workflow
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/migrate.integration.test.ts`
- Create: `packages/domain/src/model-diagnostics.ts`
- Create: `packages/domain/src/model-diagnostics.integration.test.ts`
- Modify: `packages/domain/package.json`
- Modify: `packages/domain/src/runtime-config.ts`
- Modify: `packages/domain/src/runtime-config.test.ts`
- Create: `apps/api/src/model-diagnostics/model-diagnostics.tokens.ts`
- Create: `apps/api/src/model-diagnostics/model-diagnostics.module.ts`
- Create: `apps/api/src/model-diagnostics/model-diagnostics.controller.ts`
- Create: `apps/api/src/model-diagnostics/model-diagnostics.controller.test.ts`
- Modify: `apps/api/src/config/runtime-config.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/api.integration.test.ts`
- Modify: `apps/api/package.json`

**Interfaces:**
- `createModelDiagnostics({ db, adapter, clock })` 返回 `get(): Promise<ModelDiagnosticResponse>` 与 `run(): Promise<ModelDiagnosticResponse>`；服务是部署级诊断，不接收 `userId`。
- 数据表 `model_diagnostic_results` 使用 `(configuration_fingerprint, checked_at)` 复合主键，列严格限制为 `configuration_fingerprint`、`status`、`checks`、`reason_code`、`checked_at`、`latency_bucket`；CHECK 同时约束稳定枚举、`checks` 必须是对象、只能有四个固定键且值只能为 `passed | failed | not_verified`。
- `GET /v1/model-diagnostics` 读取当前指纹状态并以 `pg_try_advisory_xact_lock` 探测是否有另一实例正在诊断；锁被占用时返回 `checking`，获得锁时只读稳定结果并立即释放，绝不发外部请求。`POST /v1/model-diagnostics` 接受无正文/空对象、拒绝非空输入并触发或复用诊断。两者均返回含 `checks` 的 `ModelDiagnosticResponseSchema`、设置 `Cache-Control: no-store` 且受 `SessionGuard` 保护。

- [ ] **Step 1: 写迁移与领域失败测试**

  覆盖允许列与固定四键 `checks` CHECK、当前指纹从未检查、10 分钟内成功复用、10 分钟边界过期、密钥/端点/组织/项目/model/探针版本变化立即失效、失败连续记录推导有上限指数退避、退避结束后允许新一轮、同指纹并发只有锁持有者调用 Adapter、POST 锁失败立即返回 `checking`、GET 在锁占用期间也返回 `checking` 且不调用 Adapter、持锁者写入前二次读缓存、意外异常被净化成稳定失败。

- [ ] **Step 2: 运行 database/domain 定点测试，确认失败**

  Run: `pnpm --filter @job-copilot/database test -- src/migrate.integration.test.ts && pnpm --filter @job-copilot/domain test -- src/model-diagnostics.integration.test.ts`
  Expected: FAIL，因为表与领域服务尚不存在。

- [ ] **Step 3: 实现迁移、领域服务与运行配置**

  `run()` 先读成功缓存/失败退避，再在短事务内调用 `pg_try_advisory_xact_lock(hashtextextended(fingerprint, 50))`；未得锁立即结束事务返回 `checking`。得锁后二次读取，再以 20 秒 AbortController 调 Adapter 并只插入安全列。运行配置读取 `OPENAI_API_KEY`、可选 endpoint/organization/project；`APP_ENV=test` 强制 Fake，测试 setup 删除全部 OpenAI 环境变量。

- [ ] **Step 4: 写 API 失败测试**

  覆盖 GET/POST 未认证为 401、GET/POST 的 `Cache-Control: no-store`、POST 无正文/空对象成功而非空对象为 400、首次 `unverified`、GET 与 POST 在锁争用时均为 `checking`、可用/失败/暂不可用的四项检查、中文摘要、影响、有限建议动作与 `retryAt`，并扫描响应与捕获日志，确认不存在配置指纹、密钥、请求、原始响应、组织/项目、模型 ID 和注入的敏感哨兵。

- [ ] **Step 5: 实现 Nest 模块并注册 AppModule**

  provider 在测试环境只创建 Fake；其他环境按运行配置创建 OpenAI Adapter。Controller 用严格空对象/可选正文 schema 拒绝非空输入，通过稳定映射生成用户文案并显式设置 no-store；未知异常交给现有 `ApiProblemFilter`，Adapter 原始值在进入过滤器前已经被丢弃。

- [ ] **Step 6: 串行验证 Task 2**

  Run: `pnpm --filter @job-copilot/database test -- src/migrate.integration.test.ts && pnpm --filter @job-copilot/domain test -- src/model-diagnostics.integration.test.ts src/runtime-config.test.ts && pnpm --filter api test -- src/model-diagnostics/model-diagnostics.controller.test.ts src/api.integration.test.ts && pnpm --filter @job-copilot/database typecheck && pnpm --filter @job-copilot/domain typecheck && pnpm --filter api typecheck`
  Expected: PASS；Fake 调用计数证明缓存、退避与竞争场景均有界。

- [ ] **Step 7: 提交并交给 Sol 只读审查**

  Commit: `feat: persist and expose model diagnostics`
  Review gate: 核查允许持久化列、非阻塞事务锁、跨实例语义、指纹永不出 API、认证边界与稳定中文投影。

### Task 3: 模型连接页、工作台入口与用户旅程验收

**Files:**
- Modify: `apps/web/lib/server/api-client.ts`
- Create: `apps/web/lib/server/model-diagnostics.ts`
- Create: `apps/web/lib/server/model-diagnostics.test.ts`
- Create: `apps/web/app/api/model-diagnostics/route.ts`
- Create: `apps/web/app/api/model-diagnostics/route.test.ts`
- Create: `apps/web/app/(workbench)/profile/model-connection/page.tsx`
- Create: `apps/web/app/(workbench)/profile/model-connection/page.test.tsx`
- Create: `apps/web/components/workbench/model-connection-view.tsx`
- Create: `apps/web/components/workbench/model-connection-view.test.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.test.tsx`
- Modify: `apps/web/app/globals.css`
- Create: `apps/web/e2e/model-diagnostics.spec.ts`
- Modify: default test/runtime environment setup files that currently define API process variables, only to clear OpenAI variables and select Fake diagnostics

**Interfaces:**
- Server client 增加 `getModelDiagnostics(sessionToken)` 与 `runModelDiagnostics(sessionToken)`；BFF `GET|POST /api/model-diagnostics` 只转发安全契约和当前 session。
- `/profile/model-connection` 首次服务端读取状态；客户端点击“检查模型连接”后 POST，若得到 `checking`，每秒 GET 一次，最多 25 次，然后停在明确的“检查仍在进行，可稍后刷新”状态。

- [ ] **Step 1: 写 Web 单元与路由失败测试**

  覆盖契约解析、认证重定向保留、`unverified/checking/available/failed/temporarily_unavailable` 五种文案、原因/影响/动作/时间/延迟展示、退避期禁用重复触发、有界轮询停止，以及工作台“运行设置”中 `/profile/model-connection` 中文链接。

- [ ] **Step 2: 运行 Web 定点测试，确认失败**

  Run: `pnpm --filter web test -- lib/server/model-diagnostics.test.ts app/api/model-diagnostics/route.test.ts app/'(workbench)'/profile/model-connection/page.test.tsx components/workbench/model-connection-view.test.tsx components/workbench/workbench-home-view.test.tsx`
  Expected: FAIL，因为页面、BFF 与工作台入口尚不存在。

- [ ] **Step 3: 实现最小页面与运行接线**

  使用现有 workbench ledger、按钮与焦点样式；状态同时使用文本、标题和 `aria-live`，不只依赖颜色。移动宽度下按钮与状态卡不横向溢出并保留触控尺寸；页面只说“模型连接”，不展示 API Key、供应商账户、组织/项目或具体模型 ID。

- [ ] **Step 4: 写已认证 Playwright 旅程**

  从 `/home` 的“运行设置”进入模型连接页，验证未验证状态、触发 Fake 成功、刷新后仍可用、失败/暂不可用的稳定中文建议；在移动视口验证无横向溢出、键盘可操作、可见焦点和关键可访问性检查。默认运行明确清除 OpenAI 环境变量，失败即证明没有真实模型调用通道。

- [ ] **Step 5: 串行验证 Task 3 与全仓**

  Run: `pnpm --filter web test && pnpm --filter web test:e2e -- model-diagnostics.spec.ts && pnpm test:runtime && pnpm -r --workspace-concurrency=1 --if-present test && pnpm typecheck && pnpm build && pnpm lint`
  Expected: PASS；全流程仅使用 Fake，现有 Fake 深度匹配/业务模型行为不变。

- [ ] **Step 6: 提交、双轴审查与交付**

  Commit: `feat: add model connection diagnostics page`
  由两个独立只读 Sol reviewer 分别检查仓库 Standards 与 Issue #50 Spec；任何修复仍由唯一 Terra Executor 实施并串行重跑受影响测试。随后执行完整验收并记录测试数量与命令，本地提交后 fast-forward 合并回 `main`，保留原工作区用户未提交的 `CONTEXT.md`/ADR 等文档，不把它们复制进本 Issue 提交；GitHub Issue 留验收评论并关闭，不主动 push。

## References

- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI API error codes](https://developers.openai.com/api/docs/guides/error-codes)
- [OpenAI Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
