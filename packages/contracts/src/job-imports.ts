import { z } from "zod";
import { isJobInstructionLike, JOB_NORMALIZER_OUTPUT_SCHEMA_VERSION, JOB_NORMALIZER_PROMPT_VERSION, JOB_NORMALIZER_RULE_VERSION, JobNormalizationEvidenceSchema, type JobNormalizerMetadata } from "./job-normalizer";

export const JOB_IMPORT_MAX_BYTES = 524_288;
export const JOB_IMPORT_QUEUE = "job-imports";
export const JOB_IMPORT_JOB_NAME = "normalize-job-import";
export const JOB_IMPORT_CLAIM_LEASE_MS = 30_000;

const filename = z.string().trim().min(1).max(255).regex(/\.md$/i);
const nullableJobField = z.string().trim().min(1).max(20_000).nullable();
const qualificationEvidence = z.object({
  field: z.string().trim().min(1).max(64), path: z.string().trim().min(1).max(256), value: z.string().trim().min(1).max(2_000),
  rawValue: z.string().trim().min(1).max(2_000).optional(), normalizedValue: z.string().trim().min(1).max(2_000).optional(),
}).strict();
const evidenced = <T extends z.ZodType>(schema: T) => z.object({ value: schema, evidence: qualificationEvidence }).strict();
const nullableEvidenced = <T extends z.ZodType>(schema: T) => evidenced(schema).nullable();

