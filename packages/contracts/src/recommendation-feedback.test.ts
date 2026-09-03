import { describe, expect, it } from "vitest";
import {
  CalibrationProposalRevisionCommandSchema,
  CalibrationProposalRebaseCommandSchema,
  CalibrationProposalSchema,
  RecommendationDecisionCommandSchema,
  RecommendationDecisionSchema,
  RecommendationRuleConfigSchema,
} from "./recommendations";
import { DeepMatchAgentRunSourceScopeSchema } from "./agent-runs";

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

  it("校准修订只允许服务端可重算的策略意图", () => {
    expect(CalibrationProposalRevisionCommandSchema.safeParse({
      strategy: "raise_quality_bar", idempotencyKey: "00000000-0000-4000-8000-000000000002", expectedVersion: 1,
    }).success).toBe(true);
    expect(CalibrationProposalRevisionCommandSchema.safeParse({
      strategy: "raise_quality_bar", idempotencyKey: "00000000-0000-4000-8000-000000000002", expectedVersion: 1,
      ruleConfig: { minimumOverallScore: 75, minimumEvidenceDimensions: 3, requiredEvidenceDimensions: [], excludedOpportunityIds: [] },
      impactPreview: { sampleSize: 12, estimatedAffectedCount: 3, ruleDiff: {}, jobContent: "不得保存" },
    }).success).toBe(false);
  });

  it("重新计算只接受乐观版本与幂等键，不允许客户端传入规则快照", () => {
    expect(CalibrationProposalRebaseCommandSchema.safeParse({
      idempotencyKey: "00000000-0000-4000-8000-000000000002", expectedVersion: 1,
    }).success).toBe(true);
    expect(CalibrationProposalRebaseCommandSchema.safeParse({
      idempotencyKey: "00000000-0000-4000-8000-000000000002", expectedVersion: 1,
      ruleConfig: { minimumOverallScore: 75, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: [], excludedOpportunityIds: [] },
    }).success).toBe(false);
  });

  it("推荐决策投影保持投递状态之外的独立状态", () => {
    expect(RecommendationDecisionSchema.parse({ status: "pending", version: 0 })).toEqual({ status: "pending", version: 0 });
  });

  it("规则配置只接受共享的六个深度匹配维度", () => {
    expect(RecommendationRuleConfigSchema.safeParse({ minimumOverallScore: 60, minimumEvidenceDimensions: 2, requiredEvidenceDimensions: ["skills"], excludedOpportunityIds: [] }).success).toBe(true);
    expect(RecommendationRuleConfigSchema.safeParse({ minimumOverallScore: 60, minimumEvidenceDimensions: 2, requiredEvidenceDimensions: ["unknown_dimension"], excludedOpportunityIds: [] }).success).toBe(false);
    expect(RecommendationRuleConfigSchema.safeParse({ minimumOverallScore: 60, minimumEvidenceDimensions: 2, requiredEvidenceDimensions: ["skills", "skills"], excludedOpportunityIds: [] }).success).toBe(false);
    expect(RecommendationRuleConfigSchema.safeParse({ minimumOverallScore: 60, minimumEvidenceDimensions: 2, requiredEvidenceDimensions: [], excludedOpportunityIds: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"] }).success).toBe(false);
    expect(DeepMatchAgentRunSourceScopeSchema.safeParse({ kind: "deep_match", trigger: "manual", opportunityId: "00000000-0000-4000-8000-000000000001", discoveryRunId: null, initialized: true, selectionExclusions: [], recommendationRuleConfig: { minimumOverallScore: 60, minimumEvidenceDimensions: 2, requiredEvidenceDimensions: ["skills", "skills"], excludedOpportunityIds: [] } }).success).toBe(false);
  });

  it("校准建议公开安全的 stale 审核状态而不暴露规则内部标识", () => {
    expect(CalibrationProposalSchema.safeParse({
      proposalId: "00000000-0000-4000-8000-000000000010", targetId: "00000000-0000-4000-8000-000000000011", reason: "LOCATION", status: "pending", version: 1, evidenceCount: 3,
      stale: true, reviewState: "stale_rebase_required", availableStrategies: ["exclude_evidence_opportunities"],
      revision: { revisionId: "00000000-0000-4000-8000-000000000012", revisionNumber: 1, strategy: "require_related_evidence", ruleConfig: { minimumOverallScore: 91, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: ["location_logistics"], excludedOpportunityIds: [] }, impactPreview: { sampleSize: 3, estimatedAffectedCount: 2, ruleDiff: { requiredEvidenceDimensions: { from: [], to: ["location_logistics"] } } } },
    }).success).toBe(true);
  });
});
