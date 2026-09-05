import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentInboxItems, agentRunControlCommands, agentRunEvents, agentRunUsageEntries, agentRuns, auditEvents, createDatabase, jobAccounts, jobProfiles, jobTargetRevisions, jobTargets, migrateDatabase, profileFactRevisions, profileFacts, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { AgentRunControlError, createAgentRunCheckpoint, createAgentRunCommands, type AgentRunQueue } from "./agent-runs";
import { createCompanyWatchlistCommands } from "./company-watchlists";
import { createDeepMatchRunStarter } from "./deep-match-agent-runs";
import { createAccountRunPolicies } from "./account-run-policies";
import { systemAccountRunPolicy } from "@job-copilot/contracts/account-run-policies";
import { createReadyRunPreflightEvaluator } from "./testing/run-preflight";

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
    return createAgentRunCommands({ db: database, queue, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }) });
  }

  async function addGreenhouseWatchlistSource(userId: string, targetId: string): Promise<void> {
    await createCompanyWatchlistCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).addItem({
      userId, targetId, requestId: crypto.randomUUID(),
      command: { expectedVersion: 0, canonicalCompanyName: "Example AI", careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null },
    });
  }

  async function addConfirmedSkills(userId: string, names: string[]) {
    const profileId = crypto.randomUUID();
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 3, createdAt: now, updatedAt: now });
    for (const name of names) {
      const profileFactId = crypto.randomUUID();
      await database.insert(profileFacts).values({ id: profileFactId, userId, profileId, factType: "skill", createdAt: now });
      await database.insert(profileFactRevisions).values({
        id: crypto.randomUUID(), userId, profileFactId, revisionNumber: 1, factType: "skill", factValue: { name },
        state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 3, createdAt: now,
      });
    }
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
      id: () => crypto.randomUUID(), clock: () => now, executionMode: "greenhouse", runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }),
    });
    const manual = await runtimeCommands.start({
      userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() },
    });
    const scheduled = await runtimeCommands.start({
      userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() },
      trigger: { kind: "schedule", occurrenceId: crypto.randomUUID(), scheduledFor: now },
    });

    expect(manual).toMatchObject({ adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2", workflowVersion: "job-discovery-workflow-v3", outputSchemaVersion: "job-discovery-result-v3" });
    expect(scheduled).toMatchObject({ adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2", workflowVersion: "job-discovery-workflow-v3", outputSchemaVersion: "job-discovery-result-v3" });
  });

  it("Greenhouse 手动启动在可信来源额度为零时稳定拒绝", async () => {
    const { userId, targetId } = await activeTarget();
    await addGreenhouseWatchlistSource(userId, targetId);
    const settings = structuredClone(systemAccountRunPolicy().effective);
    settings.discovery.trustedSourceLimit = 0;
    await createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now }).save({ userId, command: { expectedVersion: 0, settings } });
    const runtime = createAgentRunCommands({ db: database, queue: new MemoryQueue(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, executionMode: "greenhouse", runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }) });
    await expect(runtime.start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } })).rejects.toMatchObject({ code: "AGENT_RUN_UNAVAILABLE" });
  });

  it("计划触发在启动事务内复核同次策略窗口，手动运行不受该窗口限制", async () => {
    const { userId, targetId } = await activeTarget();
    const settings = structuredClone(systemAccountRunPolicy().effective);
    settings.backgroundWindow = { start: "19:00", end: "21:00", timeZone: "Asia/Shanghai" };
    await createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now }).save({ userId, command: { expectedVersion: 0, settings } });
    const runtime = commands(new MemoryQueue());
    await expect(runtime.start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() }, trigger: { kind: "schedule", occurrenceId: crypto.randomUUID(), scheduledFor: new Date("2026-08-29T16:00:00.000Z") } })).rejects.toMatchObject({ code: "AGENT_RUN_UNAVAILABLE" });
    await expect(runtime.start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() }, trigger: { kind: "manual" } })).resolves.toMatchObject({ accountPolicyRevisionNumber: 1 });
  });

  it("等待账户锁跨越窗口边界后，以取得锁后的时刻校验计划触发", async () => {
    const { userId, targetId } = await activeTarget();
    const settings = structuredClone(systemAccountRunPolicy().effective);
    settings.backgroundWindow = { start: "19:00", end: "21:00", timeZone: "Asia/Shanghai" };
    await createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now }).save({ userId, command: { expectedVersion: 0, settings } });
    const beforeLock = new Date("2026-08-29T16:00:00.000Z"); // Asia/Shanghai 00:00，窗口外
    const afterLock = new Date("2026-08-29T12:00:00.000Z"); // Asia/Shanghai 20:00，窗口内
    let released = false;
    let release!: () => void;
    let locked!: () => void;
    const releaseLock = new Promise<void>((resolve) => { release = resolve; });
    const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
    const holder = database.$client.begin(async (connection) => {
      await connection.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [userId]);
      locked();
      await releaseLock;
    });
    await lockHeld;
    const runtime = createAgentRunCommands({
      db: database, queue: new MemoryQueue(), auditTrail: createAuditTrail({ db: database, clock: () => released ? afterLock : beforeLock }),
      id: () => crypto.randomUUID(), clock: () => released ? afterLock : beforeLock, runPreflight: createReadyRunPreflightEvaluator({ clock: () => released ? afterLock : beforeLock }),
    });
    const start = runtime.start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() }, trigger: { kind: "schedule", occurrenceId: crypto.randomUUID(), scheduledFor: afterLock } });
    released = true;
    release();
    await holder;
    await expect(start).resolves.toMatchObject({ accountPolicyRevisionNumber: 1 });
  });

  it("策略修订冻结启动范围，重放幂等键保留旧修订而新运行使用新修订", async () => {
    const { userId, targetId } = await activeTarget();
    const watchlists = createCompanyWatchlistCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await watchlists.addItem({ userId, targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, canonicalCompanyName: "First", careersUrl: "https://boards.greenhouse.io/first", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null } });
    await watchlists.addItem({ userId, targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 1, canonicalCompanyName: "Second", careersUrl: "https://boards.greenhouse.io/second", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null } });
    const policies = createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now });
    const firstSettings = structuredClone(systemAccountRunPolicy().effective); firstSettings.discovery.trustedSourceLimit = 1;
    await policies.save({ userId, command: { expectedVersion: 0, settings: firstSettings } });
    const greenhouse = (queue: AgentRunQueue) => createAgentRunCommands({ db: database, queue, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, executionMode: "greenhouse", runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }) });
    const key = crypto.randomUUID();
    const first = await greenhouse(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: key } });
    expect(first).toMatchObject({ accountPolicyRevisionNumber: 1, sourceScope: { sources: [expect.objectContaining({ sourceId: "greenhouse:first" })] } });

    const secondSettings = structuredClone(firstSettings); secondSettings.discovery.trustedSourceLimit = 2;
    await policies.save({ userId, command: { expectedVersion: 1, settings: secondSettings } });
    await expect(greenhouse(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: key } })).resolves.toMatchObject({ runId: first.runId, reused: true, accountPolicyRevisionNumber: 1, budget: first.budget, sourceScope: first.sourceScope });
    const second = await greenhouse(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    expect(second).toMatchObject({ accountPolicyRevisionNumber: 2, sourceScope: { sources: [expect.objectContaining({ sourceId: "greenhouse:first" }), expect.objectContaining({ sourceId: "greenhouse:second" })] } });
  });

  it("分层公开发现冻结三类来源额度，禁用 provider 仍允许受信任来源", async () => {
    const { userId, targetId } = await activeTarget();
    const watchlists = createCompanyWatchlistCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await watchlists.addItem({ userId, targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, canonicalCompanyName: "First", careersUrl: "https://boards.greenhouse.io/first", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null } });
    await watchlists.addItem({ userId, targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 1, canonicalCompanyName: "Second", careersUrl: "https://boards.greenhouse.io/second", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null } });
    await addConfirmedSkills(userId, ["TypeScript"]);
    const settings = structuredClone(systemAccountRunPolicy().effective);
    settings.discovery.trustedSourceLimit = 1;
    settings.discovery.publicQueryLimit = 1;
    settings.discovery.verificationCandidateLimit = 2;
    settings.discovery.enabledProviders = [];
    await createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now }).save({ userId, command: { expectedVersion: 0, settings } });
    const layered = createAgentRunCommands({ db: database, queue: new MemoryQueue(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, executionMode: "layered_public", runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }) });

    await expect(layered.start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } })).resolves.toMatchObject({
      accountPolicyRevisionNumber: 1,
      sourceScope: { trustedSources: [expect.anything()], publicDiscovery: { queries: [], maxVerificationCandidates: 2 } },
    });

    const unavailable = await activeTarget();
    await addConfirmedSkills(unavailable.userId, ["TypeScript"]);
    await createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now }).save({ userId: unavailable.userId, command: { expectedVersion: 0, settings } });
    await expect(layered.start({ userId: unavailable.userId, requestId: crypto.randomUUID(), command: { targetId: unavailable.targetId, idempotencyKey: crypto.randomUUID() } })).rejects.toMatchObject({ code: "AGENT_RUN_UNAVAILABLE" });
  });

  it("v4 手动与计划触发冻结等价的无 Watchlist 分层公开发现规格", async () => {
    const { userId, targetId } = await activeTarget();
    await addConfirmedSkills(userId, ["TypeScript", "React"]);
    const runtimeCommands = createAgentRunCommands({
      db: database, queue: new MemoryQueue(), auditTrail: createAuditTrail({ db: database, clock: () => now }),
      id: () => crypto.randomUUID(), clock: () => now, executionMode: "layered_public", runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }),
    });

    const manual = await runtimeCommands.start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const scheduled = await runtimeCommands.start({
      userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() },
      trigger: { kind: "schedule", occurrenceId: crypto.randomUUID(), scheduledFor: now },
    });

    expect(manual).toMatchObject({ adapter: "layered-public", workflowVersion: "layered-public-job-discovery-v1", outputSchemaVersion: "job-discovery-result-v4" });
    expect(scheduled).toMatchObject({ adapter: "layered-public", workflowVersion: "layered-public-job-discovery-v1", outputSchemaVersion: "job-discovery-result-v4" });
    const runs = await database.select({ id: agentRuns.id, profileSnapshot: agentRuns.profileSnapshot, watchlistSnapshot: agentRuns.watchlistSnapshot, sourceScope: agentRuns.sourceScope })
      .from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.targetId, targetId)));
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run).toMatchObject({
        profileSnapshot: { targetId, version: 3, confirmedActiveSkillNames: ["React", "TypeScript"] },
        watchlistSnapshot: { targetId, version: 0, companies: [] },
        sourceScope: {
          kind: "layered_public",
          trustedSources: [],
          publicDiscovery: { queries: expect.arrayContaining([expect.objectContaining({ kind: "general" }), expect.objectContaining({ kind: "site_constrained" })]) },
        },
      });
    }
    expect((runs[0]!.sourceScope as { publicDiscovery: { queries: unknown[] } }).publicDiscovery.queries).toHaveLength(5);
    expect((runs[1]!.sourceScope as { publicDiscovery: { queries: unknown[] } }).publicDiscovery.queries).toHaveLength(5);
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

  it("手动深度匹配也冻结账户策略修订，并在同一幂等键重放时保留原快照", async () => {
    const { userId, targetId } = await activeTarget();
    const policies = createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now });
    const firstSettings = structuredClone(systemAccountRunPolicy().effective); firstSettings.budgets.deepMatch.maxResults = 1; firstSettings.budgets.deepMatch.maxModelCalls = 1;
    await policies.save({ userId, command: { expectedVersion: 0, settings: firstSettings } });
    const starter = createDeepMatchRunStarter({ db: database, queue: new MemoryQueue(), id: () => crypto.randomUUID(), clock: () => now });
    const key = crypto.randomUUID();
    const first = await starter.start({ userId, targetId, opportunityId: crypto.randomUUID(), idempotencyKey: key, trigger: "manual" });
    await expect(database.select({ revision: agentRuns.accountPolicyRevisionNumber, budget: agentRuns.budgetSnapshot }).from(agentRuns).where(eq(agentRuns.id, first.runId))).resolves.toEqual([{ revision: 1, budget: expect.objectContaining({ maxResults: 1, maxModelCalls: 1 }) }]);
    const secondSettings = structuredClone(firstSettings); secondSettings.budgets.deepMatch.maxResults = 2; secondSettings.budgets.deepMatch.maxModelCalls = 2;
    await policies.save({ userId, command: { expectedVersion: 1, settings: secondSettings } });
    await expect(starter.start({ userId, targetId, opportunityId: crypto.randomUUID(), idempotencyKey: key, trigger: "manual" })).resolves.toEqual({ runId: first.runId, reused: true });
    const second = await starter.start({ userId, targetId, opportunityId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), trigger: "manual" });
    await expect(database.select({ revision: agentRuns.accountPolicyRevisionNumber, budget: agentRuns.budgetSnapshot }).from(agentRuns).where(eq(agentRuns.id, second.runId))).resolves.toEqual([{ revision: 2, budget: expect.objectContaining({ maxResults: 2, maxModelCalls: 2 }) }]);

    const automaticKey = crypto.randomUUID();
    const automatic = await starter.start({ userId, targetId, discoveryRunId: crypto.randomUUID(), idempotencyKey: automaticKey, trigger: "automatic" });
    await expect(database.select({ revision: agentRuns.accountPolicyRevisionNumber, budget: agentRuns.budgetSnapshot }).from(agentRuns).where(eq(agentRuns.id, automatic.runId))).resolves.toEqual([{ revision: 2, budget: expect.objectContaining({ maxResults: 2, maxModelCalls: 2 }) }]);
    const thirdSettings = structuredClone(secondSettings); thirdSettings.budgets.deepMatch.maxResults = 1; thirdSettings.budgets.deepMatch.maxModelCalls = 1;
    await policies.save({ userId, command: { expectedVersion: 2, settings: thirdSettings } });
    await expect(starter.start({ userId, targetId, discoveryRunId: crypto.randomUUID(), idempotencyKey: automaticKey, trigger: "automatic" })).resolves.toEqual({ runId: automatic.runId, reused: true });
    const laterAutomatic = await starter.start({ userId, targetId, discoveryRunId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), trigger: "automatic" });
    await expect(database.select({ revision: agentRuns.accountPolicyRevisionNumber, budget: agentRuns.budgetSnapshot }).from(agentRuns).where(eq(agentRuns.id, laterAutomatic.runId))).resolves.toEqual([{ revision: 3, budget: expect.objectContaining({ maxResults: 1, maxModelCalls: 1 }) }]);
  });

  it("模型调用先原子记入 input，严格输出后才以独立稳定键记入 output", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await createDeepMatchRunStarter({
      db: database,
      queue: new MemoryQueue(),
      id: () => crypto.randomUUID(),
      clock: () => now,
    }).start({
      userId,
      targetId,
      opportunityId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      trigger: "manual",
    });
    const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({
      status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now,
      claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now,
    }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.runId)));

    const inputKey = `${claimToken}:deep_match_model_input:1`;
    await expect(checkpoints(new Date(now.getTime() + 100)).check({
      userId, runId: run.runId, claimToken, checkpointKey: inputKey,
      reserve: { modelCalls: 1, inputTokens: 32, budgetTokens: 80 },
    })).resolves.toEqual({ kind: "continue" });
    await expect(database.select({ category: agentRunUsageEntries.category, amount: agentRunUsageEntries.amount })
      .from(agentRunUsageEntries).where(and(eq(agentRunUsageEntries.runId, run.runId), eq(agentRunUsageEntries.usageKey, inputKey))))
      .resolves.toEqual(expect.arrayContaining([{ category: "model_call", amount: 1 }, { category: "input_tokens", amount: 32 }]));
    await expect(database.select({ input: agentRuns.inputTokenCount, output: agentRuns.outputTokenCount, total: agentRuns.totalTokenCount })
      .from(agentRuns).where(eq(agentRuns.id, run.runId))).resolves.toEqual([{ input: 32, output: 0, total: 32 }]);

    const outputKey = `${claimToken}:deep_match_model_output:1`;
    await expect(checkpoints(new Date(now.getTime() + 200)).check({
      userId, runId: run.runId, claimToken, checkpointKey: outputKey,
      reserve: { outputTokens: 48 },
    })).resolves.toEqual({ kind: "continue" });
    await expect(checkpoints(new Date(now.getTime() + 200)).check({
      userId, runId: run.runId, claimToken, checkpointKey: outputKey,
      reserve: { outputTokens: 48 },
    })).resolves.toEqual({ kind: "continue" });
    await expect(database.select({ category: agentRunUsageEntries.category, amount: agentRunUsageEntries.amount })
      .from(agentRunUsageEntries).where(and(eq(agentRunUsageEntries.runId, run.runId), eq(agentRunUsageEntries.usageKey, outputKey))))
      .resolves.toEqual([{ category: "output_tokens", amount: 48 }]);
    await expect(database.select({ input: agentRuns.inputTokenCount, output: agentRuns.outputTokenCount, total: agentRuns.totalTokenCount })
      .from(agentRuns).where(eq(agentRuns.id, run.runId))).resolves.toEqual([{ input: 32, output: 48, total: 80 }]);
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
