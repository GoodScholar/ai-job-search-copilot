import { z } from "zod";
import { GreenhousePublicSourceSchema } from "./job-discovery-schedules";
import {
  DiscoveryDiagnosticSchema,
  DiscoverySourceIssueSummarySchema,
  LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER,
  LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION,
  LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION,
  LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION,
  LAYERED_PUBLIC_JOB_DISCOVERY_TOOL_ALLOWLIST,
  LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION,
  LayeredPublicJobDiscoveryProfileSnapshotSchema,
  LayeredPublicJobDiscoveryResultSummarySchema,
  LayeredPublicJobDiscoverySourceScopeSchema,
  LayeredPublicJobDiscoveryTargetSnapshotSchema,
  LayeredPublicJobDiscoveryWatchlistSnapshotSchema,
} from "./job-discovery";
import { JobTargetConstraintsSchema } from "./job-targets";

export const AGENT_RUN_QUEUE = "agent-runs";
export const AGENT_RUN_JOB_NAME = "discover-jobs";
export const AGENT_RUN_JOB_VERSION = 1;
export const AGENT_RUN_CLAIM_LEASE_MS = 30_000;
export const AGENT_RUN_SCAN_INTERVAL_MS = 1_000;
export const FAKE_JOB_DISCOVERY_WORKFLOW_VERSION = "job-discovery-workflow-v1";
export const FAKE_JOB_DISCOVERY_ADAPTER = "fake";
export const FAKE_JOB_DISCOVERY_ADAPTER_VERSION = "fake-job-discovery-v1";
export const FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER = "fake-public";
export const FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION = "fake-public-job-discovery-v1";
export const FAKE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION = "job-discovery-result-v1";
export const FAKE_JOB_DISCOVERY_SOURCE_IDS = ["fake:aurora-careers", "fake:orbit-careers"] as const;
export const GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION = "job-discovery-workflow-v2";
export const GREENHOUSE_JOB_DISCOVERY_ADAPTER = "greenhouse";
export const GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION = "greenhouse-job-board-v1";
export const GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION = "job-discovery-result-v2";
export const GREENHOUSE_JOB_DISCOVERY_RULE_VERSION = "greenhouse-job-discovery-rules-v1";
export const GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION = "job-discovery-workflow-v3";
export const GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION = "greenhouse-job-board-v2";
export const GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION = "job-discovery-result-v3";
export const GREENHOUSE_SOURCE_HEALTH_RULE_VERSION = "job-discovery-source-health-rules-v1";
export const GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST = ["job_discovery.list_source", "job_discovery.get_detail"] as const;
export const AGENT_RUN_RULE_VERSION = "fake-job-discovery-rules-v1";
export const AGENT_RUN_TOOL_ALLOWLIST = ["job_discovery.search_batch", "job_discovery.get_detail"] as const;
export const AGENT_RUN_BUDGET = {
  maxActiveDurationMs: 60_000,
  maxAttempts: 3,
  maxToolCalls: 10,
  maxResults: 5,
  maxModelCalls: 0,
  maxTokens: 0,
} as const;
export const PUBLIC_JOB_DISCOVERY_BUDGET = {
  maxActiveDurationMs: 180_000,
  maxAttempts: 3,
  maxToolCalls: 60,
  maxResults: 5,
  maxModelCalls: 0,
  maxTokens: 0,
} as const;
export const DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION = "deep-match-v1";
export const DEEP_MATCH_AGENT_RUN_STEPS = ["select_candidates", "assess_matches", "create_recommendations"] as const;
export const DEEP_MATCH_AGENT_RUN_BUDGET = {
  maxActiveDurationMs: 180_000, maxAttempts: 3, maxToolCalls: 0, maxResults: 10, maxModelCalls: 10, maxTokens: 20_000,
} as const;

const positiveInteger = z.int().min(1);
const nonnegativeInteger = z.int().nonnegative();
const nullableJobField = z.string().trim().min(1).max(20_000).nullable();
const jsonObject = z.record(z.string(), z.unknown());

export const SourceHealthStatusSchema = z.enum([
  "healthy", "zero_valid_results", "parser_degraded", "rate_limited", "hard_failed",
]);
type SourceHealthStatus = z.infer<typeof SourceHealthStatusSchema>;
export const SourceHealthProjectionStatusSchema = z.enum([
  "healthy", "zero_valid_results", "parser_degraded", "rate_limited", "hard_failed", "disabled",
]);
export const SourceHealthReasonCodeSchema = z.enum([
  "SOURCE_LIST_SCHEMA_INVALID", "SOURCE_DETAIL_FIELDS_MISSING", "SOURCE_DETAIL_URL_INVALID",
  "SOURCE_DETAIL_IDENTITY_INVALID", "SOURCE_RATE_LIMITED", "SOURCE_AUTH_FAILED", "SOURCE_TIMEOUT",
  "SOURCE_UNREACHABLE", "SOURCE_SERVER_ERROR", "SOURCE_POLICY_REJECTED",
]);
export const SourceHealthImpactScopeSchema = z.enum(["none", "entire_source", "job_details"]);
export const SourceHealthSuggestedActionSchema = z.enum([
  "none", "wait_for_next_run", "retry_later", "retry_or_disable", "reenable_source",
]);
export const SourceHealthSourceIdSchema = z.string().trim().regex(/^greenhouse:[A-Za-z0-9_-]{1,128}$/u);
export const SourceHealthImpactSchema = z.object({
  scope: SourceHealthImpactScopeSchema,
  affectedCount: nonnegativeInteger.nullable(),
}).strict().superRefine((impact, context) => {
  const invalidNone = impact.scope === "none" && impact.affectedCount !== null;
  const invalidDetails = impact.scope === "job_details" && (impact.affectedCount === null || impact.affectedCount < 1);
  if (invalidNone || invalidDetails) context.addIssue({ code: "custom", path: ["affectedCount"], message: "impact scope must match its affected count" });
});
const SourceHealthReasonCodesSchema = z.array(SourceHealthReasonCodeSchema).max(10).refine(
  (codes) => new Set(codes).size === codes.length,
  { message: "reason codes must be unique" },
);
export type SourceHealthReasonCode = z.infer<typeof SourceHealthReasonCodeSchema>;