export const JobQualificationEvidenceSchema = qualificationEvidence;
export const JobQualificationsSchema = z.object({
  workMode: nullableEvidenced(z.enum(["onsite", "hybrid", "remote"])),
  relocationRequired: nullableEvidenced(z.boolean()),
  salary: nullableEvidenced(z.object({
    minimum: z.int().nonnegative().nullable(), maximum: z.int().nonnegative().nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/), period: z.enum(["month", "year"]),
  }).strict().refine(({ minimum, maximum }) => minimum === null || maximum === null || minimum <= maximum)),
  seniority: nullableEvidenced(z.string().trim().min(1).max(128)),
  education: nullableEvidenced(z.string().trim().min(1).max(256)),
  languages: nullableEvidenced(z.array(z.object({ name: z.string().trim().min(1).max(128), level: z.string().trim().min(1).max(128).nullable() }).strict()).min(1).max(20)),
  workEligibility: nullableEvidenced(z.string().trim().min(1).max(256)),
  industry: nullableEvidenced(z.string().trim().min(1).max(256)),
  employmentType: nullableEvidenced(z.enum(["direct", "outsourcing", "dispatch", "headhunter"])),
  requiredSkills: nullableEvidenced(z.array(z.string().trim().min(1).max(128)).min(1).max(100)),
}).strict();
const missingQualifications = {
  workMode: null, relocationRequired: null, salary: null, seniority: null, education: null,
  languages: null, workEligibility: null, industry: null, employmentType: null, requiredSkills: null,
};
const jobPageUrl = z.string().trim().min(1).max(2_048).refine((value) => {
  try {
    const url = new URL(value);
    return /^https?:$/u.test(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}, "must be an HTTP(S) URL without credentials");

export const JobImportStatusSchema = z.enum(["imported", "normalizing", "completed", "failed"]);
export const JobImportInputTypeSchema = z.enum(["pasted_text", "markdown_upload", "url"]);
export const JobImportFailureCodeSchema = z.enum([
  "JOB_IMPORT_CONTENT_INVALID",
  "JOB_IMPORT_OBJECT_STORAGE_FAILED",
  "JOB_IMPORT_QUEUE_UNAVAILABLE",
  "JOB_IMPORT_NOT_FOUND",
  "JOB_IMPORT_CONTENT_READ_FAILED",
  "JOB_IMPORT_CHECKSUM_MISMATCH",
  "JOB_NORMALIZER_OUTPUT_INVALID",
  "JOB_NORMALIZER_EVIDENCE_INVALID",
  "JOB_NORMALIZER_INJECTION_DETECTED",
  "JOB_NORMALIZER_RATE_LIMITED",
  "JOB_NORMALIZER_CANCELLED",
  "JOB_NORMALIZER_BUDGET_EXHAUSTED",
  "JOB_NORMALIZER_UNAVAILABLE",
  "JOB_NORMALIZER_AUTH_FAILED",
  "JOB_IMPORT_PERSIST_FAILED",
  "JOB_PAGE_URL_INVALID",
  "JOB_PAGE_TARGET_REJECTED",
  "JOB_PAGE_REDIRECT_INVALID",
  "JOB_PAGE_TIMEOUT",
  "JOB_PAGE_UNREACHABLE",
  "JOB_PAGE_RESPONSE_TOO_LARGE",
  "JOB_PAGE_CONTENT_TYPE_INVALID",
  "JOB_PAGE_LISTING",
  "JOB_PAGE_LOGIN_REQUIRED",
  "JOB_PAGE_EXPIRED",
  "JOB_PAGE_RATE_LIMITED",
  "JOB_PAGE_UNRECOGNIZED",
]);

export const CreateJobImportCommandSchema = z.discriminatedUnion("inputType", [
  z.object({ inputType: z.literal("pasted_text"), content: z.string().min(1).max(JOB_IMPORT_MAX_BYTES) }).strict(),
  z.object({ inputType: z.literal("markdown_upload"), originalFilename: filename, content: z.string().min(1).max(JOB_IMPORT_MAX_BYTES) }).strict(),
  z.object({ inputType: z.literal("url"), url: jobPageUrl }).strict(),
]);

export const JobImportEvidenceSchema = z.object({
  sourcePostingId: z.uuid(),
  sourcePostingVersionId: z.uuid(),
  version: z.int().min(1),
  sourceType: z.enum(["user_import", "url_import"]),
  retrievedAt: z.iso.datetime(),
  originalFilename: filename.nullable(),
  requestedUrl: jobPageUrl.nullable().optional().default(null),
  finalUrl: jobPageUrl.nullable().optional().default(null),
  canonicalUrl: jobPageUrl.nullable().optional().default(null),
  pageClassification: z.literal("job").nullable().optional().default(null),
  sourceKind: z.enum(["official", "aggregator"]).nullable().optional().default(null),
}).strict();

export const JobImportOpportunitySchema = z.object({
  opportunityId: z.uuid(),
  company: nullableJobField,
  title: nullableJobField,
  location: nullableJobField,
  postedAt: z.iso.datetime().nullable(),
  deadline: z.iso.datetime().nullable(),
  description: nullableJobField,
  evidence: JobImportEvidenceSchema,
}).strict();

const JobImportBaseSchema = z.object({
  importId: z.uuid(),
  inputType: JobImportInputTypeSchema,
  originalFilename: filename.nullable(),
  status: JobImportStatusSchema,
  failureCode: JobImportFailureCodeSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export const CreateJobImportResponseSchema = JobImportBaseSchema.extend({
  detailUrl: z.string().startsWith("/v1/job-imports/"),
}).strict();

export const JobImportListSchema = z.object({
  imports: z.array(JobImportBaseSchema),
}).strict();

export const JobImportDetailSchema = JobImportBaseSchema.extend({
  opportunity: JobImportOpportunitySchema.nullable(),
}).strict();

export const JobImportJobSchema = z.object({
  version: z.literal(1),
  importId: z.uuid(),
  userId: z.uuid(),
}).strict();

const fieldEvidence = z.array(JobNormalizationEvidenceSchema).max(6).superRefine((items, context) => {
  const known = new Set(["company", "title", "location", "postedAt", "deadline", "description"]);
  const seen = new Set<string>();
  for (const item of items) {
    if (!known.has(item.field) || seen.has(item.field)) context.addIssue({ code: "custom", message: "field evidence must be unique and supported" });
    seen.add(item.field);
  }
});
const usage = z.object({
  status: z.enum(["known", "unknown", "not_called"]), inputTokens: z.int().nonnegative().nullable(),
  outputTokens: z.int().nonnegative().nullable(), totalTokens: z.int().nonnegative().nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === "known" && (value.inputTokens === null || value.outputTokens === null || value.totalTokens !== value.inputTokens + value.outputTokens)) context.addIssue({ code: "custom", message: "known usage requires exact token totals" });
  if (value.status !== "known" && (value.inputTokens !== null || value.outputTokens !== null || value.totalTokens !== null)) context.addIssue({ code: "custom", message: "unknown usage must not invent token counts" });
});
const modelOutput = z.object({
  company: nullableJobField,
  title: nullableJobField,
  location: nullableJobField,
  postedAt: z.iso.datetime().nullable(),
  deadline: z.iso.datetime().nullable(),
  deadlineProvenance: z.object({ field: z.literal("deadline"), path: z.string().trim().min(1).max(256), value: z.string().trim().min(1).max(512), status: z.literal("invalid") }).strict().nullable(),
  description: nullableJobField,
  qualifications: z.object({
    workMode: z.object({ value: z.enum(["onsite", "hybrid", "remote"]), evidence: JobNormalizationEvidenceSchema }).strict().nullable(),
    relocationRequired: z.object({ value: z.boolean(), evidence: JobNormalizationEvidenceSchema }).strict().nullable(),
    salary: z.object({ value: z.object({ minimum: z.int().nonnegative().nullable(), maximum: z.int().nonnegative().nullable(), currency: z.string().regex(/^[A-Z]{3}$/), period: z.enum(["month", "year"]) }).strict(), evidence: JobNormalizationEvidenceSchema }).strict().nullable(),
    seniority: z.object({ value: z.string().trim().min(1).max(128), evidence: JobNormalizationEvidenceSchema }).strict().nullable(),
    education: z.object({ value: z.string().trim().min(1).max(256), evidence: JobNormalizationEvidenceSchema }).strict().nullable(),
    languages: z.object({ value: z.array(z.object({ name: z.string().trim().min(1).max(128), level: z.string().trim().min(1).max(128).nullable() }).strict()).min(1).max(20), evidence: JobNormalizationEvidenceSchema }).strict().nullable(),
    workEligibility: z.object({ value: z.string().trim().min(1).max(256), evidence: JobNormalizationEvidenceSchema }).strict().nullable(),
    industry: z.object({ value: z.string().trim().min(1).max(256), evidence: JobNormalizationEvidenceSchema }).strict().nullable(),
    employmentType: z.object({ value: z.enum(["direct", "outsourcing", "dispatch", "headhunter"]), evidence: JobNormalizationEvidenceSchema }).strict().nullable(),
    requiredSkills: z.object({ value: z.array(z.string().trim().min(1).max(128)).min(1).max(100), evidence: JobNormalizationEvidenceSchema }).strict().nullable(),
  }).strict(),
  fieldEvidence,
}).strict();

export const JobNormalizerModelOutputSchema = modelOutput;
export const JobNormalizerOutputSchema = modelOutput.extend({
  deadlineProvenance: z.object({ field: z.literal("deadline"), path: z.string().trim().min(1).max(256), value: z.string().trim().min(1).max(512), status: z.literal("invalid") }).strict().nullable().optional().default(null),
  qualifications: JobQualificationsSchema.optional().default(missingQualifications),
  fieldEvidence: fieldEvidence.optional().default([]),
  normalizerVersion: z.string().trim().min(1).max(64),
  adapter: z.enum(["fake", "openai"]).optional().default("fake"),
  model: z.string().trim().min(1).max(128).nullable().optional().default(null),
  promptVersion: z.string().trim().min(1).max(64).optional().default(JOB_NORMALIZER_PROMPT_VERSION),
  outputSchemaVersion: z.string().trim().min(1).max(64).optional().default(JOB_NORMALIZER_OUTPUT_SCHEMA_VERSION),
  ruleVersion: z.string().trim().min(1).max(64).optional().default(JOB_NORMALIZER_RULE_VERSION),
  usage: usage.optional().default({ status: "not_called", inputTokens: null, outputTokens: null, totalTokens: null }),
}).strict();

type PersistedEvidence = z.infer<typeof JobNormalizationEvidenceSchema> & { sourcePostingVersionId: string };
type PersistedQualificationEvidence = z.infer<typeof qualificationEvidence> & { sourcePostingVersionId: string };
export type PersistedJobNormalizerOutput = Omit<JobNormalizerOutput, "fieldEvidence" | "qualifications"> & {
  fieldEvidence: PersistedEvidence[];
  qualifications: {
    [K in keyof JobQualifications]: JobQualifications[K] extends { value: infer Value; evidence: unknown } | null
      ? { value: Value; evidence: PersistedQualificationEvidence } | null
      : never;
  };
};

/** Provider output stays identity-free. Bind source identity only after the application owns a real immutable version. */
export function bindJobNormalizerOutput(sourcePostingVersionId: string, output: JobNormalizerOutput): PersistedJobNormalizerOutput {
  const parsed = JobNormalizerOutputSchema.parse(output);
  return {
    ...parsed,
    fieldEvidence: parsed.fieldEvidence.map((evidence) => ({ ...evidence, sourcePostingVersionId })),
    qualifications: Object.fromEntries(Object.entries(parsed.qualifications).map(([field, qualification]) => [field,
      qualification === null ? null : { ...qualification, evidence: { ...qualification.evidence, sourcePostingVersionId } },
    ])) as PersistedJobNormalizerOutput["qualifications"],
  };
}

/** Reconstruct and validate the strict provider contract without ever accepting a model-supplied source identity. */
export function validatePersistedJobNormalizerOutput(value: unknown, input: { sourcePostingVersionId: string; metadata?: JobNormalizerMetadata }): JobNormalizerOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JOB_NORMALIZER_PERSISTED_OUTPUT_INVALID");
  const persisted = value as Record<string, unknown>;
  const fieldEvidence = Array.isArray(persisted.fieldEvidence) ? persisted.fieldEvidence.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || (item as Record<string, unknown>).sourcePostingVersionId !== input.sourcePostingVersionId) throw new Error("JOB_NORMALIZER_PERSISTED_EVIDENCE_INVALID");
    const { sourcePostingVersionId: _sourcePostingVersionId, ...evidence } = item as Record<string, unknown>;
    return evidence;
  }) : persisted.fieldEvidence;
  const qualifications = persisted.qualifications && typeof persisted.qualifications === "object" && !Array.isArray(persisted.qualifications)
    ? Object.fromEntries(Object.entries(persisted.qualifications as Record<string, unknown>).map(([field, qualification]) => {
      if (qualification === null) return [field, null];
      if (!qualification || typeof qualification !== "object" || Array.isArray(qualification)) throw new Error("JOB_NORMALIZER_PERSISTED_EVIDENCE_INVALID");
      const item = qualification as { evidence?: unknown };
      if (!item.evidence || typeof item.evidence !== "object" || Array.isArray(item.evidence) || (item.evidence as Record<string, unknown>).sourcePostingVersionId !== input.sourcePostingVersionId) throw new Error("JOB_NORMALIZER_PERSISTED_EVIDENCE_INVALID");
      const { sourcePostingVersionId: _sourcePostingVersionId, ...evidence } = item.evidence as Record<string, unknown>;
      return [field, { ...item, evidence }];
    }))
    : persisted.qualifications;
  const output = JobNormalizerOutputSchema.parse({ ...persisted, fieldEvidence, qualifications });
  if (input.metadata && (output.adapter !== input.metadata.adapter || output.normalizerVersion !== input.metadata.normalizerVersion || output.promptVersion !== input.metadata.promptVersion || output.outputSchemaVersion !== input.metadata.outputSchemaVersion || output.ruleVersion !== input.metadata.ruleVersion || output.model !== input.metadata.model)) throw new Error("JOB_NORMALIZER_PERSISTED_METADATA_INVALID");
  return output;
}

