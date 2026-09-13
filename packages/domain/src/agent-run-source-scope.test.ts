import { describe, expect, it } from "vitest";
import { projectPublicAgentRunSourceScope } from "./agent-run-source-scope";

const discoveryRunId = "00000000-0000-4000-8000-000000000001";

describe("运行来源范围公共投影", () => {
  it("移除深匹配推荐冻结证据，而不改变可公开的冻结选择", () => {
    const sourceScope = {
      kind: "deep_match", trigger: "automatic", opportunityId: null, discoveryRunId,
      recommendationRuleConfig: { minimumOverallScore: 60, minimumEvidenceDimensions: 2, requiredEvidenceDimensions: [], excludedOpportunityIds: [] },
      initialized: true, selectionExclusions: [],
      frozenRecommendationEvidence: {
        version: "recommendation-evidence-v1", plannedTrustedSourceCount: 1, plannedPublicQueryCount: 0,
        discoveryFacts: { version: "recommendation-discovery-facts-v1", trusted: [{ sourceId: "fake:aurora-careers", checked: true, outcome: "credible_zero", losses: [] }], publicQueries: [] },
        frozenTriageVersionIds: [],
      },
    } as const;

    expect(projectPublicAgentRunSourceScope(sourceScope)).toEqual({
      kind: "deep_match", trigger: "automatic", opportunityId: null, discoveryRunId,
      recommendationRuleConfig: sourceScope.recommendationRuleConfig,
      initialized: true, selectionExclusions: [],
    });
  });
});
