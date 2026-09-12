import { describe, expect, it } from "vitest";
import {
  ControlRecommendationRunCommandSchema,
  RecommendationResultSchema,
  RecommendationRunFailureSchema,
  RecommendationRunPreparationSchema,
  RecommendationRunSchema,
  StartRecommendationRunCommandSchema,
} from "./recommendation-runs";

const runId = "00000000-0000-4000-8000-000000000001";
const targetId = "00000000-0000-4000-8000-000000000002";
const resultId = "00000000-0000-4000-8000-000000000003";
const recommendationListId = "00000000-0000-4000-8000-000000000004";
const publishedAt = "2026-09-12T00:00:00.000Z";
const budget = { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 } as const;
const deepMatchBudget = { maxActiveDurationMs: 180_000, maxAttempts: 3, maxToolCalls: 0, maxResults: 10, maxModelCalls: 10, maxTokens: 20_000 } as const;
const target = { targetId, targetVersion: 1, roleFamily: "frontend" } as const;
const readyPreflight = {
  version: "run-preflight-v1", workflow: "recommendation", trigger: "manual", targetId, status: "ready", items: [], warningFingerprint: null, checkedAt: publishedAt,
} as const;
const blockedPreflight = { ...readyPreflight, targetId: null, status: "blocked", items: [{
  code: "PRIMARY_JOB_TARGET_MISSING", severity: "blocking", summary: "当前没有活动主求职目标", evidence: { kind: "job_target", primaryTargetId: null, primaryTargetVersion: null, requestedTargetId: null, requestedTargetVersion: null, requestedTargetState: "missing", checkedAt: publishedAt }, impact: "无法安全启动推荐运行。", retryable: false, suggestedActions: ["review_job_targets"],
}] } as const;
const closingEvidence = {
  discovery: { discoveredJobCount: 5 },
  sourceCoverage: { plannedTrustedSourceCount: 2, plannedPublicQueryCount: 1, checkedBranchCount: 3, credibleBranchCount: 2, verifiedJobCount: 5 },
  coverageLosses: [{ code: "TRUSTED_SOURCE_UNAVAILABLE", affectedCount: 1, retryable: true }],
  qualification: { evaluatedCount: 5, rejectedCount: 1, insufficientInformationCount: 1, expiredCount: 0 },
  coarseRanking: { eligibleCount: 3, belowThresholdCount: 1, candidateLimitExcludedCount: 0, deepMatchCandidateCount: 2 },
  deepMatching: { evaluatedCount: 2, qualityInsufficientCount: 1, finalRecommendationCount: 1 },
  suggestedActions: ["restart_discovery"],
} as const;
const completedStages = [
  { key: "discovery", status: "completed", startedAt: publishedAt, completedAt: publishedAt },
  { key: "qualification", status: "completed", startedAt: publishedAt, completedAt: publishedAt },
  { key: "coarse_ranking", status: "completed", startedAt: publishedAt, completedAt: publishedAt },
  { key: "deep_matching", status: "completed", startedAt: publishedAt, completedAt: publishedAt },
  { key: "result_publication", status: "completed", startedAt: publishedAt, completedAt: publishedAt },
] as const;