const parserDegradationReasons: ReadonlySet<SourceHealthReasonCode> = new Set([
  "SOURCE_LIST_SCHEMA_INVALID", "SOURCE_DETAIL_FIELDS_MISSING", "SOURCE_DETAIL_URL_INVALID", "SOURCE_DETAIL_IDENTITY_INVALID",
]);
const hardFailureReasons: ReadonlySet<SourceHealthReasonCode> = new Set([
  "SOURCE_AUTH_FAILED", "SOURCE_TIMEOUT", "SOURCE_UNREACHABLE", "SOURCE_SERVER_ERROR", "SOURCE_POLICY_REJECTED",
]);
const sourceHealthSuggestedActions: Record<SourceHealthStatus, z.infer<typeof SourceHealthSuggestedActionSchema>> = {
  healthy: "none",
  zero_valid_results: "wait_for_next_run",
  parser_degraded: "retry_or_disable",
  rate_limited: "retry_later",
  hard_failed: "retry_or_disable",
};

function hasStatusMatchedSourceHealthEvidence(
  status: SourceHealthStatus,
  reasonCodes: SourceHealthReasonCode[],
  impact: z.infer<typeof SourceHealthImpactSchema>,
): boolean {
  if (status === "healthy" || status === "zero_valid_results") {
    return reasonCodes.length === 0 && impact.scope === "none" && impact.affectedCount === null;
  }
  if (status === "parser_degraded") {
    return reasonCodes.length > 0 && reasonCodes.every((code) => parserDegradationReasons.has(code))
      && (impact.scope === "job_details" || impact.scope === "entire_source");
  }
  if (status === "rate_limited") {
    return reasonCodes.length === 1 && reasonCodes[0] === "SOURCE_RATE_LIMITED" && impact.scope === "entire_source";
  }
  return reasonCodes.length > 0 && reasonCodes.every((code) => hardFailureReasons.has(code)) && impact.scope === "entire_source";
}

export const JobSourceHealthCheckSchema = z.object({
  checkId: z.uuid(),
  runId: z.uuid(),
  targetId: z.uuid(),
  watchlistItemId: z.uuid(),
  sourceId: SourceHealthSourceIdSchema,
  status: SourceHealthStatusSchema,
  reasonCodes: SourceHealthReasonCodesSchema,
  impact: SourceHealthImpactSchema,
  observedPostingCount: nonnegativeInteger,
  selectedDetailCount: nonnegativeInteger,
  validDetailCount: nonnegativeInteger,
  requestAttemptCount: nonnegativeInteger,
  checkedAt: z.iso.datetime(),
}).strict().superRefine((check, context) => {
  const invalidOrdering = check.validDetailCount > check.selectedDetailCount || check.selectedDetailCount > check.observedPostingCount;
  if (invalidOrdering) context.addIssue({ code: "custom", path: ["validDetailCount"], message: "valid details must be selected and selected details observed" });
  if (check.requestAttemptCount < 1) context.addIssue({ code: "custom", path: ["requestAttemptCount"], message: "controlled checks require an attempt" });
  if (check.status === "healthy" && (check.validDetailCount < 1 || !hasStatusMatchedSourceHealthEvidence(check.status, check.reasonCodes, check.impact))) {
    context.addIssue({ code: "custom", path: ["status"], message: "healthy checks retain verified progress without issue evidence" });
  }
  if (check.status === "zero_valid_results" && (check.validDetailCount !== 0 || !hasStatusMatchedSourceHealthEvidence(check.status, check.reasonCodes, check.impact))) {
    context.addIssue({ code: "custom", path: ["status"], message: "zero-valid checks are completed without issue evidence" });
  }
  if ((check.status === "parser_degraded" || check.status === "rate_limited" || check.status === "hard_failed")
    && !hasStatusMatchedSourceHealthEvidence(check.status, check.reasonCodes, check.impact)) {
    context.addIssue({ code: "custom", path: ["reasonCodes"], message: "source health evidence must match its status" });
  }
});
export const JobSourceHealthProjectionSchema = z.object({
  watchlistItemId: z.uuid(),
  sourceId: SourceHealthSourceIdSchema,
  name: z.string().trim().min(1).max(200),
  state: z.enum(["enabled", "disabled"]),
  status: SourceHealthProjectionStatusSchema.nullable(),
  runId: z.uuid().nullable(),
  reasonCodes: SourceHealthReasonCodesSchema,
  impact: SourceHealthImpactSchema,
  lastCheckedAt: z.iso.datetime().nullable(),
  suggestedAction: SourceHealthSuggestedActionSchema,
}).strict().superRefine((projection, context) => {
  const noIssueEvidence = projection.runId === null && projection.lastCheckedAt === null && projection.reasonCodes.length === 0
    && projection.impact.scope === "none" && projection.impact.affectedCount === null;
  if ((projection.state === "disabled") !== (projection.status === "disabled")) {
    context.addIssue({ code: "custom", path: ["status"], message: "Watchlist state and disabled projection status must pair" });
  }
  if (projection.status === null && !(projection.state === "enabled" && noIssueEvidence && projection.suggestedAction === "wait_for_next_run")) {
    context.addIssue({ code: "custom", message: "unchecked enabled sources contain no evidence and wait for the next run" });
  }
  if (projection.status === "disabled" && !(projection.state === "disabled" && noIssueEvidence && projection.suggestedAction === "reenable_source")) {
    context.addIssue({ code: "custom", message: "disabled sources project current state without issue evidence" });
  }
  if (projection.status !== null && projection.status !== "disabled"
    && (projection.runId === null || projection.lastCheckedAt === null
      || !hasStatusMatchedSourceHealthEvidence(projection.status, projection.reasonCodes, projection.impact)
      || projection.suggestedAction !== sourceHealthSuggestedActions[projection.status])) {
    context.addIssue({ code: "custom", message: "checked enabled sources retain matched controlled-check evidence" });
  }
});

/** 当前 Watchlist 来源的 owner-bound 健康诊断概览。 */
export const JobSourceHealthOverviewSchema = z.object({
  targetId: z.uuid(),
  watchlistVersion: nonnegativeInteger,
  sources: z.array(JobSourceHealthProjectionSchema).max(50),
}).strict().superRefine((overview, context) => {
  const keys = overview.sources.map((source) => `${source.watchlistItemId}:${source.sourceId}`);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["sources"], message: "current sources must be unique" });
});

