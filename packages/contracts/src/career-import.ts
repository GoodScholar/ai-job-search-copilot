import { z } from "zod";
import { ProfileSnapshotSchema } from "./profile-review";

export const CAREER_DOCUMENT_MAX_BYTES = 524_288;
export const CAREER_IMPORT_MAX_FACTS = 500;
export const CAREER_IMPORT_QUEUE = "career-imports";
export const CAREER_IMPORT_JOB_NAME = "parse-career-document";
export const CAREER_PARSER_PROMPT_VERSION = "career-import-prompt-v1";
export const CAREER_PARSER_OUTPUT_SCHEMA_VERSION = "career-facts-v1";
export const FAKE_CAREER_PARSER_METADATA = {
  adapter: "fake", parserVersion: "fake-career-parser-v1", promptVersion: CAREER_PARSER_PROMPT_VERSION,
  outputSchemaVersion: CAREER_PARSER_OUTPUT_SCHEMA_VERSION, model: null,
} as const;
export const DEFAULT_CAREER_PARSER_BUDGET = { maxInputBytes: 16_384, maxOutputTokens: 4_000, maxTotalTokens: 20_000, timeoutMs: 25_000 } as const;
export type CareerParserBudget = { maxInputBytes: number; maxOutputTokens: number; maxTotalTokens?: number; timeoutMs: number };
export type CareerParserCallOptions = { signal?: AbortSignal; budget?: CareerParserBudget };
export type CareerParserMetadata = {
  adapter: "fake" | "openai"; parserVersion: string; promptVersion: string;
  outputSchemaVersion: string; model: string | null;
};
export type CareerParserErrorCode = "CAREER_PARSER_OUTPUT_INVALID" | "CAREER_PARSER_RATE_LIMITED" | "CAREER_PARSER_CANCELLED" | "CAREER_PARSER_BUDGET_EXHAUSTED" | "CAREER_PARSER_UNAVAILABLE" | "CAREER_PARSER_AUTH_FAILED" | "CAREER_PARSER_PRIVACY_UNVERIFIED";
export class CareerParserError extends Error {
  constructor(readonly code: CareerParserErrorCode) { super(code); }
}

export function numberedCareerMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/gu, "\n").split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n");
}

/** UTF-8 字节数作为保守 Token 上界，另预留固定指令与 Schema 开销。 */
export function assertCareerParserInputBudget(markdown: string, options: CareerParserCallOptions) {
  if (options.signal?.aborted) throw new CareerParserError("CAREER_PARSER_CANCELLED");
  const budget = options.budget ?? DEFAULT_CAREER_PARSER_BUDGET;
  const maxTotalTokens = budget.maxTotalTokens ?? DEFAULT_CAREER_PARSER_BUDGET.maxTotalTokens;
  const encoder = new TextEncoder();
  const inputTokenBound = encoder.encode(JSON.stringify(numberedCareerMarkdown(markdown))).byteLength + 1500;
  if (![budget.maxInputBytes, budget.maxOutputTokens, budget.timeoutMs, maxTotalTokens].every((value) => Number.isSafeInteger(value) && value > 0)
    || encoder.encode(markdown).byteLength > budget.maxInputBytes || inputTokenBound + budget.maxOutputTokens > maxTotalTokens)
    throw new CareerParserError("CAREER_PARSER_BUDGET_EXHAUSTED");
  return { ...budget, maxTotalTokens, inputTokenBound };
}

const filename = z.string().trim().min(1).max(255).regex(/\.(?:md|docx|pdf)$/i);
const confidenceBasisPoints = z.int().min(0).max(10_000);

const markdownParserEvidence = z.object({
  locatorType: z.literal("markdown_lines"),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  excerpt: z.string().min(1).max(2_000).refine((excerpt) => excerpt.trim().length > 0),
}).strict().refine(({ startLine, endLine }) => startLine <= endLine, {
  path: ["endLine"],
  message: "endLine must be greater than or equal to startLine",
});

