import { describe, expect, it } from "vitest";
import { completeRecommendationDiscoveryFacts, projectPublicAgentRunSourceScope } from "./agent-run-source-scope";

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

  it("以原计划和实际执行范围的差集补齐 hardcap 事实，而不猜测执行范围内缺失事实", () => {
    const trustedSources = Array.from({ length: 51 }, (_, index) => ({ source: { sourceId: `greenhouse:legacy-${index}` } }));
    const queries = Array.from({ length: 11 }, (_, index) => ({ queryId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}` }));
    const plannedScope = { trustedSources, publicDiscovery: { queries } };
    const executionScope = { trustedSources: trustedSources.slice(0, 50), publicDiscovery: { queries: queries.slice(0, 10) } };
    const discoveryFacts = {
      version: "recommendation-discovery-facts-v1" as const,
      trusted: executionScope.trustedSources.map(({ source }) => ({ sourceId: source.sourceId, checked: true, outcome: "credible_zero" as const, losses: [] })),
      publicQueries: executionScope.publicDiscovery.queries.map(({ queryId }) => ({ queryId, checked: true, outcome: "credible_zero" as const, losses: [] })),
    };

    expect(completeRecommendationDiscoveryFacts({ plannedScope, executionScope, discoveryFacts, publicDiscoveryEnabled: true })).toMatchObject({
      trusted: expect.arrayContaining([{ sourceId: "greenhouse:legacy-50", checked: false, outcome: "failed", losses: [{ code: "DISCOVERY_BUDGET_EXCEEDED", retryable: false }] }]),
      publicQueries: expect.arrayContaining([{ queryId: queries[10]!.queryId, checked: false, outcome: "failed", losses: [{ code: "DISCOVERY_BUDGET_EXCEEDED", retryable: false }] }]),
    });
    expect(() => completeRecommendationDiscoveryFacts({
      plannedScope,
      executionScope,
      discoveryFacts: { ...discoveryFacts, publicQueries: discoveryFacts.publicQueries.slice(0, 9) },
      publicDiscoveryEnabled: true,
    })).toThrow("RECOMMENDATION_DISCOVERY_FACTS_SCOPE_INVALID");
  });

  it("将整体 provider 禁用与数量 hardcap 区分为不可检查的不同事实", () => {
    const queryId = "00000000-0000-4000-8000-000000000099";
    expect(completeRecommendationDiscoveryFacts({
      plannedScope: { trustedSources: [], publicDiscovery: { queries: [{ queryId }] } },
      executionScope: { trustedSources: [], publicDiscovery: { queries: [] } },
      discoveryFacts: { version: "recommendation-discovery-facts-v1", trusted: [], publicQueries: [] },
      publicDiscoveryEnabled: false,
    })).toEqual({
      version: "recommendation-discovery-facts-v1",
      trusted: [],
      publicQueries: [{ queryId, checked: false, outcome: "failed", losses: [{ code: "PUBLIC_DISCOVERY_UNAVAILABLE", retryable: false }] }],
    });
  });
});
