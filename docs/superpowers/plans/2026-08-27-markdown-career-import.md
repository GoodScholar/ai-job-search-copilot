# Markdown 职业资料导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 Issue #3 的完整产品纵切：目标求职者上传 Markdown 职业资料，独立 Worker 通过确定性 Fake Parser 生成带可定位证据的待确认候选事实，并在 `/profile` 与工作台中恢复、展示真实状态。

**Architecture:** PostgreSQL 是导入状态和候选事实的权威来源，MinIO 保存原始 Markdown，BullMQ 使用 `importId` 作为确定性 `jobId` 驱动独立 NestJS Worker。API 负责上传校验、账户所有权、幂等创建和查询；Worker 只通过窄端口读取原文、解析并原子写入；Next.js RSC 负责首次读取，Client Component 只负责上传状态和 1 秒短轮询。

**Tech Stack:** Node.js `>=22.22.2`（执行环境使用工作区 Node `24.19.0`）、pnpm `11.5.2`、Next.js `16.3.2`、React `19.2.8`、NestJS `11.2.3`、Fastify `5.12.1`、`@fastify/multipart` `10.1.1`、BullMQ `6.2.2`、PostgreSQL、Drizzle ORM `0.45.2`、Redis、MinIO SDK `8.0.6`、Zod `4.4.3`、Vitest `4.1.11`、Testcontainers `12.1.0`、Playwright `1.62.1`。

**Spec:** `docs/superpowers/specs/2026-08-27-markdown-career-import-design.md`；父规格为 GitHub Issue #1，执行 Ticket 为 GitHub Issue #3。

## Global Constraints

- 只实现 Issue #3；不实现候选事实确认、修改、拒绝、主要求职画像版本、DOCX、PDF、冲突处理、真实模型 Adapter 或 SSE。
- 原始输入只接受单个 UTF-8 `.md` 文件；最大原始字节数固定为 `524288`，拒绝非法 UTF-8、NUL 和仅含空白的内容。
- 接受 `text/markdown`、`text/plain`；空 MIME 与 `application/octet-stream` 只有在扩展名和内容检查同时通过时接受。
- MinIO bucket 固定为私有 `career-documents`，对象 key 固定为 `accounts/{userId}/career-documents/{documentId}/source.md`，不得包含原始文件名。
- PostgreSQL 是业务状态唯一权威来源；Redis 只保存 BullMQ 任务，任务载荷不得包含 Markdown、文件名、证据或联系方式。
- 状态只允许 `queued | processing | completed | failed`；完成状态不可逆，失败重排回到 `queued`，重复上传命中 `queued` 或 `processing` 均执行确定性 `jobId` 幂等补发。这是在没有 Outbox 或恢复扫描器时的用户触发恢复语义；`processing` 成功补发仍返回当前 `200`，Redis 不可用时维持现有失败响应与数据库状态。
- Fake Parser 固定为 `fake-career-parser-v1`，提示词版本固定为 `career-import-prompt-v1`，输出 Schema 固定为 `career-facts-v1`。
- 候选事实类型只允许 `experience | education | skill | project | language | achievement | certification`，本切片确认状态固定为 `pending`。
- 单次导入最多 500 条候选事实；第 501 条以 `CAREER_IMPORT_FACT_LIMIT_EXCEEDED` 全单稳定失败、零部分写入。这是针对不可信内容和单消费者资源的硬边界，不静默截断。
- 只保存 `grounding: quoted` 且 Markdown 行号、片段和值均可验证的事实；推断、缺少证据、越界、未知字段和非法值不得进入数据库。
- 日志与审计不得包含正文、文件名、对象 key、证据片段、联系方式、完整校验和或完整 Parser 输入输出。
- Web 使用中文产品语言，状态不能只靠颜色表达，交互控件最小高度 `44px`，支持键盘、可见焦点、Desktop Chrome、Mobile Safari 和 WCAG AA 基线。
- 实现 Web 前阅读 `apps/web/AGENTS.md`、`apps/web/node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`、`apps/web/node_modules/next/dist/docs/01-app/02-guides/forms.md`、`apps/web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`。
- 测试不访问真实模型，不使用 SQLite、内存队列或本地文件替代生产数据语义；领域与 HTTP 单测可以注入窄 Fake port。
- 每个任务严格执行红 → 最小实现 → 绿；任务验收通过后只提交该任务列出的文件。
- 用户所有的未跟踪 `.superpowers/` 不得添加、删除、移动或格式化。
- 执行开始时运行 `IMPLEMENT_BASE=$(git rev-parse HEAD)` 并保存该值；最终双轴审查使用 `git diff "$IMPLEMENT_BASE"...HEAD`。

## File Structure

- `packages/contracts/src/career-import.ts`：HTTP DTO、候选事实判别联合、Parser 输出、BullMQ 任务和常量的唯一共享契约。
- `packages/database/src/schema.ts`、`packages/database/migrations/0002_career_imports.sql`：职业资料、导入、候选事实和证据表及约束。
- `packages/domain/src/career-imports.ts`：创建/复用、查询、状态转换、证据验证和原子完成；同时定义对象存储、队列和 Parser 窄端口。
- `apps/api/src/career-import/`：multipart 边界、认证 Controller、MinIO writer、BullMQ producer 与 Nest 组合根。
- `apps/worker/src/career-import/`：Fake Parser、MinIO reader、BullMQ consumer 与 Nest 组合根。
- `apps/web/app/(workbench)/profile/`：认证 RSC 页面与上传 Server Action。
- `apps/web/app/api/career-imports/[importId]/route.ts`：Client Component 使用的同源轮询 BFF。
- `apps/web/components/workbench/profile-import-view.tsx`：文件选择、上传状态、事实和证据展示。

