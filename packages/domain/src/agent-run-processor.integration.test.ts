import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentRunEvents, agentRunJobResults, agentRunUsageEntries, agentRuns, createDatabase, jobAccounts, jobOpportunities, jobOpportunitySources, jobSourcePostings, jobSourcePostingVersions, jobTargetRevisions, jobTargets, migrateDatabase, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createAgentRunCheckpoint, createAgentRunCommands, createAgentRunProcessor, createAgentRunQueries, type AgentRunCheckpoint, type AgentRunQueue, type DiscoveryContentStore, type JobDiscoveryAdapter, type JobDiscoveryAdapterResolver } from "./agent-runs";
import { GREENHOUSE_JOB_DISCOVERY_ADAPTER, GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION, GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, GREENHOUSE_JOB_DISCOVERY_RULE_VERSION, GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION, PUBLIC_JOB_DISCOVERY_BUDGET } from "@job-copilot/contracts/agent-runs";

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
    return { userId, runId: started.runId };
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