export const AgentRunStatusSchema = z.enum(["queued", "running", "paused", "completed", "failed", "cancelled"]);
export const AgentRunControlStateSchema = z.enum(["none", "pause_requested", "cancel_requested"]);
export const AgentRunControlActionSchema = z.enum(["pause", "resume", "cancel"]);
export const AgentRunBudgetDimensionSchema = z.enum(["active_duration", "attempts", "tool_calls", "model_calls", "tokens"]);
export const AgentRunCurrentStepSchema = z.enum([
  "queued", "batch_search", "fetch_details", "persist_results", "select_candidates", "assess_matches", "create_recommendations", "completed", "failed", "cancelled",
]);
export const AgentRunStepKeySchema = z.enum(["batch_search", "fetch_details", "persist_results", "select_candidates", "assess_matches", "create_recommendations"]);
export const AgentRunStepStatusSchema = z.enum(["pending", "running", "completed", "failed"]);
export const AgentRunFailureCodeSchema = z.enum([
  "AGENT_RUN_ADAPTER_RETRYABLE",
  "AGENT_RUN_ADAPTER_FAILED",
  "AGENT_RUN_CONTENT_STORAGE_FAILED",
  "AGENT_RUN_PERSIST_FAILED",
  "AGENT_RUN_BUDGET_EXCEEDED",
  "AGENT_RUN_MODEL_RETRYABLE",
  "AGENT_RUN_MODEL_AUTH_FAILED",
  "AGENT_RUN_MODEL_POLICY_REJECTED",
  "AGENT_RUN_MODEL_INVALID_RESPONSE",
]);
export const AgentRunEventTypeSchema = z.enum([
  "run.queued", "run.started", "step.started", "step.completed", "run.retry_scheduled", "run.completed", "run.failed",
  "run.pause_requested", "run.paused", "run.resume_requested", "run.resumed", "run.cancel_requested", "run.cancelled", "run.budget_updated",
]);
export type AgentRunEventType = z.infer<typeof AgentRunEventTypeSchema>;
export const AGENT_RUN_TERMINAL_EVENT_TYPES = ["run.paused", "run.cancelled", "run.completed", "run.failed"] as const;

export function isAgentRunTerminalEvent(eventType: AgentRunEventType): boolean {
  return (AGENT_RUN_TERMINAL_EVENT_TYPES as readonly AgentRunEventType[]).includes(eventType);
}

export const AgentRunBudgetSchema = z.object({
  maxActiveDurationMs: z.literal(60_000), maxAttempts: z.literal(3), maxToolCalls: z.literal(10),
  maxResults: z.literal(5), maxModelCalls: z.literal(0), maxTokens: z.literal(0),
}).strict();

export const AgentRunTargetSnapshotSchema = z.object({
  targetId: z.uuid(), version: positiveInteger, priority: z.enum(["primary", "secondary"]),
  state: z.literal("active"), constraints: JobTargetConstraintsSchema,
}).strict();

export const AgentRunSourceScopeSchema = z.object({
  kind: z.literal("company_watchlist"), adapter: z.literal(FAKE_JOB_DISCOVERY_ADAPTER),
  adapterVersion: z.literal(FAKE_JOB_DISCOVERY_ADAPTER_VERSION),
  watchlistVersion: nonnegativeInteger,
  sources: z.array(z.string().trim().min(1).max(2_048)).max(52).refine(
    (values) => new Set(values).size === values.length,
    { message: "sources must be unique" },
  ),
}).strict();

export const PublicAgentRunSourceScopeSchema = z.object({
  kind: z.literal("company_watchlist"),
  adapter: z.literal(GREENHOUSE_JOB_DISCOVERY_ADAPTER),
  adapterVersion: z.literal(GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION),
  watchlistVersion: positiveInteger,
  sources: z.array(GreenhousePublicSourceSchema).min(1).max(50).refine(
    (sources) => new Set(sources.map((source) => source.sourceId)).size === sources.length,
    { message: "source IDs must be unique" },
  ),
}).strict();

export const PublicSourceHealthAgentRunSourceScopeSchema = z.object({
  kind: z.literal("company_watchlist"),
  adapter: z.literal(GREENHOUSE_JOB_DISCOVERY_ADAPTER),
  adapterVersion: z.literal(GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION),
  watchlistVersion: positiveInteger,
  sources: z.array(GreenhousePublicSourceSchema).min(1).max(50).refine(
    (sources) => new Set(sources.map((source) => source.sourceId)).size === sources.length,
    { message: "source IDs must be unique" },
  ),
}).strict();

const FakeAgentRunExecutionSpecSchema = z.object({
  targetSnapshot: AgentRunTargetSnapshotSchema,
  sourceScope: AgentRunSourceScopeSchema,
  workflowVersion: z.literal(FAKE_JOB_DISCOVERY_WORKFLOW_VERSION),
  ruleVersion: z.literal(AGENT_RUN_RULE_VERSION),
  adapter: z.literal(FAKE_JOB_DISCOVERY_ADAPTER),
  adapterVersion: z.literal(FAKE_JOB_DISCOVERY_ADAPTER_VERSION),
  outputSchemaVersion: z.literal(FAKE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION),
  toolAllowlist: z.tuple([z.literal(AGENT_RUN_TOOL_ALLOWLIST[0]), z.literal(AGENT_RUN_TOOL_ALLOWLIST[1])]),
  model: z.null(),
  budget: AgentRunBudgetSchema,
}).strict();

const PublicAgentRunBudgetSchema = z.object({
  maxActiveDurationMs: z.literal(180_000), maxAttempts: z.literal(3), maxToolCalls: z.literal(60),
  maxResults: z.literal(5), maxModelCalls: z.literal(0), maxTokens: z.literal(0),
}).strict();

export const DeepMatchAgentRunBudgetSchema = z.object({
  maxActiveDurationMs: z.literal(180_000), maxAttempts: z.literal(3), maxToolCalls: z.literal(0),
  maxResults: z.literal(10), maxModelCalls: z.literal(10), maxTokens: z.literal(20_000),
}).strict();
export const DeepMatchAgentRunSourceScopeSchema = z.object({ kind: z.literal("deep_match"), trigger: z.enum(["automatic", "manual"]), opportunityId: z.uuid().nullable() }).strict().superRefine((scope, context) => {
  if (scope.trigger === "manual" && scope.opportunityId === null) context.addIssue({ code: "custom", path: ["opportunityId"], message: "manual matching must bind one opportunity" });
  if (scope.trigger === "automatic" && scope.opportunityId !== null) context.addIssue({ code: "custom", path: ["opportunityId"], message: "automatic matching evaluates discovery candidates" });
});
export type AgentRunSourceScope = z.infer<typeof AgentRunSourceScopeSchema>;
export type DeepMatchAgentRunSourceScope = z.infer<typeof DeepMatchAgentRunSourceScopeSchema>;
export const DeepMatchAgentRunExecutionSpecSchema = z.object({
  targetSnapshot: AgentRunTargetSnapshotSchema, sourceScope: DeepMatchAgentRunSourceScopeSchema,
  workflowVersion: z.literal(DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION), ruleVersion: z.literal("deep-match-rules-v1"),
  adapter: z.literal("fake-deep-match"), adapterVersion: z.literal("fake-deep-match-v1"), outputSchemaVersion: z.literal("deep-match-result-v1"),
  toolAllowlist: z.tuple([]), model: z.object({ provider: z.literal("fake"), model: z.literal("fake-deep-match-model-v1") }).strict(), budget: DeepMatchAgentRunBudgetSchema,
}).strict();