export function validateJobNormalizerOutput(content: string, output: JobNormalizerOutput): boolean {
  // Historical snapshots and test seams predate call accounting. They remain readable,
  // while every configured v2 adapter reports known usage and must satisfy full proof.
  if (output.usage.status !== "known") return true;
  if (isJobInstructionLike(content)) return false;
  const evidenceByField = new Map(output.fieldEvidence.map((item) => [item.field, item]));
  for (const field of ["company", "title", "location", "postedAt", "deadline", "description"] as const) {
    const value = output[field];
    const evidence = evidenceByField.get(field);
    if (value === null ? Boolean(evidence) : !evidence || evidence.normalizedValue !== value || !evidenceMatchesPath(content, evidence.path, evidence.rawValue) || !matchesScalarNormalization(field, evidence.rawValue, value)) return false;
  }
  if (output.deadlineProvenance) {
    const provenance = output.deadlineProvenance;
    if (output.deadline !== null || !evidenceMatchesPath(content, provenance.path, provenance.value) || !Number.isNaN(new Date(provenance.value).getTime())) return false;
  }
  return Object.entries(output.qualifications).every(([field, qualification]) => !qualification || Boolean(qualification.evidence.rawValue && qualification.evidence.normalizedValue) && qualification.evidence.field === field && evidenceMatchesPath(content, qualification.evidence.path, qualification.evidence.rawValue!) && qualification.evidence.normalizedValue === normalizedQualificationValue(qualification.value) && matchesQualificationNormalization(field, qualification.evidence.rawValue!, qualification.value));
}

