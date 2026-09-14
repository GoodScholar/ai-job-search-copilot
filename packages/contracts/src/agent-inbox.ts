import { z } from "zod";
import {
  AgentRunBudgetDimensionSchema,
  AgentRunControlSnapshotSchema,
  AgentRunFailureCodeSchema,
} from "./agent-runs";
import { RecommendationRunFailureSuggestedActionSchema } from "./recommendation-runs";
import { RunPreflightWarningFingerprintSchema } from "./run-preflight";

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const sameActions = (actual: readonly string[], expected: readonly string[]) => actual.length === expected.length && actual.every((action, index) => action === expected[index]);
const unreadActions = (status: z.infer<typeof AgentInboxStatusSchema>, terminalActions: readonly string[]) => status === "unread" ? ["mark_read", ...terminalActions] : terminalActions;
const nonBudgetFailureCodes = new Set<string>(AgentRunFailureCodeSchema.options.filter((code) => code !== "AGENT_RUN_BUDGET_EXCEEDED"));

export const AgentInboxKindSchema = z.enum([
  "run_failed", "budget_exhausted", "decision_required", "source_attention", "discovery_attention",
  "candidate_fact", "recommendation_list", "recommendation_result", "calibration_proposal",
]);
export const AgentInboxStatusSchema = z.enum(["unread", "read", "resolved"]);
export const AgentInboxActionSchema = z.enum(["restart_run", "resume_run", "cancel_run", "mark_read", "dismiss"]);
export const AgentInboxReasonCodeSchema = z.union([
  z.literal("AGENT_RUN_PAUSED"), z.literal("SOURCE_HEALTH_ATTENTION"), z.literal("DISCOVERY_ATTENTION"),
  z.literal("CANDIDATE_FACT_PENDING"), z.literal("RECOMMENDATION_LIST_PUBLISHED"), z.literal("NO_RECOMMENDATIONS_PUBLISHED"), z.literal("CALIBRATION_PROPOSAL_CREATED"),
  AgentRunFailureCodeSchema,
]);

export const AgentInboxTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("candidate_fact"), candidateFactId: z.uuid(), href: z.string().regex(/^\/profile#candidate-facts$/u) }).strict(),
  z.object({ type: z.literal("agent_run"), runId: z.uuid(), href: z.string().regex(new RegExp(`^/home\\?runId=${uuidPattern}#agent-run$`, "u")) }).strict(),
  z.object({ type: z.literal("recommendation_run"), physicalRunId: z.uuid(), rootRunId: z.uuid(), targetId: z.uuid(), href: z.string().regex(new RegExp(`^/home\\?runId=${uuidPattern}#recommendation-run$`, "u")) }).strict(),
  z.object({ type: z.literal("job_source"), watchlistItemId: z.uuid(), targetId: z.uuid(), href: z.string().regex(new RegExp(`^/profile/targets/${uuidPattern}/watchlist#source-health$`, "u")) }).strict(),
  z.object({ type: z.literal("recommendation_list"), recommendationListId: z.uuid(), targetId: z.uuid(), href: z.string().regex(new RegExp(`^/recommendations\\?targetId=${uuidPattern}&recommendationListId=${uuidPattern}#recommendation-list$`, "u")) }).strict(),
  z.object({ type: z.literal("recommendation_result"), recommendationResultId: z.uuid(), rootRunId: z.uuid(), targetId: z.uuid(), href: z.string().regex(new RegExp(`^/recommendations\\?runId=${uuidPattern}&resultId=${uuidPattern}#recommendation-result$`, "u")) }).strict(),
  z.object({ type: z.literal("calibration_proposal"), proposalId: z.uuid(), targetId: z.uuid(), href: z.string().regex(new RegExp(`^/recommendations\\?targetId=${uuidPattern}#calibration-proposal$`, "u")) }).strict(),
]);

const copy = z.string().trim().min(1).max(500);
const suggestedActions = z.array(RecommendationRunFailureSuggestedActionSchema).max(2).refine((actions) => new Set(actions).size === actions.length, "suggested actions must be unique");
const itemSchema = z.object({
  itemId: z.uuid(), runId: z.uuid().nullable(), kind: AgentInboxKindSchema, status: AgentInboxStatusSchema,
  reasonCode: AgentInboxReasonCodeSchema, budgetDimension: AgentRunBudgetDimensionSchema.nullable(),
  retryable: z.boolean(), suggestedActions,
  title: z.string().trim().min(1).max(200), message: copy,
  basis: copy, impact: copy, suggestedAction: copy,
  target: AgentInboxTargetSchema, availableActions: z.array(AgentInboxActionSchema).max(3),
  createdAt: z.iso.datetime(), readAt: z.iso.datetime().nullable(), resolvedAt: z.iso.datetime().nullable(),
}).strict();

