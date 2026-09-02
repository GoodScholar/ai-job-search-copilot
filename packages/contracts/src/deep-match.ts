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
  evidenceSnapshot: z.object({
    jobEvidence: z.array(z.object({ id: evidenceId, value: z.string().trim().min(1).max(512) }).strict()).max(20),
    profileEvidence: z.array(z.object({ id: evidenceId, value: z.string().trim().min(1).max(256) }).strict()).max(20),
  }).strict().optional(),
  opportunitySnapshot: z.object({
    company: z.string().nullable(),
    title: z.string().nullable(),
    location: z.string().nullable(),
  }).strict().optional(),
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

/** Shared recommendation acceptance rule.  Persistence and ADR-0029 evaluation must never drift. */
export function acceptsDeepMatchAssessment(assessment: DeepMatchAssessment): boolean {
  return assessment.overallScore >= 40
    && assessment.dimensions.filter((dimension) => dimension.judgment === "evidence_backed_inference").length >= 2;
}

/** Shared coarse-triage gate used before a candidate may enter deep matching. */
export type DeepMatchTriageEligibility = {
  sourcePostingVersionId: string;
  expectedSourcePostingVersionId: string;
  targetVersion: number;
  expectedTargetVersion: number;
  overallVerdict: string;
  deadlineStatus: string;
  availability: string;
  overallScore: number | null;
  threshold: number | null;
};

export function isDeepMatchTriageEligible(input: DeepMatchTriageEligibility): boolean {
  return input.sourcePostingVersionId === input.expectedSourcePostingVersionId
    && input.targetVersion === input.expectedTargetVersion
    && input.overallVerdict === "pass"
    && input.deadlineStatus !== "expired"
    && input.availability === "open"
    && input.overallScore !== null
    && input.threshold !== null
    && input.overallScore >= input.threshold;
}

export const DeepMatchCandidateSchema = z.object({
  opportunityId: z.uuid(),
  sourcePostingVersionId: z.uuid(),
  jobEvidence: z.array(z.object({ id: evidenceId, value: z.string().trim().min(1).max(512), dimensions: z.array(assessmentDimension).min(1).max(DEEP_MATCH_DIMENSIONS.length) }).strict()).min(1).max(20),
  profileEvidence: z.array(z.object({ id: evidenceId, profileFactRevisionId: z.uuid(), value: z.string().trim().min(1).max(256), dimensions: z.array(assessmentDimension).min(1).max(DEEP_MATCH_DIMENSIONS.length) }).strict()).min(1).max(20),
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
export type DeepMatchAdapterCall = {
  signal: AbortSignal;
  usageKey: string;
  budget: { maxTokens: number; reservedInputTokens: number; reservedOutputTokens: number };
  /** Test-only fixture data is passed through the adapter seam, never job text. */
  fixture?: { qualityInsufficientOpportunityIds?: readonly string[]; overallScoresByOpportunityId?: Readonly<Record<string, number>> };
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
  /** Frozen execution-spec reservation before an invocation; actual usage is returned by assess. */
  readonly reservedUsage: Pick<DeepMatchAdapterUsage, "inputTokens" | "outputTokens">;
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
  readonly reservedUsage = FAKE_DEEP_MATCH_TOKEN_USAGE;

  async assess(input: DeepMatchAdapterInput, call: DeepMatchAdapterCall): Promise<DeepMatchAdapterResult> {
    if (call.signal.aborted) throw new DeepMatchAdapterError("retryable");
    const parsed = DeepMatchAdapterInputSchema.parse(input);
    const insufficient = new Set(call.fixture?.qualityInsufficientOpportunityIds ?? []);
    const assessments = parsed.candidates.map((candidate) => {
      const evidenceBackedDimensions = DEEP_MATCH_DIMENSIONS.filter((dimension) => candidate.jobEvidence.some((item) => item.dimensions.includes(dimension))
        && candidate.profileEvidence.some((item) => item.dimensions.includes(dimension))).length;
      // A high band requires comprehensive two-sided evidence.  Sparse evidence remains
      // visible as a cautious result or quality exclusion; it must never be promoted by a
      // fabricated aggregate score.
      const score = insufficient.has(candidate.opportunityId) ? 30
        : (call.fixture?.overallScoresByOpportunityId?.[candidate.opportunityId]
          ?? (evidenceBackedDimensions === DEEP_MATCH_DIMENSIONS.length ? 80
          : evidenceBackedDimensions >= 4 ? 65
              : evidenceBackedDimensions >= 2 ? 50
                : 50));
      const assessment = DeepMatchAssessmentSchema.parse({
        opportunityId: candidate.opportunityId,
        overallScore: score,
        dimensions: DEEP_MATCH_DIMENSIONS.map((dimension) => {
          const job = candidate.jobEvidence.find((item) => item.dimensions.includes(dimension));
          const profile = candidate.profileEvidence.find((item) => item.dimensions.includes(dimension));
          if (!job || !profile) return { dimension, score: 0, judgment: "insufficient_evidence" as const, jobEvidenceIds: [], profileEvidenceIds: [], summary: "缺少该维度双方可核验的证据，未作匹配推断。" };
          return { dimension, score, judgment: "evidence_backed_inference" as const, jobEvidenceIds: [job.id], profileEvidenceIds: [profile.id], summary: "基于该维度的岗位要求与已确认画像事实的匹配推断。" };
        }),
      });
      return validateDeepMatchEvidenceClosure(assessment, {
        jobEvidenceIds: candidate.jobEvidence.map((item) => item.id),
        profileEvidenceIds: candidate.profileEvidence.map((item) => item.id),
      });
    });
    return { assessments, usage: { ...FAKE_DEEP_MATCH_TOKEN_USAGE, latencyMs: 0 } };
  }
}
