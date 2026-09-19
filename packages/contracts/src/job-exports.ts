import { z } from "zod";

export const JobExportFilterSchema = z.enum(["active", "archived", "all"]);
export const JobExportCommandSchema = z.object({
  commandId: z.uuid(),
  filter: JobExportFilterSchema,
  fieldVersion: z.literal(1),
}).strict();

export const JobExportStatusSchema = z.enum(["generating", "ready", "failed", "expired"]);
export const JobExportFailureCodeSchema = z.enum(["JOB_EXPORT_GENERATION_FAILED"]);
export const JobExportSchema = z.object({
  id: z.uuid(),
  status: JobExportStatusSchema,
  filter: JobExportFilterSchema,
  fieldVersion: z.literal(1),
  rowCount: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  failureCode: JobExportFailureCodeSchema.nullable(),
}).strict();
export const JobExportListSchema = z.object({ items: z.array(JobExportSchema) }).strict();
export const JOB_EXPORT_QUEUE = "job-exports";
export const JOB_EXPORT_JOB_NAME = "generate-job-export";
export const JOB_EXPORT_FIELD_VERSION = 1;
export const JobExportJobSchema = z.object({ version: z.literal(1), exportId: z.uuid(), userId: z.uuid() }).strict();

export type JobExportFilter = z.infer<typeof JobExportFilterSchema>;
export type JobExportCommand = z.infer<typeof JobExportCommandSchema>;
export type JobExportStatus = z.infer<typeof JobExportStatusSchema>;
export type JobExportFailureCode = z.infer<typeof JobExportFailureCodeSchema>;
export type JobExport = z.infer<typeof JobExportSchema>;
export type JobExportList = z.infer<typeof JobExportListSchema>;
export type JobExportJob = z.infer<typeof JobExportJobSchema>;
