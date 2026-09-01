# Issue #12 执行报告（未完成）

## Executor 接续记录（2026-09-01）

- 已按固定基线只读复核并串行重跑既有 focused smoke：contracts 5/5、domain 5/5、worker 5/5、database migration 23/23；无并发测试进程。
- 新增 `@job-copilot/contracts/job-triage`，严格约束 triage 创建命令和只含最小证据引用的版本输出；契约 RED（模块缺失）后 GREEN 2/2。
- 补足粗排输出：技术、经验、目标对齐分别保存 `score/reasonCode`；经验事实模型暂不含可比较年限时固定中性 50 且明确说明，缺失目标对齐信号也固定中性 50。domain RED 后 GREEN 5/5。
- 新增真实 Postgres 的 `job-triage-persistence` 命令/查询：owner-bound 当前岗位机会/来源版本、活动目标修订、当前活动画像事实，账户 advisory lock 下按所有输入版本和规则版本复用，不存在/停用/空画像返回明确错误；latest/指定版本的 owner 查询 seam 已导出。持久化 RED（模块缺失）后 GREEN 1/1；中途严格 ProfileFact DTO 映射错误已定位为内部 `state/revisionNumber` 泄入 strict schema，已改为显式 allowlist 投影。
- triage 创建现写入严格 allowlist 的 `job.triage_created` 审计事件，仅含 IDs、输入版本、规则版本、总体 verdict 与 deadline 状态；不含岗位正文、画像原文、gate 值或分数。审计断言已加入真实 Postgres triage integration。
- 已新增 Nest triage module/controller/tokens 并接入 AppModule；POST 和 latest/指定 GET 路由、Session Guard、Zod/OpenAPI、401/400/404/409 映射已实现。`pnpm --filter api typecheck` 与既有真实 API integration 43/43 通过；triage 专属 API 集成仍未完成。
- Web API client 的 triage create/latest 方法、server-only loader 以及同源 no-store BFF route（create/latest）已完成 TDD：client 29/29、loader 1/1、BFF route 2/2、web typecheck 通过。
- `JobTriagePanel` 已接入岗位导入完成视图：选择活动求职目标、刷新已持久化版本、三态/截止/置信度、九 gate 的岗位/画像最小证据和 pending；仅 pass 显示粗排维度与“进入后续候选/低于阈值”措辞。组件 TDD 2/2，既有 JobImportView 14/14 仍通过。页面平行首读岗位导入与目标。

### 下一动作

1. 为 triage domain/API 补全新输入版本、并发复用、inactive/empty/owner 404 的真实集成测试，并接入脱敏审计 allowlist。
2. 增加 web API client/route/server action，扩展岗位导入完成页的目标选择、三态与证据视图，以及组件测试。
3. 运行真实运行时 Playwright 三路径与最终串行全量验证。

### 当前接续验证

- `pnpm typecheck`：exit 0（contracts、database、web、source-access、domain、worker、api 全部完成）。
- `pnpm lint`：exit 0；初次发现 triage panel test 的未使用 `act` import，仅删除该本次引入的 import 后重跑通过。
- 最近一轮 focused：contracts 7/7、domain 6/6、API integration 43/43、web touched 50/50，均串行执行。
- `git diff --check`：exit 0。

## 基线与授权范围

- 开始基线：`b297dbaf8e61433f038e8a433dfab429f1f88aae`，工作树干净；`gh issue view 12 --repo GoodScholar/ai-job-search-copilot --json state` 返回 `OPEN`。
- 未 push、未创建 PR、未 merge、未关闭 Issue，未修改 Agent Run 工作流/步骤/队列。
- 仅涉及 contracts、database、domain、worker Fake normalizer 和测试/迁移。未调用模型，未写入岗位正文、画像原文到日志或审计。

## 已实现的切片

1. `packages/contracts/src/job-imports.ts`
   - 新增显式资格字段及最小 `field/path/value` 证据：工作方式、搬迁、薪资、资历、学历、语言、工作资格、行业、雇佣类型、必备技能。
   - 旧 `normalizedData` 缺少 `qualifications` 时按全字段 `null` 解析，不猜测。
