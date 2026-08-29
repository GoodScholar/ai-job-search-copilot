import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_BUDGET,
  AGENT_RUN_CLAIM_LEASE_MS,
  AGENT_RUN_JOB_NAME,
  AGENT_RUN_QUEUE,
  AGENT_RUN_SCAN_INTERVAL_MS,
  AgentRunAdapterErrorSchema,
  AgentRunDetailSchema,
  AgentRunJobSchema,
  AgentRunSseEventSchema,
  FAKE_JOB_DISCOVERY_ADAPTER,
  FAKE_JOB_DISCOVERY_ADAPTER_VERSION,
  FAKE_JOB_DISCOVERY_SOURCE_IDS,
  FAKE_JOB_DISCOVERY_WORKFLOW_VERSION,
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

describe("agent run contracts", () => {
  it("parses the strict start command and queued run detail", () => {
    expect(StartAgentRunCommandSchema.parse({ targetId, idempotencyKey: "08614f5c-b5cb-4c1d-8fca-3777105b5f19" }))
      .toEqual({ targetId, idempotencyKey: "08614f5c-b5cb-4c1d-8fca-3777105b5f19" });
    const summary = {
      runId, targetId, targetVersion: 1,
      targetSnapshot: { targetId, version: 1, priority: "primary", state: "active", constraints: targetSnapshot },
      sourceScope: {
        kind: "company_watchlist", adapter: "fake", adapterVersion: FAKE_JOB_DISCOVERY_ADAPTER_VERSION,
        sources: FAKE_JOB_DISCOVERY_SOURCE_IDS,
      },
      workflowVersion: FAKE_JOB_DISCOVERY_WORKFLOW_VERSION,
      adapter: FAKE_JOB_DISCOVERY_ADAPTER, adapterVersion: FAKE_JOB_DISCOVERY_ADAPTER_VERSION,
      outputSchemaVersion: "job-discovery-result-v1", budget: AGENT_RUN_BUDGET,
      status: "queued", currentStep: "queued", version: 1, attemptCount: 0,
      failureCode: null, queuedAt: now, startedAt: null, completedAt: null,
      failedAt: null, updatedAt: now,
    };
    expect(AgentRunDetailSchema.parse({ ...summary, steps: [], events: [], results: [] }))
      .toMatchObject({ runId, targetId, status: "queued", currentStep: "queued" });
    expect(StartAgentRunResponseSchema.parse({ ...summary, reused: false }))
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

  it("rejects unknown keys from every public schema and keeps adapter errors stable", () => {
    expect(StartAgentRunCommandSchema.safeParse({ targetId, idempotencyKey: "key", extra: true }).success).toBe(false);
    expect(AgentRunDetailSchema.safeParse({ runId, extra: true }).success).toBe(false);
    expect(AgentRunJobSchema.safeParse({ version: 1, runId, userId, targetSnapshot }).success).toBe(false);
    expect(AgentRunSseEventSchema.safeParse({
      id: "1", event: "run.queued",
      data: { eventType: "run.queued", status: "queued", currentStep: "queued", attemptCount: 0 }, extra: true,
    }).success).toBe(false);
    expect(AgentRunAdapterErrorSchema.parse({ code: "SOURCE_UNAVAILABLE", retryable: true }))
      .toEqual({ code: "SOURCE_UNAVAILABLE", retryable: true });
    expect(AgentRunAdapterErrorSchema.safeParse({ code: "SOURCE_UNAVAILABLE", retryable: true, message: "unstable" }).success)
      .toBe(false);
  });
});
