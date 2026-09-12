import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentInboxItems, agentRunControlCommands, agentRunEvents, agentRunSteps, agentRunUsageEntries, agentRuns, auditEvents, companyWatchlistRevisions, companyWatchlists, createDatabase, jobAccounts, jobProfiles, jobTargetRevisions, jobTargets, migrateDatabase, modelDiagnosticResults, profileFactRevisions, profileFacts, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { AgentRunControlError, createAgentRunCheckpoint, createAgentRunCommands, type AgentRunQueue } from "./agent-runs";
import { createCompanyWatchlistCommands } from "./company-watchlists";
import { createDeepMatchRunStarter as createDomainDeepMatchRunStarter } from "./deep-match-agent-runs";
import { createAccountRunPolicies } from "./account-run-policies";
import { systemAccountRunPolicy } from "@job-copilot/contracts/account-run-policies";
import { createReadyRunPreflightEvaluator } from "./testing/run-preflight";
import { RunPreflightRejectedError, createRunPreflightEvaluator } from "./run-preflight";
import { createModelDiagnosticProjectionReader } from "./model-diagnostics";
import { createAccountRunControl } from "./account-run-control";

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

function createDeepMatchRunStarter(deps: Omit<Parameters<typeof createDomainDeepMatchRunStarter>[0], "runPreflight"> & { runPreflight?: Parameters<typeof createDomainDeepMatchRunStarter>[0]["runPreflight"] }) {
  return createDomainDeepMatchRunStarter({ ...deps, runPreflight: deps.runPreflight ?? createReadyRunPreflightEvaluator({ clock: deps.clock }) });
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

  async function realEvaluatorWithFingerprint(clock: () => Date = () => now) {
    const fingerprint = crypto.randomUUID();
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: now });
    return { fingerprint, evaluator: createRunPreflightEvaluator({
      capabilityAdapter: { adapter: "greenhouse", adapterVersion: "test", declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring"] }) },
      modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }), discoveryExecutionMode: "greenhouse", id: () => crypto.randomUUID(), clock,
    }) };
  }

  async function realEvaluator(userId: string) {
    void userId;
    return (await realEvaluatorWithFingerprint()).evaluator;
  }

  function realCommands(queue: AgentRunQueue, runPreflight: Awaited<ReturnType<typeof realEvaluator>>) {
    return createAgentRunCommands({ db: database, queue, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, executionMode: "greenhouse", runPreflight });
  }

  async function addGreenhouseWatchlistSource(userId: string, targetId: string): Promise<void> {
    await createCompanyWatchlistCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).addItem({
      userId, targetId, requestId: crypto.randomUUID(),
      command: { expectedVersion: 0, canonicalCompanyName: "Example AI", careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null },
    });
  }

  async function disableOnlyGreenhouseWatchlistSource(userId: string, targetId: string): Promise<void> {
    const [watchlist] = await database.select({ id: companyWatchlists.id, version: companyWatchlists.version }).from(companyWatchlists).where(and(eq(companyWatchlists.userId, userId), eq(companyWatchlists.targetId, targetId)));
    const [revision] = await database.select({ items: companyWatchlistRevisions.items }).from(companyWatchlistRevisions).where(and(eq(companyWatchlistRevisions.userId, userId), eq(companyWatchlistRevisions.watchlistId, watchlist!.id), eq(companyWatchlistRevisions.version, watchlist!.version)));
    await database.update(companyWatchlists).set({ version: watchlist!.version + 1, updatedAt: now }).where(eq(companyWatchlists.id, watchlist!.id));
    await database.insert(companyWatchlistRevisions).values({
      id: crypto.randomUUID(), userId, watchlistId: watchlist!.id, targetId, version: watchlist!.version + 1,
      items: (revision!.items as Array<Record<string, unknown>>).map((item) => ({ ...item, state: "disabled" })), createdAt: now,
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

  it("ready preflight fixture 将报告中的策略证据与返回策略保持同一修订", async () => {
    const { userId, targetId } = await activeTarget();
    const settings = structuredClone(systemAccountRunPolicy().effective);
    settings.budgets.fake.maxResults = 4;
    await createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now }).save({ userId, command: { expectedVersion: 0, settings } });

    const evaluation = await createReadyRunPreflightEvaluator({ clock: () => now }).evaluate(database, { userId, targetId, workflow: "discovery", trigger: "manual" });
    const evidence = evaluation.report.items.find((item) => item.code === "ACCOUNT_RUN_POLICY_READY")!.evidence;
    expect(evidence).toMatchObject({ kind: "account_run_policy", revisionNumber: evaluation.policy.revisionNumber });
    expect(evaluation.policy.snapshot).toEqual(settings);
  });

  it("真实 preflight 在同一启动事务拒绝 blocked、要求当前 warning 确认，并原子保存 ready 快照", async () => {
    const blocked = await activeTarget();
    await addGreenhouseWatchlistSource(blocked.userId, blocked.targetId);
    const blockedRuntime = realCommands(new MemoryQueue(), await realEvaluator(blocked.userId));
    await expect(blockedRuntime.start({ userId: blocked.userId, requestId: crypto.randomUUID(), command: { targetId: blocked.targetId, idempotencyKey: crypto.randomUUID() } })).rejects.toMatchObject({ code: "RUN_PREFLIGHT_BLOCKED" } satisfies Partial<RunPreflightRejectedError>);
    await expect(database.select().from(agentRuns).where(eq(agentRuns.userId, blocked.userId))).resolves.toHaveLength(0);
    await expect(database.select().from(agentRunSteps).where(eq(agentRunSteps.userId, blocked.userId))).resolves.toHaveLength(0);
    await expect(database.select().from(agentRunEvents).where(eq(agentRunEvents.userId, blocked.userId))).resolves.toHaveLength(0);

    const ready = await activeTarget();
    await addConfirmedSkills(ready.userId, ["TypeScript"]);
    await addGreenhouseWatchlistSource(ready.userId, ready.targetId);
    const evaluator = await realEvaluator(ready.userId);
    const runtime = realCommands(new MemoryQueue(), evaluator);
    const preflight = await evaluator.evaluate(database, { userId: ready.userId, targetId: ready.targetId, workflow: "discovery", trigger: "manual" });
    expect(preflight.report.status).toBe("ready_with_warnings");
    await expect(runtime.start({ userId: ready.userId, requestId: crypto.randomUUID(), command: { targetId: ready.targetId, idempotencyKey: crypto.randomUUID() } })).rejects.toMatchObject({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED", report: preflight.report });
    const idempotencyKey = crypto.randomUUID();
    const created = await runtime.start({ userId: ready.userId, requestId: crypto.randomUUID(), command: { targetId: ready.targetId, idempotencyKey, warningFingerprint: preflight.report.warningFingerprint } });
    const [persisted] = await database.select({ preflightSnapshot: agentRuns.preflightSnapshot, policyRevision: agentRuns.accountPolicyRevisionNumber, policySnapshot: agentRuns.accountPolicySnapshot }).from(agentRuns).where(eq(agentRuns.id, created.runId));
    expect(persisted).toEqual({ preflightSnapshot: preflight.report, policyRevision: preflight.policy.revisionNumber, policySnapshot: preflight.policy.snapshot });
    await database.update(jobTargets).set({ state: "inactive" }).where(eq(jobTargets.id, ready.targetId));
    await expect(runtime.start({ userId: ready.userId, requestId: crypto.randomUUID(), command: { targetId: ready.targetId, idempotencyKey } })).resolves.toMatchObject({ runId: created.runId, reused: true });

    const stale = await activeTarget();
    await addConfirmedSkills(stale.userId, ["TypeScript"]);
    await addGreenhouseWatchlistSource(stale.userId, stale.targetId);
    const staleEvaluator = await realEvaluator(stale.userId);
    const pageReport = await staleEvaluator.evaluate(database, { userId: stale.userId, targetId: stale.targetId, workflow: "discovery", trigger: "manual" });
    await database.update(jobTargets).set({ state: "inactive" }).where(eq(jobTargets.id, stale.targetId));
    await expect(realCommands(new MemoryQueue(), staleEvaluator).start({ userId: stale.userId, requestId: crypto.randomUUID(), command: { targetId: stale.targetId, idempotencyKey: crypto.randomUUID(), warningFingerprint: pageReport.report.warningFingerprint } })).rejects.toMatchObject({ code: "RUN_PREFLIGHT_BLOCKED" } satisfies Partial<RunPreflightRejectedError>);
    await expect(database.select().from(agentRuns).where(eq(agentRuns.userId, stale.userId))).resolves.toHaveLength(0);
  });

  it("页面预读后在启动事务重检五类权威 blocker，且不创建运行副作用", async () => {
    const scenarios = [
      {
        name: "移除最后 active profile fact",
        blockerCode: "PROFILE_EVIDENCE_MISSING",
        mutate: async ({ userId }: { userId: string; targetId: string; fingerprint: string }) => {
          await database.delete(profileFactRevisions).where(eq(profileFactRevisions.userId, userId));
          await database.delete(profileFacts).where(eq(profileFacts.userId, userId));
        },
      },
      {
        name: "停用 requested target",
        blockerCode: "REQUESTED_JOB_TARGET_INACTIVE",
        mutate: async ({ targetId }: { userId: string; targetId: string; fingerprint: string }) => {
          await database.update(jobTargets).set({ state: "inactive" }).where(eq(jobTargets.id, targetId));
        },
      },
      {
        name: "停用唯一 enabled real Greenhouse source",
        blockerCode: "SOURCE_CAPABILITY_UNAVAILABLE",
        mutate: async ({ userId, targetId }: { userId: string; targetId: string; fingerprint: string }) => {
          await disableOnlyGreenhouseWatchlistSource(userId, targetId);
        },
      },
      {
        name: "将当前 deployment fingerprint 的模型诊断改为 failed",
        blockerCode: "MODEL_DIAGNOSTIC_UNAVAILABLE",
        mutate: async ({ fingerprint }: { userId: string; targetId: string; fingerprint: string }) => {
          await database.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: "failed", checks: { authentication: "passed", modelAvailability: "failed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_LOW_COST_MODEL_UNAVAILABLE", latencyBucket: "under_1s", checkedAt: new Date(now.getTime() + 1) });
        },
      },
      {
        name: "将 relevant account policy budget 改为 0",
        blockerCode: "ACCOUNT_RUN_POLICY_BLOCKED",
        mutate: async ({ userId }: { userId: string; targetId: string; fingerprint: string }) => {
          const settings = structuredClone(systemAccountRunPolicy().effective);
          settings.budgets.publicDiscovery.maxResults = 0;
          await createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now }).save({ userId, command: { expectedVersion: 0, settings } });
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const { userId, targetId } = await activeTarget();
      await addConfirmedSkills(userId, ["TypeScript"]);
      await addGreenhouseWatchlistSource(userId, targetId);
      const { evaluator, fingerprint } = await realEvaluatorWithFingerprint();
      const page = await evaluator.evaluate(database, { userId, targetId, workflow: "discovery", trigger: "manual" });
      expect(page.report).toMatchObject({ status: "ready_with_warnings", warningFingerprint: expect.any(String) });

      await scenario.mutate({ userId, targetId, fingerprint });

      await expect(realCommands(new MemoryQueue(), evaluator).start({
        userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID(), warningFingerprint: page.report.warningFingerprint },
      })).rejects.toMatchObject({
        code: "RUN_PREFLIGHT_BLOCKED",
        report: { status: "blocked", items: expect.arrayContaining([expect.objectContaining({ code: scenario.blockerCode, severity: "blocking" })]) },
      });
      await expect(database.select().from(agentRuns).where(eq(agentRuns.userId, userId))).resolves.toHaveLength(0);
      await expect(database.select().from(agentRunSteps).where(eq(agentRunSteps.userId, userId))).resolves.toHaveLength(0);
      await expect(database.select().from(agentRunEvents).where(eq(agentRunEvents.userId, userId))).resolves.toHaveLength(0);
    }
  });

  it("真实 preflight 以账户边界隔离 target、warning fingerprint 和 idempotency key", async () => {
    const owner = await activeTarget();
    await addConfirmedSkills(owner.userId, ["TypeScript"]);
    await addGreenhouseWatchlistSource(owner.userId, owner.targetId);
    const ownerEvaluator = await realEvaluator(owner.userId);
    const ownerReport = await ownerEvaluator.evaluate(database, { userId: owner.userId, targetId: owner.targetId, workflow: "discovery", trigger: "manual" });
    const key = crypto.randomUUID();
    const ownerRun = await realCommands(new MemoryQueue(), ownerEvaluator).start({ userId: owner.userId, requestId: crypto.randomUUID(), command: { targetId: owner.targetId, idempotencyKey: key, warningFingerprint: ownerReport.report.warningFingerprint } });

    const other = await activeTarget();
    await addConfirmedSkills(other.userId, ["TypeScript"]);
    await addGreenhouseWatchlistSource(other.userId, other.targetId);
    const otherEvaluator = await realEvaluator(other.userId);
    const otherRuntime = realCommands(new MemoryQueue(), otherEvaluator);
    await expect(otherRuntime.start({ userId: other.userId, requestId: crypto.randomUUID(), command: { targetId: owner.targetId, idempotencyKey: key, warningFingerprint: ownerReport.report.warningFingerprint } })).rejects.toMatchObject({ code: "RUN_PREFLIGHT_BLOCKED" } satisfies Partial<RunPreflightRejectedError>);
    const otherReport = await otherEvaluator.evaluate(database, { userId: other.userId, targetId: other.targetId, workflow: "discovery", trigger: "manual" });
    await expect(otherRuntime.start({ userId: other.userId, requestId: crypto.randomUUID(), command: { targetId: other.targetId, idempotencyKey: key, warningFingerprint: ownerReport.report.warningFingerprint } })).rejects.toMatchObject({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED", report: otherReport.report } satisfies Partial<RunPreflightRejectedError>);
    const otherRun = await otherRuntime.start({ userId: other.userId, requestId: crypto.randomUUID(), command: { targetId: other.targetId, idempotencyKey: key, warningFingerprint: otherReport.report.warningFingerprint } });
    expect(otherRun.runId).not.toBe(ownerRun.runId);
    await expect(database.select().from(agentRuns).where(eq(agentRuns.idempotencyKey, key))).resolves.toHaveLength(2);
  });

  it("账户锁等待期间以锁后来源状态重算 warning fingerprint", async () => {
    const owner = await activeTarget();
    await addConfirmedSkills(owner.userId, ["TypeScript"]);
    await addGreenhouseWatchlistSource(owner.userId, owner.targetId);
    const beforeLock = now;
    const afterLock = new Date(now.getTime() + 1_000);
    let lockReleased = false;
    const { evaluator } = await realEvaluatorWithFingerprint(() => lockReleased ? afterLock : beforeLock);
    const page = await evaluator.evaluate(database, { userId: owner.userId, targetId: owner.targetId, workflow: "discovery", trigger: "manual" });
    expect(page.report.checkedAt).toBe(beforeLock.toISOString());
    let release!: () => void; let locked!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    const holder = database.$client.begin(async (connection) => {
      await connection.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [owner.userId]);
      locked(); await held;
    });
    await acquired;
    try {
      const start = realCommands(new MemoryQueue(), evaluator).start({ userId: owner.userId, requestId: crypto.randomUUID(), command: { targetId: owner.targetId, idempotencyKey: crypto.randomUUID(), warningFingerprint: page.report.warningFingerprint } });
      const [watchlist] = await database.select({ id: companyWatchlists.id, items: companyWatchlistRevisions.items }).from(companyWatchlists).innerJoin(companyWatchlistRevisions, and(eq(companyWatchlistRevisions.watchlistId, companyWatchlists.id), eq(companyWatchlistRevisions.version, companyWatchlists.version))).where(eq(companyWatchlists.targetId, owner.targetId));
      await database.update(companyWatchlists).set({ version: 2, updatedAt: now }).where(eq(companyWatchlists.id, watchlist!.id));
      await database.insert(companyWatchlistRevisions).values({ id: crypto.randomUUID(), userId: owner.userId, watchlistId: watchlist!.id, targetId: owner.targetId, version: 2, items: [...watchlist!.items as object[], { itemId: crypto.randomUUID(), canonicalCompanyName: "Second", careersUrl: "https://boards.greenhouse.io/second", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null, state: "enabled", position: 2 }], createdAt: now });
      lockReleased = true; release(); await holder;
      const rejection = await start.then(() => null, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(RunPreflightRejectedError);
      const report = (rejection as RunPreflightRejectedError).report;
      expect((rejection as RunPreflightRejectedError).code).toBe("RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED");
      expect(report.targetId).toBe(owner.targetId);
      expect(report.checkedAt).toBe(afterLock.toISOString());
      expect(report.warningFingerprint).not.toBe(page.report.warningFingerprint);
      expect(report.items).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SOURCE_CAPABILITY_READY", evidence: expect.objectContaining({ kind: "source_capability", enabledSourceCount: 2, capableSourceCount: 2, status: "ready", checkedAt: afterLock.toISOString() }) }), expect.objectContaining({ code: "SOURCE_HEALTH_UNCHECKED", evidence: expect.objectContaining({ kind: "source_health", uncheckedSourceCount: 2 }) })]));
      await expect(database.select().from(agentRuns).where(eq(agentRuns.userId, owner.userId))).resolves.toHaveLength(0);
      await expect(database.select().from(agentRunSteps).where(eq(agentRunSteps.userId, owner.userId))).resolves.toHaveLength(0);
      await expect(database.select().from(agentRunEvents).where(eq(agentRunEvents.userId, owner.userId))).resolves.toHaveLength(0);
    } finally { release(); await holder.catch(() => undefined); }
  }, 15_000);

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
    await addConfirmedSkills(userId, ["TypeScript"]);
    await addGreenhouseWatchlistSource(userId, targetId);
    const settings = structuredClone(systemAccountRunPolicy().effective);
    settings.backgroundWindow = { start: "19:00", end: "21:00", timeZone: "Asia/Shanghai" };
    await createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now }).save({ userId, command: { expectedVersion: 0, settings } });
    const preflight = await realEvaluator(userId);
    const runtime = realCommands(new MemoryQueue(), preflight);
    await expect(runtime.start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() }, trigger: { kind: "schedule", occurrenceId: crypto.randomUUID(), scheduledFor: new Date("2026-08-29T16:00:00.000Z") } })).rejects.toMatchObject({ code: "RUN_PREFLIGHT_BLOCKED" });
    const manual = await preflight.evaluate(database, { userId, targetId, workflow: "discovery", trigger: "manual" });
    await expect(runtime.start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID(), warningFingerprint: manual.report.warningFingerprint }, trigger: { kind: "manual" } })).resolves.toMatchObject({ accountPolicyRevisionNumber: 1 });
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

  it("账户停止后拒绝恢复已暂停运行且保留暂停事实", async () => {
    const { userId, targetId } = await activeTarget();
    const queue = new MemoryQueue();
    const started = await commands(queue).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .control({ userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    await expect(commands(queue).control({ userId, requestId: crypto.randomUUID(), runId: started.runId, command: { commandId: crypto.randomUUID(), action: "resume" } }))
      .rejects.toMatchObject({ code: "ACCOUNT_RUN_STOPPED" });
    await expect(database.select({ status: agentRuns.status, controlState: agentRuns.controlState }).from(agentRuns).where(eq(agentRuns.id, started.runId)))
      .resolves.toEqual([{ status: "paused", controlState: "none" }]);
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

  it("账户停止且 run pause 标记丢失时 checkpoint 不新增 reservation", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", attemptCount: 1, startedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now, controlState: "none" }).where(eq(agentRuns.id, run.runId));
    await createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .control({ userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    await database.update(agentRuns).set({ controlState: "none" }).where(eq(agentRuns.id, run.runId));

    await expect(checkpoints(new Date(now.getTime() + 100)).check({ userId, runId: run.runId, claimToken, checkpointKey: `${claimToken}:stopped-reserve`, reserve: { toolCalls: 1, sourceRequests: 1 } })).resolves.toEqual({ kind: "paused" });
    await expect(Promise.all([
      database.select({ status: agentRuns.status, toolCallCount: agentRuns.toolCallCount, sourceRequestCount: agentRuns.sourceRequestCount }).from(agentRuns).where(eq(agentRuns.id, run.runId)),
      database.select({ category: agentRunUsageEntries.category }).from(agentRunUsageEntries).where(eq(agentRunUsageEntries.runId, run.runId)),
    ])).resolves.toEqual([[{ status: "paused", toolCallCount: 0, sourceRequestCount: 0 }], [{ category: "active_duration" }]]);
  });

  it("账户停止且 run pause 标记丢失时 checkpoint 以过期 lease 截止结算后暂停", async () => {
    const { userId, targetId } = await activeTarget();
    const run = await commands(new MemoryQueue()).start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const claimToken = crypto.randomUUID();
    const leaseExpiry = new Date(now.getTime() - 1);
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", attemptCount: 1, startedAt: new Date(now.getTime() - 30_000), claimToken, claimExpiresAt: leaseExpiry, activeSliceStartedAt: new Date(now.getTime() - 30_000), controlState: "none" }).where(eq(agentRuns.id, run.runId));
    await createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .control({ userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    await database.update(agentRuns).set({ controlState: "none" }).where(eq(agentRuns.id, run.runId));

    await expect(checkpoints().check({ userId, runId: run.runId, claimToken, checkpointKey: `${claimToken}:stopped-expired` })).resolves.toEqual({ kind: "paused" });
    await expect(database.select({ status: agentRuns.status, activeDurationMs: agentRuns.activeDurationMs, claimToken: agentRuns.claimToken }).from(agentRuns).where(eq(agentRuns.id, run.runId)))
      .resolves.toEqual([{ status: "paused", activeDurationMs: 29_999, claimToken: null }]);
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
    await expect(starter.start({ userId, targetId, opportunityId: crypto.randomUUID(), idempotencyKey: key, trigger: "manual" })).resolves.toEqual({ kind: "created", runId: first.runId, reused: true });
    const second = await starter.start({ userId, targetId, opportunityId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), trigger: "manual" });
    await expect(database.select({ revision: agentRuns.accountPolicyRevisionNumber, budget: agentRuns.budgetSnapshot }).from(agentRuns).where(eq(agentRuns.id, second.runId))).resolves.toEqual([{ revision: 2, budget: expect.objectContaining({ maxResults: 2, maxModelCalls: 2 }) }]);

    const automaticKey = crypto.randomUUID();
    const automatic = await starter.start({ userId, targetId, discoveryRunId: crypto.randomUUID(), idempotencyKey: automaticKey, trigger: "automatic" });
    await expect(database.select({ revision: agentRuns.accountPolicyRevisionNumber, budget: agentRuns.budgetSnapshot }).from(agentRuns).where(eq(agentRuns.id, automatic.runId))).resolves.toEqual([{ revision: 2, budget: expect.objectContaining({ maxResults: 2, maxModelCalls: 2 }) }]);
    const thirdSettings = structuredClone(secondSettings); thirdSettings.budgets.deepMatch.maxResults = 1; thirdSettings.budgets.deepMatch.maxModelCalls = 1;
    await policies.save({ userId, command: { expectedVersion: 2, settings: thirdSettings } });
    await expect(starter.start({ userId, targetId, discoveryRunId: crypto.randomUUID(), idempotencyKey: automaticKey, trigger: "automatic" })).resolves.toEqual({ kind: "created", runId: automatic.runId, reused: true });
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
