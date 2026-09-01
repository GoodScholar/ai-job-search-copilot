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
    jobEvidence: [{ id: "job:typescript", value: "岗位明确要求 TypeScript" }],
    profileEvidence: [{ id: "profile:typescript", profileFactRevisionId: "00000000-0000-4000-8000-000000000210", value: "已确认 TypeScript 经历" }],
  },
  {
    opportunityId: "00000000-0000-4000-8000-000000000011",
    sourcePostingVersionId: "00000000-0000-4000-8000-000000000111",
    jobEvidence: [{ id: "job:react", value: "岗位明确要求 React" }],
    profileEvidence: [{ id: "profile:react", profileFactRevisionId: "00000000-0000-4000-8000-000000000211", value: "已确认 React 经历" }],
  },
];

const triageRejectedOpportunityId = "00000000-0000-4000-8000-000000000012";

export async function runDeepMatchEvaluation(adapter: DeepMatchAdapter) {
  const parsedCandidates = candidates.map((candidate) => DeepMatchCandidateSchema.parse(candidate));
  const assessments = await adapter.assess({ candidates: parsedCandidates }, {
    signal: new AbortController().signal,
    usageKey: `${DEEP_MATCH_EVALUATION_VERSION}:${DEEP_MATCH_OUTPUT_SCHEMA_VERSION}`,
    budget: { maxTokens: 80 * parsedCandidates.length, reservedInputTokens: FAKE_DEEP_MATCH_TOKEN_USAGE.inputTokens, reservedOutputTokens: FAKE_DEEP_MATCH_TOKEN_USAGE.outputTokens },
  });
  if (FAKE_DEEP_MATCH_TOKEN_USAGE.inputTokens + FAKE_DEEP_MATCH_TOKEN_USAGE.outputTokens > 80) throw new Error("DEEP_MATCH_EVALUATION_TOKEN_CEILING");
  const accepted = assessments.map((assessment) => {
    const candidate = parsedCandidates.find((item) => item.opportunityId === assessment.opportunityId);
    if (!candidate) throw new Error("DEEP_MATCH_EVALUATION_UNEXPECTED_OPPORTUNITY");
    const parsed = DeepMatchAssessmentSchema.parse(assessment);
    validateDeepMatchEvidenceClosure(parsed, {
      jobEvidenceIds: candidate.jobEvidence.map((item) => item.id),
      profileEvidenceIds: candidate.profileEvidence.map((item) => item.id),
    });
    if (parsed.dimensions.length !== DEEP_MATCH_DIMENSIONS.length || parsed.overallScore < 60) throw new Error("DEEP_MATCH_EVALUATION_QUALITY");
    return parsed;
  }).sort((left, right) => right.overallScore - left.overallScore || left.opportunityId.localeCompare(right.opportunityId));
  if (accepted.length !== candidates.length) throw new Error("DEEP_MATCH_EVALUATION_COMPLETENESS");
  return {
    evaluationVersion: DEEP_MATCH_EVALUATION_VERSION,
    cases: candidates.length,
    acceptedOpportunityIds: accepted.map((item) => item.opportunityId),
    rejectedOpportunityIds: [triageRejectedOpportunityId],
  };
}