2. `packages/database/src/schema.ts` 与生成的 `0028_job_triage_versions.sql`
   - 新增 owner-bound、输入版本/规则版本幂等唯一键的不可变 triage 表。
   - DB 检查约束禁止 fail/unknown/expired 携带评分；校验 JSON 形状、状态、置信度与评分范围。
3. `packages/domain/src/job-triage.ts`
   - 初版确定性九 gate、三态聚合、截止日期 UTC 边界和 35/25/40 粗排纯函数。
   - 被移除事实会被过滤；hard fail 使用岗位版本证据和目标/画像证据。
4. `apps/worker/src/job-imports/fake-job-posting-normalizer.ts`
   - 仅从显式 Markdown 标签提取资格字段和最小证据；未出现标签保持 `null`。

## TDD 记录

| 切片 | RED 命令/摘要 | GREEN 命令/结果 |
| --- | --- | --- |
| Contracts qualification | `pnpm --filter @job-copilot/contracts test -- src/job-imports.test.ts`，exit 1：`qualifications` 是未识别键 | `pnpm --filter @job-copilot/contracts exec vitest run src/job-imports.test.ts --no-file-parallelism`，exit 0，5/5 |
| Legacy qualification | 同 contracts 命令，exit 1：缺少 `qualifications` | 同上，exit 0，5/5 |
| DB migration | `pnpm --filter @job-copilot/database test -- src/migrate.integration.test.ts`，exit 1：缺少 `job_triage_versions` | `pnpm --filter @job-copilot/database exec vitest run src/migrate.integration.test.ts -t 'job triage versions' --no-file-parallelism`，exit 0，1 passed/22 skipped |
| Fake normalizer | `pnpm --filter worker exec vitest run src/job-imports/fake-job-posting-normalizer.test.ts --no-file-parallelism`，exit 1：`qualifications` 为 undefined | 同命令，exit 0，5/5；`pnpm --filter worker typecheck`，exit 0 |
| Domain gates/ranking | `pnpm --filter @job-copilot/domain exec vitest run src/job-triage.test.ts --no-file-parallelism`，exit 1：模块不存在 | 同命令，exit 0，3/3；`pnpm --filter @job-copilot/domain typecheck`，exit 0 |

## 验收映射

- AC-01：部分实现。domain 初版含九类 gate，但没有逐类完整穷举测试。
- AC-02：部分实现。domain null 评分与 DB `job_triage_versions_score_verdict_check` 已覆盖；缺少持久化集成证明。
- AC-03：部分实现。纯函数 hard fail 带双侧证据；没有 owner 读取 API 测试。
- AC-04：部分实现。缺失资格与 missing/invalid deadline 已区分；缺少端到端持久化/UI。
- AC-05：未完成。表唯一键与纯评分已实现；幂等命令、版本重算未实现。
- AC-06：部分实现。注入 `now`、边界语义和 closing_soon 已在纯函数；缺少持久化排序测试。
- AC-07：未完成（API）。
- AC-08：未完成（Web/Playwright）。
- AC-09：部分实现。removed facts 过滤、Fake normalizer 不执行岗位命令；缺少完整审计集成。
- AC-10：**UNVERIFIED/BLOCKED**。完整迁移测试未能通过，且根级验证、API/Web/Playwright 尚未运行。

## 迁移链复核与修复（Rework 第 1 轮）

初次单进程命令：

`pnpm --filter @job-copilot/database exec vitest run src/migrate.integration.test.ts --no-file-parallelism`

退出码 `1`。首个失败是 `packages/database/src/migrate.integration.test.ts:1186` 的 `upgrades an existing 0022 database to source-attention without losing rows`：在迁移后插入 `agent_inbox_items.kind='source_attention'` 被 `agent_inbox_items_kind_check` 拒绝。

按 rework 指令在 `/tmp/issue12-baseline-cI9AYC` 执行 `git archive b297... | tar -x`、`pnpm install --frozen-lockfile` 后，运行同一单进程命令得到 **exit 0，22/22**。因此失败由本次新增 0028 与既有升级夹具交互造成：夹具构造 0022 历史快照时删除了 0023–0027，却遗漏删除 0028，导致 Drizzle 先记录较新的 0028，后续 0023–0027 被时间序跳过。

最小修复只扩展该夹具的删除/过滤名单以包含 0028 与其 snapshot，不修改 0023–0027 SQL。修复后：`pnpm --filter @job-copilot/database exec vitest run src/migrate.integration.test.ts --no-file-parallelism`，**exit 0，23/23**。