const PublicAgentRunExecutionSpecSchema = z.object({
  targetSnapshot: AgentRunTargetSnapshotSchema,
  sourceScope: PublicAgentRunSourceScopeSchema,
  workflowVersion: z.literal(GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION),
  ruleVersion: z.literal(GREENHOUSE_JOB_DISCOVERY_RULE_VERSION),
  adapter: z.literal(GREENHOUSE_JOB_DISCOVERY_ADAPTER),
  adapterVersion: z.literal(GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION),
  outputSchemaVersion: z.literal(GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION),
  toolAllowlist: z.tuple([z.literal(AGENT_RUN_TOOL_ALLOWLIST[0]), z.literal(AGENT_RUN_TOOL_ALLOWLIST[1])]),
  model: z.null(),
  budget: PublicAgentRunBudgetSchema,
}).strict();

const PublicSourceHealthAgentRunExecutionSpecSchema = z.object({
  targetSnapshot: AgentRunTargetSnapshotSchema,
  sourceScope: PublicSourceHealthAgentRunSourceScopeSchema,
  workflowVersion: z.literal(GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION),
  ruleVersion: z.literal(GREENHOUSE_SOURCE_HEALTH_RULE_VERSION),
  adapter: z.literal(GREENHOUSE_JOB_DISCOVERY_ADAPTER),
  adapterVersion: z.literal(GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION),
  outputSchemaVersion: z.literal(GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION),
  toolAllowlist: z.tuple([z.literal(GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST[0]), z.literal(GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST[1])]),
  model: z.null(),
  budget: PublicAgentRunBudgetSchema,
}).strict();

const LayeredPublicAgentRunExecutionSpecSchema = z.object({
  targetSnapshot: LayeredPublicJobDiscoveryTargetSnapshotSchema,
  profileSnapshot: LayeredPublicJobDiscoveryProfileSnapshotSchema,
  watchlistSnapshot: LayeredPublicJobDiscoveryWatchlistSnapshotSchema,
  sourceScope: LayeredPublicJobDiscoverySourceScopeSchema,
  workflowVersion: z.literal(LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION),
  ruleVersion: z.literal(LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION),
  adapter: z.literal(LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER),
  adapterVersion: z.literal(LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION),
  outputSchemaVersion: z.literal(LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION),
  toolAllowlist: z.tuple([
    z.literal(LAYERED_PUBLIC_JOB_DISCOVERY_TOOL_ALLOWLIST[0]),
    z.literal(LAYERED_PUBLIC_JOB_DISCOVERY_TOOL_ALLOWLIST[1]),
    z.literal(LAYERED_PUBLIC_JOB_DISCOVERY_TOOL_ALLOWLIST[2]),
    z.literal(LAYERED_PUBLIC_JOB_DISCOVERY_TOOL_ALLOWLIST[3]),
  ]),
  model: z.null(),
  budget: PublicAgentRunBudgetSchema,
}).strict().superRefine((spec, context) => {
  if (spec.profileSnapshot.targetId !== spec.targetSnapshot.targetId || spec.watchlistSnapshot.targetId !== spec.targetSnapshot.targetId) {
    context.addIssue({ code: "custom", message: "v4 snapshots must bind to the same target" });
  }
});

export const AgentRunExecutionSpecSchema = z.union([
  FakeAgentRunExecutionSpecSchema,
  PublicAgentRunExecutionSpecSchema,
  PublicSourceHealthAgentRunExecutionSpecSchema,
  LayeredPublicAgentRunExecutionSpecSchema,
  DeepMatchAgentRunExecutionSpecSchema,
]);

export const AgentRunUsageSchema = z.object({
  activeDurationMs: nonnegativeInteger,
  attempts: nonnegativeInteger,
  toolCalls: nonnegativeInteger,
  sourceRequests: nonnegativeInteger,
  modelCalls: nonnegativeInteger,
  inputTokens: nonnegativeInteger,
  outputTokens: nonnegativeInteger,
  totalTokens: nonnegativeInteger,
  results: nonnegativeInteger,
  complete: z.boolean(),
}).strict().superRefine((usage, context) => {
  if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    context.addIssue({ code: "custom", path: ["totalTokens"], message: "total tokens must equal input plus output" });
  }
});

export const AgentRunTerminationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed"), failureCode: z.null(), budgetDimension: z.null() }).strict(),
  z.object({ kind: z.literal("completed_with_source_issues"), failureCode: z.null(), budgetDimension: z.null() }).strict(),
  z.object({ kind: z.literal("cancelled_by_user"), failureCode: z.null(), budgetDimension: z.null() }).strict(),
  z.object({ kind: z.literal("source_failed"), failureCode: z.enum(["AGENT_RUN_ADAPTER_RETRYABLE", "AGENT_RUN_ADAPTER_FAILED", "AGENT_RUN_MODEL_RETRYABLE", "AGENT_RUN_MODEL_AUTH_FAILED", "AGENT_RUN_MODEL_POLICY_REJECTED", "AGENT_RUN_MODEL_INVALID_RESPONSE"]), budgetDimension: z.null() }).strict(),
  z.object({ kind: z.literal("content_storage_failed"), failureCode: z.literal("AGENT_RUN_CONTENT_STORAGE_FAILED"), budgetDimension: z.null() }).strict(),
  z.object({ kind: z.literal("persistence_failed"), failureCode: z.literal("AGENT_RUN_PERSIST_FAILED"), budgetDimension: z.null() }).strict(),
  z.object({ kind: z.literal("budget_exhausted"), failureCode: z.literal("AGENT_RUN_BUDGET_EXCEEDED"), budgetDimension: AgentRunBudgetDimensionSchema }).strict(),
]);

