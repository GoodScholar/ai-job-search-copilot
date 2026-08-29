import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_BUDGET,
  AGENT_RUN_RULE_VERSION,
  AGENT_RUN_TOOL_ALLOWLIST,
  AGENT_RUN_TERMINAL_EVENT_TYPES,
  AGENT_RUN_CLAIM_LEASE_MS,
  AGENT_RUN_JOB_NAME,
  AGENT_RUN_QUEUE,
  AGENT_RUN_SCAN_INTERVAL_MS,
  AgentRunAdapterErrorSchema,
  AgentRunBudgetSchema,
  AgentRunBudgetDimensionSchema,
  AgentRunControlActionSchema,
  AgentRunControlStateSchema,
  AgentRunDetailSchema,
  AgentRunExecutionSpecSchema,
  AgentRunEventDataSchema,
  AgentRunEventSchema,
  AgentRunJobSchema,
  AgentRunResultSchema,
  AgentRunStartErrorCodeSchema,
  AgentRunSourceScopeSchema,
  AgentRunSseEventSchema,
  AgentRunStepSchema,
  AgentRunSummarySchema,
  AgentRunTerminationSchema,
  AgentRunTargetSnapshotSchema,
  AgentRunUsageSchema,
  GREENHOUSE_JOB_DISCOVERY_ADAPTER,
  GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION,
  GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION,
  GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION,
  GREENHOUSE_JOB_DISCOVERY_RULE_VERSION,
  PUBLIC_JOB_DISCOVERY_BUDGET,
  PublicDiscoveryBatchSearchResultSchema,
  DiscoveryBatchSearchInputSchema,
  DiscoveryBatchSearchResultSchema,
  DiscoveryDetailInputSchema,
  DiscoveryDetailResultSchema,
  DiscoveryDetailSchema,
  DiscoverySearchInputSchema,
  DiscoverySearchResultSchema,
  DiscoverySearchSummarySchema,
  FAKE_JOB_DISCOVERY_ADAPTER,
  FAKE_JOB_DISCOVERY_ADAPTER_VERSION,
  FAKE_JOB_DISCOVERY_SOURCE_IDS,
  FAKE_JOB_DISCOVERY_WORKFLOW_VERSION,
  LatestAgentRunResponseSchema,
  StartAgentRunCommandSchema,
  StartAgentRunResponseSchema,
  ControlAgentRunCommandSchema,
  ControlAgentRunResponseSchema,
  isAgentRunTerminalEvent,
} from "./agent-runs";

const targetId = "87a0d3ac-4aed-4bd5-a703-68bf82cc6c49";
const runId = "1e764df5-19f3-49f3-b16e-512147298baa";
const userId = "ec09ab6f-af8f-4b78-9a9c-cbcfbb1e5799";
const now = "2026-08-29T00:00:00.000Z";
const targetSnapshot = {
  roleFamily: "AI 应用工程师", seniority: null, locations: ["上海"], workModes: ["hybrid"],
  relocation: "unknown", salary: null, industries: [],
  dealBreakers: {
    excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false,
    excludeDispatch: false, excludeHeadhunter: false, other: [],
  },
};
const sourceScope = {
  kind: "company_watchlist", adapter: "fake", adapterVersion: FAKE_JOB_DISCOVERY_ADAPTER_VERSION,
  watchlistVersion: 0,
  sources: FAKE_JOB_DISCOVERY_SOURCE_IDS,
};
const runTargetSnapshot = { targetId, version: 1, priority: "primary", state: "active", constraints: targetSnapshot };
const queuedSummary = {
  runId, targetId, targetVersion: 1, targetSnapshot: runTargetSnapshot, sourceScope,
  workflowVersion: FAKE_JOB_DISCOVERY_WORKFLOW_VERSION,
  adapter: FAKE_JOB_DISCOVERY_ADAPTER, adapterVersion: FAKE_JOB_DISCOVERY_ADAPTER_VERSION,
  outputSchemaVersion: "job-discovery-result-v1", budget: AGENT_RUN_BUDGET,
  status: "queued", currentStep: "queued", version: 1, attemptCount: 0,
  failureCode: null, queuedAt: now, startedAt: null, completedAt: null, failedAt: null, cancelledAt: null, updatedAt: now,
};
const executionSpec = {
  targetSnapshot: runTargetSnapshot, sourceScope, workflowVersion: FAKE_JOB_DISCOVERY_WORKFLOW_VERSION,
  ruleVersion: AGENT_RUN_RULE_VERSION, adapter: FAKE_JOB_DISCOVERY_ADAPTER,
  adapterVersion: FAKE_JOB_DISCOVERY_ADAPTER_VERSION, outputSchemaVersion: "job-discovery-result-v1",
  toolAllowlist: AGENT_RUN_TOOL_ALLOWLIST, model: null, budget: AGENT_RUN_BUDGET,
};
const usage = {
  activeDurationMs: 0, attempts: 0, toolCalls: 0, sourceRequests: 0, modelCalls: 0,
  inputTokens: 0, outputTokens: 0, totalTokens: 0, results: 0, complete: false,
};
const step = {
  stepKey: "batch_search", ordinal: 1, status: "pending", attemptCount: 0,
  startedAt: null, completedAt: null, failedAt: null, failureCode: null,
};
const eventData = { eventType: "run.queued", status: "queued", currentStep: "queued", attemptCount: 0 };
const event = { sequence: 1, runVersion: 1, eventType: "run.queued", data: eventData, createdAt: now };
const result = {
  resultId: "ca3f587c-eac6-4533-9347-11f654d9ecdf", ordinal: 1,
  opportunityId: "a9722f16-e91d-4c3f-968a-a89b2d592401", sourcePostingId: "9b1d0e37-d2ff-4f05-b6cd-bc9e8c9d9c98",
  sourcePostingVersionId: "d6804068-4fae-4c49-af06-7de4c08ff8cf", company: "示例科技", title: "AI 工程师",
  location: "上海", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true,
};
const detail = {
  ...queuedSummary, executionSpec, controlState: "none", usage, termination: null, retryOfRunId: null,
  steps: [step], events: [event], results: [result],
};
const searchSummary = {
  sourceId: "fake:aurora-careers", detailId: "aurora-1", company: "示例科技", title: "AI 工程师",
  location: "上海", postedAt: null, deadline: null,
};
const discoveryDetail = { ...searchSummary, sourceType: "company_careers", isOfficial: true, rawPayload: {} };