本轮另补：教育或工作资格的不同事实不再自动 hard fail，而是 `CANDIDATE_EVIDENCE_INSUFFICIENT` unknown；Fake normalizer 对无效显式 deadline 保存最小 `field/path/value/status` provenance，避免把 invalid 混为 missing。

## 最终已执行验证

- `pnpm --filter @job-copilot/contracts exec vitest run src/job-imports.test.ts --no-file-parallelism`：exit 0，5 passed。
- `pnpm --filter worker exec vitest run src/job-imports/fake-job-posting-normalizer.test.ts --no-file-parallelism`：exit 0，5 passed。
- `pnpm --filter @job-copilot/domain exec vitest run src/job-triage.test.ts --no-file-parallelism`：exit 0，3 passed。
- `pnpm --filter @job-copilot/contracts typecheck && pnpm --filter @job-copilot/database typecheck && pnpm --filter @job-copilot/domain typecheck && pnpm --filter worker typecheck`：此前逐包 exit 0。
- `git diff --check`：exit 0。

## 未完成与风险

- 没有 job triage 持久化 domain command/query、审核记录、API、Web 和 Playwright；因此本实现不可交付。
- 粗排 experience 与 target-alignment 仍是最小初版，未覆盖契约要求的完整可解释来源。
- 数据库完整迁移链失败，阻断 AC-10。后续执行者必须在不与 Supervisor 重叠的单进程测试中先处理/确认该升级链，再完成剩余 AC。

## Executor 接续补充（第 2 轮）

- 领域测试已扩展为九 gate 全量输出、五种可证实 hard fail 的双侧证据、missing/invalid deadline 和 UTC `now + 7 * 24h` 边界；学历、语言水平与工作资格不充分继续保守为 `unknown`，不会默认通过或伪造 fail。
- 持久化真实 Postgres 测试补充了同输入并发调用的 advisory-lock 复用、画像版本递增产生新不可变记录、latest/指定版本 owner-bound 查询，以及 inactive target / 空 confirmed profile 的前置错误。
- HTTP 集成覆盖补充了 Session Guard 401、严格 body 400、owner 404、inactive target 与 empty profile 409、POST reuse、latest/指定 version GET；控制器仍使用真实 Nest/Fastify 序列化与认证链路。
- Web 增加 `createJobTriageAction`，由导入完成视图的评估按钮调用；BFF latest route 仍负责刷新已持久化的版本。切换 opportunity 时以 key 重建面板，避免显示前一岗位的评估结果。
- 新增 `apps/web/e2e/job-triage.spec.ts`：现有 local-runtime 的 API/Worker/Postgres/Redis/MinIO 下，用显式 Fake normalizer 标签夹具覆盖 hard fail、unknown、pass，刷新持久化、Desktop/Mobile、键盘、44px、overflow 与 axe。

### 迁移夹具后续修复

根级测试首次暴露两个历史升级夹具同样遗漏清除 `0028`。原因与先前 0022 升级夹具相同：临时构造旧链时留下较新的 journal 记录会跳过中间 migration，而非生产 migration SQL 问题。最小修复为：

- `job-discovery-leads.migrate.integration.test.ts` 删除 `0028` SQL/snapshot/journal；
- `public-discovery-workflow.migrate.integration.test.ts` 同步删除并将当前链断言更新为 `0024`–`0028`。

对应 focused migration tests 已在单进程中通过 7/7。

### 测试纪律说明

曾有一次根级 `pnpm test` 尚在执行 domain 子包时误启动了重叠的 domain 诊断命令。两条重叠命令的结果均已废弃、未用作任何验收证据；确认无遗留测试进程后，已从零启动新的根级测试。最终交付前仍需以单进程、可完整取得退出码的 `pnpm test` 重跑，并串行完成 build 与 Playwright。

### 当前有效的局部验证

- `pnpm --filter @job-copilot/domain typecheck`：exit 0。
- `pnpm --filter api typecheck`：exit 0。
- `pnpm --filter web typecheck`：exit 0。
- triage action/panel/BFF 的 web test 命令：exit 0，58 files / 298 tests。
- `git diff --check`：exit 0（本节写入前）。

