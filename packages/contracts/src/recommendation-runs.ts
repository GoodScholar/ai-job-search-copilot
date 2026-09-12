import { z } from "zod";
import { AgentRunBudgetSchema, AgentRunFailureCodeSchema, AgentRunStatusSchema } from "./agent-runs";
import { RunPreflightReportSchema, RunPreflightSnapshotSchema, RunPreflightWarningFingerprintSchema } from "./run-preflight";

const nonnegativeInteger = z.int().nonnegative();
const positiveInteger = z.int().positive();
const safeChineseCopy = (maxLength: number) => z.string().trim().min(1).max(maxLength).regex(/\p{Script=Han}/u, "必须包含中文安全文案");

export const RECOMMENDATION_RUN_STAGE_KEYS = ["discovery", "qualification", "coarse_ranking", "deep_matching", "result_publication"] as const;
export const RecommendationRunStageKeySchema = z.enum(RECOMMENDATION_RUN_STAGE_KEYS);
export const RecommendationRunStageStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled"]);
export const RecommendationRunSuggestedActionSchema = z.enum(["restart_discovery", "review_source_health", "review_profile", "review_primary_target"]);
export const RecommendationRunFailureSuggestedActionSchema = z.enum([
  "restart_discovery", "review_source_health", "review_profile", "review_primary_target", "run_model_diagnostic", "review_account_run_policy",
]);
export const RecommendationCoverageLossCodeSchema = z.enum([
  "TRUSTED_SOURCE_UNAVAILABLE", "PUBLIC_DISCOVERY_UNAVAILABLE", "SOURCE_HEALTH_DEGRADED", "SOURCE_CAPABILITY_UNAVAILABLE", "VERIFICATION_FAILED", "DISCOVERY_BUDGET_EXCEEDED",
]);
export const RecommendationRunFailureCodeSchema = z.union([
  AgentRunFailureCodeSchema,
  z.literal("RECOMMENDATION_HANDOFF_FAILED"),
  z.literal("RECOMMENDATION_PUBLICATION_FAILED"),
]);

export const RecommendationRunTargetSchema = z.object({
  targetId: z.uuid(), targetVersion: positiveInteger, roleFamily: z.string().trim().min(1).max(100),
}).strict();
export const RecommendationRunSourceScopeSchema = z.object({
  trustedSourceCount: nonnegativeInteger, publicQueryCount: nonnegativeInteger,
}).strict();

export const RecommendationResultEvidenceSchema = z.object({
  discovery: z.object({ discoveredJobCount: nonnegativeInteger }).strict(),
  sourceCoverage: z.object({
    plannedTrustedSourceCount: nonnegativeInteger, plannedPublicQueryCount: nonnegativeInteger, checkedBranchCount: nonnegativeInteger,
    credibleBranchCount: nonnegativeInteger, verifiedJobCount: nonnegativeInteger,
  }).strict(),
  coverageLosses: z.array(z.object({ code: RecommendationCoverageLossCodeSchema, affectedCount: nonnegativeInteger, retryable: z.boolean() }).strict()).max(32),
  qualification: z.object({
    evaluatedCount: nonnegativeInteger, rejectedCount: nonnegativeInteger, insufficientInformationCount: nonnegativeInteger, expiredCount: nonnegativeInteger,
  }).strict(),
  coarseRanking: z.object({
    eligibleCount: nonnegativeInteger, belowThresholdCount: nonnegativeInteger, candidateLimitExcludedCount: nonnegativeInteger, deepMatchCandidateCount: nonnegativeInteger,
  }).strict(),
  deepMatching: z.object({ evaluatedCount: nonnegativeInteger, qualityInsufficientCount: nonnegativeInteger, finalRecommendationCount: nonnegativeInteger }).strict(),
  suggestedActions: z.array(RecommendationRunSuggestedActionSchema).max(2).refine((actions) => new Set(actions).size === actions.length, "建议动作不可重复"),
}).strict().superRefine((evidence, context) => {
  const { discovery, qualification, coarseRanking, deepMatching, sourceCoverage } = evidence;
  const eligibleAfterQualification = discovery.discoveredJobCount - qualification.rejectedCount - qualification.insufficientInformationCount - qualification.expiredCount;
  if (qualification.evaluatedCount !== discovery.discoveredJobCount) context.addIssue({ code: "custom", path: ["qualification", "evaluatedCount"], message: "资格评估数量必须与发现岗位数量一致" });
  if (coarseRanking.eligibleCount !== eligibleAfterQualification) context.addIssue({ code: "custom", path: ["coarseRanking", "eligibleCount"], message: "粗排合格数量必须闭合资格门槛结果" });
  if (coarseRanking.eligibleCount !== coarseRanking.belowThresholdCount + coarseRanking.candidateLimitExcludedCount + coarseRanking.deepMatchCandidateCount) context.addIssue({ code: "custom", path: ["coarseRanking"], message: "粗排数量必须闭合" });
  if (deepMatching.evaluatedCount !== coarseRanking.deepMatchCandidateCount || deepMatching.evaluatedCount !== deepMatching.qualityInsufficientCount + deepMatching.finalRecommendationCount) context.addIssue({ code: "custom", path: ["deepMatching"], message: "深度匹配数量必须闭合" });
  if (sourceCoverage.credibleBranchCount < 1) context.addIssue({ code: "custom", path: ["sourceCoverage", "credibleBranchCount"], message: "可信结果至少需要一个可信发现分支" });
  if (sourceCoverage.checkedBranchCount > sourceCoverage.plannedTrustedSourceCount + sourceCoverage.plannedPublicQueryCount) context.addIssue({ code: "custom", path: ["sourceCoverage", "checkedBranchCount"], message: "已检查分支不能超过计划来源范围" });
  if (sourceCoverage.credibleBranchCount > sourceCoverage.checkedBranchCount) context.addIssue({ code: "custom", path: ["sourceCoverage", "credibleBranchCount"], message: "可信分支不能超过已检查分支" });
  if (sourceCoverage.verifiedJobCount !== discovery.discoveredJobCount) context.addIssue({ code: "custom", path: ["sourceCoverage", "verifiedJobCount"], message: "已验证岗位与发现岗位必须使用同一去重口径" });
});