/** Add the legacy display value only after strict provider output has passed its schema. */
export function bindStrictJobNormalizerOutput(raw: z.infer<typeof JobNormalizerModelOutputSchema>, metadata: JobNormalizerMetadata & { usage: import("./job-normalizer").JobNormalizerUsage }): JobNormalizerOutput {
  return JobNormalizerOutputSchema.parse({
    ...raw, ...metadata,
    qualifications: Object.fromEntries(Object.entries(raw.qualifications).map(([field, qualification]) => [field, qualification === null ? null : { ...qualification, evidence: { ...qualification.evidence, value: qualification.evidence.rawValue } }])),
  });
}

function evidenceMatchesPath(content: string, path: string, rawValue: string): boolean {
  const match = /^lines:(\d+)-(\d+)$/u.exec(path);
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const lines = content.split(/\r\n|\r|\n/u);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length) return false;
  return lines.slice(start - 1, end).join("\n").includes(rawValue);
}

function matchesScalarNormalization(field: string, rawValue: string, normalizedValue: string): boolean {
  if (rawValue === normalizedValue) return true;
  if (field !== "postedAt" && field !== "deadline") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(rawValue)) return false;
  const date = new Date(rawValue);
  return !Number.isNaN(date.getTime()) && date.toISOString() === normalizedValue;
}

