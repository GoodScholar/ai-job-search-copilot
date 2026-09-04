import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentInboxItems, agentRunEvents, agentRunJobResults, agentRunSteps, agentRunUsageEntries, agentRuns, auditEvents, createDatabase, jobAccounts, jobOpportunities, jobOpportunitySources, jobSourcePostingVersions, jobSourcePostings, jobTargetRevisions, jobTargets, migrateDatabase, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import { createAgentRunCommands, createAgentRunProcessor as createDomainAgentRunProcessor, createAgentRunQueries, createAgentRunRecoveryQueries, type AgentRunQueue, type DiscoveryContentStore, type JobDiscoveryAdapter, type JobDiscoveryAdapterResolver } from "./agent-runs";
import { createCompanyWatchlistCommands } from "./company-watchlists";
import { createJobTargetCommands } from "./job-targets";

const now = new Date("2026-08-29T12:00:00.000Z");
const constraints = {
  roleFamily: "AI 应用工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [],
  dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
};

class MemoryQueue implements AgentRunQueue {
  readonly jobs: Array<{ version: 1; runId: string; userId: string }> = [];
  fail = false;
  async enqueue(job: { version: 1; runId: string; userId: string }) {
    if (this.fail) throw new Error("queue unavailable");
    this.jobs.push(job);
  }
}

class MemoryStore implements DiscoveryContentStore {
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  async put({ objectKey }: { objectKey: string; bytes: Uint8Array; mediaType: "application/json"; runId: string }) { this.puts.push(objectKey); }
  async delete({ objectKey }: { objectKey: string }) { this.deletes.push(objectKey); }
}

function adapter(result: { retryable?: boolean } = {}): JobDiscoveryAdapter {
  const summary = { sourceId: "fake:aurora-careers", detailId: "opening-1", company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null };
  return {
    search: async () => ({ ok: true, data: summary }),
    searchBatch: async () => result.retryable ? { ok: false, error: { code: "UPSTREAM", retryable: true } } : { ok: true, data: [summary] },
    getDetail: async () => ({ ok: true, data: { ...summary, sourceType: "company_careers", isOfficial: true, rawPayload: { b: 2, a: 1 } } }),
  };
}

type TestProcessorInput = Omit<Parameters<typeof createDomainAgentRunProcessor>[0], "adapterResolver"> & { adapter: JobDiscoveryAdapter };

function createAgentRunProcessor(input: TestProcessorInput) {
  const { adapter: testAdapter, ...deps } = input;
  const adapterResolver: JobDiscoveryAdapterResolver = { resolve: () => testAdapter };
  return createDomainAgentRunProcessor({ ...deps, adapterResolver });
}

