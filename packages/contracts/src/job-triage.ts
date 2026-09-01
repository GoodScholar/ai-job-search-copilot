import { z } from "zod";

const gate = z.enum([
  "location", "work_mode", "relocation", "salary", "seniority",
  "education", "language", "work_eligibility", "deal_breakers",
]);
const verdict = z.enum(["pass", "fail", "unknown"]);

const jobEvidence = z.object({
  sourcePostingVersionId: z.uuid(), field: z.string().trim().min(1).max(64),
  path: z.string().trim().min(1).max(256), value: z.string().trim().min(1).max(512),
}).strict();
const candidateEvidence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("target_constraint"), path: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal("profile_fact"), factId: z.uuid(), revisionId: z.uuid() }).strict(),
]);
const gateResult = z.object({
  verdict, reasonCode: z.string().trim().min(1).max(96), jobEvidence: jobEvidence.nullable(), candidateEvidence: candidateEvidence.nullable(),
}).strict();

const dimensionScore = z.object({
  score: z.int().min(0).max(100), reasonCode: z.string().trim().min(1).max(96),
}).strict();

export const CreateJobTriageVersionCommandSchema = z.object({ targetId: z.uuid() }).strict();
export const JobTriageVersionSchema = z.object({
  triageVersionId: z.uuid(), opportunityId: z.uuid(), targetId: z.uuid(), overallVerdict: verdict,
  gateResults: z.record(gate, gateResult),
  pendingItems: z.array(z.object({ gate, reasonCode: z.string().trim().min(1).max(96), message: z.string().trim().min(1).max(256) }).strict()).max(16),
  deadlineStatus: z.enum(["expired", "closing_soon", "valid", "missing", "invalid"]),
  confidenceBasisPoints: z.int().min(0).max(10_000),
  dimensionScores: z.object({ technical: dimensionScore, experience: dimensionScore, targetAlignment: dimensionScore }).strict().nullable(),
  overallScore: z.int().min(0).max(100).nullable(), threshold: z.int().min(0).max(100).nullable(),
  createdAt: z.iso.datetime(),
}).strict();

export type CreateJobTriageVersionCommand = z.infer<typeof CreateJobTriageVersionCommandSchema>;
export type JobTriageVersion = z.infer<typeof JobTriageVersionSchema>;