const docxParserEvidence = z.object({
  locatorType: z.literal("docx_paragraphs"),
  startParagraph: z.int().min(1),
  endParagraph: z.int().min(1),
  excerpt: z.string().min(1).max(2_000).refine((excerpt) => excerpt.trim().length > 0),
}).strict().refine(({ startParagraph, endParagraph }) => startParagraph <= endParagraph, {
  path: ["endParagraph"], message: "endParagraph must be greater than or equal to startParagraph",
});

const parserEvidence = z.discriminatedUnion("locatorType", [markdownParserEvidence, docxParserEvidence]);

const markdownCandidateEvidence = z.object({
  documentId: z.uuid(),
  sourceFilename: filename,
  locatorType: z.literal("markdown_lines"),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  excerpt: z.string().min(1).max(2_000).refine((excerpt) => excerpt.trim().length > 0),
}).strict().refine(({ startLine, endLine }) => startLine <= endLine, {
  path: ["endLine"],
  message: "endLine must be greater than or equal to startLine",
});

const docxCandidateEvidence = z.object({
  documentId: z.uuid(), sourceFilename: filename, locatorType: z.literal("docx_paragraphs"),
  startParagraph: z.int().min(1), endParagraph: z.int().min(1),
  excerpt: z.string().min(1).max(2_000).refine((excerpt) => excerpt.trim().length > 0),
}).strict().refine(({ startParagraph, endParagraph }) => startParagraph <= endParagraph, {
  path: ["endParagraph"], message: "endParagraph must be greater than or equal to startParagraph",
});

const pdfCandidateEvidence = z.object({
  documentId: z.uuid(), sourceFilename: filename, locatorType: z.literal("pdf_pages"),
  startPage: z.int().min(1), endPage: z.int().min(1),
  excerpt: z.string().min(1).max(2_000).refine((excerpt) => excerpt.trim().length > 0),
}).strict().refine(({ startPage, endPage }) => startPage <= endPage, {
  path: ["endPage"], message: "endPage must be greater than or equal to startPage",
});

const candidateEvidence = z.discriminatedUnion("locatorType", [markdownCandidateEvidence, docxCandidateEvidence, pdfCandidateEvidence]);

const namedValue = z.object({ name: z.string().trim().min(1).max(500) }).strict();
const summaryValue = z.object({ summary: z.string().trim().min(1).max(2_000) }).strict();
const languageValue = z.object({
  name: z.string().trim().min(1).max(200),
  level: z.string().trim().min(1).max(200).optional(),
}).strict();

const parserFact = (factType: "skill" | "certification" | "language" | "experience" | "education" | "project" | "achievement", factValue: typeof namedValue | typeof summaryValue | typeof languageValue) => z.object({
  factType: z.literal(factType),
  factValue,
  confidenceBasisPoints,
  grounding: z.literal("quoted"),
  evidence: parserEvidence,
}).strict();

const candidateFact = (factType: "skill" | "certification" | "language" | "experience" | "education" | "project" | "achievement", factValue: typeof namedValue | typeof summaryValue | typeof languageValue) => z.object({
  factId: z.uuid(),
  factType: z.literal(factType),
  factValue,
  confidenceBasisPoints,
  confirmationStatus: z.literal("pending"),
  createdAt: z.iso.datetime(),
  evidence: candidateEvidence,
}).strict();

export const CareerParserFactSchema = z.discriminatedUnion("factType", [
  parserFact("skill", namedValue),
  parserFact("certification", namedValue),
  parserFact("language", languageValue),
  parserFact("experience", summaryValue),
  parserFact("education", summaryValue),
  parserFact("project", summaryValue),
  parserFact("achievement", summaryValue),
]);

export const CandidateFactSchema = z.discriminatedUnion("factType", [
  candidateFact("skill", namedValue),
  candidateFact("certification", namedValue),
  candidateFact("language", languageValue),
  candidateFact("experience", summaryValue),
  candidateFact("education", summaryValue),
  candidateFact("project", summaryValue),
  candidateFact("achievement", summaryValue),
]);

