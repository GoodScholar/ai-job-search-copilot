import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { agentInboxItems, agentRunEvents, agentRunJobResults, agentRunSteps, agentRunUsageEntries, agentRuns, auditEvents, createDatabase, jobAccounts, jobDiscoveryDiagnostics, jobDiscoveryRunResults, jobDiscoverySourceIssues, jobOpportunities, jobOpportunitySources, jobSourceHealthChecks, jobSourcePostings, jobSourcePostingVersions, jobTargetRevisions, jobTargets, migrateDatabase, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createAgentRunCheckpoint, createAgentRunCommands, createAgentRunProcessor, createAgentRunQueries, type AgentRunCheckpoint, type AgentRunQueue, type DiscoveryContentStore, type JobDiscoveryAdapter, type JobDiscoveryAdapterResolver } from "./agent-runs";
import { createCompanyWatchlistCommands } from "./company-watchlists";
import { AgentRunDetailSchema, AgentRunEventSchema, GREENHOUSE_JOB_DISCOVERY_ADAPTER, GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION, GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, GREENHOUSE_JOB_DISCOVERY_RULE_VERSION, GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION, GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST, GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, PUBLIC_JOB_DISCOVERY_BUDGET } from "@job-copilot/contracts/agent-runs";
import { LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER, LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION, LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION, LAYERED_PUBLIC_JOB_DISCOVERY_TOOL_ALLOWLIST, LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION } from "@job-copilot/contracts/job-discovery";

