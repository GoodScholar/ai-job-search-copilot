import { describe, expect, it } from "vitest";
import type { FrozenRecommendationEvidence } from "@job-copilot/contracts/recommendation-discovery-facts";
import { buildRecommendationPublicationEvidence } from "./recommendation-publication-evidence";

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
  "00000000-0000-4000-8000-000000000006",
  "00000000-0000-4000-8000-000000000007",
  "00000000-0000-4000-8000-000000000008",
] as const;

function triage(index: number, input: Partial<{ overallVerdict: "pass" | "fail" | "unknown"; deadlineStatus: "expired" | "closing_soon" | "valid" | "missing" | "invalid" }> = {}) {
  return { triageVersionId: ids[index]!, opportunityId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, overallVerdict: "pass" as const, deadlineStatus: "valid" as const, ...input };
}

function frozen(triageIds: readonly string[], input: Partial<FrozenRecommendationEvidence["discoveryFacts"]> = {}): FrozenRecommendationEvidence {
  return {
    version: "recommendation-evidence-v1" as const,
    plannedTrustedSourceCount: 1,
    plannedPublicQueryCount: 1,
    rootBudgetExcludedJobCount: 0,
    discoveryFacts: {
      version: "recommendation-discovery-facts-v1" as const,
      trusted: input.trusted ?? [{ sourceId: "fake:aurora", checked: true, outcome: "credible_results" as const, losses: [{ code: "SOURCE_HEALTH_DEGRADED" as const, retryable: true }] }],
      publicQueries: input.publicQueries ?? [{ queryId: "20000000-0000-4000-8000-000000000001", checked: false, outcome: "failed" as const, losses: [{ code: "PUBLIC_DISCOVERY_UNAVAILABLE" as const, retryable: false }] }],
    },
    frozenTriageVersionIds: [...triageIds],
  };
}

