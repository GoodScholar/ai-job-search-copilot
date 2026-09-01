import { z } from "zod";

export const DEEP_MATCH_DIMENSIONS = [
  "skills",
  "experience",
  "project_depth",
  "career_direction",
  "location_logistics",
  "qualification_risk",
] as const;
export const DEEP_MATCH_MAX_CANDIDATES = 10;
export const DEEP_MATCH_OUTPUT_SCHEMA_VERSION = "deep-match-result-v1";
export const FAKE_DEEP_MATCH_ADAPTER = "fake-deep-match";
export const FAKE_DEEP_MATCH_ADAPTER_VERSION = "fake-deep-match-v1";

const evidenceId = z.string().trim().min(1).max(128);
const assessmentDimension = z.enum(DEEP_MATCH_DIMENSIONS);
const judgment = z.enum(["evidence_backed_inference", "insufficient_evidence"]);

export const DeepMatchAssessmentSchema = z.object({
  opportunityId: z.uuid(),
  overallScore: z.int().min(0).max(100),
  dimensions: z.array(z.object({
    dimension: assessmentDimension,
    score: z.int().min(0).max(100),
    judgment,
    jobEvidenceIds: z.array(evidenceId).max(20),
    profileEvidenceIds: z.array(evidenceId).max(20),
    summary: z.string().trim().min(1).max(500),
  }).strict()).length(DEEP_MATCH_DIMENSIONS.length),
}).strict().superRefine((assessment, context) => {
  const dimensions = assessment.dimensions.map((item) => item.dimension);
  if (new Set(dimensions).size !== DEEP_MATCH_DIMENSIONS.length) {
    context.addIssue({ code: "custom", path: ["dimensions"], message: "six dimensions must be unique" });
  }
  assessment.dimensions.forEach((item, index) => {
    const evidenceBacked = item.judgment === "evidence_backed_inference";
    if (evidenceBacked && (!item.jobEvidenceIds.length || !item.profileEvidenceIds.length)) {
      context.addIssue({ code: "custom", path: ["dimensions", index], message: "evidence-backed inference requires both evidence sides" });
    }
    if (!evidenceBacked && (item.jobEvidenceIds.length || item.profileEvidenceIds.length)) {
      context.addIssue({ code: "custom", path: ["dimensions", index], message: "insufficient evidence cannot assert citations" });
    }
  });
});

export type DeepMatchAssessment = z.infer<typeof DeepMatchAssessmentSchema>;

export const DeepMatchCandidateSchema = z.object({
  opportunityId: z.uuid(),
  sourcePostingVersionId: z.uuid(),
  jobEvidence: z.array(z.object({ id: evidenceId, value: z.string().trim().min(1).max(512) }).strict()).min(1).max(20),
  profileEvidence: z.array(z.object({ id: evidenceId, profileFactRevisionId: z.uuid(), value: z.string().trim().min(1).max(256) }).strict()).min(1).max(20),
}).strict();
export type DeepMatchCandidate = z.infer<typeof DeepMatchCandidateSchema>;

export const DeepMatchAdapterInputSchema = z.object({ candidates: z.array(DeepMatchCandidateSchema).max(DEEP_MATCH_MAX_CANDIDATES) }).strict();
export type DeepMatchAdapterInput = z.infer<typeof DeepMatchAdapterInputSchema>;

export const DeepMatchAdapterFailureCategorySchema = z.enum(["retryable", "auth", "policy", "invalid_output"]);
export type DeepMatchAdapterFailureCategory = z.infer<typeof DeepMatchAdapterFailureCategorySchema>;

/** #35 的生产适配器必须使用同一稳定分类，不能把 provider 文本泄露到运行状态。 */
export class DeepMatchAdapterError extends Error {
  constructor(readonly category: DeepMatchAdapterFailureCategory) { super(`DEEP_MATCH_${category.toUpperCase()}`); }
}