---

### Task 1: 锁定职业资料导入共享契约

**Files:**
- Create: `packages/contracts/src/career-import.ts`
- Create: `packages/contracts/src/career-import.test.ts`
- Modify: `packages/contracts/package.json`

**Interfaces:**
- Consumes: Zod `4.4.3`。
- Produces: `CareerImportStatusSchema`、`CandidateFactSchema`、`CareerImportSummarySchema`、`CareerImportListSchema`、`CareerImportDetailSchema`、`CreateCareerImportResponseSchema`、`CareerParserOutputSchema`、`CareerImportJobSchema`、推导类型与版本/队列常量。

- [ ] **Step 1: 写严格契约失败测试**

```ts
import { describe, expect, it } from "vitest";
import {
  CAREER_DOCUMENT_MAX_BYTES, CAREER_IMPORT_JOB_NAME, CAREER_IMPORT_QUEUE,
  CareerImportJobSchema, CareerParserOutputSchema, CandidateFactSchema,
} from "./career-import";

describe("career import contracts", () => {
  it("locks size, queue and task protocol", () => {
    expect(CAREER_DOCUMENT_MAX_BYTES).toBe(524_288);
    expect(CAREER_IMPORT_QUEUE).toBe("career-imports");
    expect(CAREER_IMPORT_JOB_NAME).toBe("parse-career-document");
    expect(CareerImportJobSchema.parse({ version: 1, importId: crypto.randomUUID(), userId: crypto.randomUUID() }))
      .toMatchObject({ version: 1 });
  });

  it("rejects unknown parser and fact fields", () => {
    expect(() => CareerParserOutputSchema.parse({
      adapter: "fake", parserVersion: "fake-career-parser-v1",
      promptVersion: "career-import-prompt-v1", outputSchemaVersion: "career-facts-v1",
      facts: [], rawMarkdown: "secret",
    })).toThrow();
    expect(() => CandidateFactSchema.parse({
      factId: crypto.randomUUID(), factType: "skill", factValue: { name: "TypeScript", level: "inferred" },
      confidenceBasisPoints: 10_000, confirmationStatus: "pending", createdAt: new Date().toISOString(),
      evidence: { documentId: crypto.randomUUID(), sourceFilename: "resume.md", locatorType: "markdown_lines", startLine: 1, endLine: 1, excerpt: "- TypeScript" },
    })).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `pnpm --filter @job-copilot/contracts test -- career-import.test.ts`

Expected: FAIL，`./career-import` 尚不存在。

- [ ] **Step 3: 实现严格判别联合与 DTO**

```ts
const namedValue = z.object({ name: z.string().trim().min(1).max(500) }).strict();
const summaryValue = z.object({ summary: z.string().trim().min(1).max(2_000) }).strict();
const languageValue = z.object({
  name: z.string().trim().min(1).max(200),
  level: z.string().trim().min(1).max(200).optional(),
}).strict();