describe("逻辑推荐运行契约", () => {
  it("接受可信的非空推荐清单并拒绝空清单和不闭合证据", () => {
    const result = { kind: "recommendation_list", resultId, recommendationListId: resultId, itemCount: 1, evidence: closingEvidence, publishedAt } as const;
    expect(RecommendationResultSchema.parse(result)).toEqual(result);
    expect(() => RecommendationResultSchema.parse({ ...result, itemCount: 0 })).toThrow();
    expect(() => RecommendationResultSchema.parse({ ...result, evidence: { ...closingEvidence, qualification: { ...closingEvidence.qualification, evaluatedCount: 4 } } })).toThrow();
    expect(() => RecommendationResultSchema.parse({ ...result, evidence: { ...closingEvidence, sourceCoverage: { ...closingEvidence.sourceCoverage, credibleBranchCount: 0 } } })).toThrow();
    expect(RecommendationResultSchema.safeParse({ ...result, evidence: { ...closingEvidence, suggestedActions: ["restart_discovery", "review_source_health", "review_profile"] } }).success).toBe(false);
    expect(RecommendationResultSchema.safeParse({ ...result, evidence: { ...closingEvidence, suggestedActions: ["restart_discovery", "restart_discovery"] } }).success).toBe(false);
  });

  it("将暂无推荐与深度匹配结果绑定，且不接受清单标识", () => {
    const result = { kind: "no_recommendations", resultId, evidence: { ...closingEvidence, deepMatching: { evaluatedCount: 2, qualityInsufficientCount: 2, finalRecommendationCount: 0 } }, publishedAt } as const;
    expect(RecommendationResultSchema.parse(result)).toEqual(result);
    expect(RecommendationResultSchema.safeParse({ ...result, recommendationListId }).success).toBe(false);
  });

  it("固定五个阶段的顺序，并将完成运行绑定到唯一可信结果", () => {
    const result = { kind: "recommendation_list", resultId, recommendationListId: resultId, itemCount: 1, evidence: closingEvidence, publishedAt } as const;
    const run = { runId, status: "completed", currentStage: null, stages: completedStages, target, sourceScope: { trustedSourceCount: 2, publicQueryCount: 1 }, accountPolicyRevisionNumber: 1, budgets: { discovery: budget, deepMatch: deepMatchBudget }, preflightSnapshot: readyPreflight, result, failure: null, createdAt: publishedAt, updatedAt: publishedAt } as const;
    expect(RecommendationRunSchema.parse(run)).toEqual(run);
    expect(RecommendationRunSchema.safeParse({ ...run, stages: [...completedStages].reverse() }).success).toBe(false);
    expect(RecommendationRunSchema.safeParse({ ...run, result: null }).success).toBe(false);
  });

  it("准备投影允许缺少主目标，但必须由阻塞检查报告说明", () => {
    const preparation = { target: null, sourceScope: { trustedSourceCount: 0, publicQueryCount: 0 }, accountPolicyRevisionNumber: 1, budgets: { discovery: budget, deepMatch: deepMatchBudget }, preflight: blockedPreflight } as const;
    expect(RecommendationRunPreparationSchema.parse(preparation)).toEqual(preparation);
    expect(RecommendationRunPreparationSchema.safeParse({ ...preparation, preflight: readyPreflight }).success).toBe(false);
  });

  it("将启动和控制命令限制为服务端可推导字段", () => {
    const start = { idempotencyKey: runId, warningFingerprint: null } as const;
    expect(StartRecommendationRunCommandSchema.parse(start)).toEqual(start);
    expect(StartRecommendationRunCommandSchema.safeParse({ ...start, targetId }).success).toBe(false);
    expect(StartRecommendationRunCommandSchema.safeParse({ ...start, budgets: { discovery: budget } }).success).toBe(false);
    expect(ControlRecommendationRunCommandSchema.parse({ commandId: runId, action: "pause" })).toEqual({ commandId: runId, action: "pause" });
  });

  it("失败代码仅接受稳定的运行原因枚举", () => {
    const failure = { code: "RECOMMENDATION_HANDOFF_FAILED", stage: "qualification", summary: "资格门槛交接失败", impact: "本次推荐无法继续发布。", retryable: true, suggestedActions: ["restart_discovery"] } as const;
    expect(RecommendationRunFailureSchema.parse(failure)).toEqual(failure);
    expect(RecommendationRunFailureSchema.safeParse({ ...failure, code: "li@example.com" }).success).toBe(false);
  });

  it("拒绝运行中、失败和取消运行的矛盾阶段拓扑", () => {
    const failure = { code: "RECOMMENDATION_HANDOFF_FAILED", stage: "qualification", summary: "资格门槛交接失败", impact: "本次推荐无法继续发布。", retryable: true, suggestedActions: ["restart_discovery"] } as const;
    const baseRun = { runId, target, sourceScope: { trustedSourceCount: 2, publicQueryCount: 1 }, accountPolicyRevisionNumber: 1, budgets: { discovery: budget, deepMatch: deepMatchBudget }, preflightSnapshot: readyPreflight, result: null, failure: null, createdAt: publishedAt, updatedAt: publishedAt } as const;
    expect(RecommendationRunSchema.safeParse({
      ...baseRun, status: "running", currentStage: "coarse_ranking",
      stages: [
        completedStages[0],
        { key: "qualification", status: "failed", startedAt: publishedAt, completedAt: publishedAt },
        { key: "coarse_ranking", status: "running", startedAt: publishedAt, completedAt: null },
        { key: "deep_matching", status: "pending", startedAt: null, completedAt: null },
        { key: "result_publication", status: "pending", startedAt: null, completedAt: null },
      ],
    }).success).toBe(false);
    expect(RecommendationRunSchema.safeParse({
      ...baseRun, status: "failed", currentStage: "qualification", failure,
      stages: [
        completedStages[0],
        { key: "qualification", status: "failed", startedAt: publishedAt, completedAt: publishedAt },
        { key: "coarse_ranking", status: "running", startedAt: publishedAt, completedAt: null },
        { key: "deep_matching", status: "pending", startedAt: null, completedAt: null },
        { key: "result_publication", status: "pending", startedAt: null, completedAt: null },
      ],
    }).success).toBe(false);
    expect(RecommendationRunSchema.safeParse({
      ...baseRun, status: "cancelled", currentStage: null,
      stages: [
        { key: "discovery", status: "cancelled", startedAt: publishedAt, completedAt: publishedAt },
        { key: "qualification", status: "running", startedAt: publishedAt, completedAt: null },
        { key: "coarse_ranking", status: "pending", startedAt: null, completedAt: null },
        { key: "deep_matching", status: "pending", startedAt: null, completedAt: null },
        { key: "result_publication", status: "pending", startedAt: null, completedAt: null },
      ],
    }).success).toBe(false);
  });

  it("拒绝超过计划来源范围的覆盖计数和不一致的运行来源范围", () => {
    const result = { kind: "recommendation_list", resultId, recommendationListId: resultId, itemCount: 1, evidence: closingEvidence, publishedAt } as const;
    expect(RecommendationResultSchema.safeParse({ ...result, evidence: { ...closingEvidence, sourceCoverage: { ...closingEvidence.sourceCoverage, checkedBranchCount: 4 } } }).success).toBe(false);
    expect(RecommendationResultSchema.safeParse({ ...result, evidence: { ...closingEvidence, sourceCoverage: { ...closingEvidence.sourceCoverage, credibleBranchCount: 3, checkedBranchCount: 2 } } }).success).toBe(false);
    expect(RecommendationRunSchema.safeParse({
      runId, status: "completed", currentStage: null, stages: completedStages, target,
      sourceScope: { trustedSourceCount: 1, publicQueryCount: 1 }, accountPolicyRevisionNumber: 1,
      budgets: { discovery: budget, deepMatch: deepMatchBudget }, preflightSnapshot: readyPreflight, result, failure: null, createdAt: publishedAt, updatedAt: publishedAt,
    }).success).toBe(false);
  });
});
