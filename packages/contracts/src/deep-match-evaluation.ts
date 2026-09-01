import {
  DEEP_MATCH_OUTPUT_SCHEMA_VERSION,
  DEEP_MATCH_DIMENSIONS,
  FAKE_DEEP_MATCH_TOKEN_USAGE,
  DeepMatchAssessmentSchema,
  DeepMatchCandidateSchema,
  validateDeepMatchEvidenceClosure,
  type DeepMatchAdapter,
  type DeepMatchCandidate,
} from "./deep-match";

/** 评分、提示词、adapter 或输出 schema 变更都必须更新此版本并通过本门禁。 */
export const DEEP_MATCH_EVALUATION_VERSION = "deep-match-eval-v1";

const candidates: readonly DeepMatchCandidate[] = [
  {
    opportunityId: "00000000-0000-4000-8000-000000000010",
    sourcePostingVersionId: "00000000-0000-4000-8000-000000000110",
    jobEvidence: [{ id: "job:typescript", value: "岗位明确要求 TypeScript", dimensions: ["skills"] }],
    profileEvidence: [{ id: "profile:typescript", profileFactRevisionId: "00000000-0000-4000-8000-000000000210", value: "已确认 TypeScript 经历", dimensions: ["skills"] }],
  },
  {
    opportunityId: "00000000-0000-4000-8000-000000000011",
    sourcePostingVersionId: "00000000-0000-4000-8000-000000000111",
    jobEvidence: [{ id: "job:react", value: "岗位明确要求 React", dimensions: ["skills"] }],
    profileEvidence: [{ id: "profile:react", profileFactRevisionId: "00000000-0000-4000-8000-000000000211", value: "已确认 React 经历", dimensions: ["skills"] }],
  },
];

const triageRejectedOpportunityId = "00000000-0000-4000-8000-000000000012";
const qualityRejectedOpportunityId = candidates[1]!.opportunityId;

export async function runDeepMatchEvaluation(adapter: DeepMatchAdapter) {
  const parsedCandidates = candidates.map((candidate) => DeepMatchCandidateSchema.parse(candidate));
  const result = await adapter.assess({ candidates: parsedCandidates }, {
    signal: new AbortController().signal,
    usageKey: `${DEEP_MATCH_EVALUATION_VERSION}:${DEEP_MATCH_OUTPUT_SCHEMA_VERSION}`,
    budget: { maxTokens: 80 * parsedCandidates.length, reservedInputTokens: adapter.reservedUsage.inputTokens, reservedOutputTokens: adapter.reservedUsage.outputTokens },
    fixture: { qualityInsufficientOpportunityIds: [qualityRejectedOpportunityId] },
  });
  if (result.usage.inputTokens + result.usage.outputTokens > 80 || result.usage.latencyMs > 5_000) throw new Error("DEEP_MATCH_EVALUATION_RESOURCE_CEILING");
  const assessed = result.assessments.map((assessment) => {
    const candidate = parsedCandidates.find((item) => item.opportunityId === assessment.opportunityId);
    if (!candidate) throw new Error("DEEP_MATCH_EVALUATION_UNEXPECTED_OPPORTUNITY");
    const parsed = DeepMatchAssessmentSchema.parse(assessment);
    validateDeepMatchEvidenceClosure(parsed, {
      jobEvidenceIds: candidate.jobEvidence.map((item) => item.id),
      profileEvidenceIds: candidate.profileEvidence.map((item) => item.id),
    });
    if (parsed.dimensions.length !== DEEP_MATCH_DIMENSIONS.length) throw new Error("DEEP_MATCH_EVALUATION_DIMENSIONS");
    return parsed;
  }).sort((left, right) => right.overallScore - left.overallScore || left.opportunityId.localeCompare(right.opportunityId));
  if (assessed.length !== candidates.length || new Set(assessed.map((item) => item.opportunityId)).size !== candidates.length) throw new Error("DEEP_MATCH_EVALUATION_COMPLETENESS");
  const accepted = assessed.filter((item) => item.overallScore >= 60);
  const rejected = assessed.filter((item) => item.overallScore < 60);
  if (accepted.map((item) => item.opportunityId).join(",") !== candidates[0]!.opportunityId || rejected.map((item) => item.opportunityId).join(",") !== qualityRejectedOpportunityId) throw new Error("DEEP_MATCH_EVALUATION_RANKING_OR_REJECTION");
  return {
    evaluationVersion: DEEP_MATCH_EVALUATION_VERSION,
    cases: candidates.length,
    acceptedOpportunityIds: accepted.map((item) => item.opportunityId),
    rejectedOpportunityIds: [qualityRejectedOpportunityId, triageRejectedOpportunityId],
  };
}
