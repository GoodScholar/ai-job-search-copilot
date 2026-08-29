import { z } from "zod";
import { GreenhousePublicSourceSchema } from "./job-discovery-schedules";
import { JobTargetConstraintsSchema } from "./job-targets";

export const AGENT_RUN_QUEUE = "agent-runs";
export const AGENT_RUN_JOB_NAME = "discover-jobs";
export const AGENT_RUN_JOB_VERSION = 1;
export const AGENT_RUN_CLAIM_LEASE_MS = 30_000;
export const AGENT_RUN_SCAN_INTERVAL_MS = 1_000;
export const FAKE_JOB_DISCOVERY_WORKFLOW_VERSION = "job-discovery-workflow-v1";
export const FAKE_JOB_DISCOVERY_ADAPTER = "fake";
export const FAKE_JOB_DISCOVERY_ADAPTER_VERSION = "fake-job-discovery-v1";
export const FAKE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION = "job-discovery-result-v1";
export const FAKE_JOB_DISCOVERY_SOURCE_IDS = ["fake:aurora-careers", "fake:orbit-careers"] as const;
export const GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION = "job-discovery-workflow-v2";
export const GREENHOUSE_JOB_DISCOVERY_ADAPTER = "greenhouse";
export const GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION = "greenhouse-job-board-v1";
export const GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION = "job-discovery-result-v2";
export const GREENHOUSE_JOB_DISCOVERY_RULE_VERSION = "greenhouse-job-discovery-rules-v1";
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

const positiveInteger = z.int().min(1);
const nonnegativeInteger = z.int().nonnegative();
const nullableJobField = z.string().trim().min(1).max(20_000).nullable();
const jsonObject = z.record(z.string(), z.unknown());

export const AgentRunStatusSchema = z.enum(["queued", "running", "paused", "completed", "failed", "cancelled"]);
export const AgentRunControlStateSchema = z.enum(["none", "pause_requested", "cancel_requested"]);
export const AgentRunControlActionSchema = z.enum(["pause", "resume", "cancel"]);
export const AgentRunBudgetDimensionSchema = z.enum(["active_duration", "attempts", "tool_calls", "model_calls", "tokens"]);
export const AgentRunCurrentStepSchema = z.enum([
  "queued", "batch_search", "fetch_details", "persist_results", "completed", "failed", "cancelled",
]);
export const AgentRunStepKeySchema = z.enum(["batch_search", "fetch_details", "persist_results"]);
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

export const AgentRunExecutionSpecSchema = z.discriminatedUnion("adapter", [
  FakeAgentRunExecutionSpecSchema,
  PublicAgentRunExecutionSpecSchema,
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
  if (usage.modelCalls !== 0 || usage.inputTokens !== 0 || usage.outputTokens !== 0 || usage.totalTokens !== 0) {
    context.addIssue({ code: "custom", path: ["modelCalls"], message: "fake runs do not use models" });
  }
});

export const AgentRunTerminationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed"), failureCode: z.null(), budgetDimension: z.null() }).strict(),
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
  z.object({ eventType: z.literal("run.started"), status: z.literal("running"), currentStep: z.literal("batch_search"), attemptCount: positiveInteger }).strict(),
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
export const AgentRunSummarySchema = z.discriminatedUnion("adapter", [FakeAgentRunSummarySchema, PublicAgentRunSummarySchema]).superRefine((summary, context) => {
  if ((summary.status === "cancelled") !== (summary.currentStep === "cancelled")) {
    context.addIssue({ code: "custom", path: ["currentStep"], message: "cancelled status and step must pair" });
  }
});

const AgentRunDetailFields = {
  controlState: AgentRunControlStateSchema, usage: AgentRunUsageSchema,
  termination: AgentRunTerminationSchema.nullable(), retryOfRunId: z.uuid().nullable(),
  steps: z.array(AgentRunStepSchema), events: z.array(AgentRunEventSchema), results: z.array(AgentRunResultSchema),
};
export const AgentRunDetailSchema = z.discriminatedUnion("adapter", [
  FakeAgentRunSummarySchema.extend({ ...AgentRunDetailFields, executionSpec: FakeAgentRunExecutionSpecSchema }).strict(),
  PublicAgentRunSummarySchema.extend({ ...AgentRunDetailFields, executionSpec: PublicAgentRunExecutionSpecSchema }).strict(),
]).superRefine((detail, context) => {
  const terminal = detail.status === "completed" || detail.status === "failed" || detail.status === "cancelled";
  if (!terminal && detail.termination !== null) context.addIssue({ code: "custom", path: ["termination"], message: "nonterminal runs have no termination" });
  if (terminal && detail.usage.complete && detail.termination === null) context.addIssue({ code: "custom", path: ["termination"], message: "complete terminal runs require termination" });
  if (detail.termination !== null) {
    const statusMatches = (detail.status === "completed" && detail.termination.kind === "completed")
      || (detail.status === "cancelled" && detail.termination.kind === "cancelled_by_user")
      || (detail.status === "failed" && ["source_failed", "content_storage_failed", "persistence_failed", "budget_exhausted"].includes(detail.termination.kind));
    if (!statusMatches) context.addIssue({ code: "custom", path: ["termination", "kind"], message: "termination kind must match status" });
    if (detail.failureCode !== detail.termination.failureCode) context.addIssue({ code: "custom", path: ["failureCode"], message: "failure code must match termination" });
  }
  if ((detail.status === "cancelled") !== (detail.currentStep === "cancelled")) context.addIssue({ code: "custom", path: ["currentStep"], message: "cancelled status and step must pair" });
});

export const StartAgentRunResponseSchema = z.discriminatedUnion("adapter", [
  FakeAgentRunSummarySchema.extend({ reused: z.boolean() }).strict(),
  PublicAgentRunSummarySchema.extend({ reused: z.boolean() }).strict(),
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
export type DiscoveryDetailInput = z.infer<typeof DiscoveryDetailInputSchema>;
export type DiscoverySearchResult = z.infer<typeof DiscoverySearchResultSchema>;
export type DiscoveryBatchSearchResult = z.infer<typeof DiscoveryBatchSearchResultSchema>;
export type PublicDiscoveryBatchSearchResult = z.infer<typeof PublicDiscoveryBatchSearchResultSchema>;
export type DiscoveryDetailResult = z.infer<typeof DiscoveryDetailResultSchema>;
