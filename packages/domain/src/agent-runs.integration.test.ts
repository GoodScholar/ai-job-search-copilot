import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentRunEvents, agentRunJobResults, agentRunSteps, agentRuns, createDatabase, jobAccounts, jobOpportunities, jobSourcePostingVersions, jobSourcePostings, jobTargetRevisions, jobTargets, migrateDatabase, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createAgentRunCommands, createAgentRunProcessor, createAgentRunQueries, createAgentRunRecoveryQueries, type AgentRunQueue, type DiscoveryContentStore, type JobDiscoveryAdapter } from "./agent-runs";

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
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", claimToken: crypto.randomUUID(), claimExpiresAt: new Date(now.getTime() - 1), startedAt: now }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, expired.runId)));
    await expect(createAgentRunRecoveryQueries({ db: database, clock: () => now }).listRecoverable()).resolves.toEqual(expect.arrayContaining([
      { version: 1, runId: queued.runId, userId }, { version: 1, runId: expired.runId, userId },
    ]));
  });

  it("以租约互斥处理、原子保存发现结果，并跨 run 复用机会证据", async () => {
    const { userId, targetId } = await activeTarget();
    const first = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const store = new MemoryStore();
    const processor = createAgentRunProcessor({ db: database, adapter: adapter(), contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, runId: first.runId, userId, finalAttempt: true })).resolves.toBe("completed");
    await expect(processor.process({ version: 1, runId: first.runId, userId, finalAttempt: true })).resolves.toBe("stale");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: first.runId })).resolves.toMatchObject({ status: "completed", currentStep: "completed", attemptCount: 1, results: [expect.objectContaining({ ordinal: 1, company: "示例科技" })], events: expect.arrayContaining([expect.objectContaining({ eventType: "run.completed" })]) });
    await expect(database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, userId))).resolves.toHaveLength(1);
    await expect(database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId))).resolves.toHaveLength(1);
    await expect(database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, userId))).resolves.toEqual([expect.objectContaining({ importId: null, description: null })]);
    const second = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await expect(processor.process({ version: 1, runId: second.runId, userId, finalAttempt: true })).resolves.toBe("completed");
    await expect(database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, userId))).resolves.toHaveLength(1);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.userId, userId))).resolves.toHaveLength(2);
    expect(store.puts[0]).toMatch(new RegExp(`^accounts/${userId}/agent-runs/${first.runId}/sources/[0-9a-f]{64}/[0-9a-f-]{36}/[0-9a-f]{64}\\.json$`));
    expect(store.deletes).toHaveLength(1);
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

  it("达到已持久化的第三次尝试时不创建第四个 claim，而是直接失败", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await database.update(agentRuns).set({ attemptCount: 3 }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    await expect(createAgentRunProcessor({ db: database, adapter: adapter(), contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("failed");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({ attemptCount: 3, status: "failed", failureCode: "AGENT_RUN_BUDGET_EXCEEDED", events: expect.arrayContaining([expect.objectContaining({ eventType: "run.failed", data: expect.objectContaining({ attemptCount: 3 }) })]) });
  });

  it("在活动租约期间拒绝第二个 processor，并在过期接管后拒绝旧 token 提交", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const entered = deferred<void>();
    const release = deferred<void>();
    let searches = 0;
    const takeoverAdapter = adapter();
    takeoverAdapter.searchBatch = async () => {
      searches += 1;
      if (searches === 1) { entered.resolve(); await release.promise; }
      return { ok: true, data: [{ sourceId: "fake:aurora-careers", detailId: "opening-1", company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null }] };
    };
    const processor = createAgentRunProcessor({ db: database, adapter: takeoverAdapter, contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    const oldDelivery = processor.process({ version: 1, runId: run.runId, userId, finalAttempt: true });
    await entered.promise;
    await expect(processor.process({ version: 1, runId: run.runId, userId, finalAttempt: true })).resolves.toBe("retry");
    await database.update(agentRuns).set({ claimExpiresAt: new Date(now.getTime() - 1) }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    await expect(processor.process({ version: 1, runId: run.runId, userId, finalAttempt: true })).resolves.toBe("completed");
    release.resolve();
    await expect(oldDelivery).resolves.toBe("stale");
    await expect(database.select().from(agentRunJobResults).where(and(eq(agentRunJobResults.userId, userId), eq(agentRunJobResults.runId, run.runId)))).resolves.toHaveLength(1);
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
    await expect(createAgentRunProcessor({ db: database, adapter: slow, contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant }).process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("failed");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({ status: "failed", failureCode: "AGENT_RUN_BUDGET_EXCEEDED" });
  });

  it("put 在写入后跨过 attempt deadline 时，仍以独立 cleanup deadline 删除本 claim 的对象", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    let instant = now;
    const store = new MemoryStore();
    store.put = async ({ objectKey }) => { store.puts.push(objectKey); instant = new Date(now.getTime() + 60_000); };
    await expect(createAgentRunProcessor({ db: database, adapter: adapter(), contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant, cleanupTimeoutMs: 1 }).process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("failed");
    expect(store.deletes).toEqual(expect.arrayContaining(store.puts));
  });

  it("在可重试失败时重新排队，在最终尝试时终止且不暴露原始错误", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const retrying = createAgentRunProcessor({ db: database, adapter: adapter({ retryable: true }), contentStore: new MemoryStore(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(retrying.process({ version: 1, runId: run.runId, userId, finalAttempt: false })).resolves.toBe("retry");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({ status: "queued", startedAt: null, failureCode: null, events: expect.arrayContaining([expect.objectContaining({ eventType: "run.retry_scheduled", data: expect.not.objectContaining({ message: expect.anything() }) })]) });
    await expect(retrying.process({ version: 1, runId: run.runId, userId, finalAttempt: true })).resolves.toBe("failed");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: run.runId })).resolves.toMatchObject({ status: "failed", failureCode: "AGENT_RUN_ADAPTER_RETRYABLE", events: expect.arrayContaining([expect.objectContaining({ eventType: "run.failed" })]) });
  });
});
