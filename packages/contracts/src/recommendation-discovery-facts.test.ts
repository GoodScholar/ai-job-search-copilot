import { describe, expect, it } from "vitest";
import { FrozenRecommendationEvidenceSchema, RecommendationDiscoveryFactsSchema } from "./recommendation-discovery-facts";

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
    expect(FrozenRecommendationEvidenceSchema.parse(frozen)).toEqual(frozen);
    expect(RecommendationDiscoveryFactsSchema.safeParse({ ...facts, trusted: [...facts.trusted, facts.trusted[0]] }).success).toBe(false);
    expect(FrozenRecommendationEvidenceSchema.safeParse({ ...frozen, plannedTrustedSourceCount: 0 }).success).toBe(false);
    expect(FrozenRecommendationEvidenceSchema.safeParse({ ...frozen, frozenTriageVersionIds: [triageVersionId, triageVersionId] }).success).toBe(false);
    expect(RecommendationDiscoveryFactsSchema.safeParse({ ...facts, trusted: [{ ...facts.trusted[0], checked: false }] }).success).toBe(false);
    expect(RecommendationDiscoveryFactsSchema.safeParse({ ...facts, trusted: [{ ...facts.trusted[0], outcome: "failed", losses: [] }] }).success).toBe(false);
    expect(RecommendationDiscoveryFactsSchema.safeParse({ ...facts, extra: true }).success).toBe(false);
    expect(RecommendationDiscoveryFactsSchema.safeParse({ ...facts, publicQueries: Array.from({ length: 11 }, (_, index) => ({ ...facts.publicQueries[0], queryId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}` })) }).success).toBe(false);
  });
});
