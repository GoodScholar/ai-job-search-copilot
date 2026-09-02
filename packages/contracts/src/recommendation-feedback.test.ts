import { describe, expect, it } from "vitest";
import {
  CalibrationProposalRevisionCommandSchema,
  RecommendationDecisionCommandSchema,
  RecommendationDecisionSchema,
} from "./recommendations";

describe("推荐反馈契约", () => {
  it("收藏只接受决策、幂等键和乐观版本", () => {
    expect(RecommendationDecisionCommandSchema.safeParse({
      decision: "saved", idempotencyKey: "00000000-0000-4000-8000-000000000001", expectedVersion: 0,
    }).success).toBe(true);
    expect(RecommendationDecisionCommandSchema.safeParse({
      decision: "saved", idempotencyKey: "00000000-0000-4000-8000-000000000001", expectedVersion: 0, applicationStatus: "submitted",
    }).success).toBe(false);
  });

  it("忽略允许跳过原因与备注，但限制备注长度和原因码", () => {
    expect(RecommendationDecisionCommandSchema.safeParse({
      decision: "ignored", idempotencyKey: "00000000-0000-4000-8000-000000000001", expectedVersion: 0,
    }).success).toBe(true);
    expect(RecommendationDecisionCommandSchema.safeParse({
      decision: "ignored", reason: "LOCATION", note: "地点不合适", idempotencyKey: "00000000-0000-4000-8000-000000000001", expectedVersion: 0,
    }).success).toBe(true);
    expect(RecommendationDecisionCommandSchema.safeParse({
      decision: "ignored", reason: "LOCATION", note: "x".repeat(501), idempotencyKey: "00000000-0000-4000-8000-000000000001", expectedVersion: 0,
    }).success).toBe(false);
    for (const reason of ["ROLE_DIRECTION", "LOCATION", "SALARY", "COMPANY", "INDUSTRY", "SENIORITY", "MISMATCH", "EXPIRED", "ALREADY_HANDLED"]) {
      expect(RecommendationDecisionCommandSchema.safeParse({ decision: "ignored", reason, note: "x".repeat(500), idempotencyKey: "00000000-0000-4000-8000-000000000001", expectedVersion: 0 }).success).toBe(true);
    }
    expect(RecommendationDecisionCommandSchema.safeParse({ decision: "ignored", reason: "APPLICATION_STATUS", idempotencyKey: "00000000-0000-4000-8000-000000000001", expectedVersion: 0 }).success).toBe(false);
  });

  it("校准修订严格限制规则策略与影响预览", () => {
    expect(CalibrationProposalRevisionCommandSchema.safeParse({
      strategy: "raise_quality_bar", idempotencyKey: "00000000-0000-4000-8000-000000000002", expectedVersion: 1,
      ruleConfig: { minimumOverallScore: 75, minimumEvidenceDimensions: 3, requiredEvidenceDimensions: [], excludedOpportunityIds: [] },
      impactPreview: { sampleSize: 12, estimatedAffectedCount: 3, ruleDiff: { minimumOverallScore: { from: 60, to: 75 } } },
    }).success).toBe(true);
    expect(CalibrationProposalRevisionCommandSchema.safeParse({
      strategy: "raise_quality_bar", idempotencyKey: "00000000-0000-4000-8000-000000000002", expectedVersion: 1,
      ruleConfig: { minimumOverallScore: 75, minimumEvidenceDimensions: 3, requiredEvidenceDimensions: [], excludedOpportunityIds: [] },
      impactPreview: { sampleSize: 12, estimatedAffectedCount: 3, ruleDiff: {}, jobContent: "不得保存" },
    }).success).toBe(false);
  });

  it("推荐决策投影保持投递状态之外的独立状态", () => {
    expect(RecommendationDecisionSchema.parse({ status: "pending", version: 0 })).toEqual({ status: "pending", version: 0 });
  });
});