function normalizedQualificationValue(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value); }

function matchesQualificationNormalization(field: string, rawValue: string, value: unknown): boolean {
  const raw = rawValue.trim();
  if (["seniority", "education", "workEligibility", "industry"].includes(field)) return raw === value;
  if (field === "workMode") return ({ "现场": "onsite", "混合": "hybrid", "远程": "remote", onsite: "onsite", hybrid: "hybrid", remote: "remote" } as Record<string, string>)[raw.toLowerCase()] === value;
  if (field === "relocationRequired") return ({ "是": true, "否": false, yes: true, no: false, true: true, false: false } as Record<string, boolean>)[raw.toLowerCase()] === value;
  if (field === "employmentType") return ({ "直接雇佣": "direct", "外包": "outsourcing", "派遣": "dispatch", "猎头": "headhunter", direct: "direct", outsourcing: "outsourcing", dispatch: "dispatch", headhunter: "headhunter" } as Record<string, string>)[raw.toLowerCase()] === value;
  if (field === "salary") {
    const match = raw.match(/^([A-Z]{3})\s+(\d+)(?:-(\d+))\/(month|year)$/u);
    return Boolean(match) && JSON.stringify({ minimum: Number(match![2]), maximum: match![3] ? Number(match![3]) : null, currency: match![1], period: match![4] }) === JSON.stringify(value);
  }
  if (field === "requiredSkills") return JSON.stringify(raw.split(/[,，]/u).map((item) => item.trim()).filter(Boolean)) === JSON.stringify(value);
  if (field === "languages") return JSON.stringify(raw.split(/[,，]/u).map((item) => item.trim()).filter(Boolean).map((item) => { const [name, level] = item.split(/\s*\(([^)]+)\)\s*/u); return { name: name!.trim(), level: level?.trim() || null }; })) === JSON.stringify(value);
  return false;
}

export type CreateJobImportCommand = z.infer<typeof CreateJobImportCommandSchema>;
export type CreateJobImportResponse = z.infer<typeof CreateJobImportResponseSchema>;
export type JobImportStatus = z.infer<typeof JobImportStatusSchema>;
export type JobImportInputType = z.infer<typeof JobImportInputTypeSchema>;
export type JobImportFailureCode = z.infer<typeof JobImportFailureCodeSchema>;
export type JobImportList = z.infer<typeof JobImportListSchema>;
export type JobImportDetail = z.infer<typeof JobImportDetailSchema>;
export type JobImportJob = z.infer<typeof JobImportJobSchema>;
export type JobNormalizerOutput = z.infer<typeof JobNormalizerOutputSchema>;
export type JobQualifications = z.infer<typeof JobQualificationsSchema>;
export const FAKE_JOB_NORMALIZER_METADATA: JobNormalizerMetadata = {
  adapter: "fake", normalizerVersion: "fake-job-normalizer-v2", promptVersion: JOB_NORMALIZER_PROMPT_VERSION,
  outputSchemaVersion: JOB_NORMALIZER_OUTPUT_SCHEMA_VERSION, ruleVersion: JOB_NORMALIZER_RULE_VERSION, model: null,
};
