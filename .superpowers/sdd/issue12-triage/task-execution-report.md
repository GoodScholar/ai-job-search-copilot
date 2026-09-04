# Issue #12 执行报告

## 基线、提交链与范围

- 固定基线：`b297dbaf8e61433f038e8a433dfab429f1f88aae`；本轮开始 HEAD：`9ec1f505880313c33438b8215e2ddb95ba2270bf`。
- 本 Issue 提交链：`905accb`（确定性 triage 工作流）、`b17d826`（首轮审查修复）、`c2002bc`（证据审查修复）、`8cf388f`（R1 九 gate 矩阵）、`0536bb3`（证据上下文加固）、`9ec1f50`（首轮 closeout）和本次 closeout 提交。
- 本次 diff 仅涉及 triage contracts/domain 及其 domain、persistence、HTTP API、Web 回归测试和本报告；未 push、PR、merge、关闭 Issue 或启动下一 Issue。

## 最终设计裁决

1. `EvidenceGapSchema` 是 contracts 导出的共享判别联合体，domain 直接使用 `EvidenceGap`，不再以私有模板字符串表达缺口。
2. 技能缺口以 `{ kind: "profile_skills", count, examples }` 对外投影：`count` 保留全部 1–100 条缺口，`examples` 最多 20 条且顺序稳定。技术分数仍由所有 required skills 计算；置信度以 `count` 扣减，绝不以截断后的数组长度扣减。
3. `JOB_TRIAGE_MAX_EVIDENCE_ITEMS = 20`、岗位证据值 512、候选/目标证据值 256 均由 contracts 定义并由 domain 复用。统一摘要是确定性的前缀加 `…`，保留原有 ID、version、field、path 追溯字段；UI 只显示 label/value，不显示内部 path、reason code 或 UUID。
4. 最大输入按冻结 contracts 构造：required skills 单项最长 128、最多 100，但其原始 evidence.value 最多 512；持久化 100 条回归使用 4 字符技能名（连同分隔符 499 字符），因此是合法输入。岗位 title 则以精确 20,000 字符测试。
5. 九 gate 保持既有保守语义：仅结构化、双侧可证明冲突才 `fail`；学历、语言等级、工作资格和 `dealBreakers.other` 缺乏否定模型时仍为 `unknown`。

## 本轮 AC/实现映射

| 项目 | 实现与回归 |
| --- | --- |
| A：100 技能缺口 | contracts/schema、domain、PostgreSQL persistence 和真实 HTTP 都覆盖 21、100 条全部未匹配 skills；断言技术分数 50、置信度 0、`count` 为全量、公开 `missing` 有界且 schema parse 成功。 |
| B：最大证据字段 | domain/persistence 覆盖 20 个最大 locations、industries、excludedCompanies 和 20,000 字符 title；岗位/目标证据分别严格为 512/256。HTTP serializer 与 Web component 回归确认稳定可读返回且不暴露内部字段。 |
| C：共享契约 | contracts 导出 `EvidenceGapSchema`、`EvidenceGap` 和统一上限常量；domain 导入并用于 projection、candidate evidence slice 与置信度计数。 |
| 原 Issue 资格规则 | R1 表驱动矩阵仍覆盖九 gate 的 pass、缺岗位/候选证据的 unknown、可表达 hard fail 的双侧证据，以及学历/语言/工作资格的保守 unknown。 |

## TDD RED→GREEN

- RED：新的 contracts 回归传入结构化 `missing` 时被旧字符串数组拒绝，且 `EvidenceGapSchema` 不存在；domain 21/100 未匹配 skills 原本会生成 21/100 条 `missing`，超过 20 条响应上限。
- GREEN：以共享结构化 gap 取代字符串、在 domain 聚合全部缺口并仅投影前 20 示例；`evidenceGapCount` 使用 full `count` 计算置信度。
- RED：最大 locations/industries/deal-breakers 拼接和 title 直接复制可突破 256/512；domain 回归断言失败。
- GREEN：统一 `summarizeEvidence` 被岗位直接字段、qualification evidence、目标约束和 profile facts 复用，保持原追溯元数据不变。
- 持久化 RED 调试中，首次 100 条长中文技能和重复中文 title 实际超出冻结输入 contracts（evidence 512、title 20,000），因此修正测试数据为合法最大构造；不是生产实现缺陷。最终 persistence/HTTP 均 schema parse。