export const CareerParserFactSchema = z.discriminatedUnion("factType", [
  parserFact("skill", namedValue), parserFact("certification", namedValue),
  parserFact("language", languageValue), parserFact("experience", summaryValue),
  parserFact("education", summaryValue), parserFact("project", summaryValue),
  parserFact("achievement", summaryValue),
]);
```

共同字段固定为 `confidenceBasisPoints: z.int().min(0).max(10_000)`、`grounding: z.literal("quoted")`；证据固定为 `locatorType: "markdown_lines"` 和从 1 开始的闭区间。所有 object 使用 `.strict()`，日期使用 `z.iso.datetime()`。

```ts
export const CAREER_DOCUMENT_MAX_BYTES = 524_288;
export const CAREER_IMPORT_MAX_FACTS = 500;
export const CAREER_IMPORT_QUEUE = "career-imports";
export const CAREER_IMPORT_JOB_NAME = "parse-career-document";
export const CareerImportJobSchema = z.object({
  version: z.literal(1), importId: z.uuid(), userId: z.uuid(),
}).strict();
```

- [ ] **Step 4: 覆盖七类事实、失败码和响应结构**

使用 `it.each` 对七类合法值逐一 `parse`；断言非法类型、置信度、`inferred`、`startLine > endLine`、响应未知字段、任务正文与文件名字段全部失败。导入失败码只允许：

```ts
[
  "CAREER_IMPORT_QUEUE_UNAVAILABLE", "CAREER_DOCUMENT_NOT_FOUND",
  "CAREER_DOCUMENT_READ_FAILED", "CAREER_DOCUMENT_CHECKSUM_MISMATCH",
  "CAREER_IMPORT_FACT_LIMIT_EXCEEDED",
  "CAREER_PARSER_OUTPUT_INVALID", "CAREER_PARSER_EVIDENCE_INVALID",
  "NO_SUPPORTED_FACTS", "CAREER_IMPORT_PERSIST_FAILED",
]
```

- [ ] **Step 5: 暴露 subpath 并验证绿灯**

在 `packages/contracts/package.json` 添加 `"./career-import": "./src/career-import.ts"`。

Run:

```bash
pnpm --filter @job-copilot/contracts test -- career-import.test.ts
pnpm --filter @job-copilot/contracts typecheck
```

Expected: PASS。

- [ ] **Step 6: 提交共享契约**

```bash
git add packages/contracts
git commit -m "feat: define career import contracts (#3)"
```

---

### Task 2: 持久化职业资料、导入、候选事实与证据

**Files:**
- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/migrations/0002_career_imports.sql`
- Modify: `packages/database/migrations/meta/_journal.json`
- Create: `packages/database/migrations/meta/0002_snapshot.json`
- Modify: `packages/database/src/migrate.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 的状态、事实类型和长度边界。
- Produces: `careerDocuments`、`careerImports`、`candidateFacts`、`candidateFactEvidence` Drizzle 表对象及数据库约束。

- [ ] **Step 1: 扩展迁移失败测试**

```ts
it("migrates account-owned career imports and evidence", async () => {
  expect(await listPublicTables(migratedDatabase)).toEqual(expect.arrayContaining([
    "career_documents", "career_imports", "candidate_facts", "candidate_fact_evidence",
  ]));
  const constraints = await migratedDatabase.execute(sql`
    select conname from pg_constraint where conname in (
      'career_documents_user_checksum_unique', 'career_imports_document_versions_unique',
      'candidate_facts_import_fact_key_unique', 'candidate_fact_evidence_fact_unique'
    ) order by conname
  `);
  expect(constraints).toHaveLength(4);
});
```

加入 SQL 插入断言：跨账户相同 checksum 可以写入；同账户相同 checksum 返回 `23505`；越界 `byte_size`、置信度、行号和非法状态返回 `23514`。

- [ ] **Step 2: 运行迁移测试并确认红灯**

Run: `pnpm --filter @job-copilot/database test -- migrate.integration.test.ts`

Expected: FAIL，四张表或约束不存在。

- [ ] **Step 3: 添加 Drizzle Schema**

```ts
unique("career_documents_user_checksum_unique").on(table.userId, table.checksumSha256)
unique("career_imports_document_versions_unique").on(
  table.careerDocumentId, table.parserVersion, table.promptVersion, table.outputSchemaVersion,
)
unique("candidate_facts_import_fact_key_unique").on(table.careerImportId, table.factKey)
unique("candidate_fact_evidence_fact_unique").on(table.candidateFactId)
```

逐列实现设计文档“数据模型”章节列出的字段、可空性和时间戳。`original_filename` 为 `varchar(255)`、`object_key` 为 `varchar(512)`、`fact_value` 为 `jsonb`、`excerpt` 为 `text`；四表都有 `user_id` 外键。使用具名 `check(...)` 锁定状态、事实类型、`pending`、SHA-256 格式、`byte_size between 0 and 524288`、`confidence_basis_points between 0 and 10000`、`start_line >= 1`、`end_line >= start_line`。

- [ ] **Step 4: 生成并审查迁移**

Run: `pnpm --filter @job-copilot/database exec drizzle-kit generate --config=drizzle.config.ts --name=career_imports`

Expected: 生成编号 `0002` 的迁移和 journal；不得删除或重建 Issue #2 表。

- [ ] **Step 5: 验证迁移绿灯和类型**

```bash
pnpm --filter @job-copilot/database test -- migrate.integration.test.ts
pnpm --filter @job-copilot/database typecheck
```

Expected: PASS。

- [ ] **Step 6: 提交数据模型**

```bash
git add packages/database
git commit -m "feat: persist career import records (#3)"
```

---

### Task 3: 实现确定性 Fake Parser v1

**Files:**
- Create: `apps/worker/src/career-import/fake-career-document-parser.ts`
- Create: `apps/worker/src/career-import/fake-career-document-parser.test.ts`

**Interfaces:**
- Consumes: `CareerParserOutputSchema`；输入为 UTF-8 Markdown 字符串。
- Produces: `FakeCareerDocumentParser.parse(markdown: string): Promise<unknown>`。

- [ ] **Step 1: 写合成简历精确解析失败测试**

```ts
const resume = [
  "# 张三", "邮箱：secret@example.test", "## 工作经历",
  "- AI 应用工程师｜示例科技｜2024-至今", "## 技能", "- TypeScript", "- React",
  "## 教育经历", "- 示例大学｜计算机科学｜2020", "## 项目经历",
  "- Job Copilot：构建证据驱动的求职工作流", "## 语言", "- 英语：专业工作水平",
  "## 成果", "- 将解析耗时降低 35%", "## 联系方式", "- 电话：13800000000",
].join("\n");

it("extracts only supported quoted facts with exact lines", async () => {
  const output = CareerParserOutputSchema.parse(await new FakeCareerDocumentParser().parse(resume));
  expect(output.facts).toEqual(expect.arrayContaining([
    expect.objectContaining({ factType: "skill", factValue: { name: "TypeScript" }, evidence: expect.objectContaining({ startLine: 6, endLine: 6, excerpt: "- TypeScript" }) }),
    expect.objectContaining({ factType: "language", factValue: { name: "英语", level: "专业工作水平" }, evidence: expect.objectContaining({ startLine: 13 }) }),
    expect.objectContaining({ factType: "achievement", factValue: { summary: "将解析耗时降低 35%" }, evidence: expect.objectContaining({ startLine: 15 }) }),
  ]));
  expect(JSON.stringify(output)).not.toContain("secret@example.test");
  expect(JSON.stringify(output)).not.toContain("13800000000");
});
```

- [ ] **Step 2: 运行 Parser 测试并确认红灯**

Run: `pnpm --filter worker test -- fake-career-document-parser.test.ts`

Expected: FAIL，Parser 类不存在。

- [ ] **Step 3: 实现最小章节状态机**

使用按 `\n` 保留行号的单次扫描，不引入 Markdown AST。只识别 `#{1,6}` 标题；章节别名固定为：

```ts
const sectionAliases = new Map([
  ["技能", "skill"], ["skills", "skill"], ["technical skills", "skill"],
  ["工作经历", "experience"], ["工作经验", "experience"], ["experience", "experience"], ["work experience", "experience"],
  ["教育", "education"], ["教育经历", "education"], ["education", "education"],
  ["项目", "project"], ["项目经历", "project"], ["projects", "project"],
  ["语言", "language"], ["languages", "language"],
  ["成果", "achievement"], ["主要成果", "achievement"], ["achievements", "achievement"],
  ["证书", "certification"], ["认证", "certification"], ["certifications", "certification"],
]);
```

