# Issue #12 执行报告

## 基线、提交链与范围

- 固定基线：`b297dbaf8e61433f038e8a433dfab429f1f88aae`。
- 最终提交链包含：`905accb`（确定性 triage 工作流）、`b17d826`（首轮审查修复）、`c2002bc`（证据审查修复）以及本提交（R1 九 gate 回归矩阵与本报告）。
- 最终 diff 限于 Issue #12 的 contracts、database migration/schema、domain、worker Fake normalizer、API、Web、端到端/集成测试与本报告；没有 push、PR、merge、关闭 Issue 或启动下一 Issue。
- 本报告替换旧接续草稿；不保留“未完成”“BLOCKED”或下一动作结论。

## 设计裁决

1. 九 gate 固定为 `location`、`work_mode`、`relocation`、`salary`、`seniority`、`education`、`language`、`work_eligibility`、`deal_breakers`；总体 verdict 仅由这些 gate 聚合。
2. 只有现有结构化模型能同时给出岗位侧明确要求与候选/目标侧明确反证时，gate 才能 `fail`，且结果必须同时保存 `jobEvidence` 与 `candidateEvidence`。
3. 学历、语言等级、工作资格的不同事实不能安全地推出否定结论：没有层级/互斥解析器时一律 `unknown`，不伪造 hard fail。语言逐项验证全部岗位要求。
4. 目标的 `salary: null` 与 `seniority: null` 是 contracts 明确表达的“无此限制”，不是缺失证据；因此保持 `SALARY_MINIMUM_NOT_SET` / `SENIORITY_NOT_RESTRICTED` 的 `pass`。可比较但币种/周期不一致的薪资，或 `relocation: unknown`，才是 `unknown`。
5. 公司、行业、雇佣类型红线均有结构化 hard-fail 路径；`dealBreakers.other` 没有可比较的岗位字段，故保守为 `unknown`。

## AC 实现映射

| AC | 实现与证据 |
| --- | --- |
| AC-01 | `packages/domain/src/job-triage.ts` 产出九 gate、三态 verdict 与 pending；R1 `job-triage.test.ts` 的表驱动矩阵逐项覆盖 pass、岗位侧缺失、候选侧不足及可表达 fail。 |
| AC-02 | 仅全 gate pass 且未过期时计算粗排；DB `job_triage_versions_score_verdict_check` 禁止 fail/unknown/expired 携带评分。 |
| AC-03 | hard fail 均由岗位与目标/画像双侧最小证据支撑；真实持久化、API 与 Web 读取为 owner-bound。 |
| AC-04 | 缺失/无效截止日期独立为 pending，UTC 七天边界得到领域回归覆盖。 |
| AC-05 | `job_triage_versions` 以输入版本和规则版本幂等；advisory lock 并发复用，同一画像版本变化创建新的不可变版本。 |
| AC-06 | `sequence`（0029）提供稳定 latest/rank 次序；closing-soon 在分数相同下优先。 |
| AC-07 | Nest controller/module 提供 POST、latest 与指定版本 GET；API 集成覆盖认证、输入、owner、inactive/empty profile 与复用。 |
| AC-08 | Web action、同源 no-store BFF、triage panel 与导入完成视图已接通；真实 Desktop Chrome、Mobile Safari 都覆盖 hard fail、unknown、pass 与刷新。 |
| AC-09 | Fake normalizer 只接受显式标签并保留最小 provenance；审计写入严格 allowlist，不保存岗位/画像原文。 |
| AC-10 | 0028/0029 与三类历史升级夹具均在完整 migration focused suite 通过；根级测试、typecheck、lint、build、双端 E2E 均以本报告列出的新鲜串行命令通过。 |

## TDD 证据

早期切片的已落地 RED→GREEN 记录：contracts qualification（模块/strict schema）、数据库 0028 triage versions、worker Fake normalizer、domain gate/ranking、持久化命令/查询、API triage 路由、Web client/BFF/action/panel 均先以对应模块缺失、契约拒绝或行为断言失败建立 RED，再以最小实现转绿。

