import { z } from "zod";

export const JOB_TRIAGE_GATES = [
  "location", "work_mode", "relocation", "salary", "seniority",
  "education", "language", "work_eligibility", "deal_breakers",
] as const;
export const JOB_TRIAGE_MAX_EVIDENCE_ITEMS = 20;
export const JOB_TRIAGE_MAX_REQUIRED_SKILL_GAPS = 100;
export const JOB_TRIAGE_MAX_JOB_EVIDENCE_VALUE_LENGTH = 512;
export const JOB_TRIAGE_MAX_CANDIDATE_EVIDENCE_VALUE_LENGTH = 256;
export const JobTriageGateSchema = z.enum(JOB_TRIAGE_GATES);
const gate = JobTriageGateSchema;
const verdict = z.enum(["pass", "fail", "unknown"]);
export const JobTriageReasonCodeSchema = z.enum([
  "JOB_EVIDENCE_MISSING", "TARGET_CONSTRAINT_MISSING", "CANDIDATE_EVIDENCE_MISSING", "CANDIDATE_EVIDENCE_INSUFFICIENT", "CANDIDATE_LEVEL_INSUFFICIENT",
  "WORK_MODE_ALLOWED", "WORK_MODE_CONFLICT", "REMOTE_LOCATION_COMPATIBLE", "LOCATION_ALLOWED", "LOCATION_CONFLICT", "RELOCATION_CONFIRMATION_REQUIRED", "RELOCATION_CONFLICT", "RELOCATION_NOT_REQUIRED", "RELOCATION_WILLING",
  "SALARY_MINIMUM_NOT_SET", "SALARY_NOT_COMPARABLE", "SALARY_BELOW_MINIMUM", "SALARY_COVERS_MINIMUM", "SALARY_RANGE_INSUFFICIENT", "SENIORITY_NOT_RESTRICTED", "SENIORITY_MATCH", "SENIORITY_CONFLICT",
  "EDUCATION_MATCH", "WORK_ELIGIBILITY_MATCH", "LANGUAGE_MATCH", "LANGUAGE_CONFLICT", "DEAL_BREAKERS_NOT_ENABLED", "DEAL_BREAKER_NOT_MATCHED", "DEAL_BREAKER_MATCH", "DEAL_BREAKER_COMPANY_CONFLICT", "DEAL_BREAKER_INDUSTRY_CONFLICT", "DEAL_BREAKER_OTHER_CONFLICT",
  "DEADLINE_MISSING", "DEADLINE_INVALID", "REQUIRED_SKILLS_COMPARED", "REQUIRED_SKILLS_MISSING_NEUTRAL", "REQUIRED_SKILLS_EVIDENCE_MISSING_NEUTRAL", "EXPERIENCE_EVIDENCE_MISSING_NEUTRAL", "TARGET_ALIGNMENT_CONFIRMED", "TARGET_ALIGNMENT_EVIDENCE_MISSING_NEUTRAL", "TARGET_ALIGNMENT_EVIDENCE_INCOMPLETE_NEUTRAL",
]).or(z.string().regex(/^(EDUCATION|WORK_ELIGIBILITY)_MATCH$/));

const jobEvidence = z.object({
  sourcePostingVersionId: z.uuid(), field: z.string().trim().min(1).max(64),
  path: z.string().trim().min(1).max(256), value: z.string().trim().min(1).max(JOB_TRIAGE_MAX_JOB_EVIDENCE_VALUE_LENGTH),
}).strict();
const candidateEvidence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("target_constraint"), targetId: z.uuid(), version: z.int().min(1), path: z.string().trim().min(1).max(256), label: z.string().trim().min(1).max(64), value: z.string().trim().min(1).max(JOB_TRIAGE_MAX_CANDIDATE_EVIDENCE_VALUE_LENGTH) }).strict(),
  z.object({ kind: z.literal("profile_fact"), factId: z.uuid(), revisionId: z.uuid(), label: z.string().trim().min(1).max(64), value: z.string().trim().min(1).max(JOB_TRIAGE_MAX_CANDIDATE_EVIDENCE_VALUE_LENGTH) }).strict(),
]);
const gateResult = z.object({
  verdict, reasonCode: JobTriageReasonCodeSchema, jobEvidence: jobEvidence.nullable(), candidateEvidence: candidateEvidence.nullable(),
}).strict();

export const EvidenceGapSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("job_requirements") }).strict(),
  z.object({ kind: z.literal("profile_skills"), count: z.int().min(1).max(JOB_TRIAGE_MAX_REQUIRED_SKILL_GAPS), examples: z.array(z.string().trim().min(1).max(128)).min(1).max(JOB_TRIAGE_MAX_EVIDENCE_ITEMS) }).strict(),
  z.object({ kind: z.literal("profile_experience") }).strict(),
  z.object({ kind: z.literal("target_alignment") }).strict(),
]);

const dimensionScore = z.object({
  score: z.int().min(0).max(100), reasonCode: JobTriageReasonCodeSchema,
  jobEvidence: z.array(jobEvidence).max(JOB_TRIAGE_MAX_EVIDENCE_ITEMS), candidateEvidence: z.array(candidateEvidence).max(JOB_TRIAGE_MAX_EVIDENCE_ITEMS), missing: z.array(EvidenceGapSchema).max(JOB_TRIAGE_MAX_EVIDENCE_ITEMS),
}).strict();

export const CreateJobTriageVersionCommandSchema = z.object({ targetId: z.uuid() }).strict();
export const JobTriageVersionSchema = z.object({
  triageVersionId: z.uuid(), opportunityId: z.uuid(), targetId: z.uuid(), overallVerdict: verdict,
  gateResults: z.record(gate, gateResult),
  pendingItems: z.array(z.object({ gate, reasonCode: JobTriageReasonCodeSchema, message: z.string().trim().min(1).max(256) }).strict()).max(16),
  deadlineStatus: z.enum(["expired", "closing_soon", "valid", "missing", "invalid"]),
  confidenceBasisPoints: z.int().min(0).max(10_000),
  dimensionScores: z.object({ technical: dimensionScore, experience: dimensionScore, targetAlignment: dimensionScore }).strict().nullable(),
  overallScore: z.int().min(0).max(100).nullable(), threshold: z.int().min(0).max(100).nullable(),
  sequence: z.int().min(1),
  createdAt: z.iso.datetime(),
}).strict();

export type CreateJobTriageVersionCommand = z.infer<typeof CreateJobTriageVersionCommandSchema>;
export type JobTriageVersion = z.infer<typeof JobTriageVersionSchema>;
export type JobTriageGate = z.infer<typeof JobTriageGateSchema>;
export type JobTriageReasonCode = z.infer<typeof JobTriageReasonCodeSchema>;
export type EvidenceGap = z.infer<typeof EvidenceGapSchema>;