const now = new Date("2026-08-29T12:00:00.000Z");
const constraints = { roleFamily: "AI 应用工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } };

class Queue implements AgentRunQueue { async enqueue() {} }
class Store implements DiscoveryContentStore {
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  async put({ objectKey }: { objectKey: string }) { this.puts.push(objectKey); }
  async delete({ objectKey }: { objectKey: string }) { this.deletes.push(objectKey); }
}

describe("AgentRunProcessor checkpoints", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);
  afterAll(async () => { await database?.$client.end(); await container?.stop(); });

  async function run() {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now });
    const started = await createAgentRunCommands({ db: database, queue: new Queue(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    return { userId, targetId, runId: started.runId };
  }

  async function layeredRun() {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const runId = crypto.randomUUID(); const queryId = crypto.randomUUID(); const watchlistItemId = crypto.randomUUID(); const sourcePostingId = crypto.randomUUID(); const sourcePostingVersionId = crypto.randomUUID();
    const targetSnapshot = { targetId, version: 1, priority: "primary" as const, state: "active" as const, constraints };
    const profileSnapshot = { targetId, version: 1, confirmedActiveSkillNames: [] };
    const watchlistSnapshot = { targetId, version: 0, companies: [] };
    const sourceScope = { kind: "layered_public" as const, trustedSources: [{ kind: "greenhouse_trusted_source" as const, source: { sourceId: "greenhouse:example", watchlistItemId, canonicalCompanyName: "Example", careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards-api.greenhouse.io"], boardToken: "example" } }], publicDiscovery: { provider: "anysearch" as const, batchSize: 5 as const, maxVerificationCandidates: 10 as const, queries: [{ ordinal: 1, queryId, kind: "general" as const, stableFingerprint: "a".repeat(64), query: "AI 应用工程师", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 as const }] } };
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now });
    await database.insert(jobSourcePostings).values({ id: sourcePostingId, userId, sourceType: "company_careers", sourceIdentifier: "greenhouse:example:opening-1", sourceId: "greenhouse:example", sourceIdentity: { sourceId: "greenhouse:example", detailId: "opening-1" }, applicationDeadline: null, isOfficial: true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId, sourcePostingId, version: 1, contentSha256: "a".repeat(64), rawContentSha256: "b".repeat(64), rawObjectReference: {}, normalizedData: {}, retrievedAt: now, availability: "open", createdAt: now });
    await database.insert(agentRuns).values({ id: runId, userId, targetId, idempotencyKey: crypto.randomUUID(), targetVersion: 1, targetSnapshot, profileSnapshot, watchlistSnapshot, sourceScope, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET, workflowVersion: LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION, ruleVersion: LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION, adapter: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER, adapterVersion: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION, outputSchemaVersion: LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, toolAllowlist: LAYERED_PUBLIC_JOB_DISCOVERY_TOOL_ALLOWLIST, modelSnapshot: null, status: "queued", currentStep: "queued", controlState: "none", version: 1, attemptCount: 0, activeDurationMs: 0, toolCallCount: 0, sourceRequestCount: 0, modelCallCount: 0, inputTokenCount: 0, outputTokenCount: 0, totalTokenCount: 0, resultCount: 0, usageComplete: false, queuedAt: now, createdAt: now, updatedAt: now });
    await database.insert(agentRunSteps).values(["batch_search", "fetch_details", "persist_results"].map((stepKey, index) => ({ id: crypto.randomUUID(), userId, runId, stepKey, ordinal: index + 1, status: "pending", attemptCount: 0 })));
    return { userId, targetId, runId, queryId, sourcePostingVersionId };
  }

  async function extraTrustedVersion(job: { userId: string }, index: number, input: { sourceType?: "company_careers" | "public_web"; isOfficial?: boolean } = {}) {
    const sourcePostingId = crypto.randomUUID();
    const sourcePostingVersionId = crypto.randomUUID();
    await database.insert(jobSourcePostings).values({ id: sourcePostingId, userId: job.userId, sourceType: input.sourceType ?? "company_careers", sourceIdentifier: `greenhouse:example:opening-extra-${index}`, sourceId: "greenhouse:example", sourceIdentity: { sourceId: "greenhouse:example", detailId: `opening-extra-${index}` }, applicationDeadline: null, isOfficial: input.isOfficial ?? true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId: job.userId, sourcePostingId, version: 1, contentSha256: `${index.toString(16)}`.repeat(64).slice(0, 64), rawContentSha256: `${(index + 8).toString(16)}`.repeat(64).slice(0, 64), rawObjectReference: {}, normalizedData: {}, retrievedAt: now, availability: "open", createdAt: now });
    return sourcePostingVersionId;
  }

  function resolver(adapter: JobDiscoveryAdapter): JobDiscoveryAdapterResolver { return { resolve: () => adapter }; }
  function checkpoint(): AgentRunCheckpoint {
    return createAgentRunCheckpoint({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
  }
  function successAdapter(calls = { search: 0, detail: 0 }): JobDiscoveryAdapter {
    const summary = { sourceId: "fake:aurora-careers", detailId: "opening-1", company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null };
    return {
      search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
      searchBatch: async () => { calls.search += 1; return { ok: true, data: [summary] }; },
      getDetail: async () => { calls.detail += 1; return { ok: true, data: { ...summary, sourceType: "company_careers", isOfficial: true, rawPayload: { source: "aurora" } } }; },
    };
  }

  it("v4 processor 严格恢复完整 spec、调度物理操作并独立持久化运行问题", async () => {
    const job = await layeredRun(); let observedSpec: unknown;
    const outcome = await createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("v1-v3 adapter must not receive v4"); } },
      layeredPublicWorkflowResolver: { resolve: ({ executionSpec }) => ({ run: async ({ beforePhysicalOperation }) => {
        observedSpec = executionSpec;
        await beforePhysicalOperation({ kind: "search", identity: job.queryId });
        return { hasTrustedSuccess: true, sourcePostingVersionIds: [job.sourcePostingVersionId], trustedSourcePostingVersionIds: [job.sourcePostingVersionId], diagnostics: [{ scope: "provider", code: "ANYSEARCH_NOT_CONFIGURED", retryable: false, affectedCount: 1 }], sourceIssues: [{ provider: "anysearch", code: "ANYSEARCH_NOT_CONFIGURED", affectedCount: 1 }, { provider: "greenhouse", code: "GREENHOUSE_DEGRADED", affectedCount: 1 }] };
      } }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    }).process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true });
    expect(outcome).toBe("completed");
    expect(observedSpec).toMatchObject({ workflowVersion: LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION, profileSnapshot: { targetId: job.targetId }, watchlistSnapshot: { targetId: job.targetId }, sourceScope: { publicDiscovery: { queries: [expect.objectContaining({ ordinal: 1, allowedSiteDomains: [] })] } } });
    await expect(database.select().from(jobDiscoverySourceIssues).where(eq(jobDiscoverySourceIssues.runId, job.runId))).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ provider: "anysearch", code: "ANYSEARCH_NOT_CONFIGURED" }), expect.objectContaining({ provider: "greenhouse", code: "GREENHOUSE_DEGRADED" })]));
    await expect(database.select().from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId))).resolves.toEqual([]);
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ status: "completed", termination: { kind: "completed_with_source_issues" }, results: [{ sourcePostingVersionId: job.sourcePostingVersionId }], sourceIssues: [{ provider: "anysearch", code: "ANYSEARCH_NOT_CONFIGURED" }, { provider: "greenhouse", code: "GREENHOUSE_DEGRADED" }], usage: { toolCalls: 1, sourceRequests: 1 } });
  });

  it("拒绝 plan 外 diagnostic 的恶意 resolver，事务不写 discovery facts", async () => {
    const job = await layeredRun();
    const outcome = await createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({ hasTrustedSuccess: true, sourcePostingVersionIds: [job.sourcePostingVersionId], trustedSourcePostingVersionIds: [job.sourcePostingVersionId], diagnostics: [{ scope: "query", queryId: crypto.randomUUID(), kind: "general", stableFingerprint: "f".repeat(64), code: "ANYSEARCH_POLICY_REJECTED", retryable: false, affectedCount: 1 }] }) }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true });
    expect(outcome).toBe("failed");
    await expect(Promise.all([database.select().from(jobDiscoveryDiagnostics).where(eq(jobDiscoveryDiagnostics.runId, job.runId)), database.select().from(jobDiscoveryRunResults).where(eq(jobDiscoveryRunResults.runId, job.runId)), database.select().from(jobDiscoverySourceIssues).where(eq(jobDiscoverySourceIssues.runId, job.runId))])).resolves.toEqual([[], [], []]);
  });

  it("v4 budget terminal 与预算 inbox 并存 discovery attention，重放不重复", async () => {
    const job = await layeredRun();
    await database.update(agentRuns).set({ attemptCount: 2 }).where(eq(agentRuns.id, job.runId));
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({ hasTrustedSuccess: false, branchSuccess: { trusted: false, publicDiscovery: false }, diagnostics: [{ scope: "provider", code: "ANYSEARCH_QUOTA_EXHAUSTED", retryable: true, affectedCount: 1 }], sourceIssues: [{ provider: "anysearch", code: "ANYSEARCH_QUOTA_EXHAUSTED", affectedCount: 1 }] }) }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: false })).resolves.toBe("budget_exhausted");
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: false })).resolves.toBe("budget_exhausted");
    const [issues, inbox, attentionAudit] = await Promise.all([
      database.select().from(jobDiscoverySourceIssues).where(eq(jobDiscoverySourceIssues.runId, job.runId)),
      database.select().from(agentInboxItems).where(eq(agentInboxItems.runId, job.runId)),
      database.select().from(auditEvents).where(and(eq(auditEvents.requestId, job.runId), eq(auditEvents.reasonCode, "DISCOVERY_ATTENTION"))),
    ]);
    expect(issues).toEqual([expect.objectContaining({ code: "ANYSEARCH_QUOTA_EXHAUSTED", affectedCount: 1 })]);
    expect(inbox.filter((item) => item.kind === "budget_exhausted")).toHaveLength(1);
    expect(inbox.filter((item) => item.kind === "discovery_attention")).toHaveLength(1);
    expect(attentionAudit).toHaveLength(1);
  });

  it("v4 实际不可重试终态不受 finalAttempt 影响，并且重放不重复 attention", async () => {
    const job = await layeredRun();
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({
        hasTrustedSuccess: false,
        branchSuccess: { trusted: false, publicDiscovery: false },
        diagnostics: [{ scope: "provider", code: "ANYSEARCH_NOT_CONFIGURED", retryable: false, affectedCount: 1 }],
        sourceIssues: [{ provider: "anysearch", code: "ANYSEARCH_NOT_CONFIGURED", affectedCount: 1 }],
      }) }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: false })).resolves.toBe("failed");
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("failed");
    const [issues, attention, attentionAudit] = await Promise.all([
      database.select().from(jobDiscoverySourceIssues).where(eq(jobDiscoverySourceIssues.runId, job.runId)),
      database.select().from(agentInboxItems).where(and(eq(agentInboxItems.runId, job.runId), eq(agentInboxItems.kind, "discovery_attention"))),
      database.select().from(auditEvents).where(and(eq(auditEvents.requestId, job.runId), eq(auditEvents.reasonCode, "DISCOVERY_ATTENTION"))),
    ]);
    expect(issues).toEqual([expect.objectContaining({ code: "ANYSEARCH_NOT_CONFIGURED", affectedCount: 1 })]);
    expect(attention).toHaveLength(1);
    expect(attentionAudit).toHaveLength(1);
  });

  it("v4 result 复原既有 ordinal，稳定截断为五条并保持 detail/resultCount 一致", async () => {
    const job = await layeredRun();
    const extra = await Promise.all([1, 2, 3, 4, 5].map((index) => extraTrustedVersion(job, index)));
    await database.insert(jobDiscoveryRunResults).values({ id: crypto.randomUUID(), userId: job.userId, runId: job.runId, sourcePostingVersionId: job.sourcePostingVersionId, ordinal: 1, createdAt: now });
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({ hasTrustedSuccess: true, branchSuccess: { trusted: true, publicDiscovery: false }, sourcePostingVersionIds: [...extra, job.sourcePostingVersionId], trustedSourcePostingVersionIds: [...extra, job.sourcePostingVersionId], diagnostics: [] }) }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    await expect(database.select({ resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ resultCount: 5 }]);
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ results: [
      { sourcePostingVersionId: job.sourcePostingVersionId },
      { sourcePostingVersionId: extra[0] },
      { sourcePostingVersionId: extra[1] },
      { sourcePostingVersionId: extra[2] },
      { sourcePostingVersionId: extra[3] },
    ] });
  });

  it("v4 trusted result 必须属于获批可信来源且仍为官方 company careers", async () => {
    const job = await layeredRun();
    const untrustedVersion = await extraTrustedVersion(job, 9, { sourceType: "public_web", isOfficial: false });
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({ hasTrustedSuccess: true, branchSuccess: { trusted: true, publicDiscovery: false }, sourcePostingVersionIds: [untrustedVersion], trustedSourcePostingVersionIds: [untrustedVersion], diagnostics: [] }) }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("failed");
    await expect(database.select().from(jobDiscoveryRunResults).where(eq(jobDiscoveryRunResults.runId, job.runId))).resolves.toEqual([]);
  });

  it("v4 completed duplicate delivery 不重放 workflow、结果或 usage", async () => {
    const job = await layeredRun();
    let calls = 0;
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async ({ beforePhysicalOperation }) => {
        calls += 1;
        await beforePhysicalOperation({ kind: "search", identity: job.queryId });
        return { hasTrustedSuccess: true, branchSuccess: { trusted: true, publicDiscovery: false }, sourcePostingVersionIds: [job.sourcePostingVersionId], trustedSourcePostingVersionIds: [job.sourcePostingVersionId], diagnostics: [] };
      } }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    expect(calls).toBe(1);
    await expect(Promise.all([
      database.select().from(jobDiscoveryRunResults).where(eq(jobDiscoveryRunResults.runId, job.runId)),
      database.select({ toolCalls: agentRuns.toolCallCount, sourceRequests: agentRuns.sourceRequestCount, resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, job.runId)),
    ])).resolves.toEqual([[expect.objectContaining({ sourcePostingVersionId: job.sourcePostingVersionId })], [{ toolCalls: 1, sourceRequests: 1, resultCount: 1 }]]);
  });

  it.each(["search", "extract", "fetch"] as const)("v4 checkpoint 在 %s 前停止后续物理调用", async (stopAt) => {
    const job = await layeredRun();
    const hooks: string[] = [];
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => input.checkpointKey.includes(`:layered_${stopAt}_`)
      ? { kind: "paused" }
      : durable.check(input) };
    const processor = createAgentRunProcessor({
      db: database, checkpoint: controlled,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async ({ beforePhysicalOperation }) => {
        for (const kind of ["search", "extract", "fetch"] as const) { hooks.push(kind); await beforePhysicalOperation({ kind, identity: kind === "search" ? job.queryId : crypto.randomUUID() }); }
        return { hasTrustedSuccess: true, branchSuccess: { trusted: true, publicDiscovery: false }, sourcePostingVersionIds: [job.sourcePostingVersionId], trustedSourcePostingVersionIds: [job.sourcePostingVersionId], diagnostics: [] };
      } }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("paused");
    expect(hooks).toEqual(["search", "extract", "fetch"].slice(0, ["search", "extract", "fetch"].indexOf(stopAt) + 1));
  });

  it.each(["cancelled", "budget_exhausted", "stale"] as const)("v4 checkpoint 返回 %s 时不调用 workflow 后续物理操作", async (outcome) => {
    const job = await layeredRun(); let hooks = 0;
    const durable = checkpoint();
    const stop = outcome === "budget_exhausted" ? { kind: "budget_exhausted" as const, budgetDimension: "tool_calls" as const } : outcome === "cancelled" ? { kind: "cancelled" as const } : { kind: "stale" as const };
    const controlled: AgentRunCheckpoint = { check: async (input) => input.checkpointKey.includes(":layered_search_") ? stop : durable.check(input) };
    const processor = createAgentRunProcessor({ db: database, checkpoint: controlled, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => ({ run: async ({ beforePhysicalOperation }) => { hooks += 1; await beforePhysicalOperation({ kind: "search", identity: job.queryId }); hooks += 1; return { hasTrustedSuccess: true, diagnostics: [] }; } }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe(outcome);
    expect(hooks).toBe(1);
  });

  it("v4 retry 只保留诊断；后续成功不遗留 source issue 或 attention", async () => {
    const job = await layeredRun(); let retry = true;
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => retry
      ? { hasTrustedSuccess: false, branchSuccess: { trusted: false, publicDiscovery: false }, diagnostics: [{ scope: "provider", code: "ANYSEARCH_UNAVAILABLE", retryable: true, affectedCount: 1 }], sourceIssues: [{ provider: "anysearch", code: "ANYSEARCH_UNAVAILABLE", affectedCount: 1 }] }
      : { hasTrustedSuccess: true, branchSuccess: { trusted: true, publicDiscovery: false }, sourcePostingVersionIds: [job.sourcePostingVersionId], trustedSourcePostingVersionIds: [job.sourcePostingVersionId], diagnostics: [] } }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("retry");
    await expect(Promise.all([database.select().from(jobDiscoveryDiagnostics).where(eq(jobDiscoveryDiagnostics.runId, job.runId)), database.select().from(jobDiscoverySourceIssues).where(eq(jobDiscoverySourceIssues.runId, job.runId)), database.select().from(agentInboxItems).where(and(eq(agentInboxItems.runId, job.runId), eq(agentInboxItems.kind, "discovery_attention")))] )).resolves.toEqual([[expect.objectContaining({ code: "ANYSEARCH_UNAVAILABLE" })], [], []]);
    retry = false;
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: false })).resolves.toBe("completed");
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ status: "completed", termination: { kind: "completed" }, sourceIssues: [] });
  });

  it("来源调用后暂停会阻止后续外部调用", async () => {
    const job = await run();
    let details = 0;
    const adapter: JobDiscoveryAdapter = {
      search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
      searchBatch: async () => {
        await database.update(agentRuns).set({ controlState: "pause_requested" }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
        return { ok: true, data: [{ sourceId: "fake:aurora-careers", detailId: "opening-1", company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null }] };
      },
      getDetail: async () => { details += 1; return { ok: false, error: { code: "UNUSED", retryable: false } }; },
    };

    const outcome = await createAgentRunProcessor({ db: database, adapterResolver: resolver(adapter), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true });

    expect(outcome).toBe("paused");
    expect(details).toBe(0);
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ status: "paused", controlState: "none" });
  });

  it("领取后到达暂停时不解析或调用来源 adapter", async () => {
    const job = await run();
    const calls = { search: 0, detail: 0 };
    const durable = checkpoint();
    let first = true;
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      if (first) {
        first = false;
        await database.update(agentRuns).set({ controlState: "pause_requested" }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
      }
      return durable.check(input);
    } };

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter(calls)), checkpoint: controlled, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("paused");
    expect(calls).toEqual({ search: 0, detail: 0 });
  });

  it("来源调用前取消时不产生来源外部调用", async () => {
    const job = await run();
    const calls = { search: 0, detail: 0 };
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      if (input.checkpointKey.includes(":source_search_batch:1")) {
        await database.update(agentRuns).set({ controlState: "cancel_requested" }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
      }
      return durable.check(input);
    } };

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter(calls)), checkpoint: controlled, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("cancelled");
    expect(calls).toEqual({ search: 0, detail: 0 });
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ status: "cancelled", controlState: "none" });
  });

  it("对象写入后取消会清理本 claim 的对象", async () => {
    const job = await run();
    const store = new Store();
    store.put = async ({ objectKey }) => {
      store.puts.push(objectKey);
      await database.update(agentRuns).set({ controlState: "cancel_requested" }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    };

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("cancelled");
    expect(store.deletes).toEqual(store.puts);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId))).resolves.toHaveLength(0);
  });

  it("提交前控制使迟到的领域结果成为 stale 并清理对象", async () => {
    const job = await run();
    const store = new Store();
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      if (input.checkpointKey.includes(":domain_commit_before:1")) {
        await database.update(agentRuns).set({ controlState: "cancel_requested" }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
        return { kind: "continue" };
      }
      return durable.check(input);
    } };

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), checkpoint: controlled, contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("stale");
    expect(store.deletes).toEqual(store.puts);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId))).resolves.toHaveLength(0);
  });

  it("完成后的重复任务不重放结果或预占计费", async () => {
    const job = await run();
    const store = new Store();
    const processor = createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    await expect(processor.process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("stale");
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId))).resolves.toHaveLength(1);
    await expect(database.select().from(agentRunUsageEntries).where(eq(agentRunUsageEntries.runId, job.runId))).resolves.toHaveLength(5);
    await expect(database.select({ usageKey: agentRunUsageEntries.usageKey, category: agentRunUsageEntries.category, amount: agentRunUsageEntries.amount, stepKey: agentRunUsageEntries.stepKey, attemptCount: agentRunUsageEntries.attemptCount }).from(agentRunUsageEntries)
      .where(and(eq(agentRunUsageEntries.runId, job.runId), eq(agentRunUsageEntries.category, "result"))))
      .resolves.toEqual([expect.objectContaining({ amount: 1, stepKey: "persist_results", attemptCount: 1 })]);
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ usage: { toolCalls: 2, sourceRequests: 2, modelCalls: 0, results: 1 } });
    await expect(database.select().from(agentRunEvents).where(and(eq(agentRunEvents.runId, job.runId), eq(agentRunEvents.eventType, "run.budget_updated")))).resolves.toHaveLength(4);
  });

  it("v3 提交后的 checkpoint 异常保留已引用对象，重放不重复持久化", async () => {
    const job = await run();
    const source = { sourceId: "greenhouse:post-commit", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Post Commit", careersUrl: "https://boards.greenhouse.io/post-commit", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "post-commit" };
    await database.update(agentRuns).set({ adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET, sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources: [source] } }).where(eq(agentRuns.id, job.runId));
    const sourceHealthAdapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      listSource: async () => ({ ok: true, attemptCount: 1, data: { sourceId: source.sourceId, observedDetailIds: ["701"], candidates: [{ sourceId: source.sourceId, detailId: "701", company: null, title: "AI Engineer", location: "Shanghai" }] } }),
      getSourceDetail: async () => ({ ok: true, attemptCount: 1, data: { sourceId: source.sourceId, detailId: "701", company: "Post Commit", title: "AI Engineer", location: "Shanghai", postedAt: "2026-08-20T00:00:00.000Z", deadline: null, sourceType: "company_careers", isOfficial: true, absoluteUrl: "https://boards.greenhouse.io/post-commit/jobs/701", rawPayload: { id: 701 } } }),
    };
    const durable = checkpoint();
    const afterCommitBomb: AgentRunCheckpoint = { check: async (input) => {
      if (input.checkpointKey.includes(":domain_commit_after:1")) throw new Error("post-commit checkpoint failed");
      return durable.check(input);
    } };
    const store = new Store();
    const deps = { db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => sourceHealthAdapter as any }, contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any;
    await expect(createAgentRunProcessor({ ...deps, checkpoint: afterCommitBomb }).process({ version: 1, ...job, finalAttempt: true })).rejects.toThrow("post-commit checkpoint failed");
    await expect(database.select({ status: agentRuns.status, terminationKind: agentRuns.terminationKind }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ status: "completed", terminationKind: "completed" }]);
    await expect(database.select({ rawObjectReference: jobSourcePostingVersions.rawObjectReference }).from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, job.userId))).resolves.toEqual([{ rawObjectReference: { objectKey: store.puts[0] } }]);
    expect(store.deletes).toEqual([]);
    const beforeReplay = await Promise.all([
      database.select().from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId)),
      database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId)),
      database.select().from(agentRunEvents).where(eq(agentRunEvents.runId, job.runId)),
      database.select().from(agentInboxItems).where(eq(agentInboxItems.runId, job.runId)),
      database.select().from(auditEvents).where(eq(auditEvents.resourceId, job.runId)),
    ]);
    await expect(createAgentRunProcessor({ ...deps }).process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    await expect(Promise.all([
      database.select().from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId)),
      database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId)),
      database.select().from(agentRunEvents).where(eq(agentRunEvents.runId, job.runId)),
      database.select().from(agentInboxItems).where(eq(agentInboxItems.runId, job.runId)),
      database.select().from(auditEvents).where(eq(auditEvents.resourceId, job.runId)),
    ])).resolves.toEqual(beforeReplay);
    expect(store.deletes).toEqual([]);
  });

  it("Public v2 每个 board 列表和每个已选详情各预占一次逻辑预算，并持久完整扫描事实", async () => {
    const job = await run();
    const sources = [
      { sourceId: "greenhouse:fictional-labs", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Fictional Labs", careersUrl: "https://boards.greenhouse.io/fictional-labs", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "fictional-labs" },
      { sourceId: "greenhouse:fictional-labs-secondary", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Fictional Labs Secondary", careersUrl: "https://boards.greenhouse.io/fictional-labs-secondary", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "fictional-labs-secondary" },
    ];
    await database.update(agentRuns).set({
      adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION,
      workflowVersion: GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_JOB_DISCOVERY_RULE_VERSION,
      outputSchemaVersion: GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET,
      sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION, watchlistVersion: 1, sources },
    }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const adapter: JobDiscoveryAdapter = {
      search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
      searchBatch: async (input: any) => { await input.beforeList?.(sources[0]!.sourceId); await input.beforeList?.(sources[1]!.sourceId); return { ok: true, data: { items: [{ sourceId: sources[0]!.sourceId, detailId: "701", company: null, title: "AI Engineer", location: "Shanghai" }], scans: [{ sourceId: sources[0]!.sourceId, observedDetailIds: ["701"], complete: true }, { sourceId: sources[1]!.sourceId, observedDetailIds: [], complete: true }] } }; },
      getDetail: async () => ({ ok: true, data: { sourceId: sources[0]!.sourceId, detailId: "701", company: "Fictional Labs", title: "AI Engineer", location: "Shanghai", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: { job: 701 } } }),
    };

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(adapter), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ adapter: "greenhouse", usage: { toolCalls: 3, sourceRequests: 3, results: 1 } });
  });

  it("v3 healthy + hard_failed 保留成功来源并原子写入一项来源关注 Inbox", async () => {
    const job = await run();
    const healthy = { sourceId: "greenhouse:healthy", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Healthy", careersUrl: "https://boards.greenhouse.io/healthy", allowedDomains: ["boards-api.greenhouse.io"], boardToken: "healthy" };
    const failed = { sourceId: "greenhouse:failed", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Failed", careersUrl: "https://boards.greenhouse.io/failed", allowedDomains: ["boards-api.greenhouse.io"], boardToken: "failed" };
    await database.update(agentRuns).set({
      adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION,
      outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST,
      budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET,
      sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources: [healthy, failed] },
    }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const historicalPostingId = crypto.randomUUID(); const historicalVersionId = crypto.randomUUID(); const historicalOpportunityId = crypto.randomUUID();
    await database.insert(jobSourcePostings).values({ id: historicalPostingId, userId: job.userId, sourceType: "company_careers", sourceIdentifier: "a".repeat(64), sourceId: failed.sourceId, sourceIdentity: { sourceId: failed.sourceId, detailId: "historical" }, applicationDeadline: null, isOfficial: true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourcePostingVersions).values({ id: historicalVersionId, userId: job.userId, sourcePostingId: historicalPostingId, version: 1, contentSha256: "b".repeat(64), rawContentSha256: "c".repeat(64), rawObjectReference: { objectKey: "historical.json" }, retrievedAt: now, availability: "open", createdAt: now });
    await database.insert(jobOpportunities).values({ id: historicalOpportunityId, userId: job.userId, importId: null, sourcePostingVersionId: historicalVersionId, dedupKey: "d".repeat(64), company: "Failed", title: "Historical", location: null, postedAt: null, deadline: null, description: null, normalizedData: {}, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId: job.userId, opportunityId: historicalOpportunityId, sourcePostingVersionId: historicalVersionId, createdAt: now });
    const sourceHealthAdapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      listSource: async ({ source }: any) => source.sourceId === failed.sourceId
        ? { ok: false, failure: { category: "hard_failed", reasonCode: "SOURCE_SERVER_ERROR", retryable: true, attemptCount: 2 } }
        : { ok: true, attemptCount: 1, data: { sourceId: healthy.sourceId, observedDetailIds: ["701"], candidates: [{ sourceId: healthy.sourceId, detailId: "701", company: null, title: "AI Engineer", location: "Shanghai" }] } },
      getSourceDetail: async () => ({ ok: true, attemptCount: 1, data: { sourceId: healthy.sourceId, detailId: "701", company: "Healthy", title: "AI Engineer", location: "Shanghai", postedAt: "2026-08-20T00:00:00.000Z", deadline: null, sourceType: "company_careers", isOfficial: true, absoluteUrl: "https://boards.greenhouse.io/healthy/jobs/701", rawPayload: { id: 701 } } }),
    };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => sourceHealthAdapter as any }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any)
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    await expect(database.select({ status: agentRuns.status, terminationKind: agentRuns.terminationKind, resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ status: "completed", terminationKind: "completed_with_source_issues", resultCount: 1 }]);
    await expect(database.select({ status: jobSourceHealthChecks.status }).from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId))).resolves.toEqual(expect.arrayContaining([{ status: "healthy" }, { status: "hard_failed" }]));
    await expect(database.select({ kind: agentInboxItems.kind, reasonCode: agentInboxItems.reasonCode }).from(agentInboxItems).where(eq(agentInboxItems.runId, job.runId))).resolves.toEqual([{ kind: "source_attention", reasonCode: "SOURCE_HEALTH_ATTENTION" }]);
    await expect(database.select({ availability: jobSourcePostings.availability }).from(jobSourcePostings).where(eq(jobSourcePostings.id, historicalPostingId))).resolves.toEqual([{ availability: "open" }]);
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ sourceChecks: expect.arrayContaining([expect.objectContaining({ status: "healthy" }), expect.objectContaining({ status: "hard_failed" })]) });
  });

  it("真实 watchlist 快照排除 disabled 来源：仅 zero 仍普通完成且不创建来源关注", async () => {
    const seed = await run();
    const watchlists = createCompanyWatchlistCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await watchlists.addItem({ userId: seed.userId, targetId: seed.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, canonicalCompanyName: "Enabled", careersUrl: "https://boards.greenhouse.io/enabled", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null } });
    const withDisabled = await watchlists.addItem({ userId: seed.userId, targetId: seed.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 1, canonicalCompanyName: "Disabled", careersUrl: "https://boards.greenhouse.io/disabled", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null } });
    await watchlists.setItemState({ userId: seed.userId, targetId: seed.targetId, requestId: crypto.randomUUID(), itemId: withDisabled.items[1]!.itemId, command: { expectedVersion: 2, state: "disabled" } });
    const started = await createAgentRunCommands({ db: database, queue: new Queue(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, executionMode: "greenhouse" }).start({ userId: seed.userId, requestId: crypto.randomUUID(), command: { targetId: seed.targetId, idempotencyKey: crypto.randomUUID() } });
    const [frozen] = await database.select({ sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.id, started.runId));
    const [enabled] = (frozen!.sourceScope as { sources: Array<{ sourceId: string; watchlistItemId: string; canonicalCompanyName: string }> }).sources;
    expect(frozen!.sourceScope).toMatchObject({ sources: [{ canonicalCompanyName: "Enabled" }] });
    const sourceHealthAdapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      listSource: async () => ({ ok: true, attemptCount: 1, data: { sourceId: enabled!.sourceId, observedDetailIds: [], candidates: [] } }),
      getSourceDetail: async () => { throw new Error("UNUSED"); },
    };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => sourceHealthAdapter as any }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any).process({ version: 1, userId: seed.userId, runId: started.runId, finalAttempt: true })).resolves.toBe("completed");
    await expect(database.select({ status: agentRuns.status, terminationKind: agentRuns.terminationKind }).from(agentRuns).where(eq(agentRuns.id, started.runId))).resolves.toEqual([{ status: "completed", terminationKind: "completed" }]);
    await expect(database.select({ sourceId: jobSourceHealthChecks.sourceId, status: jobSourceHealthChecks.status, watchlistItemId: jobSourceHealthChecks.watchlistItemId }).from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, started.runId))).resolves.toEqual([{ sourceId: enabled!.sourceId, status: "zero_valid_results", watchlistItemId: enabled!.watchlistItemId }]);
    await expect(database.select({ kind: agentInboxItems.kind }).from(agentInboxItems).where(eq(agentInboxItems.runId, started.runId))).resolves.toEqual([]);
  });

  it.each([
    [["healthy", "rate_limited"], "completed_with_source_issues", 1],
    [["healthy", "parser_degraded"], "completed_with_source_issues", 1],
    [["zero_valid_results", "hard_failed"], "completed_with_source_issues", 0],
    [["zero_valid_results", "rate_limited"], "completed_with_source_issues", 0],
    [["zero_valid_results", "parser_degraded"], "completed_with_source_issues", 0],
    [["zero_valid_results", "list_parser_degraded"], "completed_with_source_issues", 0],
    [["zero_valid_results", "zero_valid_results"], "completed", 0],
    [["hard_failed", "rate_limited"], "source_failed", 0],
    [["parser_retained", "hard_failed"], "completed_with_source_issues", 1],
    [["rate_retained"], "completed_with_source_issues", 1],
    [["hard_retained"], "completed_with_source_issues", 1],
  ] as const)("v3 真值表 %j 终止为 %s", async (outcomes, terminationKind, resultCount) => {
    const job = await run();
    const sources = outcomes.map((outcome, index) => ({ sourceId: `greenhouse:truth-${index}`, watchlistItemId: crypto.randomUUID(), canonicalCompanyName: `Truth ${index}`, careersUrl: `https://boards.greenhouse.io/truth-${index}`, allowedDomains: ["boards-api.greenhouse.io"], boardToken: `truth-${index}`, outcome }));
    await database.update(agentRuns).set({ adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET, sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources: sources.map(({ outcome: _outcome, ...source }) => source) } }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const historicalPostingIds = new Map<string, string>();
    for (const [index, source] of sources.entries()) {
      const postingId = crypto.randomUUID();
      historicalPostingIds.set(source.sourceId, postingId);
      await database.insert(jobSourcePostings).values({ id: postingId, userId: job.userId, sourceType: "company_careers", sourceIdentifier: `${index}`.padStart(64, "0"), sourceId: source.sourceId, sourceIdentity: { sourceId: source.sourceId, detailId: "historical" }, applicationDeadline: null, isOfficial: true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
      await database.insert(jobSourcePostingVersions).values({ id: crypto.randomUUID(), userId: job.userId, sourcePostingId: postingId, version: 1, contentSha256: `${index}`.padStart(64, "1"), rawContentSha256: `${index}`.padStart(64, "2"), rawObjectReference: { objectKey: `truth-${index}.json` }, retrievedAt: now, availability: "open", createdAt: now });
    }
    const adapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      listSource: async ({ source }: any) => {
        const scenario = sources.find((item) => item.sourceId === source.sourceId)!.outcome;
        if (scenario === "rate_limited") return { ok: false, failure: { category: "rate_limited", reasonCode: "SOURCE_RATE_LIMITED", retryable: true, attemptCount: 2 } };
        if (scenario === "hard_failed") return { ok: false, failure: { category: "hard_failed", reasonCode: "SOURCE_SERVER_ERROR", retryable: true, attemptCount: 2 } };
        if (scenario === "list_parser_degraded") return { ok: false, failure: { category: "parser_degraded", reasonCode: "SOURCE_LIST_SCHEMA_INVALID", retryable: false, attemptCount: 1 } };
        if (scenario === "zero_valid_results") return { ok: true, attemptCount: 1, data: { sourceId: source.sourceId, observedDetailIds: [], candidates: [] } };
        const ids = ["parser_retained", "rate_retained", "hard_retained"].includes(scenario) ? ["701", "702"] : ["701"];
        return { ok: true, attemptCount: 1, data: { sourceId: source.sourceId, observedDetailIds: ids, candidates: ids.map((detailId) => ({ sourceId: source.sourceId, detailId, company: null, title: "AI Engineer", location: "Shanghai" })) } };
      },
      getSourceDetail: async ({ source, detailId }: any) => {
        const scenario = sources.find((item) => item.sourceId === source.sourceId)!.outcome;
        if (scenario === "parser_degraded" || (scenario === "parser_retained" && detailId === "702")) return { ok: false, failure: { category: "parser_degraded", reasonCode: "SOURCE_DETAIL_FIELDS_MISSING", retryable: false, attemptCount: 1 } };
        if (scenario === "rate_retained" && detailId === "702") return { ok: false, failure: { category: "rate_limited", reasonCode: "SOURCE_RATE_LIMITED", retryable: true, attemptCount: 2 } };
        if (scenario === "hard_retained" && detailId === "702") return { ok: false, failure: { category: "hard_failed", reasonCode: "SOURCE_SERVER_ERROR", retryable: true, attemptCount: 2 } };
        return { ok: true, attemptCount: 1, data: { sourceId: source.sourceId, detailId, company: source.canonicalCompanyName, title: "AI Engineer", location: "Shanghai", postedAt: "2026-08-20T00:00:00.000Z", deadline: null, sourceType: "company_careers", isOfficial: true, absoluteUrl: `https://boards.greenhouse.io/${source.boardToken}/jobs/${detailId}`, rawPayload: { detailId } } };
      },
    };
    const outcome = await createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => adapter as any }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any).process({ version: 1, ...job, finalAttempt: true });
    expect(outcome).toBe(terminationKind === "source_failed" ? "failed" : "completed");
    await expect(database.select({ terminationKind: agentRuns.terminationKind, resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ terminationKind, resultCount }]);
    const healthFacts = {
      healthy: { status: "healthy", reasonCodes: [], impactScope: "none", impactAffectedCount: null, observedPostingCount: 1, selectedDetailCount: 1, validDetailCount: 1, requestAttemptCount: 2, availability: "closed" },
      zero_valid_results: { status: "zero_valid_results", reasonCodes: [], impactScope: "none", impactAffectedCount: null, observedPostingCount: 0, selectedDetailCount: 0, validDetailCount: 0, requestAttemptCount: 1, availability: "closed" },
      parser_degraded: { status: "parser_degraded", reasonCodes: ["SOURCE_DETAIL_FIELDS_MISSING"], impactScope: "job_details", impactAffectedCount: 1, observedPostingCount: 1, selectedDetailCount: 1, validDetailCount: 0, requestAttemptCount: 2, availability: "open" },
      list_parser_degraded: { status: "parser_degraded", reasonCodes: ["SOURCE_LIST_SCHEMA_INVALID"], impactScope: "entire_source", impactAffectedCount: null, observedPostingCount: 0, selectedDetailCount: 0, validDetailCount: 0, requestAttemptCount: 1, availability: "open" },
      parser_retained: { status: "parser_degraded", reasonCodes: ["SOURCE_DETAIL_FIELDS_MISSING"], impactScope: "job_details", impactAffectedCount: 1, observedPostingCount: 2, selectedDetailCount: 2, validDetailCount: 1, requestAttemptCount: 3, availability: "open" },
      rate_retained: { status: "rate_limited", reasonCodes: ["SOURCE_RATE_LIMITED"], impactScope: "entire_source", impactAffectedCount: null, observedPostingCount: 2, selectedDetailCount: 2, validDetailCount: 1, requestAttemptCount: 4, availability: "open" },
      hard_retained: { status: "hard_failed", reasonCodes: ["SOURCE_SERVER_ERROR"], impactScope: "entire_source", impactAffectedCount: null, observedPostingCount: 2, selectedDetailCount: 2, validDetailCount: 1, requestAttemptCount: 4, availability: "open" },
      rate_limited: { status: "rate_limited", reasonCodes: ["SOURCE_RATE_LIMITED"], impactScope: "entire_source", impactAffectedCount: null, observedPostingCount: 0, selectedDetailCount: 0, validDetailCount: 0, requestAttemptCount: 2, availability: "open" },
      hard_failed: { status: "hard_failed", reasonCodes: ["SOURCE_SERVER_ERROR"], impactScope: "entire_source", impactAffectedCount: null, observedPostingCount: 0, selectedDetailCount: 0, validDetailCount: 0, requestAttemptCount: 2, availability: "open" },
    } as const;
    await expect(database.select({ sourceId: jobSourceHealthChecks.sourceId, status: jobSourceHealthChecks.status, reasonCodes: jobSourceHealthChecks.reasonCodes, impactScope: jobSourceHealthChecks.impactScope, impactAffectedCount: jobSourceHealthChecks.impactAffectedCount, observedPostingCount: jobSourceHealthChecks.observedPostingCount, selectedDetailCount: jobSourceHealthChecks.selectedDetailCount, validDetailCount: jobSourceHealthChecks.validDetailCount, requestAttemptCount: jobSourceHealthChecks.requestAttemptCount }).from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId)).orderBy(asc(jobSourceHealthChecks.sourceId))).resolves.toEqual(sources.map((source) => {
      const { availability: _availability, ...fact } = healthFacts[source.outcome];
      return { sourceId: source.sourceId, ...fact };
    }).sort((left, right) => left.sourceId.localeCompare(right.sourceId)));
    const persistedAvailability = await Promise.all(sources.map(async (source) => ({ sourceId: source.sourceId, availability: (await database.select({ availability: jobSourcePostings.availability }).from(jobSourcePostings).where(eq(jobSourcePostings.id, historicalPostingIds.get(source.sourceId)!)))[0]!.availability })));
    expect(persistedAvailability.sort((left, right) => left.sourceId.localeCompare(right.sourceId))).toEqual(sources.map((source) => ({ sourceId: source.sourceId, availability: healthFacts[source.outcome].availability })).sort((left, right) => left.sourceId.localeCompare(right.sourceId)));
    const issueCount = outcomes.filter((sourceOutcome) => sourceOutcome !== "healthy" && sourceOutcome !== "zero_valid_results").length;
    await expect(database.select({ kind: agentInboxItems.kind }).from(agentInboxItems).where(eq(agentInboxItems.runId, job.runId)).orderBy(asc(agentInboxItems.kind))).resolves.toEqual(terminationKind === "source_failed" ? [{ kind: "run_failed" }, { kind: "source_attention" }] : issueCount ? [{ kind: "source_attention" }] : []);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId))).resolves.toHaveLength(resultCount);
    if (terminationKind === "source_failed") {
      const [failedEvent] = await database.select({ sequence: agentRunEvents.sequence, runVersion: agentRunEvents.runVersion, eventType: agentRunEvents.eventType, data: agentRunEvents.data, createdAt: agentRunEvents.createdAt }).from(agentRunEvents)
        .where(and(eq(agentRunEvents.runId, job.runId), eq(agentRunEvents.eventType, "run.failed")));
      expect(AgentRunEventSchema.parse({ ...failedEvent, createdAt: failedEvent!.createdAt.toISOString() })).toMatchObject({
        eventType: "run.failed", data: { eventType: "run.failed", status: "failed", currentStep: "failed", attemptCount: 1, failureCode: "AGENT_RUN_ADAPTER_FAILED" },
      });
      await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({
        events: expect.arrayContaining([expect.objectContaining({ eventType: "run.failed", data: { eventType: "run.failed", status: "failed", currentStep: "failed", attemptCount: 1, failureCode: "AGENT_RUN_ADAPTER_FAILED" } })]),
      });
    }
  });

  it("v3 将跨来源有效详情按冻结顺序截断到总 maxResults，同时保留每来源健康事实", async () => {
    const job = await run();
    const sources = Array.from({ length: 6 }, (_, index) => ({
      sourceId: `greenhouse:cap-${index}`, watchlistItemId: crypto.randomUUID(), canonicalCompanyName: `Cap ${index}`,
      careersUrl: `https://boards.greenhouse.io/cap-${index}`, allowedDomains: ["boards-api.greenhouse.io"], boardToken: `cap-${index}`,
    }));
    await database.update(agentRuns).set({
      adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION,
      outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST,
      budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET,
      sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources },
    }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const sourceHealthAdapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      listSource: async ({ source }: any) => ({ ok: true, attemptCount: 1, data: { sourceId: source.sourceId, observedDetailIds: ["701"], candidates: [{ sourceId: source.sourceId, detailId: "701", company: null, title: "AI Engineer", location: "Shanghai" }] } }),
      getSourceDetail: async ({ source, detailId }: any) => ({ ok: true, attemptCount: 1, data: { sourceId: source.sourceId, detailId, company: source.canonicalCompanyName, title: "AI Engineer", location: "Shanghai", postedAt: "2026-08-20T00:00:00.000Z", deadline: null, sourceType: "company_careers", isOfficial: true, absoluteUrl: `https://boards.greenhouse.io/${source.boardToken}/jobs/${detailId}`, rawPayload: { detailId } } }),
    };
    const store = new Store();
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => sourceHealthAdapter as any }, contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any)
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    await expect(database.select({ status: agentRuns.status, terminationKind: agentRuns.terminationKind, resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ status: "completed", terminationKind: "completed", resultCount: 5 }]);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId))).resolves.toHaveLength(5);
    await expect(database.select({ sourceId: jobSourceHealthChecks.sourceId, status: jobSourceHealthChecks.status, validDetailCount: jobSourceHealthChecks.validDetailCount }).from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId)).orderBy(asc(jobSourceHealthChecks.sourceId))).resolves.toEqual(sources.map((source) => ({ sourceId: source.sourceId, status: "healthy", validDetailCount: 1 })));
    expect(store.puts).toHaveLength(5);
    const projection = await createAgentRunQueries({ db: database }).get(job);
    expect(projection).toMatchObject({ usage: { results: 5 } });
    expect(projection!.results).toHaveLength(5);
  });

  it("v3 runtime malformed adapter output 仍走既有全局失败而不伪造来源健康", async () => {
    const job = await run();
    const source = { sourceId: "greenhouse:malformed", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Malformed", careersUrl: "https://boards.greenhouse.io/malformed", allowedDomains: ["boards-api.greenhouse.io"], boardToken: "malformed" };
    await database.update(agentRuns).set({ adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET, sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources: [source] } }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const malformed = { adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, listSource: async () => ({ ok: true, attemptCount: 0, data: { sourceId: source.sourceId, observedDetailIds: [], candidates: [] } }), getSourceDetail: async () => { throw new Error("UNUSED"); } };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => malformed as any }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any).process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("failed");
    await expect(database.select().from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId))).resolves.toHaveLength(0);
    const detail = await createAgentRunQueries({ db: database }).get(job);
    expect(AgentRunDetailSchema.parse(detail)).toMatchObject({ status: "failed", sourceChecks: [] });
  });

  it("Public v2 detail failure 在 complete scan 后不进入 lifecycle persistence", async () => {
    const job = await run();
    const source = { sourceId: "greenhouse:detail-failure", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Failure", careersUrl: "https://boards.greenhouse.io/detail-failure", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "detail-failure" };
    const postingId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const opportunityId = crypto.randomUUID(); const evidenceId = crypto.randomUUID();
    await database.insert(jobSourcePostings).values({ id: postingId, userId: job.userId, sourceType: "company_careers", sourceIdentifier: "d".repeat(64), sourceId: source.sourceId, sourceIdentity: { sourceId: source.sourceId, detailId: "historical" }, applicationDeadline: null, isOfficial: true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourcePostingVersions).values({ id: versionId, userId: job.userId, sourcePostingId: postingId, version: 1, contentSha256: "e".repeat(64), rawContentSha256: "f".repeat(64), rawObjectReference: { objectKey: "historical.json" }, retrievedAt: now, availability: "open", createdAt: now });
    await database.insert(jobOpportunities).values({ id: opportunityId, userId: job.userId, importId: null, sourcePostingVersionId: versionId, dedupKey: "a".repeat(64), company: "Failure", title: "Historical role", location: null, postedAt: null, deadline: null, description: null, normalizedData: { sourceId: source.sourceId, detailId: "historical" }, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobOpportunitySources).values({ id: evidenceId, userId: job.userId, opportunityId, sourcePostingVersionId: versionId, createdAt: now });
    await database.update(agentRuns).set({ adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION, workflowVersion: GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_JOB_DISCOVERY_RULE_VERSION, outputSchemaVersion: GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET, sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION, watchlistVersion: 1, sources: [source] } }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const adapter: JobDiscoveryAdapter = { search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }), searchBatch: async (input: any) => { await input.beforeList(source.sourceId); return { ok: true, data: { items: [{ sourceId: source.sourceId, detailId: "missing", company: null, title: "AI Engineer", location: null }], scans: [{ sourceId: source.sourceId, observedDetailIds: ["missing"], complete: true }] } }; }, getDetail: async () => ({ ok: false, error: { code: "DETAIL_FAILED", retryable: true } }) };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(adapter), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("retry");
    await expect(database.select({ id: jobSourcePostings.id, availability: jobSourcePostings.availability }).from(jobSourcePostings).where(eq(jobSourcePostings.id, postingId))).resolves.toEqual([{ id: postingId, availability: "open" }]);
    await expect(database.select({ id: jobOpportunities.id, availability: jobOpportunities.availability }).from(jobOpportunities).where(eq(jobOpportunities.id, opportunityId))).resolves.toEqual([{ id: opportunityId, availability: "open" }]);
    await expect(database.select({ id: jobSourcePostingVersions.id }).from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.sourcePostingId, postingId))).resolves.toEqual([{ id: versionId }]);
    await expect(database.select({ id: jobOpportunitySources.id, sourcePostingVersionId: jobOpportunitySources.sourcePostingVersionId }).from(jobOpportunitySources).where(eq(jobOpportunitySources.opportunityId, opportunityId))).resolves.toEqual([{ id: evidenceId, sourcePostingVersionId: versionId }]);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId))).resolves.toHaveLength(0);
  });

  it.each([
    ["首板失败", "failure", "failed", 1, 1],
    ["首板后暂停", "pause", "paused", 1, 1],
    ["预算只够首板", "budget", "budget_exhausted", 1, 1],
  ] as const)("Public v2 %s 时，预算只在实际列表 GET 前扣除", async (_label, mode, expectedOutcome, expectedGets, expectedRequests) => {
    const job = await run();
    const sources = [
      { sourceId: "greenhouse:budget-first", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "First", careersUrl: "https://boards.greenhouse.io/budget-first", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "budget-first" },
      { sourceId: "greenhouse:budget-second", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Second", careersUrl: "https://boards.greenhouse.io/budget-second", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "budget-second" },
    ];
    await database.update(agentRuns).set({
      adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION,
      workflowVersion: GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_JOB_DISCOVERY_RULE_VERSION,
      outputSchemaVersion: GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION,
      budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET,
      sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION, watchlistVersion: 1, sources },
    }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    let gets = 0;
    const adapter: JobDiscoveryAdapter = {
      search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
      searchBatch: async (input: any) => {
        await input.beforeList(sources[0].sourceId);
        gets += 1;
        if (mode === "failure") return { ok: false, error: { code: "FIRST_LIST_FAILED", retryable: false } };
        if (mode === "pause") await database.update(agentRuns).set({ controlState: "pause_requested" }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
        await input.beforeList(sources[1].sourceId);
        gets += 1;
        return { ok: true, data: { items: [], scans: sources.map((source) => ({ sourceId: source.sourceId, observedDetailIds: [], complete: true })) } };
      },
      getDetail: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
    };
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = mode === "budget" ? { check: async (input) => input.checkpointKey.endsWith(":source_search_batch:2")
      ? { kind: "budget_exhausted", budgetDimension: "tool_calls" }
      : durable.check(input) } : durable;

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(adapter), checkpoint: controlled, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe(expectedOutcome);
    expect(gets).toBe(expectedGets);
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ usage: { sourceRequests: expectedRequests, toolCalls: expectedRequests } });
  });

  it("冻结 execution spec 的 model 为 null 时不产生模型调用计费", async () => {
    const job = await run();
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ executionSpec: { model: null }, usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
  });

  it("冻结 adapter 解析失败会按不可重试来源失败终止，而不遗留 running claim", async () => {
    const job = await run();
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("AGENT_RUN_ADAPTER_UNSUPPORTED"); } },
      contentStore: new Store(),
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      id: () => crypto.randomUUID(),
      clock: () => now,
    });

    await expect(processor.process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("failed");
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({
      status: "failed", failureCode: "AGENT_RUN_ADAPTER_FAILED", currentStep: "failed",
    });
  });

  it.each(["cancel_requested", "pause_requested"] as const)("过期 lease 的 %s 先于 attempts/active budget 被处理", async (controlState) => {
    const job = await run();
    const oldToken = crypto.randomUUID();
    await database.update(agentRuns).set({
      status: "running", currentStep: "batch_search", controlState, attemptCount: 3,
      startedAt: new Date(now.getTime() - 30_000), activeDurationMs: 60_000, claimToken: oldToken, claimExpiresAt: new Date(now.getTime() - 1), activeSliceStartedAt: new Date(now.getTime() - 30_000),
    }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const calls = { search: 0, detail: 0 };

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter(calls)), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe(controlState === "cancel_requested" ? "cancelled" : "paused");
    expect(calls).toEqual({ search: 0, detail: 0 });
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({
      status: controlState === "cancel_requested" ? "cancelled" : "paused",
      controlState: "none",
      termination: controlState === "cancel_requested" ? { kind: "cancelled_by_user" } : null,
    });
  });
});