R1 的新增表驱动矩阵先在现有 15 个领域测试基础上写入 42 个场景并运行：首次 RED 为 2 个断言（salary 与 seniority 目标为 `null` 时返回 pass）。根因核验显示 `JobTargetConstraintsSchema` 将这两个字段声明为 nullable，用于显式“不设限制”；持久化集成夹具也依赖此语义。因此没有保留临时生产代码改动，而是：

- 薪资“不足”用已结构化但币种不一致的目标下限验证 `unknown`；
- 资历 `null` 在矩阵中显式记录为“明确不限制”，回归断言 `pass`；
- 学历、语言等级、工作资格不同事实继续断言 `unknown`，明确记录不具备可安全 fail 的模型。

最终 R1 GREEN：`pnpm --filter @job-copilot/domain exec vitest run src/job-triage.test.ts src/job-triage-persistence.integration.test.ts --no-file-parallelism`，exit 0，46/46；`pnpm --filter @job-copilot/domain typecheck`，exit 0。

## 两轮审查发现与修复映射

- 首轮审查：统一 gate keys；语言逐项验证；公司/行业/雇佣类型 hard fail 要求双侧证据；date-only deadline 判 invalid；粗排缺失证据保持中性；稳定 comparator 和 `sequence`；target 切换重读；UI 脱敏、44px 与双端可访问性。
- 复审：Fake normalizer 只接受 UTC `Z` instant 并规范化；候选证据保存受限 label/value 摘要和目标版本；页面不展示 UUID/path/reason code；技能逐项 100/50 聚合；目标对齐仅在三组完整匹配时为 100。
- R1：将此前零散的领域断言收敛为九 gate 明确矩阵，并修正了测试对 nullable “不限制”语义的错误预期；没有扩大生产实现范围。

## 新鲜串行验收

所有下列命令在开始前确认没有残留 `pnpm`、Vitest、Playwright、Next 或 Nest 测试进程；未与 Supervisor 或其他测试重叠。

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @job-copilot/contracts exec vitest run src/job-imports.test.ts src/job-triage.test.ts --no-file-parallelism` | exit 0，7/7 |
| `pnpm --filter worker exec vitest run src/job-imports/fake-job-posting-normalizer.test.ts --no-file-parallelism` | exit 0，5/5 |
| `pnpm --filter @job-copilot/domain exec vitest run src/job-triage.test.ts src/job-triage-persistence.integration.test.ts --no-file-parallelism` | exit 0，46/46 |
| `pnpm --filter @job-copilot/database exec vitest run src/migrate.integration.test.ts src/job-discovery-leads.migrate.integration.test.ts src/public-discovery-workflow.migrate.integration.test.ts --no-file-parallelism` | exit 0，30/30 |
| `pnpm --filter api exec vitest run src/api.integration.test.ts --no-file-parallelism` | exit 0，44/44 |
| Web triage panel/BFF/action 四个测试文件 | exit 0，11/11 |
| `pnpm --filter web test:e2e -- e2e/job-triage.spec.ts --project='Desktop Chrome'` | exit 0，1/1，真实本地 runtime |
| `pnpm --filter web test:e2e -- e2e/job-triage.spec.ts --project='Mobile Safari'` | exit 0，1/1，真实本地 runtime |
| `pnpm test` | exit 0；runtime 40、contracts 112、database 30、source-access 125、web 298、domain 418、API 308、worker 299 |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm build` | exit 0 |

build 后确认 `apps/api/dist/` 与 `apps/worker/dist/` 均未跟踪，仅为本次生成物，已移出工作树；随后 `git diff --check b297dbaf8e61433f038e8a433dfab429f1f88aae..HEAD` 为 exit 0，且未发现残留测试进程。

## 测试并发事故说明与残余风险

历史上曾在一次根级 `pnpm test` 尚运行时误启动重叠 domain 诊断命令；该两项结果已废弃，未作为本报告任何验收依据。另一次根级运行的控制台在进程完成前被截断，也已废弃。上表的第二次根级 `pnpm test` 通过保留会话取得完整精确 exit 0，是唯一根级验收依据。

残余风险：学历、语言等级、工作资格与 `dealBreakers.other` 仍没有可证明的否定/层级模型，因此产品故意返回 `unknown` 而不是 `fail`；若未来需要 hard fail，必须先扩展结构化契约和领域规则，并以新的 RED→GREEN 测试证明。