const RecommendationListResultSchema = z.object({
  kind: z.literal("recommendation_list"), resultId: z.uuid(), recommendationListId: z.uuid(), itemCount: positiveInteger, evidence: RecommendationResultEvidenceSchema, publishedAt: z.iso.datetime(),
}).strict().superRefine((result, context) => {
  if (result.resultId !== result.recommendationListId) context.addIssue({ code: "custom", path: ["recommendationListId"], message: "推荐清单结果必须使用同一结果标识" });
  if (result.itemCount !== result.evidence.deepMatching.finalRecommendationCount) context.addIssue({ code: "custom", path: ["itemCount"], message: "清单数量必须与最终推荐数量一致" });
});
const NoRecommendationsResultSchema = z.object({
  kind: z.literal("no_recommendations"), resultId: z.uuid(), evidence: RecommendationResultEvidenceSchema, publishedAt: z.iso.datetime(),
}).strict().superRefine((result, context) => {
  if (result.evidence.deepMatching.finalRecommendationCount !== 0) context.addIssue({ code: "custom", path: ["evidence", "deepMatching", "finalRecommendationCount"], message: "暂无推荐结果的最终推荐数量必须为零" });
});
export const RecommendationResultSchema = z.discriminatedUnion("kind", [RecommendationListResultSchema, NoRecommendationsResultSchema]);

export const RecommendationRunFailureSchema = z.object({
  code: RecommendationRunFailureCodeSchema, stage: RecommendationRunStageKeySchema, summary: safeChineseCopy(200), impact: safeChineseCopy(500), retryable: z.boolean(),
  suggestedActions: z.array(RecommendationRunFailureSuggestedActionSchema).max(2).refine((actions) => new Set(actions).size === actions.length, "建议动作不可重复"),
}).strict();
export const RecommendationRunStageSchema = z.object({
  key: RecommendationRunStageKeySchema, status: RecommendationRunStageStatusSchema, startedAt: z.iso.datetime().nullable(), completedAt: z.iso.datetime().nullable(),
}).strict().superRefine((stage, context) => {
  if (stage.status === "pending" && (stage.startedAt !== null || stage.completedAt !== null)) context.addIssue({ code: "custom", message: "待处理阶段不能有时间戳" });
  if (stage.status === "running" && (stage.startedAt === null || stage.completedAt !== null)) context.addIssue({ code: "custom", message: "运行中阶段必须只有开始时间" });
  if ((stage.status === "completed" || stage.status === "failed" || stage.status === "cancelled") && stage.completedAt === null) context.addIssue({ code: "custom", message: "终态阶段必须有完成时间" });
});

export const RecommendationRunPreparationSchema = z.object({
  target: RecommendationRunTargetSchema.nullable(), sourceScope: RecommendationRunSourceScopeSchema, accountPolicyRevisionNumber: nonnegativeInteger,
  budgets: z.object({ discovery: AgentRunBudgetSchema, deepMatch: AgentRunBudgetSchema }).strict(), preflight: RunPreflightReportSchema,
}).strict().superRefine((preparation, context) => {
  if (preparation.preflight.workflow !== "recommendation") context.addIssue({ code: "custom", path: ["preflight", "workflow"], message: "推荐准备必须使用推荐运行前检查" });
  if (preparation.target === null && preparation.preflight.status !== "blocked") context.addIssue({ code: "custom", path: ["preflight", "status"], message: "缺少主求职目标的准备结果必须阻塞" });
  if (preparation.target !== null && preparation.preflight.targetId !== preparation.target.targetId) context.addIssue({ code: "custom", path: ["preflight", "targetId"], message: "运行前检查必须绑定当前主求职目标" });
});