export const StartAgentRunCommandSchema = z.object({
  targetId: z.uuid(), idempotencyKey: z.uuid(),
}).strict();
export const ControlAgentRunCommandSchema = z.object({
  commandId: z.uuid(), action: AgentRunControlActionSchema,
}).strict();
export const AgentRunControlSnapshotSchema = z.object({
  runId: z.uuid(), status: AgentRunStatusSchema, currentStep: AgentRunCurrentStepSchema,
  controlState: AgentRunControlStateSchema, version: positiveInteger,
}).strict().superRefine((snapshot, context) => {
  if ((snapshot.status === "cancelled") !== (snapshot.currentStep === "cancelled")) {
    context.addIssue({ code: "custom", path: ["currentStep"], message: "cancelled status and step must pair" });
  }
});
export const ControlAgentRunResponseSchema = z.object({
  applied: z.boolean(), run: AgentRunControlSnapshotSchema,
}).strict();
export const AgentRunStartErrorCodeSchema = z.enum([
  "AGENT_RUN_TARGET_NOT_FOUND",
  "AGENT_RUN_TARGET_INACTIVE",
  "AGENT_RUN_UNAVAILABLE",
]);

export const AgentRunStepSchema = z.object({
  stepKey: AgentRunStepKeySchema, ordinal: z.int().min(1).max(3), status: AgentRunStepStatusSchema,
  attemptCount: nonnegativeInteger, startedAt: z.iso.datetime().nullable(), completedAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(), failureCode: AgentRunFailureCodeSchema.nullable(),
}).strict();

export const AgentRunEventDataSchema = z.discriminatedUnion("eventType", [
  z.object({ eventType: z.literal("run.queued"), status: z.literal("queued"), currentStep: z.literal("queued"), attemptCount: nonnegativeInteger }).strict(),
  z.object({ eventType: z.literal("run.started"), status: z.literal("running"), currentStep: AgentRunStepKeySchema, attemptCount: positiveInteger }).strict(),
  z.object({ eventType: z.literal("step.started"), status: z.literal("running"), currentStep: AgentRunStepKeySchema, stepKey: AgentRunStepKeySchema, attemptCount: positiveInteger }).strict(),
  z.object({ eventType: z.literal("step.completed"), status: z.literal("running"), currentStep: AgentRunStepKeySchema, stepKey: AgentRunStepKeySchema, attemptCount: positiveInteger }).strict(),
  z.object({ eventType: z.literal("run.retry_scheduled"), status: z.literal("queued"), currentStep: AgentRunStepKeySchema, attemptCount: positiveInteger, failureCode: AgentRunFailureCodeSchema }).strict(),
  z.object({ eventType: z.literal("run.completed"), status: z.literal("completed"), currentStep: z.literal("completed"), attemptCount: positiveInteger, resultCount: nonnegativeInteger }).strict(),
  z.object({ eventType: z.literal("run.failed"), status: z.literal("failed"), currentStep: z.literal("failed"), attemptCount: positiveInteger, failureCode: AgentRunFailureCodeSchema }).strict(),
  z.object({ eventType: z.literal("run.pause_requested"), status: z.literal("running"), currentStep: AgentRunStepKeySchema, attemptCount: positiveInteger }).strict(),
  z.object({ eventType: z.literal("run.paused"), status: z.literal("paused"), currentStep: z.union([z.literal("queued"), AgentRunStepKeySchema]), attemptCount: nonnegativeInteger }).strict(),
  z.object({ eventType: z.literal("run.resume_requested"), status: z.literal("running"), currentStep: AgentRunStepKeySchema, attemptCount: positiveInteger }).strict(),
  z.object({ eventType: z.literal("run.resumed"), status: z.literal("queued"), currentStep: z.literal("queued"), attemptCount: nonnegativeInteger }).strict(),
  z.object({ eventType: z.literal("run.cancel_requested"), status: z.literal("running"), currentStep: AgentRunStepKeySchema, attemptCount: positiveInteger }).strict(),
  z.object({ eventType: z.literal("run.cancelled"), status: z.literal("cancelled"), currentStep: z.literal("cancelled"), attemptCount: nonnegativeInteger }).strict(),
  z.object({ eventType: z.literal("run.budget_updated"), status: z.literal("running"), currentStep: AgentRunStepKeySchema, attemptCount: positiveInteger, usage: AgentRunUsageSchema }).strict(),
]).superRefine((data, context) => {
  if ((data.eventType === "step.started" || data.eventType === "step.completed") && data.currentStep !== data.stepKey) {
    context.addIssue({ code: "custom", path: ["currentStep"], message: "current step must match step key" });
  }
});

export const AgentRunEventSchema = z.object({
  sequence: positiveInteger, runVersion: positiveInteger, eventType: AgentRunEventTypeSchema,
  data: AgentRunEventDataSchema, createdAt: z.iso.datetime(),
}).strict().superRefine(({ eventType, data }, context) => {
  if (eventType !== data.eventType) {
    context.addIssue({ code: "custom", path: ["data", "eventType"], message: "event type must match data" });
  }
});

export const AgentRunResultSchema = z.object({
  resultId: z.uuid(), ordinal: positiveInteger, opportunityId: z.uuid(), sourcePostingId: z.uuid(),
  sourcePostingVersionId: z.uuid(), company: nullableJobField, title: nullableJobField, location: nullableJobField,
  postedAt: z.iso.datetime().nullable(), deadline: z.iso.datetime().nullable(),
  sourceType: z.string().trim().min(1).max(32), isOfficial: z.boolean(),
}).strict();