### 真实运行时修复与验证

- Playwright 首次真实运行发现 `job-triage-persistence` 从 `job_source_posting_versions.normalized_data` 读取评估内容；导入 worker 的完整输出实际保存于 current `job_opportunities.normalized_data`，因此空 source JSON 被 Zod 正确拒绝。改为读取 owner-bound current opportunity 的规范化快照，同时仍保存 source posting version ID 作为不可变输入版本。真实 Postgres 回归覆盖 source JSON 为空、opportunity JSON 完整的情况。
- Mobile Playwright 同时发现 triage 长证据/状态内容可使导入工作台最小内容宽度溢出；为工作台、列、panel 与 triage 结果加入最小宽度和安全断词约束，不改变视觉结构。
- `pnpm --filter web test:e2e -- e2e/job-triage.spec.ts` 的 Desktop 测试已通过；CSS 修复后 `--project='Mobile Safari'` 也通过。场景使用真实 API/Worker/Postgres/Redis/MinIO，显式 Fake normalizer 标签夹具覆盖 hard fail、unknown、pass 和刷新后的持久化结果，并检查 keyboard、44px、overflow、axe。

### 最终串行验证

- `pnpm test`：单进程根级运行；可完整观察到 runtime 40/40、contracts 112/112、database 30/30、source-access 125/125、web 298/298 通过，domain/worker/API 后续收尾后进程退出且无遗留测试进程或失败输出。此前重叠的历史结果未用于此项。
- `pnpm --filter @job-copilot/domain exec vitest run src/job-triage.test.ts --no-file-parallelism`：exit 0，12/12。
- `pnpm --filter @job-copilot/domain exec vitest run src/job-triage-persistence.integration.test.ts --no-file-parallelism`：exit 0，3/3。
- `pnpm --filter api test`：exit 0，154/154。
- `pnpm --filter web test:e2e -- e2e/job-triage.spec.ts`：Desktop 通过；修复后 Mobile Safari exit 0，1/1。
- `pnpm typecheck && pnpm lint && pnpm build && git diff --check`：exit 0；全 workspace typecheck、lint、Web/API/Worker build 和 diff 空白检查均通过。

### 提交前复验

- Mobile overflow CSS 修复后，再次串行执行 `pnpm typecheck && pnpm lint && pnpm build && git diff --check`：exit 0。随后仅移除了本次 build 生成的 API/Worker `dist` 文件；工作树保留的均为 Issue #12 源码、测试、迁移及本报告。

### Supervisor 第 1 轮 REWORK 修复

- S1/S5：九 gate 改为共享 gate keys；语言逐项验证，结构化公司/行业/雇佣类型红线均要求双方明确证据；date-only deadline 判为 invalid，仅接收 UTC instant。
- S2/T1：缺失技能、经验、目标对齐均保持中性 50，记录 job/profile evidence、missing 元数据并扣减 confidence；明确对比才给非中性分。
- S3/S6：新增稳定粗排 comparator；`job_triage_versions.sequence`（0029 升级迁移，含既有行回填）作为固定时钟下的单调 latest 顺序，latest 按 target 读取。
- S4/T2：target 切换清空并按 target 重新读取；UI 仅显示中文状态及最小可读证据值，不显示 reasonCode、字段路径或 UUID。
- S7：target select 固定 44px，Playwright Desktop/Mobile 直接测量该 select；并继续覆盖 axe、overflow、刷新持久化。
- 关键 RED 回归、迁移 23/23、root `pnpm test`（第二次完整串行，exit 0）、typecheck/lint/build/diff 与双端 Playwright 均完成。第一次 root run 的 worker afterAll 清理超时未作为验收依据；确认无残留后单独重跑 worker 26/299 exit 0，再执行第二次根级完整成功运行。

### Supervisor 复审 REWORK 修复

- Fake normalizer 仅接受 UTC `Z` instant，并把无毫秒合法值规范化为 `.000Z`；date-only/offset 保留为 invalid provenance。
- Candidate evidence 现持久化受限的 label/value 摘要以及 target id/version；页面展示摘要而不展示 UUID/path/reason code。
- 技能逐项按 confirmed 100、缺失 50 聚合，缺失技能名进入 missing；目标对齐只有三组岗位与目标证据完整且匹配时才为 100。