export const AgentInboxItemSchema = itemSchema.superRefine((item, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  const created = Date.parse(item.createdAt);
  const read = item.readAt === null ? null : Date.parse(item.readAt);
  const resolved = item.resolvedAt === null ? null : Date.parse(item.resolvedAt);
  if ((item.status === "unread") !== (item.readAt === null && item.resolvedAt === null)) issue("status", "unread items require null readAt and resolvedAt");
  if ((item.status === "read") !== (item.readAt !== null && item.resolvedAt === null)) issue("status", "read items require readAt and null resolvedAt");
  if ((item.status === "resolved") !== (item.resolvedAt !== null)) issue("status", "resolved items require resolvedAt");
  if ((read !== null && read < created) || (resolved !== null && resolved < created) || (read !== null && resolved !== null && resolved < read)) issue("resolvedAt", "lifecycle timestamps must be chronological");
  if (item.status === "resolved" && item.availableActions.length !== 0) issue("availableActions", "resolved items have no actions");
  if (item.target.type === "agent_run" && item.target.href !== `/home?runId=${item.target.runId}#agent-run`) issue("target", "agent run href must match runId");
  if (item.target.type === "recommendation_run" && item.target.href !== `/home?runId=${item.target.rootRunId}#recommendation-run`) issue("target", "recommendation run href must match rootRunId");
  if (item.target.type === "job_source" && item.target.href !== `/profile/targets/${item.target.targetId}/watchlist#source-health`) issue("target", "job source href must match targetId");
  if (item.target.type === "recommendation_list" && item.target.href !== `/recommendations?targetId=${item.target.targetId}&recommendationListId=${item.target.recommendationListId}#recommendation-list`) issue("target", "recommendation href must match target and list");
  if (item.target.type === "recommendation_result" && item.target.href !== `/recommendations?runId=${item.target.rootRunId}&resultId=${item.target.recommendationResultId}#recommendation-result`) issue("target", "recommendation result href must match root and result");
  if (item.target.type === "calibration_proposal" && item.target.href !== `/recommendations?targetId=${item.target.targetId}#calibration-proposal`) issue("target", "calibration href must match targetId");

  const active = item.status !== "resolved";
  if (item.kind === "candidate_fact") {
    if (item.reasonCode !== "CANDIDATE_FACT_PENDING" || item.budgetDimension !== null || item.runId !== null || item.target.type !== "candidate_fact" || item.retryable || item.suggestedActions.length) issue("kind", "invalid candidate fact projection");
    if (active && !sameActions(item.availableActions, unreadActions(item.status, ["dismiss"]))) issue("availableActions", "invalid candidate fact actions");
  } else if (item.kind === "recommendation_list") {
    if (item.reasonCode !== "RECOMMENDATION_LIST_PUBLISHED" || item.budgetDimension !== null || item.runId !== null || item.target.type !== "recommendation_list" || item.retryable || item.suggestedActions.length) issue("kind", "invalid recommendation projection");
    if (active && !sameActions(item.availableActions, unreadActions(item.status, ["dismiss"]))) issue("availableActions", "invalid recommendation actions");
  } else if (item.kind === "recommendation_result") {
    if (item.reasonCode !== "NO_RECOMMENDATIONS_PUBLISHED" || item.budgetDimension !== null || item.runId !== null || item.target.type !== "recommendation_result" || item.retryable || item.suggestedActions.length) issue("kind", "invalid recommendation result projection");
    if (active && !sameActions(item.availableActions, unreadActions(item.status, ["dismiss"]))) issue("availableActions", "invalid recommendation result actions");
  } else if (item.kind === "calibration_proposal") {
    if (item.reasonCode !== "CALIBRATION_PROPOSAL_CREATED" || item.budgetDimension !== null || item.runId !== null || item.target.type !== "calibration_proposal" || item.retryable || item.suggestedActions.length) issue("kind", "invalid calibration projection");
    if (active && !sameActions(item.availableActions, unreadActions(item.status, ["dismiss"]))) issue("availableActions", "invalid calibration actions");
  } else if (item.kind === "source_attention") {
    if (item.reasonCode !== "SOURCE_HEALTH_ATTENTION" || item.budgetDimension !== null || item.runId === null || item.target.type !== "job_source" || item.retryable || item.suggestedActions.length) issue("kind", "invalid source attention projection");
    if (active && !sameActions(item.availableActions, unreadActions(item.status, ["dismiss"]))) issue("availableActions", "invalid source attention actions");
  } else {
    if (item.runId === null || (item.target.type !== "agent_run" && item.target.type !== "recommendation_run") || (item.target.type === "agent_run" && item.target.runId !== item.runId) || (item.target.type === "recommendation_run" && item.target.physicalRunId !== item.runId)) issue("target", "run items require matching run provenance");
    if (item.kind === "decision_required") {
      if (item.reasonCode !== "AGENT_RUN_PAUSED" || item.budgetDimension !== null || item.retryable || item.suggestedActions.length) issue("kind", "invalid decision projection");
      if (active && !sameActions(item.availableActions, unreadActions(item.status, ["resume_run", "cancel_run"]))) issue("availableActions", "invalid decision actions");
    } else if (item.kind === "run_failed") {
      if (!nonBudgetFailureCodes.has(item.reasonCode) || item.budgetDimension !== null) issue("kind", "invalid failure projection");
      if (item.target.type === "agent_run" && (!item.retryable || item.suggestedActions.length)) issue("kind", "legacy failure projection remains retryable");
      if (item.target.type === "recommendation_run" && item.retryable && item.reasonCode !== "AGENT_RUN_ADAPTER_RETRYABLE" && item.reasonCode !== "AGENT_RUN_MODEL_RETRYABLE") issue("kind", "only transient recommendation failures are retryable");
      if (active && !sameActions(item.availableActions, unreadActions(item.status, item.retryable ? ["restart_run", "dismiss"] : ["dismiss"]))) issue("availableActions", "invalid failure actions");
    } else if (item.kind === "budget_exhausted") {
      if (item.reasonCode !== "AGENT_RUN_BUDGET_EXCEEDED" || item.budgetDimension === null || item.retryable) issue("kind", "invalid budget projection");
      if (item.target.type === "agent_run" && item.suggestedActions.length) issue("kind", "legacy budget projection has no semantic suggestions");
      if (active && !sameActions(item.availableActions, unreadActions(item.status, ["dismiss"]))) issue("availableActions", "invalid budget actions");
    } else if (item.kind === "discovery_attention") {
      if (item.reasonCode !== "DISCOVERY_ATTENTION" || item.budgetDimension !== null || item.retryable || item.suggestedActions.length) issue("kind", "invalid discovery attention projection");
      if (active && !sameActions(item.availableActions, unreadActions(item.status, ["dismiss"]))) issue("availableActions", "invalid discovery attention actions");
    }
  }
});