export const RecommendationRunSchema = z.object({
  runId: z.uuid(), status: AgentRunStatusSchema, currentStage: RecommendationRunStageKeySchema.nullable(), stages: z.array(RecommendationRunStageSchema).length(RECOMMENDATION_RUN_STAGE_KEYS.length),
  target: RecommendationRunTargetSchema, sourceScope: RecommendationRunSourceScopeSchema, accountPolicyRevisionNumber: nonnegativeInteger,
  budgets: z.object({ discovery: AgentRunBudgetSchema, deepMatch: AgentRunBudgetSchema }).strict(), preflightSnapshot: RunPreflightSnapshotSchema,
  result: RecommendationResultSchema.nullable(), failure: RecommendationRunFailureSchema.nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict().superRefine((run, context) => {
  if (run.preflightSnapshot.workflow !== "recommendation" || run.preflightSnapshot.targetId !== run.target.targetId) context.addIssue({ code: "custom", path: ["preflightSnapshot"], message: "已启动推荐运行必须绑定推荐检查和主求职目标" });
  if (!run.stages.every((stage, index) => stage.key === RECOMMENDATION_RUN_STAGE_KEYS[index])) context.addIssue({ code: "custom", path: ["stages"], message: "阶段必须恰好按固定顺序出现一次" });
  const current = run.currentStage === null ? null : run.stages.find((stage) => stage.key === run.currentStage);
  const currentIndex = run.currentStage === null ? -1 : RECOMMENDATION_RUN_STAGE_KEYS.indexOf(run.currentStage);
  const hasActiveTopology = currentIndex >= 0 && run.stages.every((stage, index) => (
    index < currentIndex ? stage.status === "completed" : index === currentIndex ? stage.status === "pending" || stage.status === "running" : stage.status === "pending"
  ));
  const hasTerminalTopology = (terminalIndex: number, terminalStatus: "failed" | "cancelled") => terminalIndex >= 0 && run.stages.every((stage, index) => (
    index < terminalIndex ? stage.status === "completed" : index === terminalIndex ? stage.status === terminalStatus : stage.status === "pending"
  ));
  if (run.result !== null && (run.sourceScope.trustedSourceCount !== run.result.evidence.sourceCoverage.plannedTrustedSourceCount || run.sourceScope.publicQueryCount !== run.result.evidence.sourceCoverage.plannedPublicQueryCount)) {
    context.addIssue({ code: "custom", path: ["sourceScope"], message: "运行来源范围必须与发布结果中的计划来源一致" });
  }
  if (run.status === "completed") {
    if (run.currentStage !== null || run.result === null || run.failure !== null || run.stages.some((stage) => stage.status !== "completed")) context.addIssue({ code: "custom", message: "完成运行必须完成全部阶段并且只具有结果" });
  } else if (run.status === "failed") {
    if (run.currentStage === null || run.result !== null || run.failure === null || run.failure.stage !== run.currentStage || current?.status !== "failed" || !hasTerminalTopology(currentIndex, "failed")) context.addIssue({ code: "custom", message: "失败运行必须绑定失败阶段和失败详情" });
  } else if (run.status === "cancelled") {
    const cancelledIndex = run.stages.findIndex((stage) => stage.status === "cancelled");
    if (run.currentStage !== null || run.result !== null || run.failure !== null || !hasTerminalTopology(cancelledIndex, "cancelled")) context.addIssue({ code: "custom", message: "取消运行不能发布结果或失败详情" });
  } else if (run.status === "queued") {
    if (run.currentStage !== "discovery" || run.result !== null || run.failure !== null || !hasActiveTopology) context.addIssue({ code: "custom", message: "排队运行只能在发现阶段等待或开始" });
  } else if (run.currentStage === null || run.result !== null || run.failure !== null || !hasActiveTopology) {
    context.addIssue({ code: "custom", message: "非终态运行必须停留在未完成阶段且没有最终结果" });
  }
});

export const StartRecommendationRunCommandSchema = z.object({ idempotencyKey: z.uuid(), warningFingerprint: RunPreflightWarningFingerprintSchema.nullable().default(null) }).strict();
export const ControlRecommendationRunCommandSchema = z.object({ commandId: z.uuid(), action: z.enum(["pause", "resume", "cancel"]) }).strict();

export type RecommendationRunStageKey = z.infer<typeof RecommendationRunStageKeySchema>;
export type RecommendationRunStage = z.infer<typeof RecommendationRunStageSchema>;
export type RecommendationResultEvidence = z.infer<typeof RecommendationResultEvidenceSchema>;
export type RecommendationResult = z.infer<typeof RecommendationResultSchema>;
export type RecommendationRunFailure = z.infer<typeof RecommendationRunFailureSchema>;
export type RecommendationRunPreparation = z.infer<typeof RecommendationRunPreparationSchema>;
export type RecommendationRun = z.infer<typeof RecommendationRunSchema>;
export type StartRecommendationRunCommand = z.input<typeof StartRecommendationRunCommandSchema>;
export type ControlRecommendationRunCommand = z.infer<typeof ControlRecommendationRunCommandSchema>;