const AgentRunSummaryFields = {
  runId: z.uuid(), targetId: z.uuid(), targetVersion: positiveInteger, targetSnapshot: AgentRunTargetSnapshotSchema,
  status: AgentRunStatusSchema, currentStep: AgentRunCurrentStepSchema, version: positiveInteger,
  attemptCount: nonnegativeInteger, failureCode: AgentRunFailureCodeSchema.nullable(), queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(), completedAt: z.iso.datetime().nullable(), failedAt: z.iso.datetime().nullable(), cancelledAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
};
const FakeAgentRunSummarySchema = z.object({
  ...AgentRunSummaryFields, sourceScope: AgentRunSourceScopeSchema, workflowVersion: z.literal(FAKE_JOB_DISCOVERY_WORKFLOW_VERSION),
  adapter: z.literal(FAKE_JOB_DISCOVERY_ADAPTER), adapterVersion: z.literal(FAKE_JOB_DISCOVERY_ADAPTER_VERSION),
  outputSchemaVersion: z.literal(FAKE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION), budget: AgentRunBudgetSchema,
}).strict();
const PublicAgentRunSummarySchema = z.object({
  ...AgentRunSummaryFields, sourceScope: PublicAgentRunSourceScopeSchema, workflowVersion: z.literal(GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION),
  adapter: z.literal(GREENHOUSE_JOB_DISCOVERY_ADAPTER), adapterVersion: z.literal(GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION),
  outputSchemaVersion: z.literal(GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION), budget: PublicAgentRunBudgetSchema,
}).strict();
const PublicSourceHealthAgentRunSummarySchema = z.object({
  ...AgentRunSummaryFields, sourceScope: PublicSourceHealthAgentRunSourceScopeSchema,
  workflowVersion: z.literal(GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION),
  adapter: z.literal(GREENHOUSE_JOB_DISCOVERY_ADAPTER), adapterVersion: z.literal(GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION),
  outputSchemaVersion: z.literal(GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION), budget: PublicAgentRunBudgetSchema,
}).strict();
const LayeredPublicAgentRunSummarySchema = z.object({
  ...AgentRunSummaryFields,
  targetSnapshot: LayeredPublicJobDiscoveryTargetSnapshotSchema,
  sourceScope: LayeredPublicJobDiscoverySourceScopeSchema,
  workflowVersion: z.literal(LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION),
  adapter: z.literal(LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER),
  adapterVersion: z.literal(LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION),
  outputSchemaVersion: z.literal(LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION),
  budget: PublicAgentRunBudgetSchema,
}).strict();
const DeepMatchAgentRunSummarySchema = z.object({
  ...AgentRunSummaryFields, sourceScope: DeepMatchAgentRunSourceScopeSchema, workflowVersion: z.literal(DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION),
  adapter: z.literal("fake-deep-match"), adapterVersion: z.literal("fake-deep-match-v1"), outputSchemaVersion: z.literal("deep-match-result-v1"), budget: DeepMatchAgentRunBudgetSchema,
}).strict();
export const AgentRunSummarySchema = z.union([FakeAgentRunSummarySchema, PublicAgentRunSummarySchema, PublicSourceHealthAgentRunSummarySchema, LayeredPublicAgentRunSummarySchema, DeepMatchAgentRunSummarySchema]).superRefine((summary, context) => {
  if ((summary.status === "cancelled") !== (summary.currentStep === "cancelled")) {
    context.addIssue({ code: "custom", path: ["currentStep"], message: "cancelled status and step must pair" });
  }
});

const AgentRunDetailFields = {
  controlState: AgentRunControlStateSchema, usage: AgentRunUsageSchema,
  termination: AgentRunTerminationSchema.nullable(), retryOfRunId: z.uuid().nullable(),
  steps: z.array(AgentRunStepSchema), events: z.array(AgentRunEventSchema), results: z.array(AgentRunResultSchema),
};
export const AgentRunDetailSchema = z.union([
  FakeAgentRunSummarySchema.extend({ ...AgentRunDetailFields, executionSpec: FakeAgentRunExecutionSpecSchema }).strict(),
  PublicAgentRunSummarySchema.extend({ ...AgentRunDetailFields, executionSpec: PublicAgentRunExecutionSpecSchema }).strict(),
  PublicSourceHealthAgentRunSummarySchema.extend({ ...AgentRunDetailFields, executionSpec: PublicSourceHealthAgentRunExecutionSpecSchema, sourceChecks: z.array(JobSourceHealthCheckSchema).max(50) }).strict(),
  LayeredPublicAgentRunSummarySchema.extend({
    ...AgentRunDetailFields,
    executionSpec: LayeredPublicAgentRunExecutionSpecSchema,
    results: z.array(LayeredPublicJobDiscoveryResultSummarySchema).max(PUBLIC_JOB_DISCOVERY_BUDGET.maxResults),
    discoveryDiagnostics: z.array(DiscoveryDiagnosticSchema).max(50),
    sourceIssues: z.array(DiscoverySourceIssueSummarySchema).max(10),
  }).strict(),
  DeepMatchAgentRunSummarySchema.extend({ ...AgentRunDetailFields, executionSpec: DeepMatchAgentRunExecutionSpecSchema, results: z.array(AgentRunResultSchema).max(0) }).strict(),
]).superRefine((detail, context) => {
  const terminal = detail.status === "completed" || detail.status === "failed" || detail.status === "cancelled";
  if (!terminal && detail.termination !== null) context.addIssue({ code: "custom", path: ["termination"], message: "nonterminal runs have no termination" });
  if (terminal && detail.usage.complete && detail.termination === null) context.addIssue({ code: "custom", path: ["termination"], message: "complete terminal runs require termination" });
  if (detail.termination !== null) {
    const statusMatches = (detail.status === "completed" && (detail.termination.kind === "completed" || detail.termination.kind === "completed_with_source_issues"))
      || (detail.status === "cancelled" && detail.termination.kind === "cancelled_by_user")
      || (detail.status === "failed" && ["source_failed", "content_storage_failed", "persistence_failed", "budget_exhausted"].includes(detail.termination.kind));
    if (!statusMatches) context.addIssue({ code: "custom", path: ["termination", "kind"], message: "termination kind must match status" });
    if (detail.termination.kind === "completed_with_source_issues"
      && detail.workflowVersion !== GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION
      && detail.workflowVersion !== LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION) {
      context.addIssue({ code: "custom", path: ["termination", "kind"], message: "source issue completion requires the v3 or v4 source-issue contract" });
    }
    if (detail.failureCode !== detail.termination.failureCode) context.addIssue({ code: "custom", path: ["failureCode"], message: "failure code must match termination" });
  }
  if ((detail.status === "cancelled") !== (detail.currentStep === "cancelled")) context.addIssue({ code: "custom", path: ["currentStep"], message: "cancelled status and step must pair" });
  if (detail.workflowVersion === LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION
    && (detail.targetId !== detail.targetSnapshot.targetId
      || detail.targetVersion !== detail.targetSnapshot.version
      || detail.executionSpec.targetSnapshot.targetId !== detail.targetId
      || detail.executionSpec.targetSnapshot.version !== detail.targetVersion)) {
    context.addIssue({ code: "custom", path: ["targetId"], message: "v4 run detail and execution snapshots must bind to the same target version" });
  }
  if (detail.workflowVersion === LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION
    && "discoveryDiagnostics" in detail
    && detail.discoveryDiagnostics.some((diagnostic) => diagnostic.runId !== detail.runId)) {
    context.addIssue({ code: "custom", path: ["discoveryDiagnostics"], message: "v4 discovery diagnostics must belong to the detail run" });
  }
  if (detail.workflowVersion === LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION
    && detail.termination?.kind === "completed_with_source_issues"
    && "sourceIssues" in detail
    && detail.sourceIssues.length < 1) {
    context.addIssue({ code: "custom", path: ["sourceIssues"], message: "v4 source-issue completion requires a source issue" });
  }
  if (detail.workflowVersion === GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION && "sourceChecks" in detail) {
    const sources = detail.sourceScope.sources.filter((source) => typeof source !== "string");
    const sourceWatchlistItems = new Map(sources.map((source) => [source.sourceId, source.watchlistItemId]));
    const checkedSourceIds = new Set<string>();
    for (const check of detail.sourceChecks) {
      if (check.runId !== detail.runId || check.targetId !== detail.targetId || sourceWatchlistItems.get(check.sourceId) !== check.watchlistItemId || checkedSourceIds.has(check.sourceId)) {
        context.addIssue({ code: "custom", path: ["sourceChecks"], message: "source checks must be unique and bound to the v3 run source scope" });
        break;
      }
      checkedSourceIds.add(check.sourceId);
    }
    const requiresCompleteSourceChecks = detail.status === "completed" || (terminal && detail.sourceChecks.length > 0);
    if (requiresCompleteSourceChecks && (checkedSourceIds.size !== sourceWatchlistItems.size || [...sourceWatchlistItems.keys()].some((sourceId) => !checkedSourceIds.has(sourceId)))) {
      context.addIssue({ code: "custom", path: ["sourceChecks"], message: "terminal v3 runs require one source check for every frozen source" });
    }
  }
});