describe("recommendation publication evidence", () => {
  it("将冻结 triage、排除和实际 staging 分入互斥闭合证据桶", () => {
    const triages = [
      triage(0, { overallVerdict: "unknown" }), triage(1, { overallVerdict: "fail" }), triage(2, { deadlineStatus: "expired" }),
      triage(3), triage(4), triage(5), triage(6), triage(7),
    ];

    expect(buildRecommendationPublicationEvidence({
      frozen: frozen(triages.map((item) => item.triageVersionId)),
      triages,
      selectionExclusions: [
        { opportunityId: triages[0]!.opportunityId, reasonCode: "TRIAGE_NOT_PASS" },
        { opportunityId: triages[1]!.opportunityId, reasonCode: "TRIAGE_NOT_PASS" },
        { opportunityId: triages[2]!.opportunityId, reasonCode: "DEADLINE_EXPIRED" },
        { opportunityId: triages[3]!.opportunityId, reasonCode: "SCORE_BELOW_THRESHOLD" },
        { opportunityId: triages[4]!.opportunityId, reasonCode: "RULE_EXCLUDED" },
        { opportunityId: triages[5]!.opportunityId, reasonCode: "CANDIDATE_LIMIT" },
      ],
      stagedCandidates: [
        { opportunityId: triages[6]!.opportunityId, complete: true },
        { opportunityId: triages[7]!.opportunityId, complete: true },
      ],
      acceptedOpportunityIds: [triages[6]!.opportunityId],
    })).toEqual({
      discovery: { discoveredJobCount: 8 },
      sourceCoverage: { plannedTrustedSourceCount: 1, plannedPublicQueryCount: 1, checkedBranchCount: 1, credibleBranchCount: 1, verifiedJobCount: 8, rootBudgetExcludedJobCount: 0 },
      coverageLosses: [
        { code: "PUBLIC_DISCOVERY_UNAVAILABLE", affectedCount: 1, retryable: false },
        { code: "SOURCE_HEALTH_DEGRADED", affectedCount: 1, retryable: true },
      ],
      qualification: { evaluatedCount: 8, rejectedCount: 1, insufficientInformationCount: 1, expiredCount: 1 },
      coarseRanking: { eligibleCount: 5, belowThresholdCount: 1, ruleExcludedCount: 1, candidateLimitExcludedCount: 1, deepMatchCandidateCount: 2 },
      deepMatching: { evaluatedCount: 2, qualityInsufficientCount: 1, finalRecommendationCount: 1 },
      suggestedActions: ["restart_discovery", "review_source_health"],
    });
  });

  it("拒绝未完成 staging 而不是将它包装成可信空结果", () => {
    const only = triage(0);

    expect(() => buildRecommendationPublicationEvidence({
      frozen: frozen([only.triageVersionId], { publicQueries: [{ queryId: "20000000-0000-4000-8000-000000000001", checked: true, outcome: "credible_zero", losses: [] }], trusted: [{ sourceId: "fake:aurora", checked: true, outcome: "credible_zero", losses: [] }] }),
      triages: [only], selectionExclusions: [], stagedCandidates: [{ opportunityId: only.opportunityId, complete: false }], acceptedOpportunityIds: [],
    })).toThrow("RECOMMENDATION_PUBLICATION_STAGE_INCOMPLETE");
  });

  it("已有写入 schema 拒绝全 failed/verification_failed 分支的 credibleBranchCount=0", () => {
    expect(() => buildRecommendationPublicationEvidence({
      frozen: frozen([], {
        trusted: [{ sourceId: "fake:aurora", checked: false, outcome: "failed", losses: [{ code: "TRUSTED_SOURCE_UNAVAILABLE", retryable: true }] }],
        publicQueries: [{ queryId: "20000000-0000-4000-8000-000000000001", checked: false, outcome: "verification_failed", losses: [{ code: "VERIFICATION_FAILED", retryable: false }] }],
      }),
      triages: [], selectionExclusions: [], stagedCandidates: [], acceptedOpportunityIds: [],
    })).toThrow("可信结果至少需要一个可信发现分支");
  });

  it.each(["unknown", "fail"] as const)("拒绝 %s triage 缺少冻结排除事实且不可忽略其 staging", (overallVerdict) => {
    const only = triage(0, { overallVerdict });
    const input = {
      frozen: frozen([only.triageVersionId], {
        trusted: [{ sourceId: "fake:aurora", checked: true, outcome: "credible_zero" as const, losses: [] }],
        publicQueries: [{ queryId: "20000000-0000-4000-8000-000000000001", checked: true, outcome: "credible_zero" as const, losses: [] }],
      }),
      triages: [only], selectionExclusions: [], stagedCandidates: [{ opportunityId: only.opportunityId, complete: true }], acceptedOpportunityIds: [only.opportunityId],
    };

    expect(() => buildRecommendationPublicationEvidence(input)).toThrow("RECOMMENDATION_PUBLICATION_BUCKET_MISSING");
  });

  it("只在全部非信息不足且非限额的前段淘汰时建议检查主目标", () => {
    const only = triage(0, { overallVerdict: "fail" });

    expect(buildRecommendationPublicationEvidence({
      frozen: frozen([only.triageVersionId], {
        trusted: [{ sourceId: "fake:aurora", checked: true, outcome: "credible_zero", losses: [] }],
        publicQueries: [{ queryId: "20000000-0000-4000-8000-000000000001", checked: true, outcome: "credible_zero", losses: [] }],
      }),
      triages: [only], selectionExclusions: [{ opportunityId: only.opportunityId, reasonCode: "TRIAGE_NOT_PASS" }], stagedCandidates: [], acceptedOpportunityIds: [],
    }).suggestedActions).toEqual(["review_primary_target"]);
  });

  it("将同一分支同 code 的不同 retryability 合为一次覆盖损失且保留不可重试建议", () => {
    const only = triage(0, { overallVerdict: "fail" });

    const result = buildRecommendationPublicationEvidence({
      frozen: frozen([only.triageVersionId], {
        trusted: [{ sourceId: "fake:aurora", checked: true, outcome: "credible_zero", losses: [
          { code: "SOURCE_HEALTH_DEGRADED", retryable: true },
          { code: "SOURCE_HEALTH_DEGRADED", retryable: false },
        ] }],
        publicQueries: [{ queryId: "20000000-0000-4000-8000-000000000001", checked: false, outcome: "failed", losses: [{ code: "SOURCE_HEALTH_DEGRADED", retryable: false }] }],
      }),
      triages: [only], selectionExclusions: [{ opportunityId: only.opportunityId, reasonCode: "TRIAGE_NOT_PASS" }], stagedCandidates: [], acceptedOpportunityIds: [],
    });

    expect(result.coverageLosses).toEqual([{ code: "SOURCE_HEALTH_DEGRADED", affectedCount: 2, retryable: true }]);
    expect(result.suggestedActions).toEqual(["restart_discovery", "review_source_health"]);
  });
});
