import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentRunControlCommands, agentRunEvents, agentRuns, auditEvents, createDatabase, jobAccounts, jobTargetRevisions, jobTargets, migrateDatabase, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { AgentRunControlError, createAgentRunCommands, type AgentRunQueue } from "./agent-runs";

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

  it("将跨账户运行隐藏为 404，并拒绝 commandId 改变动作", async () => {
    const owner = await activeTarget();
    const other = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId: owner.userId, requestId: crypto.randomUUID(), command: { targetId: owner.targetId, idempotencyKey: crypto.randomUUID() } });
    const commandId = crypto.randomUUID();
    await commands(new MemoryQueue()).control({ userId: owner.userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId, action: "pause" } });

    await expect(commands(new MemoryQueue()).control({ userId: other.userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId: crypto.randomUUID(), action: "cancel" } })).rejects.toMatchObject({ code: "AGENT_RUN_NOT_FOUND" } satisfies Partial<AgentRunControlError>);
    await expect(commands(new MemoryQueue()).control({ userId: owner.userId, requestId: crypto.randomUUID(), runId: run.runId, command: { commandId, action: "cancel" } })).rejects.toMatchObject({ code: "AGENT_RUN_CONTROL_CONFLICT" } satisfies Partial<AgentRunControlError>);
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
});