export const StartAgentRunResponseSchema = z.union([
  FakeAgentRunSummarySchema.extend({ reused: z.boolean() }).strict(),
  PublicAgentRunSummarySchema.extend({ reused: z.boolean() }).strict(),
  PublicSourceHealthAgentRunSummarySchema.extend({ reused: z.boolean() }).strict(),
  LayeredPublicAgentRunSummarySchema.extend({ reused: z.boolean() }).strict(),
  DeepMatchAgentRunSummarySchema.extend({ reused: z.boolean() }).strict(),
]);
export const LatestAgentRunResponseSchema = z.object({ run: AgentRunDetailSchema.nullable() }).strict();

export const AgentRunJobSchema = z.object({ version: z.literal(AGENT_RUN_JOB_VERSION), runId: z.uuid(), userId: z.uuid() }).strict();
export const AgentRunSseCursorSchema = z.string().regex(/^(0|[1-9]\d*)$/u).refine((value) => Number(value) <= Number.MAX_SAFE_INTEGER, "must be a safe integer");
export const AgentRunSseEventSchema = z.object({
  id: AgentRunSseCursorSchema, event: AgentRunEventTypeSchema, runVersion: positiveInteger, data: AgentRunEventDataSchema,
}).strict().superRefine(({ event, data }, context) => {
  if (event !== data.eventType) context.addIssue({ code: "custom", path: ["data", "eventType"], message: "event must match data" });
});

export const AgentRunAdapterErrorSchema = z.object({ code: z.string().trim().min(1).max(64), retryable: z.boolean() }).strict();
const adapterResult = <T extends z.ZodType>(data: T) => z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data }).strict(), z.object({ ok: z.literal(false), error: AgentRunAdapterErrorSchema }).strict(),
]);

export const DiscoverySearchInputSchema = z.object({ targetSnapshot: AgentRunTargetSnapshotSchema, sourceId: z.string().trim().min(1).max(2_048) }).strict();
export const DiscoveryBatchSearchInputSchema = z.object({ targetSnapshot: AgentRunTargetSnapshotSchema, sourceScope: AgentRunSourceScopeSchema }).strict();
export const DiscoveryDetailInputSchema = z.object({ sourceId: z.string().trim().min(1).max(2_048), detailId: z.string().trim().min(1).max(256) }).strict();
export const DiscoverySearchSummarySchema = z.object({
  sourceId: z.string().trim().min(1).max(2_048), detailId: z.string().trim().min(1).max(256),
  company: nullableJobField, title: nullableJobField, location: nullableJobField,
  postedAt: z.iso.datetime().nullable(), deadline: z.iso.datetime().nullable(),
}).strict();
export const DiscoveryDetailSchema = DiscoverySearchSummarySchema.extend({
  sourceType: z.string().trim().min(1).max(32), isOfficial: z.boolean(), rawPayload: jsonObject,
}).strict();
export const DiscoverySearchResultSchema = adapterResult(DiscoverySearchSummarySchema);
export const DiscoveryBatchSearchResultSchema = adapterResult(z.array(DiscoverySearchSummarySchema).max(AGENT_RUN_BUDGET.maxResults));
export const PublicDiscoveryListCandidateSchema = z.object({
  sourceId: z.string().trim().regex(/^greenhouse:[A-Za-z0-9_-]+$/u),
  detailId: z.string().trim().min(1).max(256),
  company: nullableJobField,
  title: nullableJobField,
  location: nullableJobField,
}).strict();
export const PublicDiscoveryScanSchema = z.object({
  sourceId: z.string().trim().regex(/^greenhouse:[A-Za-z0-9_-]+$/u),
  observedDetailIds: z.array(z.string().trim().min(1).max(256)).refine(
    (detailIds) => new Set(detailIds).size === detailIds.length,
    { message: "observed detail IDs must be unique" },
  ),
  complete: z.boolean(),
}).strict();
export const PublicDiscoveryBatchSearchResultSchema = adapterResult(z.object({
  items: z.array(PublicDiscoveryListCandidateSchema).max(PUBLIC_JOB_DISCOVERY_BUDGET.maxResults),
  scans: z.array(PublicDiscoveryScanSchema).min(1).max(50).refine(
    (scans) => new Set(scans.map((scan) => scan.sourceId)).size === scans.length,
    { message: "scan source IDs must be unique" },
  ),
}).strict());
export const DiscoveryDetailResultSchema = adapterResult(DiscoveryDetailSchema);

