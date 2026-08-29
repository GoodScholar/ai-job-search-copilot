import { z } from "zod";
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
export const AGENT_RUN_BUDGET = {
  maxDurationMs: 60_000,
  maxAttempts: 3,
  maxToolCalls: 10,
  maxResults: 5,
  maxModelCalls: 0,
  maxTokens: 0,
} as const;

const positiveInteger = z.int().min(1);
const nonnegativeInteger = z.int().nonnegative();
const nullableJobField = z.string().trim().min(1).max(20_000).nullable();
const jsonObject = z.record(z.string(), z.unknown());

export const AgentRunStatusSchema = z.enum(["queued", "running", "completed", "failed"]);
export const AgentRunCurrentStepSchema = z.enum([
  "queued", "batch_search", "fetch_details", "persist_results", "completed", "failed",
]);
export const AgentRunStepKeySchema = z.enum(["batch_search", "fetch_details", "persist_results"]);
export const AgentRunStepStatusSchema = z.enum(["pending", "running", "completed", "failed"]);
export const AgentRunFailureCodeSchema = z.enum([
  "AGENT_RUN_ADAPTER_RETRYABLE",
  "AGENT_RUN_ADAPTER_FAILED",
  "AGENT_RUN_CONTENT_STORAGE_FAILED",
  "AGENT_RUN_PERSIST_FAILED",
  "AGENT_RUN_BUDGET_EXCEEDED",
]);
export const AgentRunEventTypeSchema = z.enum([
  "run.queued", "run.started", "step.started", "step.completed", "run.retry_scheduled", "run.completed", "run.failed",
]);

export const AgentRunBudgetSchema = z.object({
  maxDurationMs: z.literal(60_000), maxAttempts: z.literal(3), maxToolCalls: z.literal(10),
  maxResults: z.literal(5), maxModelCalls: z.literal(0), maxTokens: z.literal(0),
}).strict();

export const AgentRunTargetSnapshotSchema = z.object({
  targetId: z.uuid(), version: positiveInteger, priority: z.enum(["primary", "secondary"]),
  state: z.literal("active"), constraints: JobTargetConstraintsSchema,
}).strict();

export const AgentRunSourceScopeSchema = z.object({
  kind: z.literal("company_watchlist"), adapter: z.literal(FAKE_JOB_DISCOVERY_ADAPTER),
  adapterVersion: z.literal(FAKE_JOB_DISCOVERY_ADAPTER_VERSION),
  sources: z.tuple([z.literal(FAKE_JOB_DISCOVERY_SOURCE_IDS[0]), z.literal(FAKE_JOB_DISCOVERY_SOURCE_IDS[1])]),
}).strict();

export const StartAgentRunCommandSchema = z.object({
  targetId: z.uuid(), idempotencyKey: z.uuid(),
}).strict();

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

export const AgentRunSummarySchema = z.object({
  runId: z.uuid(), targetId: z.uuid(), targetVersion: positiveInteger, targetSnapshot: AgentRunTargetSnapshotSchema,
  sourceScope: AgentRunSourceScopeSchema, workflowVersion: z.literal(FAKE_JOB_DISCOVERY_WORKFLOW_VERSION),
  adapter: z.literal(FAKE_JOB_DISCOVERY_ADAPTER), adapterVersion: z.literal(FAKE_JOB_DISCOVERY_ADAPTER_VERSION),
  outputSchemaVersion: z.literal(FAKE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION), budget: AgentRunBudgetSchema,
  status: AgentRunStatusSchema, currentStep: AgentRunCurrentStepSchema, version: positiveInteger,
  attemptCount: nonnegativeInteger, failureCode: AgentRunFailureCodeSchema.nullable(), queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(), completedAt: z.iso.datetime().nullable(), failedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
}).strict();

export const AgentRunDetailSchema = AgentRunSummarySchema.extend({
  steps: z.array(AgentRunStepSchema), events: z.array(AgentRunEventSchema), results: z.array(AgentRunResultSchema),
}).strict();