进入受支持章节后，只抽取 `-`、`*`、`+` 或 `1.`/`1)` 开头的列表项；同级或更高标题退出章节，更深标题作为该章节的一条明确事实。技能/证书使用 `{ name }`，语言只在明确的中英文冒号处分成 `{ name, level }`，其余类型使用 `{ summary }`。直接引用置信度固定 `10000`，excerpt 保留原始整行。

- [ ] **Step 4: 补拒绝与忽略测试**

明确测试未知章节、普通段落、联系方式章节、空列表项不生成事实；中英文别名可识别；先把 CRLF/CR 规范为 LF 后行号正确；输出无额外字段。无事实时返回合法空 `facts`，由领域 Processor 转成 `NO_SUPPORTED_FACTS`。

- [ ] **Step 5: 验证 Parser 绿灯和类型**

```bash
pnpm --filter worker test -- fake-career-document-parser.test.ts
pnpm --filter worker typecheck
```

Expected: PASS。

- [ ] **Step 6: 提交 Fake Parser**

```bash
git add apps/worker/src/career-import/fake-career-document-parser.ts apps/worker/src/career-import/fake-career-document-parser.test.ts
git commit -m "feat: parse quoted markdown career facts (#3)"
```

---

### Task 4: 建立幂等导入领域深模块

**Files:**
- Create: `packages/domain/src/career-imports.ts`
- Create: `packages/domain/src/career-imports.integration.test.ts`
- Modify: `packages/domain/package.json`
- Modify: `packages/domain/src/audit-trail.ts`
- Modify: `packages/domain/src/audit-trail.integration.test.ts`
- Modify: `packages/domain/src/workbench-home.ts`
- Modify: `packages/domain/src/workbench-home.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 DTO/任务 Schema、Task 2 Drizzle 表、`AuditTrail`。
- Produces: `CareerDocumentStore`、`CareerImportQueue`、`CareerDocumentParser`；`createCareerImportCommands`、`createCareerImportQueries`、`createCareerImportProcessor`；真实工作台待确认计数。

- [ ] **Step 1: 写创建、复用、补发和失败重排的失败测试**

```ts
const commands = createCareerImportCommands({ db, auditTrail, documentStore, queue, id: ids.next, clock });
const first = await commands.createOrReuse({ userId, requestId, bytes, originalFilename: "resume.md", mediaType: "text/markdown" });
const duplicate = await commands.createOrReuse({ userId, requestId: secondRequestId, bytes, originalFilename: "renamed.md", mediaType: "text/markdown" });

expect(first).toMatchObject({ status: "queued", reused: false, shouldReturnAccepted: true });
expect(duplicate).toMatchObject({ importId: first.importId, documentId: first.documentId, status: "queued", reused: true, shouldReturnAccepted: false });
expect(queue.jobs).toEqual([expect.objectContaining({ importId: first.importId }), expect.objectContaining({ importId: first.importId })]);
expect(documentStore.puts).toHaveLength(1);
```

再测试：不同账户不复用；queue 首次失败后数据库为 `failed/CAREER_IMPORT_QUEUE_UNAVAILABLE`；同一文件重传原子恢复 `queued` 并使用同一个 `importId`；`completed` 不入队。

- [ ] **Step 2: 写 Processor 与证据事务失败测试**

```ts
await expect(processor.process({ version: 1, importId, userId, finalAttempt: false }))
  .resolves.toBe("completed");
await expect(queries.get({ userId, importId })).resolves.toMatchObject({
  status: "completed",
  facts: [expect.objectContaining({ confirmationStatus: "pending", evidence: expect.objectContaining({ startLine: 6 }) })],
});
```

分别注入 `inferred`、缺证据、片段不等于指定行、越界、未知字段、checksum 不匹配和零合法事实，断言没有部分事实。重复处理 `completed` 返回 `noop`；`processing` 重投继续处理；每次真实执行递增 `attemptCount`。

- [ ] **Step 3: 运行领域测试并确认红灯**

Run: `pnpm --filter @job-copilot/domain test -- career-imports.integration.test.ts`

Expected: FAIL，领域接口不存在。

- [ ] **Step 4: 定义窄端口和三个工厂**

```ts
export interface CareerDocumentStore {
  put(input: { objectKey: string; bytes: Uint8Array; mediaType: "text/markdown"; documentId: string }): Promise<void>;
  get(input: { objectKey: string }): Promise<Uint8Array>;
}
export interface CareerImportQueue { enqueue(job: CareerImportJob): Promise<void>; }
export interface CareerDocumentParser { parse(markdown: string): Promise<unknown>; }

