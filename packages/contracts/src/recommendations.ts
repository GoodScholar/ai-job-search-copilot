import { z } from "zod";
import { acceptsDeepMatchAssessment, DeepMatchAssessmentSchema, DeepMatchDimensionSchema, type DeepMatchAssessment } from "./deep-match";
import { RunPreflightWarningFingerprintSchema } from "./run-preflight";

export const RecommendationBandSchema = z.enum(["highly_matched", "worth_trying", "consider_carefully"]);
export const RecommendationDecisionStatusSchema = z.enum(["pending", "saved", "ignored"]);
export const RecommendationIgnoreReasonSchema = z.enum(["ROLE_DIRECTION", "LOCATION", "SALARY", "COMPANY", "INDUSTRY", "SENIORITY", "MISMATCH", "EXPIRED", "ALREADY_HANDLED"]);
export const RecommendationDecisionSchema = z.object({ status: RecommendationDecisionStatusSchema, version: z.int().nonnegative() }).strict();
export const StartRecommendationReevaluationCommandSchema = z.object({
  targetId: z.uuid(),
  opportunityId: z.uuid(),
  idempotencyKey: z.uuid(),
  warningFingerprint: RunPreflightWarningFingerprintSchema.nullable(),
}).strict();
export const RecommendationDecisionCommandSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("saved"), idempotencyKey: z.uuid(), expectedVersion: z.int().nonnegative() }).strict(),
  z.object({ decision: z.literal("ignored"), reason: RecommendationIgnoreReasonSchema.optional(), note: z.string().trim().min(1).max(500).optional(), idempotencyKey: z.uuid(), expectedVersion: z.int().nonnegative() }).strict(),
]);
export const CalibrationStrategySchema = z.enum(["require_related_evidence", "raise_quality_bar", "exclude_evidence_opportunities"]);
export const RecommendationRuleConfigSchema = z.object({
  minimumOverallScore: z.int().min(0).max(100), minimumEvidenceDimensions: z.int().min(0).max(6),
  requiredEvidenceDimensions: z.array(DeepMatchDimensionSchema).max(6), excludedOpportunityIds: z.array(z.uuid()).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.requiredEvidenceDimensions).size !== value.requiredEvidenceDimensions.length) context.addIssue({ code: "custom", path: ["requiredEvidenceDimensions"], message: "维度不可重复" });
  if (new Set(value.excludedOpportunityIds).size !== value.excludedOpportunityIds.length) context.addIssue({ code: "custom", path: ["excludedOpportunityIds"], message: "岗位不可重复" });
});
const RuleDiffValueSchema = z.union([z.int().min(0).max(100), z.array(DeepMatchDimensionSchema).max(6), z.array(z.uuid()).max(100)]);
export const CalibrationImpactPreviewSchema = z.object({ sampleSize: z.int().nonnegative(), estimatedAffectedCount: z.int().nonnegative(), ruleDiff: z.partialRecord(z.enum(["minimumOverallScore", "minimumEvidenceDimensions", "requiredEvidenceDimensions", "excludedOpportunityIds"]), z.object({ from: RuleDiffValueSchema, to: RuleDiffValueSchema }).strict()) }).strict();
/** Revision accepts only a user-selected strategy; config and preview are server-derived. */
export const CalibrationProposalRevisionCommandSchema = z.object({ strategy: CalibrationStrategySchema, idempotencyKey: z.uuid(), expectedVersion: z.int().positive() }).strict();
export const CalibrationProposalRebaseCommandSchema = z.object({ idempotencyKey: z.uuid(), expectedVersion: z.int().positive() }).strict();
/** Successful revise/rebase responses intentionally expose only public command identifiers. */
export const CalibrationProposalCommandResponseSchema = z.object({ proposalId: z.uuid(), revisionId: z.uuid(), revisionNumber: z.int().positive() }).strict();
export const CalibrationProposalResolutionCommandSchema = z.object({ action: z.enum(["approved", "rejected"]), idempotencyKey: z.uuid(), expectedVersion: z.int().positive() }).strict();
export const CalibrationProposalReviewStateSchema = z.enum(["current", "stale_rebase_required", "covered", "unrebasable", "resolved"]);
export const CalibrationProposalSchema = z.object({ proposalId: z.uuid(), targetId: z.uuid(), reason: RecommendationIgnoreReasonSchema, status: z.enum(["pending", "approved", "rejected"]), version: z.int().positive(), evidenceCount: z.int().positive(), reviewState: CalibrationProposalReviewStateSchema, availableStrategies: z.array(CalibrationStrategySchema), revision: z.object({ revisionId: z.uuid(), revisionNumber: z.int().positive(), strategy: CalibrationStrategySchema, ruleConfig: RecommendationRuleConfigSchema, impactPreview: CalibrationImpactPreviewSchema }).strict() }).strict().superRefine((value, context) => {
  const isResolved = value.status === "approved" || value.status === "rejected";
  if (isResolved && value.reviewState !== "resolved") context.addIssue({ code: "custom", path: ["reviewState"], message: "已解决建议必须使用 resolved 状态" });
  if (!isResolved && value.reviewState === "resolved") context.addIssue({ code: "custom", path: ["reviewState"], message: "pending 建议不可使用 resolved 状态" });
  if (isResolved && value.availableStrategies.length) context.addIssue({ code: "custom", path: ["availableStrategies"], message: "已解决建议不可提供恢复策略" });
});

