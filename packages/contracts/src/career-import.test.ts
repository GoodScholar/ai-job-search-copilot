import { describe, expect, it } from "vitest";
import {
  CAREER_DOCUMENT_MAX_BYTES,
  CAREER_IMPORT_MAX_FACTS,
  CAREER_IMPORT_JOB_NAME,
  CAREER_IMPORT_QUEUE,
  CandidateFactSchema,
  CareerImportDetailSchema,
  CareerImportFailureCodeSchema,
  CareerImportPathSchema,
  CareerImportJobSchema,
  CareerImportListSchema,
  CareerParserFactSchema,
  CareerParserOutputSchema,
  CreateCareerImportResponseSchema,
  CareerFactConflictSchema,
  ResolveCareerFactConflictCommandSchema,
  parseQuotedCareerFactValue,
} from "./career-import";

const id = () => crypto.randomUUID();
const now = "2026-08-27T00:00:00.000Z";

const evidence = () => ({
  documentId: id(),
  sourceFilename: "resume.md",
  locatorType: "markdown_lines",
  startLine: 1,
  endLine: 1,
  excerpt: "- TypeScript",
});

const parserEvidence = () => ({
  locatorType: "markdown_lines",
  startLine: 1,
  endLine: 1,
  excerpt: "- TypeScript",
});

const parserFact = (factType: string, factValue: object) => ({
  factType,
  factValue,
  confidenceBasisPoints: 10_000,
  grounding: "quoted",
  evidence: parserEvidence(),
});

const candidateFact = (factType: string, factValue: object) => ({
  factId: id(),
  factType,
  factValue,
  confidenceBasisPoints: 10_000,
  confirmationStatus: "pending",
  createdAt: now,
  evidence: evidence(),
});