export function createCareerImportCommands(deps: CommandDependencies): {
  createOrReuse(input: CreateOrReuseInput): Promise<CreateOrReuseResult>;
}
export function createCareerImportQueries(deps: { db: Database }): {
  list(input: { userId: string }): Promise<CareerImportSummary[]>;
  get(input: { userId: string; importId: string }): Promise<CareerImportDetail | null>;
}
export function createCareerImportProcessor(deps: ProcessorDependencies): {
  process(input: CareerImportJob & { finalAttempt: boolean }): Promise<"completed" | "failed" | "noop">;
}
```

创建流程在 PostgreSQL 唯一键下复用记录；对象仅为新职业资料写一次；新建、失败重排和命中 `queued` 或 `processing` 都调用确定性 `queue.enqueue`。这是没有 Outbox 或恢复扫描器时由重复上传触发的恢复；`processing` 成功补发保持当前 `200` 响应。入队抛错后，只有仍为 `queued` 的记录条件更新为 `failed/CAREER_IMPORT_QUEUE_UNAVAILABLE`；`processing` 保持现状并由 API 返回现有的队列不可用响应。

- [ ] **Step 5: 实现证据验证、事务完成和稳定失败**

Processor 以 `importId + userId` 读取权威记录：`completed/failed` 为 `noop`，`queued` 条件更新为 `processing`，`processing` 作为同一 BullMQ job 的恢复执行。原始字节再次校验 SHA-256，使用 fatal UTF-8 解码，再将 CRLF/CR 规范为 LF；先对不可信 raw output 的 `facts` 数组做窄且无转换的长度检查，第 501 条立即以 `CAREER_IMPORT_FACT_LIMIT_EXCEEDED` 全单稳定失败，再对未超限输出执行 `CareerParserOutputSchema.safeParse`。此检查不接受未知字段也不绕过完整 Schema；其他 Schema 非法仍为 `CAREER_PARSER_OUTPUT_INVALID`。

```ts
const lines = markdown.split("\n");
const quoted = lines.slice(fact.evidence.startLine - 1, fact.evidence.endLine).join("\n");
const evidenceMatches = quoted === fact.evidence.excerpt;
```

只保留 `evidenceMatches` 的事实；使用解析版本、事实类型、规范化后的 `factValue` JSON 和 `startLine:endLine` 计算 `factKey`。事实、证据、完成状态和完成审计在一个事务中提交，Worker 审计继续使用导入记录的 `originatingRequestId`。确定性错误立即写失败；暂时性读/持久化错误只有 `finalAttempt=true` 时写失败，否则重新抛出。

- [ ] **Step 6: 扩展严格审计白名单**

```text
career.document_import_queued    -> { documentId, importId }
career.document_import_completed -> { documentId, importId, attemptCount, factCount }
career.document_import_failed    -> { documentId, importId, attemptCount, failureCode }
```

所有 metadata object 使用 `.strict()`；测试明确拒绝 `filename`、`objectKey`、`excerpt`、`checksum`、`markdown` 和联系方式字段。

- [ ] **Step 7: 让工作台读取当前账户真实待确认计数**

在 `createWorkbenchHome` 中增加当前 `userId` 且 `confirmation_status = 'pending'` 的 `count(*)`，转换为安全整数。集成测试为两个账户分别插入候选事实，断言当前账户只统计自身数量，其他摘要仍为零。

- [ ] **Step 8: 暴露 subpath 并验证领域绿灯**

在 `packages/domain/package.json` 添加 `"./career-imports": "./src/career-imports.ts"`。

```bash
pnpm --filter @job-copilot/domain test -- career-imports.integration.test.ts audit-trail.integration.test.ts workbench-home.integration.test.ts
pnpm --filter @job-copilot/domain typecheck
```

Expected: PASS。

- [ ] **Step 9: 提交领域模块**

```bash
git add packages/domain
git commit -m "feat: add idempotent career import domain (#3)"
```

---

### Task 5: 暴露认证上传与导入查询 API

**Files:**
- Create: `apps/api/src/configure-api-application.ts`
- Create: `apps/api/src/career-import/career-import.controller.ts`
- Create: `apps/api/src/career-import/career-import.module.ts`
- Create: `apps/api/src/career-import/career-import.tokens.ts`
- Create: `apps/api/src/career-import/parse-career-document-upload.ts`
- Create: `apps/api/src/career-import/parse-career-document-upload.test.ts`
- Create: `apps/api/src/career-import/minio-career-document-store.ts`
- Create: `apps/api/src/career-import/bullmq-career-import-queue.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/api.integration.test.ts`
- Modify: `apps/api/src/common/api-problem.filter.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 4 commands/queries/ports，现有 `SessionGuard`、`ApiProblemFilter`、`DATABASE`。
- Produces: `POST /v1/career-documents/imports`、`GET /v1/career-documents/imports`、`GET /v1/career-documents/imports/:importId` 与 OpenAPI 契约。

- [ ] **Step 1: 安装固定 multipart 与 producer 依赖**

Run: `pnpm --filter api add --save-exact @fastify/multipart@10.1.1 bullmq@6.2.2`

Expected: `apps/api/package.json` 和 lockfile 只增加 API 所需依赖。

- [ ] **Step 2: 写上传边界失败测试**

对 `parseCareerDocumentUpload` 使用受控 `MultipartFile` stream，表格化断言合法 `.md`、大写 `.MD`、四种允许 MIME 通过；缺文件、多文件、错误字段名、非 `.md`、524289 字节、非法 UTF-8、NUL 和空白正文得到设计中的稳定错误码。

```ts
await expect(parseCareerDocumentUpload(markdownPart({ filename: "resume.md", bytes: new TextEncoder().encode("## 技能\n- TypeScript") })))
  .resolves.toMatchObject({ originalFilename: "resume.md", mediaType: "text/markdown" });
await expect(parseCareerDocumentUpload(markdownPart({ filename: "resume.md", bytes: new Uint8Array(524_289) })))
  .rejects.toMatchObject({ code: "CAREER_DOCUMENT_TOO_LARGE" });
```

- [ ] **Step 3: 运行上传测试并确认红灯**

Run: `pnpm --filter api test -- parse-career-document-upload.test.ts`

Expected: FAIL，解析函数不存在。

- [ ] **Step 4: 实现 Fastify multipart 注册与有限读取**

`configureApiApplication(app)` 在 `app.init()` 前执行：

```ts
await app.register(multipart, {
  limits: { files: 1, fields: 0, parts: 1, fileSize: CAREER_DOCUMENT_MAX_BYTES },
  throwFileSizeLimit: true,
});
configureOpenApi(app);
```