export const AgentInboxListSchema = z.object({ items: z.array(AgentInboxItemSchema) }).strict();
export const AgentInboxActionCommandSchema = z.discriminatedUnion("action", [
  z.object({ actionId: z.uuid(), action: z.literal("restart_run"), warningFingerprint: RunPreflightWarningFingerprintSchema.nullable().optional() }).strict(),
  z.object({ actionId: z.uuid(), action: z.literal("resume_run") }).strict(),
  z.object({ actionId: z.uuid(), action: z.literal("cancel_run") }).strict(),
  z.object({ actionId: z.uuid(), action: z.literal("mark_read") }).strict(),
  z.object({ actionId: z.uuid(), action: z.literal("dismiss") }).strict(),
]);
export const AgentInboxActionResponseSchema = z.object({ applied: z.boolean(), item: AgentInboxItemSchema, run: AgentRunControlSnapshotSchema.nullable() }).strict();

export type AgentInboxTarget = z.infer<typeof AgentInboxTargetSchema>;
export type AgentInboxItem = z.infer<typeof AgentInboxItemSchema>;
export type AgentInboxActionCommand = z.infer<typeof AgentInboxActionCommandSchema>;
export type AgentInboxActionResponse = z.infer<typeof AgentInboxActionResponseSchema>;
