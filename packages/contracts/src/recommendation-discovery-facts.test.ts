import { describe, expect, it } from "vitest";
import { FrozenRecommendationEvidenceSchema, FrozenRecommendationEvidenceWriteSchema, RecommendationDiscoveryFactsSchema } from "./recommendation-discovery-facts";

const sourceId = "greenhouse:aurora";
const queryId = "00000000-0000-4000-8000-000000000001";
const triageVersionId = "00000000-0000-4000-8000-000000000002";

describe("推荐发现冻结事实契约", () => {
  it("保留可信分支的部分覆盖损失，并拒绝重复或越界冻结身份", () => {
    const facts = {
      version: "recommendation-discovery-facts-v1",
      trusted: [{ sourceId, checked: true, outcome: "credible_results", losses: [{ code: "VERIFICATION_FAILED", retryable: true }] }],
      publicQueries: [{ queryId, checked: false, outcome: "failed", losses: [{ code: "PUBLIC_DISCOVERY_UNAVAILABLE", retryable: false }] }],
    } as const;
    const frozen = {
      version: "recommendation-evidence-v1",
      plannedTrustedSourceCount: 1,
      plannedPublicQueryCount: 1,
      discoveryFacts: facts,
      frozenTriageVersionIds: [triageVersionId],
    } as const;

    expect(RecommendationDiscoveryFactsSchema.parse(facts)).toEqual(facts);
    expect(FrozenRecommendationEvidenceSchema.parse(frozen)).toMatchObject({ ...frozen, rootBudgetExcludedJobCount: 0 });
    expect(FrozenRecommendationEvidenceWriteSchema.safeParse(frozen).success).toBe(false);
    expect(FrozenRecommendationEvidenceWriteSchema.safeParse({ ...frozen, rootBudgetExcludedJobCount: 1 }).success).toBe(true);
    expect(RecommendationDiscoveryFactsSchema.safeParse({ ...facts, trusted: [...facts.trusted, facts.trusted[0]] }).success).toBe(false);
    expect(FrozenRecommendationEvidenceSchema.safeParse({ ...frozen, plannedTrustedSourceCount: 0 }).success).toBe(false);
    expect(FrozenRecommendationEvidenceSchema.safeParse({ ...frozen, frozenTriageVersionIds: [triageVersionId, triageVersionId] }).success).toBe(false);
    expect(RecommendationDiscoveryFactsSchema.safeParse({ ...facts, trusted: [{ ...facts.trusted[0], checked: false }] }).success).toBe(false);
    expect(RecommendationDiscoveryFactsSchema.safeParse({ ...facts, trusted: [{ ...facts.trusted[0], outcome: "failed", losses: [] }] }).success).toBe(false);
    expect(RecommendationDiscoveryFactsSchema.safeParse({ ...facts, extra: true }).success).toBe(false);
    const historicalFacts = { ...facts, publicQueries: Array.from({ length: 11 }, (_, index) => ({ ...facts.publicQueries[0], queryId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}` })) };
    expect(RecommendationDiscoveryFactsSchema.safeParse(historicalFacts).success).toBe(true);
    expect(FrozenRecommendationEvidenceSchema.safeParse({ ...frozen, discoveryFacts: historicalFacts }).success).toBe(false);
  });

  it("接受每种 coverage loss code 的 retryable 组合，并拒绝重复的第十三项", () => {
    const losses = [
      "TRUSTED_SOURCE_UNAVAILABLE", "PUBLIC_DISCOVERY_UNAVAILABLE", "SOURCE_HEALTH_DEGRADED",
      "SOURCE_CAPABILITY_UNAVAILABLE", "VERIFICATION_FAILED", "DISCOVERY_BUDGET_EXCEEDED",
    ].flatMap((code) => [{ code, retryable: false }, { code, retryable: true }]);
    const facts = {
      version: "recommendation-discovery-facts-v1",
      trusted: [{ sourceId, checked: true, outcome: "credible_results", losses }],
      publicQueries: [],
    };

    expect(RecommendationDiscoveryFactsSchema.safeParse(facts).success).toBe(true);
    expect(RecommendationDiscoveryFactsSchema.safeParse({ ...facts, trusted: [{ ...facts.trusted[0], losses: [...losses, losses[0]] }] }).success).toBe(false);
  });

  it("允许历史计划中的第十一条 query 事实，并仍由冻结计划计数约束", () => {
    const publicQueries = Array.from({ length: 11 }, (_, index) => ({
      queryId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      checked: index < 10,
      outcome: index < 10 ? "credible_zero" as const : "failed" as const,
      losses: index < 10 ? [] : [{ code: "DISCOVERY_BUDGET_EXCEEDED" as const, retryable: false }],
    }));
    const facts = { version: "recommendation-discovery-facts-v1" as const, trusted: [], publicQueries };

    expect(RecommendationDiscoveryFactsSchema.safeParse(facts).success).toBe(true);
    expect(FrozenRecommendationEvidenceSchema.safeParse({
      version: "recommendation-evidence-v1",
      plannedTrustedSourceCount: 0,
      plannedPublicQueryCount: 11,
      discoveryFacts: facts,
      frozenTriageVersionIds: [],
    }).success).toBe(true);
    expect(FrozenRecommendationEvidenceSchema.safeParse({
      version: "recommendation-evidence-v1",
      plannedTrustedSourceCount: 0,
      plannedPublicQueryCount: 10,
      discoveryFacts: facts,
      frozenTriageVersionIds: [],
    }).success).toBe(false);
  });
});