生产 `main.ts` 与 integration test 都调用它。解析使用 `request.parts()` 完整消费请求，只允许一个 `fieldname === "file"` 文件；使用 `TextDecoder("utf-8", { fatal: true })`。显示名取 basename、NFC、最多 255 个 Unicode code point。

- [ ] **Step 5: 实现 MinIO 与 BullMQ Adapter**

MinIO bucket 来自 `MINIO_BUCKET ?? "career-documents"`；`put` 只写 `documentId`、字节数和 `text/markdown` metadata，`get` 以 524288 字节上限收集 stream。Producer 固定：

```ts
await queue.add(CAREER_IMPORT_JOB_NAME, CareerImportJobSchema.parse(job), {
  jobId: job.importId, attempts: 3,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: true, removeOnFail: true,
});
```

Redis connection 使用 `maxRetriesPerRequest: null`；关闭时依次 `queue.close()`、`redis.quit()`。

- [ ] **Step 6: 写 HTTP 集成失败测试**

在现有 PostgreSQL Testcontainer 中覆盖 `CAREER_DOCUMENT_STORE` 与 `CAREER_IMPORT_QUEUE` 为窄 Fake。使用手工 multipart builder 发送真实 boundary：

```ts
expect(upload.statusCode).toBe(202);
expect(upload.json()).toMatchObject({ status: "queued", reused: false, detailUrl: expect.stringMatching(/^\/v1\/career-documents\/imports\//) });
expect(repeated.statusCode).toBe(200);
expect(repeated.json().importId).toBe(upload.json().importId);
```

覆盖 401、全部上传错误码、最近 20 条倒序、跨账户/不存在详情 404、队列失败 503 且记录可重试。检查审计与捕获日志不含合成邮箱、文件名和正文。

- [ ] **Step 7: 实现 Controller、Module 与错误映射**

Controller 使用 `SessionGuard`，只从 `request.authenticatedAccount.userId` 取 owner。POST 以 `shouldReturnAccepted` 决定 202/200；GET detail 的 `null` 映射 404。上传、存储、队列错误映射为设计码与 400/413/503。

```ts
@ApiBody({ schema: {
  type: "object", required: ["file"], additionalProperties: false,
  properties: { file: { type: "string", format: "binary", description: "UTF-8 Markdown，最大 512 KiB" } },
} })
```

三个操作均声明 `@ApiBearerAuth("bearerAuth")` 并引用共享响应 DTO。

- [ ] **Step 8: 验证 API 绿灯**

```bash
pnpm --filter api test -- parse-career-document-upload.test.ts api.integration.test.ts
pnpm --filter api typecheck
pnpm --filter api build
```

Expected: PASS；OpenAPI 包含三个路径、binary file Schema、Bearer security 和 `ApiProblem`。