/** Single acceptance predicate used for previews and staged deep-match publication. */
export function acceptsRecommendationRule(assessment: DeepMatchAssessment, config: z.infer<typeof RecommendationRuleConfigSchema>): boolean {
  const evidenceBacked = assessment.dimensions.filter((dimension) => dimension.judgment === "evidence_backed_inference");
  return acceptsDeepMatchAssessment(assessment)
    && assessment.overallScore >= config.minimumOverallScore
    && evidenceBacked.length >= config.minimumEvidenceDimensions
    && config.requiredEvidenceDimensions.every((dimension) => evidenceBacked.some((item) => item.dimension === dimension))
    && !config.excludedOpportunityIds.includes(assessment.opportunityId);
}
const RecommendationJobEvidenceSchema = z.object({ id: z.string().min(1), value: z.string().min(1), provenance: z.object({ sourcePostingVersionId: z.uuid(), field: z.string().min(1), path: z.string().min(1), originalValue: z.string().min(1), normalizedValue: z.string().min(1) }).strict().optional() }).strict();
const RecommendationProfileEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string().min(1), value: z.string().min(1), kind: z.literal("profile_fact"), profileFactRevisionId: z.uuid() }).strict(),
  z.object({ id: z.string().min(1), value: z.string().min(1), kind: z.literal("target_revision"), targetRevisionId: z.uuid() }).strict(),
]);
export const RecommendationExclusionSchema = z.object({ opportunityId: z.uuid(), reasonCode: z.enum(["TRIAGE_NOT_PASS", "DEADLINE_EXPIRED", "SCORE_BELOW_THRESHOLD", "CANDIDATE_LIMIT", "MATCH_QUALITY_INSUFFICIENT"]) }).strict();
export const RecommendationItemSchema = z.object({
  recommendationListItemId: z.uuid().optional(),
  matchVersionId: z.uuid(), opportunityId: z.uuid(), company: z.string().nullable(), title: z.string().nullable(), location: z.string().nullable(),
  displayBand: RecommendationBandSchema, highlighted: z.boolean(), ordinal: z.int().min(1).max(10), jobEvidence: z.array(RecommendationJobEvidenceSchema).max(20), profileEvidence: z.array(RecommendationProfileEvidenceSchema).max(20), assessment: DeepMatchAssessmentSchema,
  decision: RecommendationDecisionSchema.optional(),
}).strict();
export const RecommendationListSchema = z.object({
  recommendationListId: z.uuid(), targetId: z.uuid(), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), sequence: z.int().min(1), createdAt: z.iso.datetime(), exclusions: z.array(RecommendationExclusionSchema), exclusionsNextCursor: z.uuid().nullable().optional(), items: z.array(RecommendationItemSchema).max(10),
}).strict();
/** Historical versions carry the same frozen details as the latest list. */
export const RecommendationListHistorySchema = z.array(RecommendationListSchema);
/** Cursor values are immutable list/exclusion ids and are always scoped by the owning query. */
export const RecommendationListHistoryPageSchema = z.object({
  items: z.array(RecommendationListSchema),
  nextCursor: z.uuid().nullable(),
}).strict();
export const RecommendationExclusionPageSchema = z.object({
  items: z.array(RecommendationExclusionSchema),
  nextCursor: z.uuid().nullable(),
}).strict();
export type RecommendationList = z.infer<typeof RecommendationListSchema>;
export type RecommendationListHistory = z.infer<typeof RecommendationListHistorySchema>;
export type RecommendationListHistoryPage = z.infer<typeof RecommendationListHistoryPageSchema>;
export type RecommendationExclusionPage = z.infer<typeof RecommendationExclusionPageSchema>;
export type RecommendationDecisionCommand = z.infer<typeof RecommendationDecisionCommandSchema>;
export type RecommendationRuleConfig = z.infer<typeof RecommendationRuleConfigSchema>;
export type CalibrationProposalRevisionCommand = z.infer<typeof CalibrationProposalRevisionCommandSchema>;
export type CalibrationProposalRebaseCommand = z.infer<typeof CalibrationProposalRebaseCommandSchema>;
export type CalibrationProposalCommandResponse = z.infer<typeof CalibrationProposalCommandResponseSchema>;
export type CalibrationProposalResolutionCommand = z.infer<typeof CalibrationProposalResolutionCommandSchema>;
export type CalibrationProposal = z.infer<typeof CalibrationProposalSchema>;
