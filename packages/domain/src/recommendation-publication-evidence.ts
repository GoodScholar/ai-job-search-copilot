import type { FrozenRecommendationEvidence } from "@job-copilot/contracts/recommendation-discovery-facts";
import { RecommendationResultEvidenceWriteSchema, type RecommendationResultEvidence } from "@job-copilot/contracts/recommendation-runs";

export type RecommendationPublicationTriage = {
  triageVersionId: string;
  opportunityId: string;
  overallVerdict: "pass" | "fail" | "unknown";
  deadlineStatus: "expired" | "closing_soon" | "valid" | "missing" | "invalid";
};

export type RecommendationPublicationExclusion = {
  opportunityId: string;
  reasonCode: "TRIAGE_NOT_PASS" | "DEADLINE_EXPIRED" | "SCORE_BELOW_THRESHOLD" | "CANDIDATE_LIMIT" | "MATCH_QUALITY_INSUFFICIENT" | "RULE_EXCLUDED";
};

export type RecommendationPublicationStagedCandidate = {
  opportunityId: string;
  complete: boolean;
};

function fail(code: string): never { throw new Error(code); }

function uniqueBy<T>(values: readonly T[], key: (value: T) => string, errorCode: string): Map<string, T> {
  const mapped = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (mapped.has(id)) fail(errorCode);
    mapped.set(id, value);
  }
  return mapped;
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