## 两轮审查发现与修复映射

- 第一轮：统一 gate、语言逐项验证、双侧 hard fail 证据、date-only 无效、稳定排序/sequence、target 切换、UI 脱敏与双端可访问性。
- 第二轮：Fake normalizer UTC round-trip、候选/目标最小证据、页面不展示 UUID/path/reason code、技能 100/50 聚合、完整目标对齐条件。
- 本轮 REWORK：补齐“全部未匹配 required skills 使公开 `missing` 超过 contracts 上限”及“合法最大文本使 evidence.value 越界”两个规格缺口，以共享 contracts 类型和唯一摘要函数完成最小修复。

## 新鲜串行验收

开始前和结束后均确认无残留 `pnpm`、Vitest、Playwright、Next 或 Nest 进程；以下命令未与 Supervisor 或彼此重叠。

| 命令 | exit / 用例 |
| --- | --- |
| `pnpm --filter @job-copilot/contracts exec vitest run src/job-imports.test.ts src/job-triage.test.ts --reporter=verbose` | 0，8/8 |
| `pnpm --filter worker exec vitest run src/job-imports/fake-job-posting-normalizer.test.ts --reporter=verbose` | 0，7/7 |
| `pnpm --filter @job-copilot/domain exec vitest run src/job-imports.test.ts src/job-imports.integration.test.ts src/job-triage.test.ts src/job-triage-persistence.integration.test.ts --reporter=dot` | 0，77/77 |
| `pnpm --filter @job-copilot/database exec vitest run src/migrate.integration.test.ts src/job-discovery-leads.migrate.integration.test.ts src/public-discovery-workflow.migrate.integration.test.ts --reporter=dot` | 0，30/30（含 0028/0029 与历史升级 fixture） |
| `pnpm --filter api exec vitest run src/api.integration.test.ts --reporter=dot` | 0，48/48 |
| `pnpm --filter web exec vitest run components/workbench/job-triage-panel.test.tsx 'app/(workbench)/jobs/import/actions.test.ts' 'app/(workbench)/jobs/import/page.test.tsx' 'app/api/job-opportunities/[opportunityId]/triage-versions/route.test.ts' lib/server/job-triage.test.ts --reporter=dot` | 0，14/14 |
| Desktop Chrome Playwright（真实本地 runtime） | 0，1/1 |
| Mobile Safari Playwright（真实本地 runtime） | 0，1/1 |
| `pnpm test`（从零、单进程会话） | 0；runtime 40、contracts 113、database 30、source-access 125、web 299、domain 429、worker 316、API 301 |
| `pnpm typecheck` | 0 |
| `pnpm lint` | 0 |
| `pnpm build` | 0 |

build 后先以 `git status --short` 确认只有未跟踪的 `apps/api/dist/`、`apps/worker/dist/`，随后精确移出工作树。`git diff --check b297dbaf8e61433f038e8a433dfab429f1f88aae..HEAD` 与最终工作树 diff 检查均应为 0。

## 测试并发事故与残余风险

历史上曾有重叠测试和一次控制台截断的根级运行；两者均已废弃，未作为本报告验收依据。本报告仅采用上述本轮串行命令，其中根级 `pnpm test` 由可续接会话取得完整 exit 0。

残余风险是产品刻意的保守边界：学历、语言等级、工作资格和自由文本其他红线没有可证明的反证/层级模型，故返回 `unknown` 而非猜测 `fail`。未来若需要 hard fail，必须先扩展结构化 contracts 和新 RED→GREEN 回归。