function twoSourceAdapter(): JobDiscoveryAdapter {
  const summaries = [
    { sourceId: "fake:aurora-careers", detailId: "opening-1", company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null },
    { sourceId: "fake:orbit-careers", detailId: "opening-2", company: "轨道科技", title: "平台工程师", location: "北京", postedAt: null, deadline: null },
  ];
  return {
    search: async () => ({ ok: true, data: summaries[0]! }),
    searchBatch: async () => ({ ok: true, data: summaries }),
    getDetail: async ({ sourceId, detailId }) => {
      const summary = summaries.find((item) => item.sourceId === sourceId && item.detailId === detailId);
      if (!summary) return { ok: false, error: { code: "NOT_FOUND", retryable: false } };
      return { ok: true, data: { ...summary, sourceType: "company_careers", isOfficial: true, rawPayload: { sourceId, detailId } } };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("agent runs", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);
  afterAll(async () => { await database?.$client.end(); await container?.stop(); });

  async function activeTarget(userId = crypto.randomUUID()) {
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now });
    return { userId, targetId };
  }

  function commands(queue: AgentRunQueue) {
    return createAgentRunCommands({ db: database, queue, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
  }

  function watchlistCommands() {
    return createCompanyWatchlistCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
  }

  it("快照活动目标、原子创建待处理步骤和首个事件，并按账户幂等唤醒队列", async () => {
    const { userId, targetId } = await activeTarget();
    const queue = new MemoryQueue();
    const command = { targetId, idempotencyKey: crypto.randomUUID() };
    const first = await commands(queue).start({ userId, requestId: crypto.randomUUID(), command });
    const duplicate = await commands(queue).start({ userId, requestId: crypto.randomUUID(), command });

    expect(first).toMatchObject({ reused: false, status: "queued", currentStep: "queued", targetId, targetVersion: 1, version: 1 });
    expect(duplicate).toMatchObject({ runId: first.runId, reused: true });
    expect(queue.jobs).toEqual([{ version: 1, runId: first.runId, userId }, { version: 1, runId: first.runId, userId }]);
    await expect(database.select().from(agentRunSteps).where(and(eq(agentRunSteps.userId, userId), eq(agentRunSteps.runId, first.runId)))).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ stepKey: "batch_search", ordinal: 1, status: "pending" }),
      expect.objectContaining({ stepKey: "fetch_details", ordinal: 2, status: "pending" }),
      expect.objectContaining({ stepKey: "persist_results", ordinal: 3, status: "pending" }),
    ]));
    await expect(database.select().from(agentRunEvents).where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, first.runId))))
      .resolves.toEqual([expect.objectContaining({ sequence: 1, runVersion: 1, eventType: "run.queued", data: { eventType: "run.queued", status: "queued", currentStep: "queued", attemptCount: 0 } })]);
    await expect(createAgentRunQueries({ db: database }).eventsAfter({ userId, runId: first.runId, afterSequence: 0 }))
      .resolves.toEqual([expect.objectContaining({ sequence: 1, eventType: "run.queued" })]);
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: first.runId })).resolves.toMatchObject({
      executionSpec: {
        ruleVersion: "fake-job-discovery-rules-v1", toolAllowlist: ["job_discovery.search_batch", "job_discovery.get_detail"], model: null,
      },
      controlState: "none",
      usage: { complete: true, activeDurationMs: 0, attempts: 0, toolCalls: 0, sourceRequests: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, results: 0 },
      termination: null,
    });
  });

  it("拒绝缺失、跨账户或已停用目标，并让队列故障保留可恢复 run", async () => {
    const { userId, targetId } = await activeTarget();
    const { userId: otherUserId } = await activeTarget();
    const queue = new MemoryQueue();
    await expect(commands(queue).start({ userId: otherUserId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } })).rejects.toThrow("AGENT_RUN_TARGET_NOT_FOUND");
    await expect(commands(queue).start({ userId, requestId: crypto.randomUUID(), command: { targetId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() } })).rejects.toThrow("AGENT_RUN_TARGET_NOT_FOUND");
    queue.fail = true;
    const queued = await commands(queue).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: queued.runId })).resolves.toMatchObject({ status: "queued" });
    await database.update(jobTargets).set({ state: "inactive", activeSlot: null }).where(and(eq(jobTargets.userId, userId), eq(jobTargets.id, targetId)));
    await expect(commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } }))
      .rejects.toMatchObject({ code: "AGENT_RUN_TARGET_INACTIVE" });
  });

  it("允许不同账户复用同一幂等键，但各自创建独立 run", async () => {
    const firstTarget = await activeTarget();
    const secondTarget = await activeTarget();
    const idempotencyKey = crypto.randomUUID();
    const queue = new MemoryQueue();
    const [first, second] = await Promise.all([
      commands(queue).start({ userId: firstTarget.userId, requestId: crypto.randomUUID(), command: { targetId: firstTarget.targetId, idempotencyKey } }),
      commands(queue).start({ userId: secondTarget.userId, requestId: crypto.randomUUID(), command: { targetId: secondTarget.targetId, idempotencyKey } }),
    ]);
    expect(first).toMatchObject({ reused: false, targetId: firstTarget.targetId });
    expect(second).toMatchObject({ reused: false, targetId: secondTarget.targetId });
    expect(second.runId).not.toBe(first.runId);
    await expect(database.select().from(agentRuns).where(eq(agentRuns.idempotencyKey, idempotencyKey))).resolves.toHaveLength(2);
  });

  it("启动后修订 target 时保留启动瞬间的版本和快照", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const revisedConstraints = { ...constraints, roleFamily: "平台工程师" };
    await createJobTargetCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .revise({ userId, requestId: crypto.randomUUID(), targetId, command: { expectedVersion: 1, priority: "primary", constraints: revisedConstraints } });
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({
      targetVersion: 1,
      targetSnapshot: { targetId, version: 1, constraints: { roleFamily: "AI 应用工程师" } },
    });
    await expect(database.select({ version: jobTargets.version }).from(jobTargets).where(and(eq(jobTargets.userId, userId), eq(jobTargets.id, targetId))))
      .resolves.toEqual([{ version: 2 }]);
  });

  it("把历史固定来源范围归一为版本 0，供查询、幂等复用和处理恢复使用", async () => {
    const { userId, targetId } = await activeTarget();
    const queue = new MemoryQueue();
    const command = { targetId, idempotencyKey: crypto.randomUUID() };
    const run = await commands(queue).start({ userId, requestId: crypto.randomUUID(), command });
    const legacySourceScope = {
      kind: "company_watchlist",
      adapter: "fake",
      adapterVersion: "fake-job-discovery-v1",
      sources: ["fake:aurora-careers", "fake:orbit-careers"],
    };
    const normalizedSourceScope = { ...legacySourceScope, watchlistVersion: 0 };
    await database.update(agentRuns).set({ sourceScope: legacySourceScope }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));

    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId }))
      .resolves.toMatchObject({ sourceScope: normalizedSourceScope, executionSpec: { sourceScope: normalizedSourceScope } });
    await expect(createAgentRunQueries({ db: database }).latest({ userId }))
      .resolves.toMatchObject({ run: { sourceScope: normalizedSourceScope, executionSpec: { sourceScope: normalizedSourceScope } } });
    await expect(commands(queue).start({ userId, requestId: crypto.randomUUID(), command }))
      .resolves.toMatchObject({ reused: true, sourceScope: normalizedSourceScope });

    const processor = createAgentRunProcessor({ db: database, adapter: adapter(), contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, runId: run.runId, userId, finalAttempt: true })).resolves.toBe("completed");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId }))
      .resolves.toMatchObject({ status: "completed", sourceScope: normalizedSourceScope, executionSpec: { sourceScope: normalizedSourceScope } });
  });

  it("通过版本化 Watchlist 快照来源优先级、禁用状态和不可变运行范围", async () => {
    const { userId, targetId } = await activeTarget();
    const queue = new MemoryQueue();
    const firstItem = await watchlistCommands().addItem({
      userId, targetId, requestId: crypto.randomUUID(),
      command: {
        expectedVersion: 0, canonicalCompanyName: "Alpha", careersUrl: "https://careers.alpha.test/jobs",
        allowedDomains: ["alpha.test"], sourceNote: "仅供用户查看",
      },
    });
    const secondItem = await watchlistCommands().addItem({
      userId, targetId, requestId: crypto.randomUUID(),
      command: {
        expectedVersion: firstItem.version, canonicalCompanyName: "Beta", careersUrl: "https://jobs.beta.test/openings",
        allowedDomains: ["beta.test"], sourceNote: null,
      },
    });
    const reordered = await watchlistCommands().reorder({
      userId, targetId, requestId: crypto.randomUUID(),
      command: { expectedVersion: secondItem.version, orderedItemIds: [secondItem.items[1]!.itemId, secondItem.items[0]!.itemId] },
    });
    expect(reordered.version).toBe(3);
    const firstSourceScope = {
      kind: "company_watchlist" as const,
      adapter: "fake" as const,
      adapterVersion: "fake-job-discovery-v1" as const,
      watchlistVersion: 3,
      sources: ["https://jobs.beta.test/openings", "https://careers.alpha.test/jobs", "fake:aurora-careers", "fake:orbit-careers"],
    };

    const first = await commands(queue).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const [persisted] = await database.select({ sourceScope: agentRuns.sourceScope }).from(agentRuns)
      .where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, first.runId)));
    const projection = await createAgentRunQueries({ db: database }).get({ userId, runId: first.runId });

    expect(first.sourceScope).toEqual(firstSourceScope);
    expect(persisted!.sourceScope).toEqual(firstSourceScope);
    expect(projection).toMatchObject({ sourceScope: firstSourceScope, executionSpec: { sourceScope: firstSourceScope } });

    const disabled = await watchlistCommands().setItemState({
      userId, targetId, requestId: crypto.randomUUID(), itemId: secondItem.items[0]!.itemId,
      command: { expectedVersion: reordered.version, state: "disabled" },
    });
    expect(disabled.version).toBe(4);
    const secondSourceScope = { ...firstSourceScope, watchlistVersion: 4, sources: ["https://jobs.beta.test/openings", "fake:aurora-careers", "fake:orbit-careers"] };
    const second = await commands(queue).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    expect(second.sourceScope).toEqual(secondSourceScope);
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: first.runId }))
      .resolves.toMatchObject({ sourceScope: firstSourceScope, executionSpec: { sourceScope: firstSourceScope } });

    const runCount = (await database.select().from(agentRuns).where(eq(agentRuns.userId, userId))).length;
    const queueCount = queue.jobs.length;
    await database.update(jobTargets).set({ state: "inactive", activeSlot: null }).where(and(eq(jobTargets.userId, userId), eq(jobTargets.id, targetId)));
    await expect(commands(queue).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } }))
      .rejects.toMatchObject({ code: "AGENT_RUN_TARGET_INACTIVE" });
    await expect(database.select().from(agentRuns).where(eq(agentRuns.userId, userId))).resolves.toHaveLength(runCount);
    expect(queue.jobs).toHaveLength(queueCount);
  });

  it("对没有完整账本的历史 run 明确标记 usage 不完整", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await database.update(agentRuns).set({ usageComplete: false, toolCallCount: 3, sourceRequestCount: 3 }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));

    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({
      usage: { complete: false, toolCalls: 3, sourceRequests: 3 },
    });
  });

  it("历史 run 从结果绑定的不可变来源版本还原岗位字段", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const postingId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const opportunityId = crypto.randomUUID();
    await database.insert(jobSourcePostings).values({ id: postingId, userId, sourceType: "company_careers", sourceIdentifier: crypto.randomUUID(), sourceIdentity: { sourceId: "greenhouse:history", detailId: "1" }, isOfficial: true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourcePostingVersions).values({ id: versionId, userId, sourcePostingId: postingId, version: 1, contentSha256: "a".repeat(64), rawContentSha256: "b".repeat(64), rawObjectReference: { objectKey: "history.json" }, normalizedData: { company: "Fictional", title: "AI Engineer", location: "Shanghai", postedAt: "2026-08-01T00:00:00.000Z", deadline: null }, retrievedAt: now, availability: "open", createdAt: now });
    await database.insert(jobOpportunities).values({ id: opportunityId, userId, importId: null, sourcePostingVersionId: versionId, dedupKey: "c".repeat(64), company: "Fictional", title: "AI Engineer", location: "Shanghai", postedAt: new Date("2026-08-01T00:00:00.000Z"), deadline: null, description: null, normalizedData: { title: "AI Engineer" }, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId, opportunityId, sourcePostingVersionId: versionId, createdAt: now });
    await database.insert(agentRunJobResults).values({ id: crypto.randomUUID(), userId, runId: run.runId, opportunityId, sourcePostingVersionId: versionId, ordinal: 1, createdAt: now });
    await database.update(jobOpportunities).set({ title: "Senior AI Engineer", location: "Beijing", postedAt: new Date("2026-08-02T00:00:00.000Z"), updatedAt: new Date("2026-08-02T00:00:00.000Z") }).where(eq(jobOpportunities.id, opportunityId));

    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({
      results: [expect.objectContaining({ company: "Fictional", title: "AI Engineer", location: "Shanghai", postedAt: "2026-08-01T00:00:00.000Z", deadline: null, sourceType: "company_careers", isOfficial: true })],
    });
  });

  it("只暴露当前账户的最新 run 和事件", async () => {
    const { userId, targetId } = await activeTarget();
    const { userId: otherUserId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await expect(createAgentRunQueries({ db: database }).get({ userId: otherUserId, runId: run.runId })).resolves.toBeNull();
    await expect(createAgentRunQueries({ db: database }).eventsAfter({ userId: otherUserId, runId: run.runId, afterSequence: 0 })).resolves.toBeNull();
    await expect(createAgentRunQueries({ db: database }).latest({ userId: otherUserId })).resolves.toEqual({ run: null });
  });

  it("确定性列出排队和过期租约的恢复任务", async () => {
    const { userId, targetId } = await activeTarget();
    const queue = new MemoryQueue();
    const queued = await commands(queue).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const expired = await commands(queue).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", claimToken: crypto.randomUUID(), claimExpiresAt: new Date(now.getTime() - 1), activeSliceStartedAt: now, startedAt: now }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, expired.runId)));
    await expect(createAgentRunRecoveryQueries({ db: database, clock: () => now }).listRecoverable()).resolves.toEqual(expect.arrayContaining([
      { version: 1, runId: queued.runId, userId }, { version: 1, runId: expired.runId, userId },
    ]));
  });

  it("完成 run 以连续事件序列和版本持久化每个工作流转换", async () => {
    const { userId, targetId } = await activeTarget();
    const first = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const store = new MemoryStore();
    const processor = createAgentRunProcessor({ db: database, adapter: adapter(), contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, runId: first.runId, userId, finalAttempt: true })).resolves.toBe("completed");
    await expect(processor.process({ version: 1, runId: first.runId, userId, finalAttempt: true })).resolves.toBe("stale");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: first.runId })).resolves.toMatchObject({
      status: "completed", currentStep: "completed", attemptCount: 1,
      usage: { complete: true, activeDurationMs: 0, toolCalls: 2, sourceRequests: 2, modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, results: 1 },
      termination: { kind: "completed", failureCode: null, budgetDimension: null },
      results: [expect.objectContaining({ ordinal: 1, company: "示例科技" })],
    });
    const events = await database.select({ sequence: agentRunEvents.sequence, runVersion: agentRunEvents.runVersion, eventType: agentRunEvents.eventType })
      .from(agentRunEvents).where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, first.runId))).orderBy(agentRunEvents.sequence);
    expect(events).toEqual([
      { sequence: 1, runVersion: 1, eventType: "run.queued" },
      { sequence: 2, runVersion: 2, eventType: "run.started" },
      { sequence: 3, runVersion: 3, eventType: "run.budget_updated" },
      { sequence: 4, runVersion: 4, eventType: "step.started" },
      { sequence: 5, runVersion: 5, eventType: "run.budget_updated" },
      { sequence: 6, runVersion: 6, eventType: "step.completed" },
      { sequence: 7, runVersion: 7, eventType: "step.started" },
      { sequence: 8, runVersion: 8, eventType: "run.budget_updated" },
      { sequence: 9, runVersion: 9, eventType: "step.completed" },
      { sequence: 10, runVersion: 10, eventType: "step.started" },
      { sequence: 11, runVersion: 11, eventType: "run.budget_updated" },
      { sequence: 12, runVersion: 12, eventType: "step.completed" },
      { sequence: 13, runVersion: 13, eventType: "run.completed" },
    ]);
  });

  it("第二个 run 按来源复用 Aurora 和 Orbit 的版本与机会，并只删除自己的冗余对象", async () => {
    const { userId, targetId } = await activeTarget();
    const first = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const store = new MemoryStore();
    const processor = createAgentRunProcessor({ db: database, adapter: twoSourceAdapter(), contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, runId: first.runId, userId, finalAttempt: true })).resolves.toBe("completed");
    const second = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await expect(processor.process({ version: 1, runId: second.runId, userId, finalAttempt: true })).resolves.toBe("completed");
    const [postings, versions, opportunities, evidence, results] = await Promise.all([
      database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, userId)),
      database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId)),
      database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, userId)),
      database.select().from(jobOpportunitySources).where(eq(jobOpportunitySources.userId, userId)),
      database.select().from(agentRunJobResults).where(eq(agentRunJobResults.userId, userId)),
    ]);
    expect(postings).toHaveLength(2);
    expect(versions).toHaveLength(2);
    expect(opportunities).toEqual(expect.arrayContaining([
      expect.objectContaining({ importId: null, description: null, company: "示例科技", title: "AI 工程师" }),
      expect.objectContaining({ importId: null, description: null, company: "轨道科技", title: "平台工程师" }),
    ]));
    expect(evidence).toHaveLength(2);
    expect(results).toHaveLength(4);
    const sourceIdentities = ["fake:aurora-careers/opening-1", "fake:orbit-careers/opening-2"];
    for (const sourceIdentity of sourceIdentities) {
      const [sourceId, detailId] = sourceIdentity.split("/");
      const posting = postings.find((item) => {
        const identity = item.sourceIdentity as { sourceId: string; detailId: string };
        return identity.sourceId === sourceId && identity.detailId === detailId;
      });
      expect(posting).toBeDefined();
      const version = versions.filter((item) => item.sourcePostingId === posting!.id);
      expect(version).toHaveLength(1);
      const sourceEvidence = evidence.filter((item) => item.sourcePostingVersionId === version[0]!.id);
      expect(sourceEvidence).toHaveLength(1);
      expect(opportunities.filter((item) => item.id === sourceEvidence[0]!.opportunityId)).toHaveLength(1);
    }
    const sourceVersionIds = versions.map((item) => item.id).sort();
    for (const runId of [first.runId, second.runId]) {
      const runResults = results.filter((item) => item.runId === runId);
      expect(runResults).toHaveLength(2);
      expect(runResults.map((item) => item.sourcePostingVersionId).sort()).toEqual(sourceVersionIds);
      expect(runResults.map((item) => item.opportunityId).sort()).toEqual(opportunities.map((item) => item.id).sort());
    }
    const winnerKeys = store.puts.slice(0, 2);
    const redundantKeys = store.puts.slice(2, 4);
    expect(winnerKeys).toHaveLength(2);
    expect(redundantKeys).toHaveLength(2);
    expect(winnerKeys.every((objectKey) => objectKey.includes(`/agent-runs/${first.runId}/`))).toBe(true);
    expect(redundantKeys.every((objectKey) => objectKey.includes(`/agent-runs/${second.runId}/`))).toBe(true);
    expect(versions.map((item) => (item.rawObjectReference as { objectKey: string }).objectKey).sort()).toEqual([...winnerKeys].sort());
    expect(store.deletes).toEqual(redundantKeys);
    expect(winnerKeys.every((objectKey) => !store.deletes.includes(objectKey))).toBe(true);
  });

  it("摘要不变而原始正文变化时追加不可变来源版本并保留新对象", async () => {
    const { userId, targetId } = await activeTarget();
    const store = new MemoryStore();
    const first = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const firstAdapter = adapter();
    await expect(createAgentRunProcessor({ db: database, adapter: firstAdapter, contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, runId: first.runId, userId, finalAttempt: true })).resolves.toBe("completed");

    const second = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const changedRaw = adapter();
    changedRaw.getDetail = async ({ sourceId, detailId }) => ({ ok: true, data: {
      sourceId, detailId, company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null,
      sourceType: "company_careers", isOfficial: true, rawPayload: { b: 2, a: 1, requirements: "新增 Python 与 Kubernetes 要求" },
    } });
    await expect(createAgentRunProcessor({ db: database, adapter: changedRaw, contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, runId: second.runId, userId, finalAttempt: true })).resolves.toBe("completed");

    const versions = await database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId));
    expect(versions).toHaveLength(2);
    const references = versions.map((version) => (version.rawObjectReference as { objectKey: string }).objectKey);
    expect(references).toEqual(expect.arrayContaining([store.puts[0]!, store.puts[1]!]));
    expect(store.deletes).not.toContain(store.puts[1]);
  });

  it("在持久化前去重同一来源身份，并以实际 result 链接数完成", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const duplicate = adapter();
    duplicate.searchBatch = async () => ({ ok: true, data: [
      { sourceId: "fake:aurora-careers", detailId: "opening-1", company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null },
      { sourceId: "fake:aurora-careers", detailId: "opening-1", company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null },
    ] });
    await expect(createAgentRunProcessor({ db: database, adapter: duplicate, contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, runId: run.runId, userId, finalAttempt: true })).resolves.toBe("completed");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({ results: [expect.objectContaining({ ordinal: 1 })], events: expect.arrayContaining([expect.objectContaining({ eventType: "run.completed", data: expect.objectContaining({ resultCount: 1 }) })]) });
  });

  it("达到已持久化的第三次尝试时不创建第四个 claim，而是返回预算终止 outcome", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await database.update(agentRuns).set({ attemptCount: 3 }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    await expect(createAgentRunProcessor({ db: database, adapter: adapter(), contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("budget_exhausted");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({
      attemptCount: 3, status: "failed", failureCode: "AGENT_RUN_BUDGET_EXCEEDED",
      termination: { kind: "budget_exhausted", failureCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "attempts" },
      events: expect.arrayContaining([expect.objectContaining({ eventType: "run.failed", data: expect.objectContaining({ attemptCount: 3, failureCode: "AGENT_RUN_BUDGET_EXCEEDED" }) })]),
    });
  });

  it("不可重试 Adapter 失败原子终止当前 running step，并且不保存原文", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const store = new MemoryStore();
    const nonretryable = adapter();
    nonretryable.searchBatch = async () => ({ ok: false, error: { code: "INVALID_RESPONSE", retryable: false } });
    await expect(createAgentRunProcessor({ db: database, adapter: nonretryable, contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("failed");

    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({
      status: "failed", failureCode: "AGENT_RUN_ADAPTER_FAILED",
      steps: expect.arrayContaining([expect.objectContaining({ stepKey: "batch_search", status: "failed", failureCode: "AGENT_RUN_ADAPTER_FAILED", failedAt: expect.any(String) })]),
    });
    await expect(database.select().from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.runId, run.runId), eq(agentInboxItems.kind, "run_failed")))).resolves.toEqual([
      expect.objectContaining({ status: "unread", reasonCode: "AGENT_RUN_ADAPTER_FAILED", budgetDimension: null }),
    ]);
    await expect(database.select().from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.eventType, "agent.inbox_opened")))).resolves.toHaveLength(1);
    expect(store.puts).toEqual([]);
  });

  it("拒绝 Adapter 的未知字段与详情身份交换，且不保存原文", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const malformed = adapter();
    malformed.searchBatch = async () => ({ ok: true, data: [{ sourceId: "fake:aurora-careers", detailId: "opening-1", company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null, unexpected: true }] } as never);
    const store = new MemoryStore();
    await expect(createAgentRunProcessor({ db: database, adapter: malformed, contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("failed");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({ status: "failed", failureCode: "AGENT_RUN_ADAPTER_FAILED" });
    expect(store.puts).toEqual([]);
  });

  it("健康尝试跨越原始 30 秒租约时由 token 续租，不被恢复扫描接管", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    let instant = now;
    const started = deferred<void>();
    const release = deferred<void>();
    const slow = adapter();
    slow.searchBatch = async () => { started.resolve(); await release.promise; return { ok: true, data: [] }; };
    const processor = createAgentRunProcessor({ db: database, adapter: slow, contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant, heartbeatIntervalMs: 5 });
    const processing = processor.process({ version: 1, runId: run.runId, userId, finalAttempt: true });
    await started.promise;
    instant = new Date(now.getTime() + 31_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const recoverable = await createAgentRunRecoveryQueries({ db: database, clock: () => instant }).listRecoverable();
    expect(recoverable).not.toContainEqual({ version: 1, runId: run.runId, userId });
    await expect(database.select().from(agentRunUsageEntries).where(and(eq(agentRunUsageEntries.userId, userId), eq(agentRunUsageEntries.runId, run.runId), eq(agentRunUsageEntries.category, "active_duration")))).resolves.toHaveLength(1);
    const heartbeatEvents = await database.select({ runVersion: agentRunEvents.runVersion, data: agentRunEvents.data }).from(agentRunEvents)
      .where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, run.runId), eq(agentRunEvents.eventType, "run.budget_updated")));
    expect(heartbeatEvents).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ usage: expect.objectContaining({ activeDurationMs: 31_000, attempts: 1 }) }) })]));
    await expect(database.select({ metadata: auditEvents.metadata }).from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.resourceId, run.runId), eq(auditEvents.eventType, "agent.run_budget_consumed"))))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ metadata: expect.objectContaining({ activeDurationMs: 31_000, attempts: 1, results: 0, tokens: 0 }) })]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(database.select().from(agentRunEvents).where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, run.runId), eq(agentRunEvents.eventType, "run.budget_updated")))).resolves.toHaveLength(3);
    release.resolve();
    await expect(processing).resolves.toBe("completed");
  });

  it("成功领取在外部执行前持久化 attempt 预算事实，重复或陈旧任务不重复记账", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const crashBeforeAdapter = adapter();
    crashBeforeAdapter.searchBatch = async () => { throw new Error("worker crashed before adapter result"); };
    const processor = createAgentRunProcessor({ db: database, adapter: crashBeforeAdapter, contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });

    await expect(processor.process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("failed");
    await expect(processor.process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("failed");
    await expect(database.select({ sequence: agentRunEvents.sequence, runVersion: agentRunEvents.runVersion, data: agentRunEvents.data }).from(agentRunEvents)
      .where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, run.runId), eq(agentRunEvents.eventType, "run.budget_updated"))))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ sequence: 3, runVersion: 3, data: {
        eventType: "run.budget_updated", status: "running", currentStep: "batch_search", attemptCount: 1,
        usage: { activeDurationMs: 0, attempts: 1, toolCalls: 0, sourceRequests: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, results: 0, complete: true },
      } })]));
    await expect(database.select().from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.resourceId, run.runId), eq(auditEvents.eventType, "agent.run_budget_consumed")))).resolves.toHaveLength(2);
  });

  it("陈旧 heartbeat 不追加预算事件或审计", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    let instant = now;
    const started = deferred<void>();
    const release = deferred<void>();
    const slow = adapter();
    slow.searchBatch = async () => { started.resolve(); await release.promise; return { ok: true, data: [] }; };
    const processing = createAgentRunProcessor({ db: database, adapter: slow, contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant, heartbeatIntervalMs: 5 })
      .process({ version: 1, runId: run.runId, userId, finalAttempt: true });
    await started.promise;
    instant = new Date(now.getTime() + 1_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await database.update(agentRuns).set({ claimToken: crypto.randomUUID() }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    const before = await database.select().from(agentRunEvents).where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, run.runId), eq(agentRunEvents.eventType, "run.budget_updated")));
    const auditsBefore = await database.select().from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.resourceId, run.runId), eq(auditEvents.eventType, "agent.run_budget_consumed")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(database.select().from(agentRunEvents).where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, run.runId), eq(agentRunEvents.eventType, "run.budget_updated")))).resolves.toHaveLength(before.length);
    await expect(database.select().from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.resourceId, run.runId), eq(auditEvents.eventType, "agent.run_budget_consumed")))).resolves.toHaveLength(auditsBefore.length);
    release.resolve();
    await expect(processing).resolves.toBe("stale");
  });

  it("claim 在账户锁后重新取时，提交的租约不会使用等待前已过期时间", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    let instant = now;
    const locked = deferred<void>();
    const releaseLock = deferred<void>();
    const blocker = database.transaction(async (transaction) => {
      await acquireAccountAdvisoryLock(transaction, userId);
      locked.resolve();
      await releaseLock.promise;
    });
    await locked.promise;
    const searched = deferred<void>();
    const releaseSearch = deferred<void>();
    const slow = adapter();
    slow.searchBatch = async () => { searched.resolve(); await releaseSearch.promise; return { ok: true, data: [] }; };
    const processor = createAgentRunProcessor({ db: database, adapter: slow, contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant, heartbeatIntervalMs: 5 });
    const processing = processor.process({ version: 1, runId: run.runId, userId, finalAttempt: true });
    instant = new Date(now.getTime() + 31_000);
    releaseLock.resolve();
    await blocker;
    await searched.promise;
    const [claimed] = await database.select({ claimExpiresAt: agentRuns.claimExpiresAt }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    expect(claimed?.claimExpiresAt?.getTime()).toBeGreaterThan(instant.getTime() + 29_000);
    releaseSearch.resolve();
    await expect(processing).resolves.toBe("completed");
  });

  it("慢 heartbeat 续租保持 single-flight，停止只等待独立有界窗口", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const searched = deferred<void>();
    const releaseSearch = deferred<void>();
    const slow = adapter();
    slow.searchBatch = async () => { searched.resolve(); await releaseSearch.promise; return { ok: true, data: [] }; };
    let renewals = 0;
    const pendingRenewal = new Promise<boolean>(() => undefined);
    const processor = createAgentRunProcessor({
      db: database, adapter: slow, contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
      heartbeatIntervalMs: 5, heartbeatStopTimeoutMs: 20,
      heartbeatRenew: async () => { renewals += 1; return pendingRenewal; },
    });
    const processing = processor.process({ version: 1, runId: run.runId, userId, finalAttempt: true });
    await searched.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(renewals).toBe(1);
    releaseSearch.resolve();
    await expect(processing).resolves.toBe("completed");
  }, 1_000);

  it("来源写入部分成功后发生瞬态存储失败时，删除登记的 claim 对象并重新排队", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const twoDetails = adapter();
    twoDetails.searchBatch = async () => ({ ok: true, data: [
      { sourceId: "fake:aurora-careers", detailId: "opening-1", company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null },
      { sourceId: "fake:orbit-careers", detailId: "opening-2", company: "轨道科技", title: "平台工程师", location: "北京", postedAt: null, deadline: null },
    ] });
    twoDetails.getDetail = async ({ sourceId, detailId }) => ({ ok: true, data: { sourceId, detailId, company: sourceId === "fake:aurora-careers" ? "示例科技" : "轨道科技", title: sourceId === "fake:aurora-careers" ? "AI 工程师" : "平台工程师", location: sourceId === "fake:aurora-careers" ? "上海" : "北京", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: { sourceId, detailId } } });
    const store = new MemoryStore();
    store.put = async ({ objectKey }) => {
      store.puts.push(objectKey);
      if (store.puts.length === 2) throw new Error("object store unavailable");
    };
    const processor = createAgentRunProcessor({ db: database, adapter: twoDetails, contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("retry");
    expect(store.puts.every((objectKey) => store.deletes.includes(objectKey))).toBe(true);
    await expect(database.select({ status: agentRuns.status, failureCode: agentRuns.failureCode }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId))))
      .resolves.toEqual([{ status: "queued", failureCode: null }]);
  });

  it("过期接管后旧 claimant 只删除自己的对象，保留 winner 的数据库引用和对象", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const oldPutStarted = deferred<void>();
    const releaseOldPut = deferred<void>();
    const store = new MemoryStore();
    let puts = 0;
    store.put = async ({ objectKey }) => {
      puts += 1;
      store.puts.push(objectKey);
      if (puts === 1) {
        oldPutStarted.resolve();
        await releaseOldPut.promise;
      }
    };
    const processor = createAgentRunProcessor({ db: database, adapter: adapter(), contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    const oldDelivery = processor.process({ version: 1, runId: run.runId, userId, finalAttempt: true });
    await oldPutStarted.promise;
    await expect(processor.process({ version: 1, runId: run.runId, userId, finalAttempt: true })).resolves.toBe("retry");
    await database.update(agentRuns).set({ claimExpiresAt: new Date(now.getTime() - 1) }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    await expect(processor.process({ version: 1, runId: run.runId, userId, finalAttempt: true })).resolves.toBe("completed");
    const winnerKey = store.puts[1]!;
    releaseOldPut.resolve();
    await expect(oldDelivery).resolves.toBe("stale");
    await expect(database.select().from(agentRunJobResults).where(and(eq(agentRunJobResults.userId, userId), eq(agentRunJobResults.runId, run.runId)))).resolves.toHaveLength(1);
    await expect(database.select({ rawObjectReference: jobSourcePostingVersions.rawObjectReference }).from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId)))
      .resolves.toEqual([{ rawObjectReference: { objectKey: winnerKey } }]);
    expect(store.deletes).toContain(store.puts[0]);
    expect(store.deletes).not.toContain(winnerKey);
  });

  it("在端口调用前后按可推进时钟执行 maxDuration 预算", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    let instant = now;
    const slow = adapter();
    slow.searchBatch = async () => {
      instant = new Date(now.getTime() + 60_000);
      return { ok: true, data: [] };
    };
    await expect(createAgentRunProcessor({ db: database, adapter: slow, contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant }).process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("budget_exhausted");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({ status: "failed", failureCode: "AGENT_RUN_BUDGET_EXCEEDED", termination: { kind: "budget_exhausted", failureCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "active_duration" } });
  });

  it("put 超过真实 attempt 定时器后才 settle 时，主流程返回并由 continuation 删除 claim 对象", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    let instant = now;
    const shortDeadlineAdapter = adapter();
    shortDeadlineAdapter.getDetail = async ({ sourceId, detailId }) => ({ ok: true, data: { sourceId, detailId, company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: { b: 2, a: 1 } } });
    const putStarted = deferred<void>();
    const settlePut = deferred<void>();
    const lateDelete = deferred<void>();
    const store = new MemoryStore();
    store.put = ({ objectKey }) => {
      store.puts.push(objectKey);
      instant = new Date(now.getTime() + 59_980);
      putStarted.resolve();
      return settlePut.promise;
    };
    store.delete = async ({ objectKey }) => {
      store.deletes.push(objectKey);
      if (store.deletes.length === 2) lateDelete.resolve();
    };
    const processor = createAgentRunProcessor({
      db: database, adapter: shortDeadlineAdapter, contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant, cleanupTimeoutMs: 20,
    });
    const processing = processor.process({ version: 1, runId: run.runId, userId, finalAttempt: true });
    await putStarted.promise;
    await expect(processing).resolves.toBe("budget_exhausted");
    expect(store.deletes).toEqual([store.puts[0]]);
    settlePut.resolve();
    await lateDelete.promise;
    expect(store.deletes).toEqual([store.puts[0], store.puts[0]]);
  }, 1_000);

  it("cleanup delete 挂起时只等待注入的 cleanup 窗口，且不覆盖主失败状态", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const twoDetails = adapter();
    twoDetails.searchBatch = async () => ({ ok: true, data: [
      { sourceId: "fake:aurora-careers", detailId: "opening-1", company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null },
      { sourceId: "fake:orbit-careers", detailId: "opening-2", company: "轨道科技", title: "平台工程师", location: "北京", postedAt: null, deadline: null },
    ] });
    twoDetails.getDetail = async ({ sourceId, detailId }) => ({ ok: true, data: { sourceId, detailId, company: sourceId === "fake:aurora-careers" ? "示例科技" : "轨道科技", title: sourceId === "fake:aurora-careers" ? "AI 工程师" : "平台工程师", location: sourceId === "fake:aurora-careers" ? "上海" : "北京", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: { sourceId, detailId } } });
    const store = new MemoryStore();
    store.put = async ({ objectKey }) => {
      store.puts.push(objectKey);
      if (store.puts.length === 2) throw new Error("object store unavailable");
    };
    store.delete = async ({ objectKey }) => {
      store.deletes.push(objectKey);
      await new Promise<void>(() => undefined);
    };
    const processor = createAgentRunProcessor({ db: database, adapter: twoDetails, contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, cleanupTimeoutMs: 20 });
    const processing = processor.process({ version: 1, runId: run.runId, userId, finalAttempt: true });
    const result = await Promise.race([
      processing,
      new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 250)),
    ]);
    expect(result).toBe("retry");
    expect(store.puts.every((objectKey) => store.deletes.includes(objectKey))).toBe(true);
    await expect(database.select({ status: agentRuns.status, failureCode: agentRuns.failureCode }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId))))
      .resolves.toEqual([{ status: "queued", failureCode: null }]);
  }, 1_000);

  it("在第三次可重试来源失败后以尝试预算终止且不暴露原始错误", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const retrying = createAgentRunProcessor({ db: database, adapter: adapter({ retryable: true }), contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(retrying.process({ version: 1, runId: run.runId, userId, finalAttempt: true })).resolves.toBe("retry");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({ status: "queued", startedAt: null, failureCode: null, events: expect.arrayContaining([expect.objectContaining({ eventType: "run.retry_scheduled", data: expect.not.objectContaining({ message: expect.anything() }) })]) });
    await expect(database.select().from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.resourceId, run.runId), eq(auditEvents.eventType, "agent.run_retry_scheduled")))).resolves.toHaveLength(1);
    await expect(retrying.process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("retry");
    await expect(retrying.process({ version: 1, runId: run.runId, userId, finalAttempt: true })).resolves.toBe("budget_exhausted");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({
      status: "failed", failureCode: "AGENT_RUN_BUDGET_EXCEEDED",
      termination: { kind: "budget_exhausted", failureCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "attempts" },
      events: expect.arrayContaining([expect.objectContaining({ eventType: "run.failed", data: expect.objectContaining({ attemptCount: 3, failureCode: "AGENT_RUN_BUDGET_EXCEEDED" }) })]),
    });
  });

  it("Processor 的真实 claim 在重试和完成时结算 active slice，且不会遗留 running slice", async () => {
    const { userId, targetId } = await activeTarget();
    const retryRun = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    let instant = now;
    const retrying = adapter({ retryable: true });
    retrying.searchBatch = async () => {
      instant = new Date(instant.getTime() + 25);
      return { ok: false, error: { code: "UPSTREAM", retryable: true } };
    };
    await expect(createAgentRunProcessor({ db: database, adapter: retrying, contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant }).process({ version: 1, runId: retryRun.runId, userId, finalAttempt: false })).resolves.toBe("retry");
    await expect(database.select({ status: agentRuns.status, activeDurationMs: agentRuns.activeDurationMs, activeSliceStartedAt: agentRuns.activeSliceStartedAt }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, retryRun.runId)))).resolves.toEqual([{ status: "queued", activeDurationMs: 25, activeSliceStartedAt: null }]);

    const completedRun = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    instant = now;
    const completing = adapter();
    completing.searchBatch = async () => {
      instant = new Date(instant.getTime() + 25);
      return { ok: true, data: [] };
    };
    await expect(createAgentRunProcessor({ db: database, adapter: completing, contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant }).process({ version: 1, runId: completedRun.runId, userId, finalAttempt: true })).resolves.toBe("completed");
    await expect(database.select({ status: agentRuns.status, activeDurationMs: agentRuns.activeDurationMs, activeSliceStartedAt: agentRuns.activeSliceStartedAt }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, completedRun.runId)))).resolves.toEqual([{ status: "completed", activeDurationMs: 25, activeSliceStartedAt: null }]);
  });

  it("未知异常属于永久失败，不会被 Processor 重新排队", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const broken = adapter();
    broken.searchBatch = async () => { throw new Error("untyped upstream error"); };
    await expect(createAgentRunProcessor({ db: database, adapter: broken, contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("failed");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({ status: "failed", failureCode: "AGENT_RUN_ADAPTER_FAILED" });
  });

  it("接管过期 running claim 时只结算旧 lease 的有效 active slice", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const oldToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", attemptCount: 1, startedAt: now, claimToken: oldToken, claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    const instant = new Date(now.getTime() + 60_000);
    await expect(createAgentRunProcessor({ db: database, adapter: adapter({ retryable: true }), contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant }).process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("retry");
    await expect(database.select({ activeDurationMs: agentRuns.activeDurationMs, status: agentRuns.status }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)))).resolves.toEqual([{ activeDurationMs: 30_000, status: "queued" }]);
    await expect(database.select({ amount: agentRunUsageEntries.amount }).from(agentRunUsageEntries).where(and(eq(agentRunUsageEntries.runId, run.runId), eq(agentRunUsageEntries.usageKey, `${oldToken}:active:${now.toISOString()}`)))).resolves.toEqual([{ amount: 30_000 }]);
  });

  it("接管结算到 active budget 时直接终止，不建立新 claim", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const oldToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", attemptCount: 1, activeDurationMs: 30_000, startedAt: now, claimToken: oldToken, claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    const instant = new Date(now.getTime() + 60_000);
    await expect(createAgentRunProcessor({ db: database, adapter: adapter(), contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant }).process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("budget_exhausted");
    await expect(database.select({ status: agentRuns.status, attemptCount: agentRuns.attemptCount, activeDurationMs: agentRuns.activeDurationMs, terminationBudgetDimension: agentRuns.terminationBudgetDimension }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)))).resolves.toEqual([{ status: "failed", attemptCount: 1, activeDurationMs: 60_000, terminationBudgetDimension: "active_duration" }]);
    await expect(database.select().from(agentRunEvents).where(and(eq(agentRunEvents.runId, run.runId), eq(agentRunEvents.eventType, "run.started")))).resolves.toHaveLength(0);
  });

  it("Processor 的 tool-call 预算终止保留 tool_calls 维度和唯一副作用", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await database.update(agentRuns).set({ budgetSnapshot: { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 0, maxResults: 5, maxModelCalls: 0, maxTokens: 0 } }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    await expect(createAgentRunProcessor({ db: database, adapter: adapter(), contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("budget_exhausted");
    await expect(database.select({ terminationBudgetDimension: agentRuns.terminationBudgetDimension }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)))).resolves.toEqual([{ terminationBudgetDimension: "tool_calls" }]);
    await expect(database.select().from(agentInboxItems).where(and(eq(agentInboxItems.runId, run.runId), eq(agentInboxItems.kind, "budget_exhausted")))).resolves.toHaveLength(1);
    for (const eventType of ["run.failed", "agent.run_budget_exhausted", "agent.inbox_opened"] as const) {
      const rows = eventType === "run.failed" ? await database.select().from(agentRunEvents).where(and(eq(agentRunEvents.runId, run.runId), eq(agentRunEvents.eventType, eventType))) : await database.select().from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.eventType, eventType)));
      expect(rows).toHaveLength(1);
    }
  });
});