export const FAKE_DEEP_MATCH_TOKEN_USAGE = { inputTokens: 32, outputTokens: 48 } as const;
/** Deterministic CI fixture only; no model or network is involved. */
export const FAKE_DEEP_MATCH_QUALITY_INSUFFICIENT_MARKER = "MATCH_QUALITY_INSUFFICIENT";
export type DeepMatchAdapterCall = {
  signal: AbortSignal;
  usageKey: string;
  budget: { maxTokens: number; reservedInputTokens: number; reservedOutputTokens: number };
  /** Test-only fixture data is passed through the adapter seam, never job text. */
  fixture?: { qualityInsufficientOpportunityIds?: readonly string[] };
};

export const DeepMatchAdapterUsageSchema = z.object({
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  latencyMs: z.int().min(0),
}).strict();
export type DeepMatchAdapterUsage = z.infer<typeof DeepMatchAdapterUsageSchema>;
export const DeepMatchAdapterResultSchema = z.object({
  assessments: z.array(DeepMatchAssessmentSchema),
  usage: DeepMatchAdapterUsageSchema,
}).strict();
export type DeepMatchAdapterResult = z.infer<typeof DeepMatchAdapterResultSchema>;

export interface DeepMatchAdapter {
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly model: string;
  assess(input: DeepMatchAdapterInput, call: DeepMatchAdapterCall): Promise<DeepMatchAdapterResult>;
}

/** Reject responses that cite untrusted or out-of-scope inputs before persistence. */
export function validateDeepMatchEvidenceClosure(
  assessment: DeepMatchAssessment,
  available: { jobEvidenceIds: readonly string[]; profileEvidenceIds: readonly string[] },
): DeepMatchAssessment {
  const job = new Set(available.jobEvidenceIds);
  const profile = new Set(available.profileEvidenceIds);
  for (const dimension of assessment.dimensions) {
    if (dimension.jobEvidenceIds.some((id) => !job.has(id)) || dimension.profileEvidenceIds.some((id) => !profile.has(id))) {
      throw new Error("model citation is outside the evidence closure");
    }
  }
  return assessment;
}

/** CI-only deterministic adapter. It never uses a network or a production model. */
export class FakeDeepMatchAdapter implements DeepMatchAdapter {
  readonly adapter = FAKE_DEEP_MATCH_ADAPTER;
  readonly adapterVersion = FAKE_DEEP_MATCH_ADAPTER_VERSION;
  readonly model = "fake-deep-match-model-v1";

  async assess(input: DeepMatchAdapterInput, call: DeepMatchAdapterCall): Promise<DeepMatchAdapterResult> {
    if (call.signal.aborted) throw new DeepMatchAdapterError("retryable");
    const parsed = DeepMatchAdapterInputSchema.parse(input);
    const insufficient = new Set(call.fixture?.qualityInsufficientOpportunityIds ?? []);
    const assessments = parsed.candidates.map((candidate) => {
      const score = insufficient.has(candidate.opportunityId) ? 50 : 80;
      const assessment = DeepMatchAssessmentSchema.parse({
        opportunityId: candidate.opportunityId,
        overallScore: score,
        dimensions: DEEP_MATCH_DIMENSIONS.map((dimension) => ({
          dimension,
          score,
          judgment: "evidence_backed_inference",
          jobEvidenceIds: [candidate.jobEvidence[0]!.id],
          profileEvidenceIds: [candidate.profileEvidence[0]!.id],
          summary: "基于岗位要求与已确认画像事实的匹配推断。",
        })),
      });
      return validateDeepMatchEvidenceClosure(assessment, {
        jobEvidenceIds: candidate.jobEvidence.map((item) => item.id),
        profileEvidenceIds: candidate.profileEvidence.map((item) => item.id),
      });
    });
    return { assessments, usage: { ...FAKE_DEEP_MATCH_TOKEN_USAGE, latencyMs: 0 } };
  }
}