export const CareerImportStatusSchema = z.enum(["queued", "processing", "completed", "failed"]);
export const CareerDocumentSourceFormatSchema = z.enum(["markdown", "docx", "pdf"]);
export const CareerDocumentPrivacyStatusSchema = z.enum([
  "legacy_unreviewed",
  "sanitized_only",
  "sanitized_with_protected_original",
]);

export const CareerImportPathSchema = z.object({
  importId: z.uuid(),
}).strict();

export const CareerImportFailureCodeSchema = z.enum([
  "CAREER_IMPORT_QUEUE_UNAVAILABLE",
  "CAREER_DOCUMENT_NOT_FOUND",
  "CAREER_DOCUMENT_READ_FAILED",
  "CAREER_DOCUMENT_PRIVACY_UNVERIFIED",
  "CAREER_DOCUMENT_CHECKSUM_MISMATCH",
  "CAREER_IMPORT_FACT_LIMIT_EXCEEDED",
  "CAREER_PARSER_OUTPUT_INVALID",
  "CAREER_PARSER_EVIDENCE_INVALID",
  "CAREER_PARSER_RATE_LIMITED",
  "CAREER_PARSER_CANCELLED",
  "CAREER_PARSER_BUDGET_EXHAUSTED",
  "CAREER_PARSER_AUTH_FAILED",
  "CAREER_PARSER_PRIVACY_UNVERIFIED",
  "CAREER_PARSER_UNAVAILABLE",
  "NO_SUPPORTED_FACTS",
  "CAREER_IMPORT_PERSIST_FAILED",
]);

