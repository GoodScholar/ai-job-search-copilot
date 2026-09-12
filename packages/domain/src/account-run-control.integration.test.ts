import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, inArray } from "drizzle-orm";
import { accountRunPolicies, agentRunEvents, agentRuns, auditEvents, createDatabase, jobAccounts, jobTargetRevisions, jobTargets, migrateDatabase, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { accountRunAdmissionReason, createAccountRunControl } from "./account-run-control";
import { AccountRunControlError } from "./account-run-control";
import { createAgentRunCommands, type AgentRunQueue } from "./agent-run-control";
import { createReadyRunPreflightEvaluator } from "./testing/run-preflight";

class MemoryQueue implements AgentRunQueue { async enqueue(): Promise<void> {} }
const constraints = { roleFamily: "AI 应用工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } };

describe("账户运行停止控制", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;
  const now = new Date("2026-09-11T00:00:00.000Z");
  beforeAll(async () => { container = await new PostgreSqlContainer("postgres:17-alpine").start(); database = createDatabase(container.getConnectionUri()); await migrateDatabase(database); }, 60_000);
  afterAll(async () => { await database?.$client.end(); await container?.stop(); });
  async function account() { const userId = randomUUID(); await database.insert(jobAccounts).values({ id: userId }); return userId; }
  function controls() { return createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now }); }
  async function activeTarget(userId?: string) { const ownerId = userId ?? await account(); const targetId = randomUUID(); await database.insert(jobTargets).values({ id: targetId, userId: ownerId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now }); await database.insert(jobTargetRevisions).values({ id: randomUUID(), userId: ownerId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now }); return { userId: ownerId, targetId }; }
  const commands = () => createAgentRunCommands({ db: database, queue: new MemoryQueue(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now, runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }) });

  it("以停止和持久化释放截点决定运行准入", () => {
    const control = { stoppedAt: null, controlVersion: 2, scheduleResumeAfter: new Date("2026-09-12T02:00:00Z") };
    expect(accountRunAdmissionReason(control, new Date("2026-09-12T01:00:00Z"))).toBe("ACCOUNT_RUN_SCHEDULE_SKIPPED");
    expect(accountRunAdmissionReason(control, new Date("2026-09-12T02:00:00Z"))).toBe("ACCOUNT_RUN_SCHEDULE_SKIPPED");
    expect(accountRunAdmissionReason(control, new Date("2026-09-12T03:00:00Z"))).toBeNull();
    expect(accountRunAdmissionReason({ ...control, stoppedAt: now })).toBe("ACCOUNT_RUN_STOPPED");
  });

  it("停止、释放与重放保留账户控制版本，读取不物化策略基线", async () => {
    const userId = await account();
    const service = controls();
    expect(await service.get({ userId })).toEqual({ stoppedAt: null, controlVersion: 0, scheduleResumeAfter: null });
    const command = { commandId: randomUUID(), expectedVersion: 0, action: "stop" as const };
    const first = await service.control({ userId, requestId: randomUUID(), command });
    expect(first).toMatchObject({ applied: true, state: { controlVersion: 1, stoppedAt: expect.any(String), scheduleResumeAfter: null } });
    const released = await service.control({ userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 1, action: "release" } });
    expect(released).toMatchObject({ applied: true, state: { controlVersion: 2, stoppedAt: null, scheduleResumeAfter: expect.any(String) } });
    await expect(service.control({ userId, requestId: randomUUID(), command })).resolves.toEqual(first);
    await expect(service.get({ userId })).resolves.toMatchObject({ stoppedAt: null, controlVersion: 2 });
  });

  it("旧版本、同命令不同载荷与相同状态的新命令分别冲突或不变更版本", async () => {
    const userId = await account(); const service = controls();
    const commandId = randomUUID();
    await service.control({ userId, requestId: randomUUID(), command: { commandId, expectedVersion: 0, action: "stop" } });
    await expect(service.control({ userId, requestId: randomUUID(), command: { commandId, expectedVersion: 1, action: "stop" } })).rejects.toMatchObject({ code: "ACCOUNT_RUN_CONTROL_COMMAND_ID_CONFLICT" } satisfies Partial<AccountRunControlError>);
    await expect(service.control({ userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 0, action: "stop" } })).rejects.toMatchObject({ code: "ACCOUNT_RUN_CONTROL_VERSION_CONFLICT" } satisfies Partial<AccountRunControlError>);
    await expect(service.control({ userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 1, action: "release" } })).resolves.toMatchObject({ applied: true, state: { controlVersion: 2 } });
    await expect(service.control({ userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 2, action: "release" } })).resolves.toEqual({ applied: false, state: { stoppedAt: null, controlVersion: 2, scheduleResumeAfter: now.toISOString() } });
    await expect(service.control({ userId, requestId: randomUUID(), command: { commandId, expectedVersion: 0, action: "release" } })).rejects.toMatchObject({ code: "ACCOUNT_RUN_CONTROL_COMMAND_ID_CONFLICT" } satisfies Partial<AccountRunControlError>);
  });

  it("读取默认控制不创建策略基线", async () => {
    const userId = await account();
    await expect(database.select().from(accountRunPolicies).where(eq(accountRunPolicies.userId, userId))).resolves.toEqual([]);
    await expect(controls().get({ userId })).resolves.toEqual({ stoppedAt: null, controlVersion: 0, scheduleResumeAfter: null });
    await expect(database.select().from(accountRunPolicies).where(eq(accountRunPolicies.userId, userId))).resolves.toEqual([]);
  });

  it("账户停止后拒绝新的手动发现运行且不创建运行", async () => {
    const target = await activeTarget();
    await controls().control({ userId: target.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 0, action: "stop" } });
    await expect(commands().start({ userId: target.userId, requestId: randomUUID(), command: { targetId: target.targetId, idempotencyKey: randomUUID() } }))
      .rejects.toMatchObject({ code: "ACCOUNT_RUN_STOPPED" });
    await expect(database.select().from(agentRuns).where(eq(agentRuns.userId, target.userId))).resolves.toEqual([]);
  });

  it("停止只暂停所属 queued/running 运行并保留取消、终态和其他账户，释放不恢复运行", async () => {
    const owner = await activeTarget(); const other = await activeTarget(); const runtime = commands();
    const queued = await runtime.start({ userId: owner.userId, requestId: randomUUID(), command: { targetId: owner.targetId, idempotencyKey: randomUUID() } });
    const paused = await runtime.start({ userId: owner.userId, requestId: randomUUID(), command: { targetId: owner.targetId, idempotencyKey: randomUUID() } });
    const running = await runtime.start({ userId: owner.userId, requestId: randomUUID(), command: { targetId: owner.targetId, idempotencyKey: randomUUID() } });
    const cancelling = await runtime.start({ userId: owner.userId, requestId: randomUUID(), command: { targetId: owner.targetId, idempotencyKey: randomUUID() } });
    const terminal = await runtime.start({ userId: owner.userId, requestId: randomUUID(), command: { targetId: owner.targetId, idempotencyKey: randomUUID() } });
    const foreign = await runtime.start({ userId: other.userId, requestId: randomUUID(), command: { targetId: other.targetId, idempotencyKey: randomUUID() } });
    await runtime.control({ userId: owner.userId, requestId: randomUUID(), runId: paused.runId, command: { commandId: randomUUID(), action: "pause" } });
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", controlState: "none", startedAt: now }).where(eq(agentRuns.id, running.runId));
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", controlState: "cancel_requested", startedAt: now }).where(eq(agentRuns.id, cancelling.runId));
    await database.update(agentRuns).set({ status: "completed", currentStep: "completed", controlState: "none", startedAt: now, completedAt: now, terminationKind: "completed" }).where(eq(agentRuns.id, terminal.runId));
    const pausedBeforeStop = await database.select().from(agentRuns).where(eq(agentRuns.id, paused.runId));
    const service = controls();
    await expect(service.control({ userId: owner.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 0, action: "stop" } })).resolves.toMatchObject({ applied: true, state: { controlVersion: 1 } });
    const rows = await database.select({ id: agentRuns.id, status: agentRuns.status, controlState: agentRuns.controlState }).from(agentRuns).where(and(eq(agentRuns.userId, owner.userId), inArray(agentRuns.id, [queued.runId, paused.runId, running.runId, cancelling.runId, terminal.runId])));
    expect(rows).toEqual(expect.arrayContaining([
      { id: queued.runId, status: "paused", controlState: "none" }, { id: paused.runId, status: "paused", controlState: "none" }, { id: running.runId, status: "running", controlState: "pause_requested" }, { id: cancelling.runId, status: "running", controlState: "cancel_requested" }, { id: terminal.runId, status: "completed", controlState: "none" },
    ]));
    await expect(database.select().from(agentRuns).where(eq(agentRuns.id, paused.runId))).resolves.toEqual(pausedBeforeStop);
    await expect(database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, foreign.runId))).resolves.toEqual([{ status: "queued" }]);
    const beforeRelease = await database.select({ id: agentRuns.id, status: agentRuns.status, controlState: agentRuns.controlState }).from(agentRuns).where(eq(agentRuns.userId, owner.userId));
    await service.control({ userId: owner.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 1, action: "release" } });
    await expect(database.select({ id: agentRuns.id, status: agentRuns.status, controlState: agentRuns.controlState }).from(agentRuns).where(eq(agentRuns.userId, owner.userId))).resolves.toEqual(beforeRelease);
    await expect(database.select({ eventType: agentRunEvents.eventType }).from(agentRunEvents).where(eq(agentRunEvents.userId, owner.userId))).resolves.toEqual(expect.arrayContaining([{ eventType: "run.paused" }, { eventType: "run.pause_requested" }]));
    await expect(database.select().from(auditEvents).where(and(eq(auditEvents.userId, owner.userId), eq(auditEvents.eventType, "account.run_stopped")))).resolves.toHaveLength(1);
  });

  it("释放账户停止不清除 running run 的 pending pause 请求", async () => {
    const target = await activeTarget(); const runtime = commands();
    const started = await runtime.start({ userId: target.userId, requestId: randomUUID(), command: { targetId: target.targetId, idempotencyKey: randomUUID() } });
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", claimToken: randomUUID(), claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now, startedAt: now, attemptCount: 1, controlState: "none" }).where(eq(agentRuns.id, started.runId));
    const service = controls();
    await service.control({ userId: target.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 0, action: "stop" } });
    await expect(database.select({ status: agentRuns.status, controlState: agentRuns.controlState }).from(agentRuns).where(eq(agentRuns.id, started.runId)))
      .resolves.toEqual([{ status: "running", controlState: "pause_requested" }]);
    await service.control({ userId: target.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 1, action: "release" } });
    await expect(database.select({ status: agentRuns.status, controlState: agentRuns.controlState }).from(agentRuns).where(eq(agentRuns.id, started.runId)))
      .resolves.toEqual([{ status: "running", controlState: "pause_requested" }]);
  });

  it("同一账户命令并发仅施加一次，no-op 不重复审计", async () => {
    const userId = await account(); const service = controls(); const command = { commandId: randomUUID(), expectedVersion: 0, action: "stop" as const };
    const results = await Promise.all([service.control({ userId, requestId: randomUUID(), command }), service.control({ userId, requestId: randomUUID(), command })]);
    expect(results[0]).toEqual(results[1]);
    await expect(database.select().from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.eventType, "account.run_stopped")))).resolves.toHaveLength(1);
    await service.control({ userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 1, action: "release" } });
    await service.control({ userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 2, action: "release" } });
    await expect(database.select().from(auditEvents).where(and(eq(auditEvents.userId, userId), eq(auditEvents.eventType, "account.run_stop_released")))).resolves.toHaveLength(1);
  });
});
