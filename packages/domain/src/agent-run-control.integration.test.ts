import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentInboxItems, agentRunControlCommands, agentRunEvents, agentRunUsageEntries, agentRuns, auditEvents, createDatabase, jobAccounts, jobTargetRevisions, jobTargets, migrateDatabase, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { AgentRunControlError, createAgentRunCheckpoint, createAgentRunCommands, type AgentRunQueue } from "./agent-runs";
import { createCompanyWatchlistCommands } from "./company-watchlists";

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

describe("agent run controls", () => {
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

  async function addGreenhouseWatchlistSource(userId: string, targetId: string): Promise<void> {
    await createCompanyWatchlistCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).addItem({
      userId, targetId, requestId: crypto.randomUUID(),
      command: { expectedVersion: 0, canonicalCompanyName: "Example AI", careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null },
    });
  }

  function checkpoints(at = now) {
    return createAgentRunCheckpoint({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => at }), id: () => crypto.randomUUID(), clock: () => at });
  }

  it("重放同一暂停命令时返回首次快照且只写一次事件、控制记录和审计", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const commandId = crypto.randomUUID();
    const first = await commands(new MemoryQueue()).control({ userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId, action: "pause" } });
    const replay = await commands(new MemoryQueue()).control({ userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId, action: "pause" } });

    expect(first).toEqual({ applied: true, run: { runId: run.runId, status: "paused", currentStep: "queued", controlState: "none", version: 2 } });
    expect(replay).toEqual(first);
    await expect(database.select().from(agentRunControlCommands).where(and(eq(agentRunControlCommands.userId, userId), eq(agentRunControlCommands.runId, run.runId)))).resolves.toHaveLength(1);
    await expect(database.select().from(agentRunEvents).where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, run.runId), eq(agentRunEvents.eventType, "run.paused")))).resolves.toHaveLength(1);
    await expect(database.select().from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.resourceId, run.runId), eq(auditEvents.eventType, "agent.run_paused")))).resolves.toHaveLength(1);
  });

  it("新的 Greenhouse 执行模式让手动与计划运行共享公开执行规格", async () => {
    const { userId, targetId } = await activeTarget();
    await addGreenhouseWatchlistSource(userId, targetId);
    const runtimeCommands = createAgentRunCommands({
      db: database, queue: new MemoryQueue(), auditTrail: createAuditTrail({ db: database, clock: () => now }),
      id: () => crypto.randomUUID(), clock: () => now, executionMode: "greenhouse",
    });
    const manual = await runtimeCommands.start({
      userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() },
    });
    const scheduled = await runtimeCommands.start({
      userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() },
      trigger: { kind: "schedule", occurrenceId: crypto.randomUUID(), scheduledFor: now },
    });

    expect(manual).toMatchObject({ adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v1", workflowVersion: "job-discovery-workflow-v2" });
    expect(scheduled).toMatchObject({ adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v1", workflowVersion: "job-discovery-workflow-v2" });
  });

  it("将跨账户运行隐藏为 404，并将 commandId 改变动作标为幂等键冲突", async () => {
    const owner = await activeTarget();
    const other = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId: owner.userId, requestId: crypto.randomUUID(), command: { targetId: owner.targetId, idempotencyKey: crypto.randomUUID() } });
    const commandId = crypto.randomUUID();
    await commands(new MemoryQueue()).control({ userId: owner.userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId, action: "pause" } });

    await expect(commands(new MemoryQueue()).control({ userId: other.userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId: crypto.randomUUID(), action: "cancel" } })).rejects.toMatchObject({ code: "AGENT_RUN_NOT_FOUND" } satisfies Partial<AgentRunControlError>);
    await expect(commands(new MemoryQueue()).control({ userId: owner.userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId, action: "cancel" } })).rejects.toMatchObject({ code: "AGENT_RUN_COMMAND_ID_CONFLICT" } satisfies Partial<AgentRunControlError>);
  });

  it("让取消覆盖运行中的暂停，并让队列唤醒故障不回滚恢复后的状态", async () => {
    const { userId, targetId } = await activeTarget();
    const queue = new MemoryQueue();
    const run = await commands(queue).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", attemptCount: 1, startedAt: now }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));

    await expect(commands(queue).control({ userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId: crypto.randomUUID(), action: "pause" } })).resolves.toMatchObject({ applied: true, run: { status: "running", controlState: "pause_requested" } });
    await expect(commands(queue).control({ userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId: crypto.randomUUID(), action: "cancel" } })).resolves.toMatchObject({ applied: true, run: { status: "running", controlState: "cancel_requested" } });
    await expect(commands(queue).control({ userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId: crypto.randomUUID(), action: "resume" } })).rejects.toMatchObject({ code: "AGENT_RUN_CONTROL_CONFLICT" } satisfies Partial<AgentRunControlError>);
    await expect(database.select({ eventType: agentRunEvents.eventType }).from(agentRunEvents).where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, run.runId)))).resolves.toEqual(expect.arrayContaining([
      { eventType: "run.pause_requested" }, { eventType: "run.cancel_requested" },
    ]));
    await expect(database.select({ eventType: auditEvents.eventType }).from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.resourceId, run.runId)))).resolves.toEqual(expect.arrayContaining([
      { eventType: "agent.run_pause_requested" }, { eventType: "agent.run_cancel_requested" },
    ]));

    const queued = await commands(queue).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await commands(queue).control({ userId, requestId: crypto.randomUUID(), runId: queued.runId, command: { commandId: crypto.randomUUID(), action: "pause" } });
    queue.fail = true;
    await expect(commands(queue).control({ userId, requestId: crypto.randomUUID(), runId: queued.runId, command: { commandId: crypto.randomUUID(), action: "resume" } })).resolves.toMatchObject({ applied: true, run: { status: "queued", currentStep: "queued", controlState: "none" } });
    await expect(database.select({ status: agentRuns.status, controlState: agentRuns.controlState }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, queued.runId)))).resolves.toEqual([{ status: "queued", controlState: "none" }]);
    await expect(database.select({ eventType: auditEvents.eventType }).from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.resourceId, queued.runId), eq(auditEvents.eventType, "agent.run_resumed")))).resolves.toHaveLength(1);
  });

  it("直接恢复或取消暂停运行时也解决对应 decision Inbox 项", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await commands(new MemoryQueue()).control({ userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId: crypto.randomUUID(), action: "pause" } });
    const [opened] = await database.select({ id: agentInboxItems.id }).from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.runId, run.runId), eq(agentInboxItems.kind, "decision_required")));
    const itemId = opened!.id;
    await commands(new MemoryQueue()).control({ userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId: crypto.randomUUID(), action: "resume" } });
    await expect(database.select({ status: agentInboxItems.status, resolvedAt: agentInboxItems.resolvedAt }).from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.id, itemId)))).resolves.toEqual([{ status: "resolved", resolvedAt: now }]);
    await expect(database.select().from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.resourceId, itemId), eq(auditEvents.eventType, "agent.inbox_resolved")))).resolves.toHaveLength(1);

    const cancelled = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await commands(new MemoryQueue()).control({ userId, requestId: crypto.randomUUID(), runId: cancelled.runId, command: { commandId: crypto.randomUUID(), action: "pause" } });
    const [openedCancel] = await database.select({ id: agentInboxItems.id }).from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.runId, cancelled.runId), eq(agentInboxItems.kind, "decision_required")));
    const cancelItemId = openedCancel!.id;
    await commands(new MemoryQueue()).control({ userId, requestId: crypto.randomUUID(), runId: cancelled.runId, command: { commandId: crypto.randomUUID(), action: "cancel" } });
    await expect(database.select({ status: agentInboxItems.status }).from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.id, cancelItemId)))).resolves.toEqual([{ status: "resolved" }]);
  });

  it("以稳定 checkpoint key 原子预占来源预算，并在耗尽时仅写一次终态、Inbox 与审计", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", attemptCount: 1, startedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));

    const checkpointAt = new Date(now.getTime() + 100);
    const first = await checkpoints(checkpointAt).check({ userId, runId: run.runId, claimToken, checkpointKey: `${claimToken}:source:search:1`, reserve: { toolCalls: 1, sourceRequests: 1 } });
    const replay = await checkpoints(checkpointAt).check({ userId, runId: run.runId, claimToken, checkpointKey: `${claimToken}:source:search:1`, reserve: { toolCalls: 1, sourceRequests: 1 } });
    expect(first).toMatchObject({ kind: "continue" });
    expect(replay).toEqual(first);
    await expect(database.select().from(agentRunUsageEntries).where(and(eq(agentRunUsageEntries.userId, userId), eq(agentRunUsageEntries.runId, run.runId)))).resolves.toHaveLength(3);
    const [checkpointRun] = await database.select({ version: agentRuns.version }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    await expect(database.select({ sequence: agentRunEvents.sequence, runVersion: agentRunEvents.runVersion, data: agentRunEvents.data }).from(agentRunEvents)
      .where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, run.runId), eq(agentRunEvents.eventType, "run.budget_updated"))))
      .resolves.toEqual([expect.objectContaining({ runVersion: checkpointRun!.version, data: {
        eventType: "run.budget_updated", status: "running", currentStep: "batch_search", attemptCount: 1,
        usage: { activeDurationMs: 100, attempts: 1, toolCalls: 1, sourceRequests: 1, modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, results: 0, complete: true },
      } })]);

    for (let ordinal = 2; ordinal <= 10; ordinal += 1) {
      await expect(checkpoints(checkpointAt).check({ userId, runId: run.runId, claimToken, checkpointKey: `${claimToken}:source:search:${ordinal}`, reserve: { toolCalls: 1, sourceRequests: 1 } })).resolves.toMatchObject({ kind: "continue" });
    }
    await expect(checkpoints(checkpointAt).check({ userId, runId: run.runId, claimToken, checkpointKey: `${claimToken}:source:search:11`, reserve: { toolCalls: 1, sourceRequests: 1 } })).resolves.toMatchObject({ kind: "budget_exhausted", budgetDimension: "tool_calls" });
    await expect(checkpoints(checkpointAt).check({ userId, runId: run.runId, claimToken, checkpointKey: `${claimToken}:source:search:12`, reserve: { toolCalls: 1, sourceRequests: 1 } })).resolves.toMatchObject({ kind: "stale" });
    await expect(database.select().from(agentRunEvents).where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, run.runId), eq(agentRunEvents.eventType, "run.failed")))).resolves.toHaveLength(1);
    await expect(database.select().from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.runId, run.runId), eq(agentInboxItems.kind, "budget_exhausted")))).resolves.toHaveLength(1);
    await expect(database.select().from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.resourceId, run.runId), eq(auditEvents.eventType, "agent.run_budget_exhausted")))).resolves.toHaveLength(1);
  });

  it("checkpoint 先处理控制请求与过期 claim，且暂停只开一条安全决策事项", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", attemptCount: 1, startedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now, controlState: "pause_requested" }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    await expect(checkpoints().check({ userId, runId: run.runId, claimToken, checkpointKey: `${claimToken}:pause` })).resolves.toMatchObject({ kind: "paused" });
    await expect(checkpoints().check({ userId, runId: run.runId, claimToken, checkpointKey: `${claimToken}:pause:replay` })).resolves.toMatchObject({ kind: "stale" });
    await expect(database.select().from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.runId, run.runId), eq(agentInboxItems.kind, "decision_required")))).resolves.toHaveLength(1);

    const stale = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const staleToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", attemptCount: 1, startedAt: now, claimToken: staleToken, claimExpiresAt: new Date(now.getTime() - 1), activeSliceStartedAt: now }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, stale.runId)));
    await expect(checkpoints().check({ userId, runId: stale.runId, claimToken: staleToken, checkpointKey: `${staleToken}:stale` })).resolves.toEqual({ kind: "stale" });

    const cancelling = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const cancelToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", attemptCount: 1, startedAt: now, claimToken: cancelToken, claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now, controlState: "cancel_requested" }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, cancelling.runId)));
    await expect(checkpoints().check({ userId, runId: cancelling.runId, claimToken: cancelToken, checkpointKey: `${cancelToken}:cancel` })).resolves.toEqual({ kind: "cancelled" });
    await expect(database.select({ status: agentRuns.status, claimToken: agentRuns.claimToken, activeSliceStartedAt: agentRuns.activeSliceStartedAt }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, cancelling.runId)))).resolves.toEqual([{ status: "cancelled", claimToken: null, activeSliceStartedAt: null }]);
  });

  it("模型零预算在调用前拒绝，且暂停区间不计入 active time", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const firstToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", attemptCount: 1, startedAt: now, claimToken: firstToken, claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now, controlState: "pause_requested" }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    await expect(checkpoints(new Date(now.getTime() + 100)).check({ userId, runId: run.runId, claimToken: firstToken, checkpointKey: `${firstToken}:pause` })).resolves.toEqual({ kind: "paused" });

    const secondToken = crypto.randomUUID();
    const resumedAt = new Date(now.getTime() + 10_000);
    await database.update(agentRuns).set({ status: "running", controlState: "none", claimToken: secondToken, claimExpiresAt: new Date(resumedAt.getTime() + 30_000), activeSliceStartedAt: resumedAt, startedAt: now }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    await expect(checkpoints(new Date(resumedAt.getTime() + 100)).check({ userId, runId: run.runId, claimToken: secondToken, checkpointKey: `${secondToken}:model`, reserve: { modelCalls: 1 } })).resolves.toMatchObject({ kind: "budget_exhausted", budgetDimension: "model_calls" });
    await expect(database.select({ activeDurationMs: agentRuns.activeDurationMs, modelCallCount: agentRuns.modelCallCount }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)))).resolves.toEqual([{ activeDurationMs: 200, modelCallCount: 0 }]);
  });

  it("重复 checkpoint key 仍执行控制，且 reserve 形状必须与首次一致", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", attemptCount: 1, startedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    const key = `${claimToken}:source:search:1`;
    await expect(checkpoints(new Date(now.getTime() + 100)).check({ userId, runId: run.runId, claimToken, checkpointKey: key, reserve: { toolCalls: 1, sourceRequests: 1 } })).resolves.toEqual({ kind: "continue" });
    await expect(checkpoints(new Date(now.getTime() + 100)).check({ userId, runId: run.runId, claimToken, checkpointKey: key, reserve: { toolCalls: 1 } })).rejects.toMatchObject({ code: "AGENT_RUN_CHECKPOINT_CONFLICT" });
    await commands(new MemoryQueue()).control({ userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId: crypto.randomUUID(), action: "pause" } });
    await expect(checkpoints(new Date(now.getTime() + 200)).check({ userId, runId: run.runId, claimToken, checkpointKey: key, reserve: { toolCalls: 1, sourceRequests: 1 } })).resolves.toEqual({ kind: "paused" });
    await expect(database.select().from(agentRunUsageEntries).where(and(eq(agentRunUsageEntries.userId, userId), eq(agentRunUsageEntries.runId, run.runId), eq(agentRunUsageEntries.usageKey, key)))).resolves.toHaveLength(2);
  });

  it("已有 checkpoint 的 reserve 不一致时仍优先执行 cancel control", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", attemptCount: 1, startedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));
    const key = `${claimToken}:source:search:1`;
    await checkpoints(new Date(now.getTime() + 100)).check({ userId, runId: run.runId, claimToken, checkpointKey: key, reserve: { toolCalls: 1, sourceRequests: 1 } });
    await commands(new MemoryQueue()).control({ userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId: crypto.randomUUID(), action: "cancel" } });
    await expect(checkpoints(new Date(now.getTime() + 200)).check({ userId, runId: run.runId, claimToken, checkpointKey: key, reserve: { toolCalls: 1 } })).resolves.toEqual({ kind: "cancelled" });
    await expect(database.select({ status: agentRuns.status }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)))).resolves.toEqual([{ status: "cancelled" }]);
    await expect(database.select().from(agentRunUsageEntries).where(and(eq(agentRunUsageEntries.runId, run.runId), eq(agentRunUsageEntries.usageKey, key)))).resolves.toHaveLength(2);
  });

  it("旧运行在立即取消、checkpoint 取消和预算终止时保留 usageComplete=false", async () => {
    const { userId, targetId } = await activeTarget();
    const commandsForUser = commands(new MemoryQueue());

    const immediate = await commandsForUser.start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await database.update(agentRuns).set({ usageComplete: false }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, immediate.runId)));
    await commandsForUser.control({ userId, requestId: crypto.randomUUID(), runId: immediate.runId, command: { commandId: crypto.randomUUID(), action: "cancel" } });

    const checkpointCancel = await commandsForUser.start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const cancelToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", attemptCount: 1, startedAt: now, claimToken: cancelToken, claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now, controlState: "cancel_requested", usageComplete: false }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, checkpointCancel.runId)));
    await expect(checkpoints().check({ userId, runId: checkpointCancel.runId, claimToken: cancelToken, checkpointKey: `${cancelToken}:cancel` })).resolves.toEqual({ kind: "cancelled" });

    const exhausted = await commandsForUser.start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const budgetToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", attemptCount: 1, startedAt: now, claimToken: budgetToken, claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now, usageComplete: false, budgetSnapshot: { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 0, maxResults: 5, maxModelCalls: 0, maxTokens: 0 } }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, exhausted.runId)));
    await expect(checkpoints().check({ userId, runId: exhausted.runId, claimToken: budgetToken, checkpointKey: `${budgetToken}:budget`, reserve: { toolCalls: 1 } })).resolves.toEqual({ kind: "budget_exhausted", budgetDimension: "tool_calls" });

    await expect(database.select({ id: agentRuns.id, usageComplete: agentRuns.usageComplete }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, immediate.runId)))).resolves.toEqual([{ id: immediate.runId, usageComplete: false }]);
    await expect(database.select({ id: agentRuns.id, usageComplete: agentRuns.usageComplete }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, checkpointCancel.runId)))).resolves.toEqual([{ id: checkpointCancel.runId, usageComplete: false }]);
    await expect(database.select({ id: agentRuns.id, usageComplete: agentRuns.usageComplete }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, exhausted.runId)))).resolves.toEqual([{ id: exhausted.runId, usageComplete: false }]);
  });
});
