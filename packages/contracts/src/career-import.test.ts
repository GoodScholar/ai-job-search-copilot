import { describe, expect, it } from "vitest";
import {
  CAREER_DOCUMENT_MAX_BYTES,
  CAREER_IMPORT_JOB_NAME,
  CAREER_IMPORT_QUEUE,
  CandidateFactSchema,
  CareerImportDetailSchema,
  CareerImportJobSchema,
  CareerImportListSchema,
  CareerParserFactSchema,
  CareerParserOutputSchema,
  CreateCareerImportResponseSchema,
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
  it("locks size, queue and task protocol", () => {
    expect(CAREER_DOCUMENT_MAX_BYTES).toBe(524_288);
    expect(CAREER_IMPORT_QUEUE).toBe("career-imports");
    expect(CAREER_IMPORT_JOB_NAME).toBe("parse-career-document");
    expect(CareerImportJobSchema.parse({ version: 1, importId: id(), userId: id() }))
      .toMatchObject({ version: 1 });
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
});
