import {
  DEEP_MATCH_OUTPUT_SCHEMA_VERSION,
  DEEP_MATCH_DIMENSIONS,
  FAKE_DEEP_MATCH_TOKEN_USAGE,
  DeepMatchAssessmentSchema,
  DeepMatchAdapterInputSchema,
  DeepMatchAdapterResultSchema,
  DeepMatchCandidateSchema,
  acceptsDeepMatchAssessment,
  DeepMatchAdapterError,
  FAKE_DEEP_MATCH_ADAPTER,
  FAKE_DEEP_MATCH_ADAPTER_VERSION,
  isDeepMatchTriageEligible,
  validateDeepMatchEvidenceClosure,
  type DeepMatchAdapter,
  type DeepMatchCandidate,
  type DeepMatchTriageEligibility,
} from "./deep-match";

/** 评分、提示词、adapter 或输出 schema 变更都必须更新此版本并通过本门禁。 */
export const DEEP_MATCH_EVALUATION_VERSION = "deep-match-eval-v1";
const EVALUATION_TOKEN_CEILING = 80;

const candidates: readonly DeepMatchCandidate[] = [
  {
    opportunityId: "00000000-0000-4000-8000-000000000010",
    sourcePostingVersionId: "00000000-0000-4000-8000-000000000110",
    jobEvidence: DEEP_MATCH_DIMENSIONS.map((dimension) => ({ id: `job:typescript:${dimension}`, value: `岗位在${dimension}维度有明确要求`, dimensions: [dimension] })),
    profileEvidence: DEEP_MATCH_DIMENSIONS.map((dimension) => ({ id: `profile:typescript:${dimension}`, kind: "profile_fact" as const, profileFactRevisionId: "00000000-0000-4000-8000-000000000210", value: `已确认${dimension}画像证据`, dimensions: [dimension] })),
  },
  {
    opportunityId: "00000000-0000-4000-8000-000000000011",
    sourcePostingVersionId: "00000000-0000-4000-8000-000000000111",
    jobEvidence: DEEP_MATCH_DIMENSIONS.map((dimension) => ({ id: `job:react:${dimension}`, value: `岗位在${dimension}维度有明确要求`, dimensions: [dimension] })),
    profileEvidence: DEEP_MATCH_DIMENSIONS.map((dimension) => ({ id: `profile:react:${dimension}`, kind: "profile_fact" as const, profileFactRevisionId: "00000000-0000-4000-8000-000000000211", value: `已确认${dimension}画像证据`, dimensions: [dimension] })),
  },
];
const eligibleTriage: Omit<DeepMatchTriageEligibility, "sourcePostingVersionId" | "expectedSourcePostingVersionId"> = { targetVersion: 1, expectedTargetVersion: 1, overallVerdict: "pass", deadlineStatus: "valid", availability: "open", overallScore: 80, threshold: 70 };
const ineligibleMutations: readonly Partial<DeepMatchTriageEligibility>[] = [
  { sourcePostingVersionId: "00000000-0000-4000-8000-000000000999" },
  { targetVersion: 2 },
  { overallVerdict: "fail" },
  { deadlineStatus: "expired" },
  { availability: "closed" },
  { overallScore: null },
  { threshold: null },
  { overallScore: 69 },
];
const evaluationCases: readonly { candidate: DeepMatchCandidate; triage: DeepMatchTriageEligibility }[] = [
  ...candidates.map((candidate) => ({ candidate, triage: { ...eligibleTriage, sourcePostingVersionId: candidate.sourcePostingVersionId, expectedSourcePostingVersionId: candidate.sourcePostingVersionId } })),
  ...ineligibleMutations.map((mutation, index) => {
    const sourcePostingVersionId = `00000000-0000-4000-8000-0000000001${String(20 + index).padStart(2, "0")}`;
    return { candidate: { ...candidates[0]!, opportunityId: `00000000-0000-4000-8000-0000000000${String(20 + index).padStart(2, "0")}`, sourcePostingVersionId }, triage: { ...eligibleTriage, sourcePostingVersionId, expectedSourcePostingVersionId: sourcePostingVersionId, ...mutation } };
  }),
];
const qualityRejectedOpportunityId = candidates[1]!.opportunityId;