const SourceHealthAdapterFailureSchema = z.object({
  category: z.enum(["parser_degraded", "rate_limited", "hard_failed"]),
  reasonCode: SourceHealthReasonCodeSchema,
  retryable: z.boolean(),
  attemptCount: positiveInteger,
}).strict().superRefine((failure, context) => {
  const parser = ["SOURCE_LIST_SCHEMA_INVALID", "SOURCE_DETAIL_FIELDS_MISSING", "SOURCE_DETAIL_URL_INVALID", "SOURCE_DETAIL_IDENTITY_INVALID"];
  const hard = ["SOURCE_AUTH_FAILED", "SOURCE_TIMEOUT", "SOURCE_UNREACHABLE", "SOURCE_SERVER_ERROR", "SOURCE_POLICY_REJECTED"];
  const valid = failure.category === "rate_limited" ? failure.reasonCode === "SOURCE_RATE_LIMITED"
    : failure.category === "parser_degraded" ? parser.includes(failure.reasonCode)
      : hard.includes(failure.reasonCode);
  if (!valid) context.addIssue({ code: "custom", path: ["reasonCode"], message: "source-health failure reason must match its category" });
});
export const SourceHealthDetailIdSchema = z.string().trim().regex(/^[A-Za-z1-9][A-Za-z0-9_-]{0,255}$/u);
const SourceHealthListCandidateSchema = z.object({
  sourceId: SourceHealthSourceIdSchema, detailId: SourceHealthDetailIdSchema, company: z.null(), title: z.string().trim().min(1).max(500), location: z.string().trim().min(1).max(500),
}).strict();
const SourceHealthListSuccessSchema = z.object({
  ok: z.literal(true), attemptCount: positiveInteger,
  data: z.object({
    sourceId: SourceHealthSourceIdSchema,
    observedDetailIds: z.array(SourceHealthDetailIdSchema).max(500).refine((ids) => new Set(ids).size === ids.length, { message: "observed detail IDs must be unique" }),
    candidates: z.array(SourceHealthListCandidateSchema).max(PUBLIC_JOB_DISCOVERY_BUDGET.maxResults),
  }).strict(),
}).strict().superRefine((result, context) => {
  if (result.data.candidates.some((candidate) => candidate.sourceId !== result.data.sourceId)) context.addIssue({ code: "custom", path: ["data", "candidates"], message: "candidate source must match list source" });
});
const SourceHealthDetailSuccessSchema = z.object({
  ok: z.literal(true), attemptCount: positiveInteger,
  data: z.object({
    sourceId: SourceHealthSourceIdSchema, detailId: SourceHealthDetailIdSchema, company: z.string().trim().min(1).max(500), title: z.string().trim().min(1).max(500), location: z.string().trim().min(1).max(500),
    postedAt: z.iso.datetime(), deadline: z.iso.datetime().nullable(), sourceType: z.literal("company_careers"), isOfficial: z.literal(true), absoluteUrl: z.url().max(2_048), rawPayload: jsonObject,
  }).strict(),
}).strict();
export const SourceHealthListResultSchema = z.union([
  SourceHealthListSuccessSchema,
  z.object({ ok: z.literal(false), failure: SourceHealthAdapterFailureSchema }).strict(),
]);
export const SourceHealthDetailResultSchema = z.union([
  SourceHealthDetailSuccessSchema,
  z.object({ ok: z.literal(false), failure: SourceHealthAdapterFailureSchema }).strict(),
]);

export function parseSourceHealthListResult(value: unknown, expectedSourceId: string): z.infer<typeof SourceHealthListResultSchema> {
  const result = SourceHealthListResultSchema.parse(value);
  if (result.ok && result.data.sourceId !== expectedSourceId) throw new z.ZodError([{ code: "custom", path: ["data", "sourceId"], message: "list source must match expected source" }]);
  return result;
}
export function parseSourceHealthDetailResult(value: unknown, expected: { sourceId: string; detailId: string }): z.infer<typeof SourceHealthDetailResultSchema> {
  const result = SourceHealthDetailResultSchema.parse(value);
  if (result.ok && (result.data.sourceId !== expected.sourceId || result.data.detailId !== expected.detailId)) throw new z.ZodError([{ code: "custom", path: ["data"], message: "detail identity must match expected source and detail" }]);
  return result;
}

export type StartAgentRunCommand = z.infer<typeof StartAgentRunCommandSchema>;
export type ControlAgentRunCommand = z.infer<typeof ControlAgentRunCommandSchema>;
export type AgentRunControlSnapshot = z.infer<typeof AgentRunControlSnapshotSchema>;
export type ControlAgentRunResponse = z.infer<typeof ControlAgentRunResponseSchema>;
export type AgentRunStartErrorCode = z.infer<typeof AgentRunStartErrorCodeSchema>;
export type AgentRunDetail = z.infer<typeof AgentRunDetailSchema>;
export type StartAgentRunResponse = z.infer<typeof StartAgentRunResponseSchema>;
export type AgentRunJob = z.infer<typeof AgentRunJobSchema>;
export type AgentRunSseEvent = z.infer<typeof AgentRunSseEventSchema>;
export type DiscoverySearchInput = z.infer<typeof DiscoverySearchInputSchema>;
export type DiscoveryBatchSearchInput = z.infer<typeof DiscoveryBatchSearchInputSchema>;
export type PublicAgentRunSourceScope = z.infer<typeof PublicAgentRunSourceScopeSchema>;
export type PublicSourceHealthAgentRunSourceScope = z.infer<typeof PublicSourceHealthAgentRunSourceScopeSchema>;
export type JobSourceHealthCheck = z.infer<typeof JobSourceHealthCheckSchema>;
export type JobSourceHealthProjection = z.infer<typeof JobSourceHealthProjectionSchema>;
export type JobSourceHealthOverview = z.infer<typeof JobSourceHealthOverviewSchema>;
export type DiscoveryDetailInput = z.infer<typeof DiscoveryDetailInputSchema>;
export type DiscoverySearchResult = z.infer<typeof DiscoverySearchResultSchema>;
export type DiscoveryBatchSearchResult = z.infer<typeof DiscoveryBatchSearchResultSchema>;
export type PublicDiscoveryBatchSearchResult = z.infer<typeof PublicDiscoveryBatchSearchResultSchema>;
export type DiscoveryDetailResult = z.infer<typeof DiscoveryDetailResultSchema>;
export type SourceHealthListResult = z.infer<typeof SourceHealthListResultSchema>;
export type SourceHealthDetailResult = z.infer<typeof SourceHealthDetailResultSchema>;