- [ ] **Step 9: 提交 API 纵切**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat: expose markdown career import api (#3)"
```

---

### Task 6: 通过真实 BullMQ Worker 完成导入

**Files:**
- Create: `apps/worker/src/career-import/minio-career-document-store.ts`
- Create: `apps/worker/src/career-import/career-import-consumer.ts`
- Create: `apps/worker/src/career-import/career-import.module.ts`
- Create: `apps/worker/src/career-import/career-import.integration.test.ts`
- Modify: `apps/worker/src/app.module.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `apps/worker/package.json`
- Modify: `scripts/local-runtime.mjs`
- Modify: `scripts/local-runtime.test.mjs`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 3 Parser、Task 4 Processor、Task 5 相同队列协议和 bucket。
- Produces: 可恢复 Consumer、真实 PostgreSQL/Redis/MinIO 集成测试和明确关闭语义。

- [ ] **Step 1: 安装 Worker 直接依赖**

```bash
pnpm --filter worker add '@job-copilot/database@workspace:*' minio@8.0.6
pnpm --filter worker add -D @testcontainers/postgresql@12.1.0 @testcontainers/redis@12.1.0 testcontainers@12.1.0
```

Expected: Worker 不依赖传递依赖访问数据库、MinIO 或 GenericContainer。

- [ ] **Step 2: 写真实基础设施失败测试**

启动 PostgreSQL `17-alpine`、Redis 与 compose 同 digest 的 MinIO GenericContainer；建 bucket、迁移数据库、写账户与原始对象，再用真实 BullMQ Queue/Worker 处理。断言详情包含具体事实与行号，Redis job payload 不含 Markdown、文件名、邮箱或 evidence。

再覆盖：相同 `jobId` 不重复事实；第一次 store read 暂时失败、第二次从 `processing` 恢复且 `attemptCount=2`；三次暂时错误后为 `failed/CAREER_DOCUMENT_READ_FAILED` 且没有事实；501 个事实和近 512 KiB 短列表均在第一次尝试以 `CAREER_IMPORT_FACT_LIMIT_EXCEEDED` 失败、没有事实，而 501 字符的单一非法事实仍为 `CAREER_PARSER_OUTPUT_INVALID`。

- [ ] **Step 3: 运行 Worker 集成测试并确认红灯**

Run: `pnpm --filter worker test -- career-import.integration.test.ts`

Expected: FAIL，Consumer 和 Worker 组合根不存在。

- [ ] **Step 4: 实现 Consumer 与最终尝试语义**

```ts
this.worker = new Worker(CAREER_IMPORT_QUEUE, async (job) => {
  const payload = CareerImportJobSchema.parse(job.data);
  const attempts = job.opts.attempts ?? 1;
  return processor.process({ ...payload, finalAttempt: job.attemptsMade + 1 >= attempts });
}, { connection, concurrency: 1 });
```

本地 Beta 并发固定为 1。`close()` 调用 `worker.close()` 等待当前 job；不使用 force。业务 `failed` 正常结束；暂时错误在非最终尝试重新抛出。

- [ ] **Step 5: 组合数据库、MinIO、审计与 Parser**

`CareerImportModule` 创建独立数据库客户端、MinIO Client、BullMQ Redis connection、Fake Parser、AuditTrail 和 Processor。读取 `DATABASE_URL`、`REDIS_URL`、`MINIO_ENDPOINT`、`MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY`、`MINIO_BUCKET`；生产必要值缺失时拒绝启动，本地值由 runtime 提供。

- [ ] **Step 6: 实现关闭顺序与 runtime 测试**

```ts
clearInterval(heartbeatTimer);
await careerImportConsumer.close();
await heartbeat.close();
await app.close();
```

`applicationEnv` 增加固定本地 MinIO access key、secret key 与 bucket；runtime test 断言 Web/API/Worker 收到相同对象存储和 Redis 配置，但凭据不输出到日志。

- [ ] **Step 7: 验证 Worker 绿灯**

```bash
pnpm --filter worker test -- fake-career-document-parser.test.ts career-import.integration.test.ts
pnpm test:runtime
pnpm --filter worker typecheck
pnpm --filter worker build
```

Expected: PASS；无悬挂 Worker、Redis、数据库或 MinIO handle。

- [ ] **Step 8: 提交 Worker 纵切**

```bash
git add apps/worker scripts/local-runtime.mjs scripts/local-runtime.test.mjs pnpm-lock.yaml
git commit -m "feat: process career imports in worker (#3)"
```

---

### Task 7: 交付 `/profile` 上传、轮询和证据界面

**Files:**
- Create: `apps/web/app/(workbench)/profile/page.tsx`
- Create: `apps/web/app/(workbench)/profile/page.test.tsx`
- Create: `apps/web/app/(workbench)/profile/actions.ts`
- Create: `apps/web/app/(workbench)/profile/actions.test.ts`
- Create: `apps/web/app/api/career-imports/[importId]/route.ts`
- Create: `apps/web/app/api/career-imports/[importId]/route.test.ts`
- Create: `apps/web/components/workbench/profile-import-view.tsx`
- Create: `apps/web/components/workbench/profile-import-view.test.tsx`
- Create: `apps/web/components/workbench/workbench-navigation.tsx`
- Modify: `apps/web/components/workbench/workbench-header.tsx`
- Modify: `apps/web/components/workbench/workbench-header.test.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.test.tsx`
- Modify: `apps/web/lib/server/api-client.ts`
- Modify: `apps/web/lib/server/api-client.test.ts`
- Create: `apps/web/lib/server/career-imports.ts`
- Create: `apps/web/lib/server/career-imports.test.ts`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: Task 1 HTTP DTO、现有 HttpOnly `job_copilot_session`、Task 5 API。
- Produces: 受保护 `/profile`、上传 Server Action、同源详情轮询 Route Handler、真实“画像”导航和工作台入口。

- [ ] **Step 1: 扩展 server-only API Client 的失败测试**

```ts
await expect(api.listCareerImports(sessionToken)).resolves.toEqual({ imports: [] });
await expect(api.createCareerImport(sessionToken, formData)).resolves.toMatchObject({ status: "queued" });
await expect(api.getCareerImport(sessionToken, importId)).resolves.toMatchObject({ importId });
```

断言每个请求包含 Bearer 和不重复的 `x-request-id`；multipart 不手工设置 `content-type`，让 `fetch` 生成 boundary；每个成功响应都通过 Task 1 Schema，非法响应抛 `ApiClientError("invalid_response")`。

- [ ] **Step 2: 写 Server Action、BFF 与认证失败测试**

上传 Action 从 `readSessionToken()` 取会话；无会话重定向 `/login?returnTo=%2Fprofile`；只取 `formData.get("file")` 并调用 API Client。详情 Route Handler 从 Cookie 取 token，校验 UUID 后调用 API；API 401 映射同源 401，404 保持 404，响应设置 `Cache-Control: no-store`。

- [ ] **Step 3: 写交互组件失败测试**

```ts
expect(screen.getByLabelText("选择 Markdown 职业资料"))
  .toHaveAttribute("accept", ".md,text/markdown,text/plain");
await user.upload(input, new File(["## 技能\n- TypeScript"], "resume.md", { type: "text/markdown" }));
await user.click(screen.getByRole("button", { name: "上传并解析" }));
expect(await screen.findByRole("status")).toHaveTextContent(/等待解析|解析中/);
```

使用 fake timers 推进 1 秒并返回 `completed`，断言显示“待确认”、事实类型、结构化值、来源文件、`第 6 行` 和证据片段；终态、卸载和导航取消 timer/AbortController。失败码映射中文说明，不显示内部 key 或英文异常。

- [ ] **Step 4: 运行 Web 目标测试并确认红灯**

Run:

```bash
pnpm --filter web test -- api-client.test.ts actions.test.ts route.test.ts profile-import-view.test.tsx
```

Expected: FAIL，新页面和接口不存在。

- [ ] **Step 5: 实现 RSC 首读、Server Action 与短轮询**

`profile/page.tsx` 调用 `getCareerImports()`；非 Next 控制流错误显示诚实可重试状态，成功时把最近导入传给唯一 Client Component。Client 状态固定为 `uploading | queued | processing | completed | failed`，轮询间隔固定 `1000ms`，只在 queued/processing 建立 timer。

```ts
type UploadActionState =
  | { ok: false; code: string; message: string }
  | { ok: true; import: CreateCareerImportResponse };
```

不得把 session token、API problem requestId 或内部失败消息返回浏览器。

- [ ] **Step 6: 实现事实展示和无障碍状态**

上传区使用可见 `<label>`、真实 `<input type="file">` 和 `<button>`；`aria-live="polite"` 包含“上传中/等待解析/解析中/解析完成/解析失败”。候选事实按 API 顺序显示中文类型、值、来源文件、Markdown 行号、最小证据和“待确认”；固定提示“确认、修改和拒绝将在下一阶段开放”，不添加无效控件。

- [ ] **Step 7: 开放画像导航与工作台入口**

`WorkbenchNavigation` 只为 `/home`、`/profile` 输出真实 Link，通过 `usePathname()` 设置准确 `aria-current="page"`；“推荐/投递”继续为禁用文本。工作台空状态链接“导入 Markdown 职业资料”；`pendingFacts > 0` 时说明它们尚未进入求职画像，不能用于推荐或材料生成。

- [ ] **Step 8: 添加沿用现有视觉语言的 CSS**

只扩展 `.profile-*` 和必要 `.workbench-*`：paper surface、hairline rule、emerald 主操作、amber 待确认；上传按钮、文件 input 和链接最小高度 `2.75rem`。桌面事实列表为两列“结构化值/证据”、`max-width: 52rem`；`max-width: 640px` 改为单列且容器 `min-width: 0`。继续服从现有 `prefers-reduced-motion`。

- [ ] **Step 9: 验证 Web 绿灯和构建**

```bash
pnpm --filter web test
pnpm --filter web lint
pnpm --filter web typecheck
pnpm --filter web build
```

Expected: PASS；构建输出包含 `/profile` 和 `/api/career-imports/[importId]`。

- [ ] **Step 10: 提交 Web 体验**

```bash
git add apps/web
git commit -m "feat: add markdown profile import workbench (#3)"
```

---

### Task 8: 锁定真实本地全栈验收并完成交付审查

**Files:**
- Create: `apps/web/e2e/markdown-career-import.spec.ts`
- Modify: `apps/web/e2e/auth-workbench.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–7 的完整 Web/API/Worker/PostgreSQL/Redis/MinIO/BullMQ 纵切。
- Produces: 不访问真实模型的 Playwright 验收、完整质量门和 Issue #3 双轴代码审查证据。

- [ ] **Step 1: 写全流程 Playwright 失败测试**

使用 `setInputFiles` 上传与 Task 3 相同行号的固定 UTF-8 Buffer，断言登录 → 画像 → 上传 → 等待/解析状态 → 完成 → 具体事实与行号 → 刷新后仍存在。

```ts
await page.getByLabel("选择 Markdown 职业资料").setInputFiles({
  name: "career.md", mimeType: "text/markdown", buffer: Buffer.from(resume, "utf8"),
});
await page.getByRole("button", { name: "上传并解析" }).click();
await expect(page.getByRole("status")).toContainText(/等待解析|解析中|解析完成/);
await expect(page.getByText("TypeScript", { exact: true })).toBeVisible();
await expect(page.getByText("第 6 行", { exact: true })).toBeVisible();
```

读取浏览器 HttpOnly Cookie 值作为测试 Bearer，同一文件第二次 POST 断言同一 `importId` 和事实数量不变；创建第二 Dev Auth 会话后 GET 第一账户详情断言 404。

- [ ] **Step 2: 添加无障碍、移动端和工作台联动断言**

Desktop Chrome 验证 Tab 顺序为品牌 → 首页 → 画像 → 退出 → 文件输入 → 上传按钮；Mobile Safari 使用真实 `tap`/文件选择。两个项目都断言控件高度至少 44、`scrollWidth === clientWidth`、axe violations 为空。返回 `/home` 后断言“待确认事实”为实际数量且职业资料入口可点击。

- [ ] **Step 3: 运行 E2E 并确认红灯或暴露遗漏**

Run: `pnpm test:e2e -- markdown-career-import.spec.ts`

Expected: 测试必须真正启动 Web、API、Worker、PostgreSQL、Redis、MinIO 和 BullMQ；若 PASS 则直接进入完整质量门，若 FAIL 则按下一步补最靠近根因的回归测试，不能放宽断言。

- [ ] **Step 4: 只修复 E2E 揭示的 Issue #3 缺口**

对每个红灯先在最靠近根因的契约、领域、API、Worker 或组件测试补回归断言，再做最小修复。禁止加入确认/编辑、DOCX/PDF、SSE、真实模型或营销页改版。

- [ ] **Step 5: 运行完整质量门**

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
docker compose config --quiet
git diff --check
git status --short
```

Expected: 所有命令退出 `0`；Playwright 为 0 failed；状态只允许本任务待提交文件和用户的 `?? .superpowers/`。

- [ ] **Step 6: 提交全栈验收**

```bash
git add apps/web/e2e apps/web/e2e/auth-workbench.spec.ts
git commit -m "test: cover markdown career import journey (#3)"
```

- [ ] **Step 7: 执行双轴代码审查**

使用 `/code-review`，fixed point 为执行开始时保存的 `$IMPLEMENT_BASE`：

```text
Standards review：AGENTS.md、apps/web/AGENTS.md、现有代码风格、安全与测试规范。
Spec review：GitHub Issue #3 与 docs/superpowers/specs/2026-08-27-markdown-career-import-design.md。
```

每条发现用文件、行号和复现证据确认；修复成立的问题，运行最小回归测试，再重新运行完整质量门。

- [ ] **Step 8: 提交审查修复并确认边界**

```bash
git add apps/api apps/worker apps/web packages/contracts packages/database packages/domain scripts/local-runtime.mjs scripts/local-runtime.test.mjs pnpm-lock.yaml
git commit -m "fix: harden markdown career import contracts (#3)"
git diff --stat "$IMPLEMENT_BASE"...HEAD
git status --short
```

审查没有代码变化时不创建空提交。最终状态只允许 `?? .superpowers/`；随后关闭 GitHub Issue #3，并进入 `finishing-a-development-branch` 的集成选择。