export async function runDeepMatchEvaluation(adapter: DeepMatchAdapter, options: { signal?: AbortSignal } = {}) {
  if (options.signal?.aborted) throw new Error("DEEP_MATCH_EVALUATION_CANCELLED");
  if (adapter.adapter !== FAKE_DEEP_MATCH_ADAPTER || adapter.adapterVersion !== FAKE_DEEP_MATCH_ADAPTER_VERSION || adapter.model !== "fake-deep-match-model-v1") throw new Error("DEEP_MATCH_EVALUATION_ADAPTER_IDENTITY");
  const eligibleCases = evaluationCases.filter((item) => isDeepMatchTriageEligible(item.triage));
  const parsedCandidates = eligibleCases.map(({ candidate }) => DeepMatchCandidateSchema.parse(candidate));
  const strictInput = DeepMatchAdapterInputSchema.parse({ candidates: parsedCandidates });
  let reservation;
  try { reservation = DeepMatchAdapterResultSchema.shape.usage.parse({ ...adapter.reservedUsage, latencyMs: 0 }); }
  catch { throw new Error("DEEP_MATCH_EVALUATION_RESERVATION_INVALID"); }
  if (reservation.inputTokens + reservation.outputTokens > EVALUATION_TOKEN_CEILING) throw new Error("DEEP_MATCH_EVALUATION_RESERVATION_BUDGET");
  let rawResult: unknown;
  try {
    const signal = options.signal ?? new AbortController().signal;
    const cancellation = new Promise<never>((_, reject) => {
      const abort = () => reject(new Error("DEEP_MATCH_EVALUATION_CANCELLED"));
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
    rawResult = await Promise.race([adapter.assess(strictInput, {
      signal,
      usageKey: `${DEEP_MATCH_EVALUATION_VERSION}:${DEEP_MATCH_OUTPUT_SCHEMA_VERSION}`,
      budget: { maxTokens: EVALUATION_TOKEN_CEILING, reservedInputTokens: adapter.reservedUsage.inputTokens, reservedOutputTokens: adapter.reservedUsage.outputTokens },
      fixture: { qualityInsufficientOpportunityIds: [qualityRejectedOpportunityId] },
    }), cancellation]);
  } catch (error) {
    if (error instanceof Error && error.message === "DEEP_MATCH_EVALUATION_CANCELLED") throw error;
    if (error instanceof DeepMatchAdapterError) throw new Error(`DEEP_MATCH_EVALUATION_ADAPTER_${error.category.toUpperCase()}`);
    throw new Error("DEEP_MATCH_EVALUATION_ADAPTER_FAILURE");
  }
  let result;
  try { result = DeepMatchAdapterResultSchema.parse(rawResult); }
  catch { throw new Error("DEEP_MATCH_EVALUATION_INVALID_OUTPUT"); }
  if (result.usage.inputTokens + result.usage.outputTokens > EVALUATION_TOKEN_CEILING || result.usage.latencyMs > 5_000) throw new Error("DEEP_MATCH_EVALUATION_RESOURCE_CEILING");
  const assessed = result.assessments.map((assessment) => {
    const candidate = parsedCandidates.find((item) => item.opportunityId === assessment.opportunityId);
    if (!candidate) throw new Error("DEEP_MATCH_EVALUATION_UNEXPECTED_OPPORTUNITY");
    const parsed = DeepMatchAssessmentSchema.parse(assessment);
    validateDeepMatchEvidenceClosure(parsed, {
      jobEvidence: candidate.jobEvidence,
      profileEvidence: candidate.profileEvidence,
    });
    if (parsed.dimensions.length !== DEEP_MATCH_DIMENSIONS.length) throw new Error("DEEP_MATCH_EVALUATION_DIMENSIONS");
    return parsed;
  }).sort((left, right) => right.overallScore - left.overallScore || left.opportunityId.localeCompare(right.opportunityId));
  if (assessed.length !== candidates.length || new Set(assessed.map((item) => item.opportunityId)).size !== candidates.length) throw new Error("DEEP_MATCH_EVALUATION_COMPLETENESS");
  const accepted = assessed.filter(acceptsDeepMatchAssessment);
  const rejected = assessed.filter((item) => !acceptsDeepMatchAssessment(item));
  if (accepted.map((item) => item.opportunityId).join(",") !== candidates[0]!.opportunityId || rejected.map((item) => item.opportunityId).join(",") !== qualityRejectedOpportunityId) throw new Error("DEEP_MATCH_EVALUATION_RANKING_OR_REJECTION");
  return {
    evaluationVersion: DEEP_MATCH_EVALUATION_VERSION,
    cases: evaluationCases.length,
    acceptedOpportunityIds: accepted.map((item) => item.opportunityId),
    rejectedOpportunityIds: [...rejected.map((item) => item.opportunityId), ...evaluationCases.filter((item) => !isDeepMatchTriageEligible(item.triage)).map((item) => item.candidate.opportunityId)],
  };
}
