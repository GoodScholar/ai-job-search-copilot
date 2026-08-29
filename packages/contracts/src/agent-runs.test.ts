import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_BUDGET,
  AGENT_RUN_CLAIM_LEASE_MS,
  AGENT_RUN_JOB_NAME,
  AGENT_RUN_QUEUE,
  AGENT_RUN_SCAN_INTERVAL_MS,
  AgentRunAdapterErrorSchema,
  AgentRunBudgetSchema,
  AgentRunDetailSchema,
  AgentRunEventDataSchema,
  AgentRunEventSchema,
  AgentRunJobSchema,
  AgentRunResultSchema,
  AgentRunSourceScopeSchema,
  AgentRunSseEventSchema,
  AgentRunStepSchema,
  AgentRunSummarySchema,
  AgentRunTargetSnapshotSchema,
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
  sources: FAKE_JOB_DISCOVERY_SOURCE_IDS,
};
const runTargetSnapshot = { targetId, version: 1, priority: "primary", state: "active", constraints: targetSnapshot };
const queuedSummary = {
  runId, targetId, targetVersion: 1, targetSnapshot: runTargetSnapshot, sourceScope,
  workflowVersion: FAKE_JOB_DISCOVERY_WORKFLOW_VERSION,
  adapter: FAKE_JOB_DISCOVERY_ADAPTER, adapterVersion: FAKE_JOB_DISCOVERY_ADAPTER_VERSION,
  outputSchemaVersion: "job-discovery-result-v1", budget: AGENT_RUN_BUDGET,
  status: "queued", currentStep: "queued", version: 1, attemptCount: 0,
  failureCode: null, queuedAt: now, startedAt: null, completedAt: null, failedAt: null, updatedAt: now,
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
const detail = { ...queuedSummary, steps: [step], events: [event], results: [result] };
const searchSummary = {
  sourceId: "fake:aurora-careers", detailId: "aurora-1", company: "示例科技", title: "AI 工程师",
  location: "上海", postedAt: null, deadline: null,
};
const discoveryDetail = { ...searchSummary, sourceType: "company_careers", isOfficial: true, rawPayload: {} };

function expectUnknownKeyRejected(schema: { safeParse(input: unknown): { success: boolean } }, sample: Record<string, unknown>) {
  expect(schema.safeParse({ ...sample, unexpected: true }).success).toBe(false);
}

describe("agent run contracts", () => {
  it("parses the strict start command and queued run detail", () => {
    expect(StartAgentRunCommandSchema.parse({ targetId, idempotencyKey: "08614f5c-b5cb-4c1d-8fca-3777105b5f19" }))
      .toEqual({ targetId, idempotencyKey: "08614f5c-b5cb-4c1d-8fca-3777105b5f19" });
    expect(AgentRunDetailSchema.parse({ ...queuedSummary, steps: [], events: [], results: [] }))
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
      budget: { maxDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
      adapter: "fake", adapterVersion: "fake-job-discovery-v1", workflow: "job-discovery-workflow-v1",
      sources: ["fake:aurora-careers", "fake:orbit-careers"],
    });
    expect(AgentRunJobSchema.parse({ version: 1, runId, userId })).toEqual({ version: 1, runId, userId });
  });

  it("serializes nonnegative safe cursors as decimal SSE ids", () => {
    const event = { id: "0", event: "run.queued", data: { eventType: "run.queued", status: "queued", currentStep: "queued", attemptCount: 0 } };
    expect(AgentRunSseEventSchema.parse(event)).toEqual(event);
    expect(AgentRunSseEventSchema.safeParse({ ...event, id: "01" }).success).toBe(false);
    expect(AgentRunSseEventSchema.safeParse({ ...event, id: "9007199254740992" }).success).toBe(false);
  });

  it("rejects an unexpected key from every public object schema", () => {
    const start = { targetId, idempotencyKey: "08614f5c-b5cb-4c1d-8fca-3777105b5f19" };
    const sseEvent = { id: "1", event: "run.queued", data: eventData };
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
});