function expectUnknownKeyRejected(schema: { safeParse(input: unknown): { success: boolean } }, sample: Record<string, unknown>) {
  expect(schema.safeParse({ ...sample, unexpected: true }).success).toBe(false);
}

describe("agent run contracts", () => {
  it("defines strict control state, control command, and public budget", () => {
    const commandId = "17fcd7b1-1a1d-4f25-9d10-45522417e919";

    expect(AgentRunControlStateSchema.options).toEqual(["none", "pause_requested", "cancel_requested"]);
    expect(AgentRunControlActionSchema.options).toEqual(["pause", "resume", "cancel"]);
    expect(AgentRunBudgetDimensionSchema.options).toEqual([
      "active_duration", "attempts", "tool_calls", "model_calls", "tokens",
    ]);
    expect(ControlAgentRunCommandSchema.parse({ commandId, action: "pause" }))
      .toEqual({ commandId, action: "pause" });
    expect(ControlAgentRunCommandSchema.safeParse({ commandId, action: "pause", extra: true }).success)
      .toBe(false);
    expect(AGENT_RUN_RULE_VERSION).toBe("fake-job-discovery-rules-v1");
    expect(AGENT_RUN_TOOL_ALLOWLIST).toEqual([
      "job_discovery.search_batch", "job_discovery.get_detail",
    ]);
    expect(AgentRunBudgetSchema.parse({
      maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5,
      maxModelCalls: 0, maxTokens: 0,
    })).toEqual(AGENT_RUN_BUDGET);
  });

  it("defines execution usage termination and control response contracts", () => {
    const usage = {
      activeDurationMs: 1_250, attempts: 1, toolCalls: 2, sourceRequests: 2,
      modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, results: 1, complete: true,
    };
    const executionSpec = {
      targetSnapshot: runTargetSnapshot, sourceScope, workflowVersion: FAKE_JOB_DISCOVERY_WORKFLOW_VERSION,
      ruleVersion: "fake-job-discovery-rules-v1", adapter: "fake",
      adapterVersion: FAKE_JOB_DISCOVERY_ADAPTER_VERSION, outputSchemaVersion: "job-discovery-result-v1",
      toolAllowlist: ["job_discovery.search_batch", "job_discovery.get_detail"], model: null, budget: AGENT_RUN_BUDGET,
    };
    expect(AgentRunExecutionSpecSchema.parse(executionSpec)).toEqual(executionSpec);
    expect(AgentRunUsageSchema.parse(usage)).toMatchObject({ activeDurationMs: 1_250, sourceRequests: 2 });
    expect(AgentRunUsageSchema.safeParse({ ...usage, inputTokens: 1 }).success).toBe(false);
    expect(AgentRunTerminationSchema.parse({
      kind: "budget_exhausted", failureCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "attempts",
    })).toEqual({ kind: "budget_exhausted", failureCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "attempts" });
    expect(ControlAgentRunResponseSchema.parse({
      applied: true, run: { runId, status: "running", currentStep: "fetch_details", controlState: "none", version: 2 },
    })).toMatchObject({ applied: true, run: { runId, status: "running" } });
  });

  it("允许版本化的有序唯一 Watchlist 来源范围，同时保留完整执行规格", () => {
    const watchlistSourceScope = {
      kind: "company_watchlist",
      adapter: "fake",
      adapterVersion: "fake-job-discovery-v1",
      watchlistVersion: 3,
      sources: ["https://careers.example.com/jobs", "fake:aurora-careers"],
    };
    const completeExecutionSpec = {
      targetSnapshot: runTargetSnapshot,
      sourceScope: watchlistSourceScope,
      workflowVersion: "job-discovery-workflow-v1",
      ruleVersion: "fake-job-discovery-rules-v1",
      adapter: "fake",
      adapterVersion: "fake-job-discovery-v1",
      outputSchemaVersion: "job-discovery-result-v1",
      toolAllowlist: ["job_discovery.search_batch", "job_discovery.get_detail"],
      model: null,
      budget: {
        maxActiveDurationMs: 60_000,
        maxAttempts: 3,
        maxToolCalls: 10,
        maxResults: 5,
        maxModelCalls: 0,
        maxTokens: 0,
      },
    };

    expect(AgentRunSourceScopeSchema.parse(watchlistSourceScope)).toEqual(watchlistSourceScope);
    expect(AgentRunSourceScopeSchema.safeParse({
      kind: "company_watchlist", adapter: "fake", adapterVersion: "fake-job-discovery-v1",
      sources: ["fake:aurora-careers", "fake:orbit-careers"],
    }).success).toBe(false);
    expect(AgentRunSourceScopeSchema.safeParse({ ...watchlistSourceScope, watchlistVersion: -1 }).success).toBe(false);
    expect(AgentRunSourceScopeSchema.safeParse({ ...watchlistSourceScope, sources: ["duplicate", "duplicate"] }).success).toBe(false);
    expect(AgentRunSourceScopeSchema.safeParse({ ...watchlistSourceScope, sources: ["x".repeat(2_049)] }).success).toBe(false);
    expect(AgentRunSourceScopeSchema.safeParse({ ...watchlistSourceScope, sources: Array.from({ length: 53 }, (_, index) => `source-${index}`) }).success).toBe(false);
    expect(AgentRunSourceScopeSchema.parse({ ...watchlistSourceScope, sources: [] }).sources).toEqual([]);
    expect(AgentRunExecutionSpecSchema.parse(completeExecutionSpec)).toEqual(completeExecutionSpec);
  });

  it("keeps the complete Fake v1 execution specimen valid while accepting a discriminated public v2 scope", () => {
    const publicExecutionSpec = {
      targetSnapshot: runTargetSnapshot,
      sourceScope: {
        kind: "company_watchlist",
        adapter: "greenhouse",
        adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION,
        watchlistVersion: 1,
        sources: [{
          sourceId: "greenhouse:aurora",
          watchlistItemId: "e384ef6d-7dc3-4e4e-8692-7d3199575716",
          canonicalCompanyName: "Aurora Labs",
          careersUrl: "https://boards.greenhouse.io/aurora",
          allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"],
          boardToken: "aurora",
        }],
      },
      workflowVersion: GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION,
      ruleVersion: GREENHOUSE_JOB_DISCOVERY_RULE_VERSION,
      adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER,
      adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION,
      outputSchemaVersion: GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION,
      toolAllowlist: ["job_discovery.search_batch", "job_discovery.get_detail"],
      model: null,
      budget: PUBLIC_JOB_DISCOVERY_BUDGET,
    };
    expect(AgentRunExecutionSpecSchema.parse(executionSpec)).toEqual(executionSpec);
    expect(AgentRunExecutionSpecSchema.parse(publicExecutionSpec)).toEqual(publicExecutionSpec);
    expect(AgentRunExecutionSpecSchema.safeParse({
      ...publicExecutionSpec,
      sourceScope: { ...publicExecutionSpec.sourceScope, sources: [{ ...publicExecutionSpec.sourceScope.sources[0], boardToken: "other" }] },
    }).success).toBe(false);
  });

  it("fixes public v2 batch success to complete scan facts without changing the v1 array shape", () => {
    expect(DiscoveryBatchSearchResultSchema.parse({ ok: true, data: [searchSummary] })).toEqual({ ok: true, data: [searchSummary] });
    expect(PublicDiscoveryBatchSearchResultSchema.parse({
      ok: true,
      data: { items: [searchSummary], scans: [{ sourceId: "greenhouse:aurora", observedDetailIds: ["42", "84"], complete: true }] },
    })).toEqual({
      ok: true,
      data: { items: [searchSummary], scans: [{ sourceId: "greenhouse:aurora", observedDetailIds: ["42", "84"], complete: true }] },
    });
    expect(PublicDiscoveryBatchSearchResultSchema.safeParse({
      ok: true, data: { items: [searchSummary], scans: [{ sourceId: "greenhouse:aurora", observedDetailIds: ["42", "42"], complete: true }] },
    }).success).toBe(false);
  });

  it("parses the strict start command and queued run detail", () => {
    expect(StartAgentRunCommandSchema.parse({ targetId, idempotencyKey: "08614f5c-b5cb-4c1d-8fca-3777105b5f19" }))
      .toEqual({ targetId, idempotencyKey: "08614f5c-b5cb-4c1d-8fca-3777105b5f19" });
    expect(AgentRunDetailSchema.parse({ ...detail, steps: [], events: [], results: [] }))
      .toMatchObject({ runId, targetId, status: "queued", currentStep: "queued" });
    expect(StartAgentRunResponseSchema.parse({ ...queuedSummary, reused: false }))
      .toMatchObject({ runId, targetId, reused: false });
  });

  it("locks queue, lease, scan, budget, and fake discovery identities", () => {
    expect({
      queue: AGENT_RUN_QUEUE, job: AGENT_RUN_JOB_NAME, lease: AGENT_RUN_CLAIM_LEASE_MS,
      scan: AGENT_RUN_SCAN_INTERVAL_MS, budget: AGENT_RUN_BUDGET, adapter: FAKE_JOB_DISCOVERY_ADAPTER,
      adapterVersion: FAKE_JOB_DISCOVERY_ADAPTER_VERSION, workflow: FAKE_JOB_DISCOVERY_WORKFLOW_VERSION,
      sources: FAKE_JOB_DISCOVERY_SOURCE_IDS,
    }).toEqual({
      queue: "agent-runs", job: "discover-jobs", lease: 30_000, scan: 1_000,
      budget: { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
      adapter: "fake", adapterVersion: "fake-job-discovery-v1", workflow: "job-discovery-workflow-v1",
      sources: ["fake:aurora-careers", "fake:orbit-careers"],
    });
    expect(AgentRunJobSchema.parse({ version: 1, runId, userId })).toEqual({ version: 1, runId, userId });
    expect(AgentRunStartErrorCodeSchema.options).toEqual([
      "AGENT_RUN_TARGET_NOT_FOUND", "AGENT_RUN_TARGET_INACTIVE", "AGENT_RUN_UNAVAILABLE",
    ]);
  });

  it("serializes versioned strict SSE envelopes with decimal cursors", () => {
    const event = { id: "0", event: "run.queued", runVersion: 1, data: { eventType: "run.queued", status: "queued", currentStep: "queued", attemptCount: 0 } };
    expect(AgentRunSseEventSchema.parse(event)).toEqual(event);
    expect(AgentRunSseEventSchema.safeParse({ ...event, id: "01" }).success).toBe(false);
    expect(AgentRunSseEventSchema.safeParse({ ...event, id: "9007199254740992" }).success).toBe(false);
    expect(AgentRunSseEventSchema.safeParse(({ id: event.id, event: event.event, data: event.data })).success).toBe(false);
    expect(AgentRunSseEventSchema.safeParse({ ...event, runVersion: 0 }).success).toBe(false);
  });

  it("exports one terminal event policy for all four terminal and three request events", () => {
    expect(AGENT_RUN_TERMINAL_EVENT_TYPES).toEqual(["run.paused", "run.cancelled", "run.completed", "run.failed"]);
    for (const eventType of AGENT_RUN_TERMINAL_EVENT_TYPES) expect(isAgentRunTerminalEvent(eventType)).toBe(true);
    for (const eventType of ["run.pause_requested", "run.resume_requested", "run.cancel_requested"] as const) {
      expect(isAgentRunTerminalEvent(eventType)).toBe(false);
    }
  });

  it("rejects an unexpected key from every public object schema", () => {
    const start = { targetId, idempotencyKey: "08614f5c-b5cb-4c1d-8fca-3777105b5f19" };
    const sseEvent = { id: "1", event: "run.queued", runVersion: 1, data: eventData };
    const adapterError = { code: "SOURCE_UNAVAILABLE", retryable: true };
    for (const [schema, sample] of [
      [StartAgentRunCommandSchema, start], [AgentRunBudgetSchema, AGENT_RUN_BUDGET],
      [AgentRunTargetSnapshotSchema, runTargetSnapshot], [AgentRunSourceScopeSchema, sourceScope],
      [AgentRunStepSchema, step], [AgentRunEventDataSchema, eventData], [AgentRunEventSchema, event],
      [AgentRunResultSchema, result], [AgentRunSummarySchema, queuedSummary], [AgentRunDetailSchema, detail],
      [StartAgentRunResponseSchema, { ...queuedSummary, reused: false }], [LatestAgentRunResponseSchema, { run: detail }],
      [AgentRunJobSchema, { version: 1, runId, userId }], [AgentRunSseEventSchema, sseEvent],
      [AgentRunAdapterErrorSchema, adapterError], [DiscoverySearchInputSchema, { targetSnapshot: runTargetSnapshot, sourceId: "fake:aurora-careers" }],
      [DiscoveryBatchSearchInputSchema, { targetSnapshot: runTargetSnapshot, sourceScope }],
      [DiscoveryDetailInputSchema, { sourceId: "fake:aurora-careers", detailId: "aurora-1" }],
      [DiscoverySearchSummarySchema, searchSummary], [DiscoveryDetailSchema, discoveryDetail],
      [DiscoverySearchResultSchema, { ok: true, data: searchSummary }],
      [DiscoveryBatchSearchResultSchema, { ok: true, data: [searchSummary] }],
      [DiscoveryDetailResultSchema, { ok: true, data: discoveryDetail }],
    ] as const) expectUnknownKeyRejected(schema, sample);
    expect(AgentRunAdapterErrorSchema.parse({ code: "SOURCE_UNAVAILABLE", retryable: true }))
      .toEqual({ code: "SOURCE_UNAVAILABLE", retryable: true });
    expect(AgentRunAdapterErrorSchema.safeParse({ code: "SOURCE_UNAVAILABLE", retryable: true, message: "unstable" }).success)
      .toBe(false);
  });

  it("rejects self-contradictory step and retry event data", () => {
    expect(AgentRunEventDataSchema.safeParse({
      eventType: "step.started", status: "running", currentStep: "batch_search", stepKey: "persist_results", attemptCount: 1,
    }).success).toBe(false);
    expect(AgentRunEventDataSchema.safeParse({
      eventType: "step.completed", status: "running", currentStep: "fetch_details", stepKey: "batch_search", attemptCount: 1,
    }).success).toBe(false);
    for (const currentStep of ["completed", "failed"]) {
      expect(AgentRunEventDataSchema.safeParse({
        eventType: "run.retry_scheduled", status: "queued", currentStep, attemptCount: 1,
        failureCode: "AGENT_RUN_ADAPTER_RETRYABLE",
      }).success).toBe(false);
    }
  });

  it("models control, budget, and cancelled events with matching lifecycle pairs", () => {
    const usageFixture = {
      activeDurationMs: 1_250, attempts: 1, toolCalls: 2, sourceRequests: 2,
      modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, results: 1, complete: true,
    };
    expect(AgentRunEventDataSchema.parse({
      eventType: "run.pause_requested", status: "running", currentStep: "fetch_details", attemptCount: 1,
    })).toMatchObject({ eventType: "run.pause_requested" });
    expect(AgentRunEventDataSchema.parse({
      eventType: "run.budget_updated", status: "running", currentStep: "fetch_details", attemptCount: 1, usage: usageFixture,
    })).toMatchObject({ usage: usageFixture });
    expect(AgentRunEventDataSchema.parse({
      eventType: "run.cancelled", status: "cancelled", currentStep: "cancelled", attemptCount: 1,
    })).toMatchObject({ status: "cancelled" });
    expect(AgentRunEventDataSchema.safeParse({
      eventType: "run.cancelled", status: "cancelled", currentStep: "fetch_details", attemptCount: 1,
    }).success).toBe(false);
    expect(AgentRunSummarySchema.safeParse({
      ...queuedSummary, status: "cancelled", currentStep: "queued", cancelledAt: now,
    }).success).toBe(false);
  });

  it("requires complete terminal details to match their termination", () => {
    expect(AgentRunDetailSchema.safeParse({
      ...detail,
      status: "completed",
      currentStep: "completed",
      startedAt: now,
      completedAt: now,
      usage: { ...usage, complete: true },
      termination: { kind: "cancelled_by_user", failureCode: null, budgetDimension: null },
    }).success).toBe(false);
  });
});
