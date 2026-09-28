import { z } from "zod";

export const JobOpportunityArchiveFilterSchema = z.enum(["active", "archived"]);
export const JobOpportunityArchiveStateSchema = z.object({
  archivedAt: z.iso.datetime().nullable(),
  version: z.int().nonnegative(),
}).strict();
export const JobOpportunityArchiveCommandSchema = z.object({
  action: z.enum(["archive", "restore"]),
  commandId: z.uuid(),
  expectedVersion: z.int().nonnegative(),
}).strict();
export const JobOpportunityArchiveCommandResponseSchema = z.object({
  applied: z.boolean(),
  state: JobOpportunityArchiveStateSchema,
}).strict();
export const JobOpportunityArchiveItemSchema = z.object({
  opportunityId: z.uuid(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  location: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.int().nonnegative(),
}).strict();
export const JobOpportunityArchivePageSchema = z.object({
  items: z.array(JobOpportunityArchiveItemSchema),
  nextCursor: z.uuid().nullable(),
  counts: z.object({ active: z.int().nonnegative(), archived: z.int().nonnegative() }).strict(),
}).strict();

export type JobOpportunityArchiveFilter = z.infer<typeof JobOpportunityArchiveFilterSchema>;
export type JobOpportunityArchiveState = z.infer<typeof JobOpportunityArchiveStateSchema>;
export type JobOpportunityArchiveCommand = z.infer<typeof JobOpportunityArchiveCommandSchema>;
export type JobOpportunityArchiveCommandResponse = z.infer<typeof JobOpportunityArchiveCommandResponseSchema>;
export type JobOpportunityArchiveItem = z.infer<typeof JobOpportunityArchiveItemSchema>;
export type JobOpportunityArchivePage = z.infer<typeof JobOpportunityArchivePageSchema>;