export function buildRecommendationPublicationEvidence(input: {
  frozen: FrozenRecommendationEvidence;
  triages: readonly RecommendationPublicationTriage[];
  selectionExclusions: readonly RecommendationPublicationExclusion[];
  stagedCandidates: readonly RecommendationPublicationStagedCandidate[];
  acceptedOpportunityIds: readonly string[];
}): RecommendationResultEvidence {
  const frozenTriageIds = new Set(input.frozen.frozenTriageVersionIds);
  if (frozenTriageIds.size !== input.frozen.frozenTriageVersionIds.length) fail("RECOMMENDATION_PUBLICATION_TRIAGE_DUPLICATE");
  const triagesById = uniqueBy(input.triages, (item) => item.triageVersionId, "RECOMMENDATION_PUBLICATION_TRIAGE_DUPLICATE");
  if (!sameIds(frozenTriageIds, new Set(triagesById.keys()))) fail("RECOMMENDATION_PUBLICATION_TRIAGE_MISMATCH");
  const triages = input.frozen.frozenTriageVersionIds.map((id) => triagesById.get(id)!);
  const triagesByOpportunity = uniqueBy(triages, (item) => item.opportunityId, "RECOMMENDATION_PUBLICATION_OPPORTUNITY_DUPLICATE");
  const exclusions = uniqueBy(input.selectionExclusions, (item) => item.opportunityId, "RECOMMENDATION_PUBLICATION_EXCLUSION_DUPLICATE");
  const staged = uniqueBy(input.stagedCandidates, (item) => item.opportunityId, "RECOMMENDATION_PUBLICATION_STAGE_DUPLICATE");
  const accepted = new Set(input.acceptedOpportunityIds);
  if (accepted.size !== input.acceptedOpportunityIds.length) fail("RECOMMENDATION_PUBLICATION_ACCEPTED_DUPLICATE");
  for (const opportunityId of exclusions.keys()) if (!triagesByOpportunity.has(opportunityId)) fail("RECOMMENDATION_PUBLICATION_EXCLUSION_INVALID");
  for (const [opportunityId, candidate] of staged) {
    if (!triagesByOpportunity.has(opportunityId) || exclusions.has(opportunityId)) fail("RECOMMENDATION_PUBLICATION_STAGE_INVALID");
    if (!candidate.complete) fail("RECOMMENDATION_PUBLICATION_STAGE_INCOMPLETE");
  }
  for (const opportunityId of accepted) if (!staged.has(opportunityId)) fail("RECOMMENDATION_PUBLICATION_ACCEPTED_INVALID");
  if (input.frozen.discoveryFacts.trusted.length !== input.frozen.plannedTrustedSourceCount
    || input.frozen.discoveryFacts.publicQueries.length !== input.frozen.plannedPublicQueryCount) fail("RECOMMENDATION_PUBLICATION_COVERAGE_INCOMPLETE");

  let rejectedCount = 0;
  let insufficientInformationCount = 0;
  let expiredCount = 0;
  let belowThresholdCount = 0;
  let ruleExcludedCount = 0;
  let candidateLimitExcludedCount = 0;
  let deepMatchCandidateCount = 0;
  let qualityInsufficientCount = 0;
  let finalRecommendationCount = 0;
  for (const triage of triages) {
    const exclusion = exclusions.get(triage.opportunityId);
    if (triage.overallVerdict === "unknown") {
      if (!exclusion) fail("RECOMMENDATION_PUBLICATION_BUCKET_MISSING");
      if (exclusion.reasonCode !== "TRIAGE_NOT_PASS") fail("RECOMMENDATION_PUBLICATION_BUCKET_CONFLICT");
      insufficientInformationCount += 1;
      continue;
    }
    if (triage.overallVerdict === "fail") {
      if (!exclusion) fail("RECOMMENDATION_PUBLICATION_BUCKET_MISSING");
      if (exclusion.reasonCode !== "TRIAGE_NOT_PASS") fail("RECOMMENDATION_PUBLICATION_BUCKET_CONFLICT");
      rejectedCount += 1;
      continue;
    }
    if (exclusion) {
      if (exclusion.reasonCode === "TRIAGE_NOT_PASS") rejectedCount += 1;
      else if (exclusion.reasonCode === "DEADLINE_EXPIRED") expiredCount += 1;
      else if (exclusion.reasonCode === "SCORE_BELOW_THRESHOLD") belowThresholdCount += 1;
      else if (exclusion.reasonCode === "RULE_EXCLUDED") ruleExcludedCount += 1;
      else if (exclusion.reasonCode === "CANDIDATE_LIMIT") candidateLimitExcludedCount += 1;
      else fail("RECOMMENDATION_PUBLICATION_BUCKET_CONFLICT");
      continue;
    }
    const candidate = staged.get(triage.opportunityId);
    if (!candidate) fail("RECOMMENDATION_PUBLICATION_STAGE_MISSING");
    deepMatchCandidateCount += 1;
    if (accepted.has(triage.opportunityId)) finalRecommendationCount += 1;
    else qualityInsufficientCount += 1;
  }

  const branches = [
    ...input.frozen.discoveryFacts.trusted.map((branch, index) => ({ key: `trusted:${index}`, branch })),
    ...input.frozen.discoveryFacts.publicQueries.map((branch, index) => ({ key: `public:${index}`, branch })),
  ];
  const losses = new Map<string, { branches: Set<string>; retryable: boolean }>();
  let hasRetryableLoss = false;
  let hasNonretryableLoss = false;
  for (const { key, branch } of branches) for (const loss of branch.losses) {
    const aggregate = losses.get(loss.code) ?? { branches: new Set<string>(), retryable: false };
    aggregate.branches.add(key);
    aggregate.retryable ||= loss.retryable;
    losses.set(loss.code, aggregate);
    hasRetryableLoss ||= loss.retryable;
    hasNonretryableLoss ||= !loss.retryable;
  }
  const discoveredJobCount = triages.length;
  const eligibleCount = discoveredJobCount - rejectedCount - insufficientInformationCount - expiredCount;
  const suggestedActions: RecommendationResultEvidence["suggestedActions"] = [];
  const plannedBranchCount = input.frozen.plannedTrustedSourceCount + input.frozen.plannedPublicQueryCount;
  if (hasRetryableLoss) suggestedActions.push("restart_discovery");
  if (branches.filter(({ branch }) => branch.checked).length < plannedBranchCount || hasNonretryableLoss) suggestedActions.push("review_source_health");
  if (insufficientInformationCount > 0) suggestedActions.push("review_profile");
  if (discoveredJobCount > 0 && deepMatchCandidateCount === 0
    && rejectedCount + expiredCount + belowThresholdCount + ruleExcludedCount === discoveredJobCount) suggestedActions.push("review_primary_target");

  return RecommendationResultEvidenceWriteSchema.parse({
    discovery: { discoveredJobCount },
    sourceCoverage: {
      plannedTrustedSourceCount: input.frozen.plannedTrustedSourceCount,
      plannedPublicQueryCount: input.frozen.plannedPublicQueryCount,
      checkedBranchCount: branches.filter(({ branch }) => branch.checked).length,
      credibleBranchCount: branches.filter(({ branch }) => branch.outcome === "credible_results" || branch.outcome === "credible_zero").length,
      verifiedJobCount: discoveredJobCount + input.frozen.rootBudgetExcludedJobCount,
      rootBudgetExcludedJobCount: input.frozen.rootBudgetExcludedJobCount,
    },
    coverageLosses: [...losses.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([code, aggregate]) => ({ code, affectedCount: aggregate.branches.size, retryable: aggregate.retryable })),
    qualification: { evaluatedCount: discoveredJobCount, rejectedCount, insufficientInformationCount, expiredCount },
    coarseRanking: { eligibleCount, belowThresholdCount, ruleExcludedCount, candidateLimitExcludedCount, deepMatchCandidateCount },
    deepMatching: { evaluatedCount: deepMatchCandidateCount, qualityInsufficientCount, finalRecommendationCount },
    suggestedActions: suggestedActions.slice(0, 2),
  });
}
