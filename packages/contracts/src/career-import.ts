import { z } from "zod";
import { ProfileSnapshotSchema } from "./profile-review";

export const CAREER_DOCUMENT_MAX_BYTES = 524_288;
export const CAREER_IMPORT_MAX_FACTS = 500;
export const CAREER_IMPORT_QUEUE = "career-imports";
export const CAREER_IMPORT_JOB_NAME = "parse-career-document";

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

export const CareerParserOutputSchema = z.object({
  adapter: z.literal("fake"),
  parserVersion: z.literal("fake-career-parser-v1"),
  promptVersion: z.literal("career-import-prompt-v1"),
  outputSchemaVersion: z.literal("career-facts-v1"),
  facts: z.array(CareerParserFactSchema).max(CAREER_IMPORT_MAX_FACTS),
}).strict();

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
