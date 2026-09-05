import { describe, expect, it } from "vitest";
import {
  CalibrationProposalRevisionCommandSchema,
  CalibrationProposalRebaseCommandSchema,
  CalibrationProposalCommandResponseSchema,
  CalibrationProposalSchema,
  RecommendationDecisionCommandSchema,
  RecommendationDecisionSchema,
  RecommendationRuleConfigSchema,
  StartRecommendationReevaluationCommandSchema,
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

  it("深度匹配重评携带与启动相同的警告确认字段", () => {
    const command = {
      targetId: "00000000-0000-4000-8000-000000000010",
      opportunityId: "00000000-0000-4000-8000-000000000011",
      idempotencyKey: "00000000-0000-4000-8000-000000000012",
      warningFingerprint: null,
    };
    expect(StartRecommendationReevaluationCommandSchema.parse(command)).toEqual(command);
    expect(StartRecommendationReevaluationCommandSchema.safeParse({ ...command, warningFingerprint: "A".repeat(64) }).success).toBe(false);
    expect(StartRecommendationReevaluationCommandSchema.safeParse({ ...command, warningFingerprint: undefined }).success).toBe(false);
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

  it("校准建议以单一判别审核状态表达合法的 pending 与已解决组合", () => {
    const base = {
      proposalId: "00000000-0000-4000-8000-000000000010", targetId: "00000000-0000-4000-8000-000000000011", reason: "LOCATION", status: "pending", version: 1, evidenceCount: 3,
      revision: { revisionId: "00000000-0000-4000-8000-000000000012", revisionNumber: 1, strategy: "require_related_evidence", ruleConfig: { minimumOverallScore: 91, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: ["location_logistics"], excludedOpportunityIds: [] }, impactPreview: { sampleSize: 3, estimatedAffectedCount: 2, ruleDiff: { requiredEvidenceDimensions: { from: [], to: ["location_logistics"] } } } },
    };
    for (const reviewState of ["current", "stale_rebase_required", "covered", "unrebasable"] as const) {
      expect(CalibrationProposalSchema.safeParse({ ...base, reviewState, availableStrategies: reviewState === "current" ? ["exclude_evidence_opportunities"] : [] }).success).toBe(true);
    }
    for (const status of ["approved", "rejected"] as const) {
      expect(CalibrationProposalSchema.safeParse({ ...base, status, reviewState: "resolved", availableStrategies: [] }).success).toBe(true);
    }
    expect(CalibrationProposalSchema.safeParse({ ...base, status: "approved", reviewState: "current", availableStrategies: [] }).success).toBe(false);
    expect(CalibrationProposalSchema.safeParse({ ...base, reviewState: "resolved", availableStrategies: [] }).success).toBe(false);
    expect(CalibrationProposalSchema.safeParse({ ...base, status: "rejected", reviewState: "resolved", availableStrategies: ["exclude_evidence_opportunities"] }).success).toBe(false);
    expect(CalibrationProposalSchema.safeParse({ ...base, reviewState: "stale_rebase_required", availableStrategies: [], stale: false }).success).toBe(false);
  });

  it("校准写命令只接受最小严格的安全响应", () => {
    const response = { proposalId: "00000000-0000-4000-8000-000000000010", revisionId: "00000000-0000-4000-8000-000000000012", revisionNumber: 2 };
    expect(CalibrationProposalCommandResponseSchema.safeParse(response).success).toBe(true);
    expect(CalibrationProposalCommandResponseSchema.safeParse({ ...response, userId: "00000000-0000-4000-8000-000000000013" }).success).toBe(false);
    expect(CalibrationProposalCommandResponseSchema.safeParse({ proposalId: response.proposalId, revisionId: response.revisionId }).success).toBe(false);
  });
});