export const StartAgentRunResponseSchema = AgentRunSummarySchema.extend({ reused: z.boolean() }).strict();
export const LatestAgentRunResponseSchema = z.object({ run: AgentRunDetailSchema.nullable() }).strict();

export const AgentRunJobSchema = z.object({ version: z.literal(AGENT_RUN_JOB_VERSION), runId: z.uuid(), userId: z.uuid() }).strict();
export const AgentRunSseCursorSchema = z.string().regex(/^(0|[1-9]\d*)$/u).refine((value) => Number(value) <= Number.MAX_SAFE_INTEGER, "must be a safe integer");
export const AgentRunSseEventSchema = z.object({
  id: AgentRunSseCursorSchema, event: AgentRunEventTypeSchema, data: AgentRunEventDataSchema,
}).strict().superRefine(({ event, data }, context) => {
  if (event !== data.eventType) context.addIssue({ code: "custom", path: ["data", "eventType"], message: "event must match data" });
});

export const AgentRunAdapterErrorSchema = z.object({ code: z.string().trim().min(1).max(64), retryable: z.boolean() }).strict();
const adapterResult = <T extends z.ZodType>(data: T) => z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data }).strict(), z.object({ ok: z.literal(false), error: AgentRunAdapterErrorSchema }).strict(),
]);

export const DiscoverySearchInputSchema = z.object({ targetSnapshot: AgentRunTargetSnapshotSchema, sourceId: z.string().trim().min(1).max(256) }).strict();
export const DiscoveryBatchSearchInputSchema = z.object({ targetSnapshot: AgentRunTargetSnapshotSchema, sourceScope: AgentRunSourceScopeSchema }).strict();
export const DiscoveryDetailInputSchema = z.object({ sourceId: z.string().trim().min(1).max(256), detailId: z.string().trim().min(1).max(256) }).strict();
export const DiscoverySearchSummarySchema = z.object({
  sourceId: z.string().trim().min(1).max(256), detailId: z.string().trim().min(1).max(256),
  company: nullableJobField, title: nullableJobField, location: nullableJobField,
  postedAt: z.iso.datetime().nullable(), deadline: z.iso.datetime().nullable(),
}).strict();
export const DiscoveryDetailSchema = DiscoverySearchSummarySchema.extend({
  sourceType: z.string().trim().min(1).max(32), isOfficial: z.boolean(), rawPayload: jsonObject,
}).strict();
export const DiscoverySearchResultSchema = adapterResult(DiscoverySearchSummarySchema);
export const DiscoveryBatchSearchResultSchema = adapterResult(z.array(DiscoverySearchSummarySchema).max(AGENT_RUN_BUDGET.maxResults));
export const DiscoveryDetailResultSchema = adapterResult(DiscoveryDetailSchema);

export type StartAgentRunCommand = z.infer<typeof StartAgentRunCommandSchema>;
export type AgentRunDetail = z.infer<typeof AgentRunDetailSchema>;
export type StartAgentRunResponse = z.infer<typeof StartAgentRunResponseSchema>;
export type AgentRunJob = z.infer<typeof AgentRunJobSchema>;
export type AgentRunSseEvent = z.infer<typeof AgentRunSseEventSchema>;
export type DiscoverySearchInput = z.infer<typeof DiscoverySearchInputSchema>;
export type DiscoveryBatchSearchInput = z.infer<typeof DiscoveryBatchSearchInputSchema>;
export type DiscoveryDetailInput = z.infer<typeof DiscoveryDetailInputSchema>;
export type DiscoverySearchResult = z.infer<typeof DiscoverySearchResultSchema>;
export type DiscoveryBatchSearchResult = z.infer<typeof DiscoveryBatchSearchResultSchema>;
export type DiscoveryDetailResult = z.infer<typeof DiscoveryDetailResultSchema>;
