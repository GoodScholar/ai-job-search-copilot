import { z } from "zod";

export const JOB_IMPORT_MAX_BYTES = 524_288;
export const JOB_IMPORT_QUEUE = "job-imports";
export const JOB_IMPORT_JOB_NAME = "normalize-job-import";
export const JOB_IMPORT_CLAIM_LEASE_MS = 30_000;

const filename = z.string().trim().min(1).max(255).regex(/\.md$/i);
const nullableJobField = z.string().trim().min(1).max(20_000).nullable();
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

export const JobNormalizerOutputSchema = z.object({
  normalizerVersion: z.string().trim().min(1).max(64),
  company: nullableJobField,
  title: nullableJobField,
  location: nullableJobField,
  postedAt: z.iso.datetime().nullable(),
  deadline: z.iso.datetime().nullable(),
  description: nullableJobField,
}).strict();

export type CreateJobImportCommand = z.infer<typeof CreateJobImportCommandSchema>;
export type CreateJobImportResponse = z.infer<typeof CreateJobImportResponseSchema>;
export type JobImportStatus = z.infer<typeof JobImportStatusSchema>;
export type JobImportInputType = z.infer<typeof JobImportInputTypeSchema>;
export type JobImportFailureCode = z.infer<typeof JobImportFailureCodeSchema>;
export type JobImportList = z.infer<typeof JobImportListSchema>;
export type JobImportDetail = z.infer<typeof JobImportDetailSchema>;
export type JobImportJob = z.infer<typeof JobImportJobSchema>;
export type JobNormalizerOutput = z.infer<typeof JobNormalizerOutputSchema>;