const CareerImportBaseSchema = z.object({
  importId: z.uuid(),
  documentId: z.uuid(),
  sourceFilename: filename,
  sourceFormat: CareerDocumentSourceFormatSchema,
  privacyStatus: CareerDocumentPrivacyStatusSchema,
  status: CareerImportStatusSchema,
  failureCode: CareerImportFailureCodeSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export const CareerImportSummarySchema = CareerImportBaseSchema.extend({
  candidateFactCount: z.int().min(0),
}).strict();

export const CareerImportListSchema = z.object({
  imports: z.array(CareerImportSummarySchema),
}).strict();

const CareerFactConflictBaseSchema = z.object({
  conflictId: z.uuid(), kind: z.enum(["date", "role", "organization", "metric"]),
  existingFact: CandidateFactSchema, incomingFact: CandidateFactSchema,
}).strict();
export const CareerFactConflictSchema = z.discriminatedUnion("status", [
  CareerFactConflictBaseSchema.extend({ status: z.literal("pending"), resolution: z.null(), profileVersion: z.null(), resolvedAt: z.null() }).strict(),
  CareerFactConflictBaseSchema.extend({ status: z.literal("resolved"), resolution: z.enum(["use_existing", "use_incoming", "keep_both"]), profileVersion: z.int().min(1), resolvedAt: z.iso.datetime() }).strict(),
]);

export const ResolveCareerFactConflictCommandSchema = z.object({
  expectedVersion: z.int().min(0), resolution: z.enum(["use_existing", "use_incoming", "keep_both"]),
}).strict();
export const ResolvedCareerFactConflictSchema = z.object({
  conflictId: z.uuid(), kind: z.enum(["date", "role", "organization", "metric"]), status: z.literal("resolved"),
  resolution: z.enum(["use_existing", "use_incoming", "keep_both"]), profileVersion: z.int().min(1), resolvedAt: z.iso.datetime(),
}).strict();
export const ResolveCareerFactConflictResponseSchema = z.object({ profile: ProfileSnapshotSchema, conflict: ResolvedCareerFactConflictSchema }).strict();

export const CareerImportDetailSchema = z.object({
  importId: z.uuid(),
  documentId: z.uuid(),
  sourceFilename: filename,
  sourceFormat: CareerDocumentSourceFormatSchema,
  privacyStatus: CareerDocumentPrivacyStatusSchema,
  status: CareerImportStatusSchema,
  failureCode: CareerImportFailureCodeSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  facts: z.array(CandidateFactSchema).max(CAREER_IMPORT_MAX_FACTS),
  conflicts: z.array(CareerFactConflictSchema).default([]),
}).strict();

export const CreateCareerImportResponseSchema = CareerImportBaseSchema.extend({
  reused: z.boolean(),
  detailUrl: z.string().startsWith("/v1/career-documents/imports/"),
}).strict();

const parserOutputBase = {
  promptVersion: z.literal(CAREER_PARSER_PROMPT_VERSION),
  outputSchemaVersion: z.literal(CAREER_PARSER_OUTPUT_SCHEMA_VERSION),
  facts: z.array(CareerParserFactSchema).max(CAREER_IMPORT_MAX_FACTS),
};
export const CareerParserOutputSchema = z.discriminatedUnion("adapter", [
  z.object({ ...parserOutputBase, adapter: z.literal("fake"), parserVersion: z.literal("fake-career-parser-v1") }).strict(),
  z.object({ ...parserOutputBase, adapter: z.literal("openai"), parserVersion: z.string().regex(/^openai-career-parser-v1-[0-9a-f]{16}$/), model: z.string().min(1).max(128) }).strict(),
]);

export const CareerImportJobSchema = z.object({
  version: z.literal(1),
  importId: z.uuid(),
  userId: z.uuid(),
}).strict();

export type CareerParserFact = z.infer<typeof CareerParserFactSchema>;
export type CandidateFact = z.infer<typeof CandidateFactSchema>;
export type CareerImportStatus = z.infer<typeof CareerImportStatusSchema>;
export type CareerDocumentSourceFormat = z.infer<typeof CareerDocumentSourceFormatSchema>;
export type CareerDocumentPrivacyStatus = z.infer<typeof CareerDocumentPrivacyStatusSchema>;
export type CareerImportFailureCode = z.infer<typeof CareerImportFailureCodeSchema>;
export type CareerImportSummary = z.infer<typeof CareerImportSummarySchema>;
export type CareerImportList = z.infer<typeof CareerImportListSchema>;
export type CareerImportDetail = z.infer<typeof CareerImportDetailSchema>;
export type CareerFactConflict = z.infer<typeof CareerFactConflictSchema>;
export type ResolveCareerFactConflictCommand = z.infer<typeof ResolveCareerFactConflictCommandSchema>;
export type ResolveCareerFactConflictResponse = z.infer<typeof ResolveCareerFactConflictResponseSchema>;
export type CreateCareerImportResponse = z.infer<typeof CreateCareerImportResponseSchema>;
export type CareerParserOutput = z.infer<typeof CareerParserOutputSchema>;

export function isCareerInstructionLike(line: string): boolean {
  const value = line.replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)])\s+/u, "").trim();
  return /^(?:忽略(?:之前|以上|上述|所有|前面).{0,12}(?:指令|要求|规则)|你现在是|从现在开始(?:你|请)|ignore (?:all |any )?(?:previous|prior|above) instructions|system\s*:|developer\s*:)/iu.test(value);
}
export type CareerImportJob = z.infer<typeof CareerImportJobSchema>;

const quotedListItemPattern = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;
const markdownHeadingPattern = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;

export function parseMarkdownHeading(line: string): { level: number; text: string } | null {
  const heading = line.match(markdownHeadingPattern);
  if (!heading) return null;
  return { level: heading[1].length, text: heading[2].trim() };
}

export function parseQuotedCareerFactValue(
  factType: CareerParserFact["factType"],
  excerpt: string,
): CareerParserFact["factValue"] | null {
  const content = (excerpt.match(quotedListItemPattern)?.[1] ?? parseMarkdownHeading(excerpt)?.text)?.trim();
  if (!content) return null;

  if (factType === "skill" || factType === "certification") return { name: content };
  if (factType === "language") {
    const language = content.match(/^(.+?)[：:]\s*(.+)$/);
    return language ? { name: language[1].trim(), level: language[2].trim() } : { name: content };
  }
  return { summary: content };
}