describe("career import contracts", () => {
  it("locks conflict detail and three explicit resolution commands", () => {
    expect(CareerFactConflictSchema.parse({
      conflictId: id(), kind: "date", status: "pending", existingFact: candidateFact("experience", { summary: "AI 工程师｜示例科技｜2023" }),
      incomingFact: candidateFact("experience", { summary: "AI 工程师｜示例科技｜2024" }), resolution: null, profileVersion: null, resolvedAt: null,
    }).status).toBe("pending");
    expect(() => CareerFactConflictSchema.parse({
      conflictId: id(), kind: "date", status: "pending", existingFact: candidateFact("experience", { summary: "AI 工程师｜示例科技｜2023" }),
      incomingFact: candidateFact("experience", { summary: "AI 工程师｜示例科技｜2024" }), resolution: "use_existing", profileVersion: 1, resolvedAt: now,
    })).toThrow();
    expect(() => CareerFactConflictSchema.parse({
      conflictId: id(), kind: "date", status: "resolved", existingFact: candidateFact("experience", { summary: "AI 工程师｜示例科技｜2023" }),
      incomingFact: candidateFact("experience", { summary: "AI 工程师｜示例科技｜2024" }), resolution: null, profileVersion: null, resolvedAt: null,
    })).toThrow();
    for (const resolution of ["use_existing", "use_incoming", "keep_both"]) {
      expect(ResolveCareerFactConflictCommandSchema.parse({ expectedVersion: 1, resolution })).toMatchObject({ resolution });
    }
  });
  it("accepts DOCX processing copies with one-based paragraph evidence", () => {
    const documentId = crypto.randomUUID();
    expect(CareerImportDetailSchema.parse({
      importId: crypto.randomUUID(), documentId, sourceFilename: "resume.docx",
      sourceFormat: "docx",
      privacyStatus: "sanitized_only", status: "completed", failureCode: null,
      createdAt: "2026-08-27T12:00:00.000Z", updatedAt: "2026-08-27T12:00:00.000Z",
      facts: [{
        factId: crypto.randomUUID(), factType: "experience", factValue: { summary: "AI 工程师｜示例科技｜2024" },
        confidenceBasisPoints: 10_000, confirmationStatus: "pending", createdAt: "2026-08-27T12:00:00.000Z",
        evidence: { documentId, sourceFilename: "resume.docx", locatorType: "docx_paragraphs", startParagraph: 2, endParagraph: 2, excerpt: "AI 工程师｜示例科技｜2024" },
      }],
    })).toMatchObject({ facts: [expect.objectContaining({ evidence: expect.objectContaining({ locatorType: "docx_paragraphs" }) })] });
  });
  it("接受 PDF 来源与按页定位的候选事实证据", () => {
    const documentId = crypto.randomUUID();
    expect(CareerImportDetailSchema.parse({
      importId: crypto.randomUUID(), documentId, sourceFilename: "resume.pdf",
      sourceFormat: "pdf", privacyStatus: "sanitized_only", status: "completed", failureCode: null,
      createdAt: "2026-08-28T12:00:00.000Z", updatedAt: "2026-08-28T12:00:00.000Z",
      facts: [{
        factId: crypto.randomUUID(), factType: "skill", factValue: { name: "TypeScript" },
        confidenceBasisPoints: 10_000, confirmationStatus: "pending", createdAt: "2026-08-28T12:00:00.000Z",
        evidence: { documentId, sourceFilename: "resume.pdf", locatorType: "pdf_pages", startPage: 2, endPage: 2, excerpt: "- TypeScript" },
      }],
    }).facts[0]?.evidence).toMatchObject({ locatorType: "pdf_pages", startPage: 2 });
  });
  it("要求公开导入响应明确给出来源格式", () => {
    expect(() => CareerImportDetailSchema.parse({
      importId: id(), documentId: id(), sourceFilename: "resume.md", privacyStatus: "sanitized_only", status: "queued", failureCode: null,
      createdAt: now, updatedAt: now, facts: [],
    })).toThrow();
  });
  it("locks size, queue and task protocol", () => {
    expect(CAREER_DOCUMENT_MAX_BYTES).toBe(524_288);
    expect(CAREER_IMPORT_MAX_FACTS).toBe(500);
    expect(CAREER_IMPORT_QUEUE).toBe("career-imports");
    expect(CAREER_IMPORT_JOB_NAME).toBe("parse-career-document");
    expect(CareerImportJobSchema.parse({ version: 1, importId: id(), userId: id() }))
      .toMatchObject({ version: 1 });
  });

  it("rejects parser and detail outputs above the bounded fact count", () => {
    const facts = Array.from({ length: 501 }, () => parserFact("skill", { name: "TypeScript" }));
    expect(() => CareerParserOutputSchema.parse({
      adapter: "fake",
      parserVersion: "fake-career-parser-v1",
      promptVersion: "career-import-prompt-v1",
      outputSchemaVersion: "career-facts-v1",
      facts,
    })).toThrow();
    expect(() => CareerImportDetailSchema.parse({
      importId: id(),
      documentId: id(),
      sourceFilename: "resume.md",
      sourceFormat: "markdown",
      status: "completed",
      failureCode: null,
      createdAt: now,
      updatedAt: now,
      facts: Array.from({ length: 501 }, () => candidateFact("skill", { name: "TypeScript" })),
    })).toThrow();
  });

  it.each([
    ["skill", { name: "TypeScript" }],
    ["certification", { name: "AWS Certified Developer" }],
    ["language", { name: "English", level: "Fluent" }],
    ["experience", { summary: "Built resilient web services." }],
    ["education", { summary: "BSc Computer Science." }],
    ["project", { summary: "Shipped an AI job-search tool." }],
    ["achievement", { summary: "Reduced latency by 40%." }],
  ])("accepts quoted %s parser facts", (factType, factValue) => {
      expect(CareerParserFactSchema.parse(parserFact(factType, factValue))).toMatchObject({
        factType,
        factValue,
      });
  });

  it("rejects unknown parser and fact fields", () => {
    expect(() => CareerParserOutputSchema.parse({
      adapter: "fake",
      parserVersion: "fake-career-parser-v1",
      promptVersion: "career-import-prompt-v1",
      outputSchemaVersion: "career-facts-v1",
      facts: [],
      rawMarkdown: "secret",
    })).toThrow();
    expect(() => CandidateFactSchema.parse(candidateFact("skill", { name: "TypeScript", level: "inferred" }))).toThrow();
  });

  it("accepts only UUID career import path parameters", () => {
    expect(CareerImportPathSchema.parse({ importId: id() })).toEqual({ importId: expect.any(String) });
    expect(() => CareerImportPathSchema.parse({ importId: "not-a-uuid" })).toThrow();
  });

  it("rejects ungrounded facts and invalid evidence ranges", () => {
    expect(() => CareerParserFactSchema.parse({
      ...parserFact("skill", { name: "TypeScript" }),
      grounding: "inferred",
    })).toThrow();
    expect(() => CareerParserFactSchema.parse({
      ...parserFact("skill", { name: "TypeScript" }),
      confidenceBasisPoints: 10_001,
    })).toThrow();
    expect(() => CandidateFactSchema.parse({
      ...candidateFact("skill", { name: "TypeScript" }),
      evidence: { ...evidence(), startLine: 2, endLine: 1 },
    })).toThrow();
  });

  it("preserves quoted evidence whitespace while rejecting whitespace-only excerpts", () => {
    const exactExcerpt = "  - TypeScript  ";
    expect(CareerParserFactSchema.parse({
      ...parserFact("skill", { name: "TypeScript" }),
      evidence: { ...parserEvidence(), excerpt: exactExcerpt },
    }).evidence.excerpt).toBe(exactExcerpt);
    expect(CandidateFactSchema.parse({
      ...candidateFact("skill", { name: "TypeScript" }),
      evidence: { ...evidence(), excerpt: exactExcerpt },
    }).evidence.excerpt).toBe(exactExcerpt);
    expect(() => CareerParserFactSchema.parse({
      ...parserFact("skill", { name: "TypeScript" }),
      evidence: { ...parserEvidence(), excerpt: " \t " },
    })).toThrow();
  });

  it.each([
    ["skill", "  - TypeScript  ", { name: "TypeScript" }],
    ["certification", "- AWS Certified Developer", { name: "AWS Certified Developer" }],
    ["language", "- English: Fluent", { name: "English", level: "Fluent" }],
    ["experience", "### Built resilient services", { summary: "Built resilient services" }],
    ["education", "- BSc Computer Science", { summary: "BSc Computer Science" }],
    ["project", "- Job Copilot", { summary: "Job Copilot" }],
    ["achievement", "- Reduced latency by 40%", { summary: "Reduced latency by 40%" }],
  ])("parses the exact supported evidence form for %s", (factType, excerpt, factValue) => {
    expect(parseQuotedCareerFactValue(factType as Parameters<typeof parseQuotedCareerFactValue>[0], excerpt)).toEqual(factValue);
  });

  it("preserves C# while stripping only whitespace-delimited closing heading hashes", () => {
    expect(parseQuotedCareerFactValue("project", "### C#")).toEqual({ summary: "C#" });
    expect(parseQuotedCareerFactValue("project", "### C# ###")).toEqual({ summary: "C#" });
  });

  it.each(["confirmed", "rejected"])("rejects %s confirmation status", (confirmationStatus) => {
    expect(() => CandidateFactSchema.parse({
      ...candidateFact("skill", { name: "TypeScript" }),
      confirmationStatus,
    })).toThrow();
  });

  it("rejects unsupported fact types, invalid filenames, and invalid job bodies", () => {
    expect(() => CareerParserFactSchema.parse(parserFact("award", { name: "Top performer" }))).toThrow();
    for (const sourceFilename of [" ", "resume.pdf", "career.docx"]) {
      expect(() => CareerImportDetailSchema.parse({
        importId: id(),
        documentId: id(),
        sourceFilename,
        status: "queued",
        failureCode: null,
        createdAt: now,
        updatedAt: now,
        facts: [],
      })).toThrow();
    }
    expect(() => CareerImportJobSchema.parse({ version: 1, importId: id(), userId: id(), attempt: 1 })).toThrow();
  });

  it("rejects unknown response fields and unsupported failure codes", () => {
    expect(() => CareerImportListSchema.parse({ imports: [], page: 1 })).toThrow();
    expect(() => CreateCareerImportResponseSchema.parse({
      importId: id(),
      documentId: id(),
      sourceFilename: "resume.md",
      status: "failed",
      failureCode: "UNKNOWN_FAILURE",
      createdAt: now,
      updatedAt: now,
    })).toThrow();
  });

  it("exposes a distinct stable failure code for fact-count overflow", () => {
    expect(CareerImportFailureCodeSchema.parse("CAREER_IMPORT_FACT_LIMIT_EXCEEDED"))
      .toBe("CAREER_IMPORT_FACT_LIMIT_EXCEEDED");
  });

  it("keeps list fact counts separate from the create-or-reuse response", () => {
    const base = {
      importId: id(),
      documentId: id(),
      sourceFilename: "resume.md",
      sourceFormat: "markdown",
      privacyStatus: "sanitized_only",
      status: "queued",
      failureCode: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(CareerImportListSchema.parse({ imports: [{ ...base, candidateFactCount: 0 }] }))
      .toMatchObject({ imports: [expect.objectContaining({ candidateFactCount: 0 })] });
    expect(CreateCareerImportResponseSchema.parse({ ...base, reused: false, detailUrl: `/v1/career-documents/imports/${base.importId}` }))
      .toMatchObject({ reused: false, detailUrl: expect.stringContaining(base.importId) });
    expect(() => CareerImportListSchema.parse({ imports: [{ ...base, candidateFactCount: -1 }] })).toThrow();
    expect(() => CreateCareerImportResponseSchema.parse({ ...base, reused: false })).toThrow();
  });
});
