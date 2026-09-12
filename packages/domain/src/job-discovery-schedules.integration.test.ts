import { spawn } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, lt, sql } from "drizzle-orm";
import {
  agentRuns,
  accountRunPolicies,
  auditEvents,
  createDatabase,
  jobAccounts,
  jobDiscoveryScheduleOccurrences,
  jobDiscoverySchedules,
  jobProfiles,
  modelDiagnosticResults,
  profileFactRevisions,
  profileFacts,
  jobTargetRevisions,
  jobTargets,
  migrateDatabase,
  type Database,
} from "@job-copilot/database";
import { createAuditTrail, type AuditTrail } from "./audit-trail";
import { createAgentRunCommands, createAgentRunQueries, type AgentRunQueue, type AgentRunStarter } from "./agent-runs";
import { createCompanyWatchlistCommands } from "./company-watchlists";
import { JobDiscoveryScheduleError, createJobDiscoverySchedules } from "./job-discovery-schedules";
import { createAccountRunPolicies } from "./account-run-policies";
import { systemAccountRunPolicy } from "@job-copilot/contracts/account-run-policies";
import { createReadyRunPreflightEvaluator } from "./testing/run-preflight";
import { createRunPreflightEvaluator } from "./run-preflight";
import { createModelDiagnosticProjectionReader } from "./model-diagnostics";
import { createAccountRunControl } from "./account-run-control";

const now = new Date("2026-08-30T01:31:00.000Z");
const constraints = {
  roleFamily: "AI 应用工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [],
  dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
};

class Queue implements AgentRunQueue {
  readonly jobs: Array<{ version: 1; runId: string; userId: string }> = [];
  fail = false;
  async enqueue(job: { version: 1; runId: string; userId: string }) {
    if (this.fail) throw new Error("queue unavailable");
    this.jobs.push(job);
  }
}

async function materializeInDeadlineProcess(databaseUrl: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      import { createDatabase } from "@job-copilot/database";
      import { createAuditTrail } from "./src/audit-trail.ts";
      import { createJobDiscoverySchedules } from "./src/job-discovery-schedules.ts";
      const db = createDatabase(process.env.DEADLINE_DATABASE_URL);
      const clock = () => new Date();
      const service = createJobDiscoverySchedules({
        db,
        runs: { start: async () => { throw new Error("materialize must not start a run"); } },
        auditTrail: createAuditTrail({ db, clock }),
        id: () => crypto.randomUUID(),
        clock,
      });
      await service.materializeDue({ limit: 2, deadline: new Date(Date.now() + 120) });
      await db.$client.end();
    `], { cwd: process.cwd(), env: { ...process.env, DEADLINE_DATABASE_URL: databaseUrl }, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", resolve);
  });
}

describe("job discovery schedules", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);
  afterAll(async () => { await database?.$client.end(); await container?.stop(); });

  async function target(state: "active" | "inactive" = "active", userId = crypto.randomUUID()) {
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state, activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state, constraints, createdAt: now });
    return { userId, targetId };
  }

  function schedules(queue = new Queue(), at = now) {
    const auditTrail = createAuditTrail({ db: database, clock: () => at });
    return {
      queue,
      commands: createAgentRunCommands({ db: database, queue, auditTrail, id: () => crypto.randomUUID(), clock: () => at, executionMode: "greenhouse", runPreflight: createReadyRunPreflightEvaluator({ clock: () => at }) }),
      service: createJobDiscoverySchedules({
        db: database,
        runs: createAgentRunCommands({ db: database, queue, auditTrail, id: () => crypto.randomUUID(), clock: () => at, executionMode: "greenhouse", runPreflight: createReadyRunPreflightEvaluator({ clock: () => at }) }),
        auditTrail,
        id: () => crypto.randomUUID(),
        clock: () => at,
      }),
    };
  }

  async function addConfirmedProfileFact(userId: string) {
    const profileId = crypto.randomUUID(); const factId = crypto.randomUUID();
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
    await database.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
    await database.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "TypeScript" }, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
  }

  async function realPreflight() {
    const configurationFingerprint = crypto.randomUUID();
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: now });
    return createRunPreflightEvaluator({
      capabilityAdapter: { adapter: "greenhouse", adapterVersion: "test", declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring"] }) },
      modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint }), discoveryExecutionMode: "greenhouse", id: () => crypto.randomUUID(), clock: () => now,
    });
  }

  async function addWatchlistSource(input: { userId: string; targetId: string; careersUrl: string; allowedDomains: string[]; expectedVersion?: number; companyName?: string }) {
    await createCompanyWatchlistCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).addItem({
      userId: input.userId, targetId: input.targetId, requestId: crypto.randomUUID(),
      command: { expectedVersion: input.expectedVersion ?? 0, canonicalCompanyName: input.companyName ?? "Example AI", careersUrl: input.careersUrl, allowedDomains: input.allowedDomains, sourceNote: null },
    });
  }

  async function dueOccurrence(input: { userId: string; targetId: string }) {
    const { service } = schedules();
    const schedule = await service.set({ userId: input.userId, targetId: input.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } });
    await database.update(jobDiscoverySchedules).set({ nextRunAt: new Date("2026-08-27T01:30:00.000Z") }).where(eq(jobDiscoverySchedules.id, schedule.scheduleId));
    const [occurrence] = await service.materializeDue({ limit: 10 });
    return occurrence!;
  }

  it("以 CAS 创建、更新和禁用计划，隐藏跨账户计划并在 Asia/Shanghai 计算下一时点", async () => {
    const owner = await target();
    const other = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/owner", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const { service } = schedules();

    const created = await service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } });
    expect(created).toMatchObject({ targetId: owner.targetId, version: 1, state: "enabled", dailyTime: "09:30", timeZone: "Asia/Shanghai", nextRunAt: "2026-08-31T01:30:00.000Z" });
    await expect(service.get({ userId: other.userId, targetId: owner.targetId })).resolves.toBeNull();
    await expect(service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "10:00" } })).rejects.toMatchObject({ code: "JOB_DISCOVERY_SCHEDULE_VERSION_CONFLICT" } satisfies Partial<JobDiscoveryScheduleError>);
    await expect(service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 1, state: "disabled", dailyTime: "10:00" } })).resolves.toMatchObject({ version: 2, state: "disabled", dailyTime: "10:00", nextRunAt: null });

    const inactive = await target("inactive");
    await expect(service.set({ userId: inactive.userId, targetId: inactive.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } })).rejects.toMatchObject({ code: "JOB_DISCOVERY_SCHEDULE_TARGET_INACTIVE" } satisfies Partial<JobDiscoveryScheduleError>);
  });

  it("仅在账户后台窗口内启用每日检查，并支持跨日窗口", async () => {
    const policy = createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now });
    const crossDaySettings = {
      discovery: { trustedSourceLimit: 50, publicQueryLimit: 5, verificationCandidateLimit: 10, enabledProviders: ["anysearch"] as ["anysearch"] },
      budgets: {
        publicDiscovery: { maxActiveDurationMs: 180_000, maxAttempts: 3, maxToolCalls: 60, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
        deepMatch: { maxActiveDurationMs: 180_000, maxAttempts: 3, maxToolCalls: 0, maxResults: 10, maxModelCalls: 10, maxTokens: 20_000 },
        fake: { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
      },
      backgroundWindow: { start: "22:00", end: "02:00", timeZone: "Asia/Shanghai" as const },
    };
    const addExecutableTarget = async (suffix: string) => {
      const owner = await target();
      await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: `https://boards.greenhouse.io/window-${suffix}`, allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
      return owner;
    };
    const set = (owner: { userId: string; targetId: string }, at: Date, dailyTime: string) => schedules(new Queue(), at).service.set({
      userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(),
      command: { expectedVersion: 0, state: "enabled", dailyTime },
    });

    const defaultAllowed = await addExecutableTarget("default-allowed");
    await expect(set(defaultAllowed, new Date("2026-08-30T14:00:00.000Z"), "09:30")).resolves.toMatchObject({ state: "enabled" }); // 夜间保存明日 09:30 仍可配置
    const defaultClosed = await addExecutableTarget("default-closed");
    await expect(set(defaultClosed, new Date("2026-08-30T00:00:00.000Z"), "23:00")).rejects.toMatchObject({ code: "ACCOUNT_RUN_POLICY_WINDOW_CLOSED" }); // 白天不能配置窗口外 23:00

    const crossDayAllowed = await addExecutableTarget("cross-day-allowed");
    await policy.save({ userId: crossDayAllowed.userId, command: { expectedVersion: 0, settings: crossDaySettings } });
    await expect(set(crossDayAllowed, new Date("2026-08-30T04:00:00.000Z"), "23:00")).resolves.toMatchObject({ state: "enabled" }); // 中午保存夜间 23:00 仍可配置
    const crossDayEarlyAllowed = await addExecutableTarget("cross-day-early-allowed");
    await policy.save({ userId: crossDayEarlyAllowed.userId, command: { expectedVersion: 0, settings: crossDaySettings } });
    await expect(set(crossDayEarlyAllowed, new Date("2026-08-30T04:00:00.000Z"), "01:00")).resolves.toMatchObject({ state: "enabled" });
    const crossDayClosed = await addExecutableTarget("cross-day-closed");
    await policy.save({ userId: crossDayClosed.userId, command: { expectedVersion: 0, settings: crossDaySettings } });
    await expect(set(crossDayClosed, new Date("2026-08-30T15:00:00.000Z"), "12:00")).rejects.toMatchObject({ code: "ACCOUNT_RUN_POLICY_WINDOW_CLOSED" }); // 夜间不能配置跨日窗口外 12:00
  });

  it("既有幂等运行优先回填 dispatched，即使当前策略已收紧", async () => {
    const policy = createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now });
    const tightenedSettings = {
      discovery: { trustedSourceLimit: 50, publicQueryLimit: 5, verificationCandidateLimit: 10, enabledProviders: ["anysearch"] as ["anysearch"] },
      budgets: {
        publicDiscovery: { maxActiveDurationMs: 180_000, maxAttempts: 3, maxToolCalls: 60, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
        deepMatch: { maxActiveDurationMs: 180_000, maxAttempts: 3, maxToolCalls: 0, maxResults: 10, maxModelCalls: 10, maxTokens: 20_000 },
        fake: { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
      },
      backgroundWindow: { start: "22:00", end: "02:00", timeZone: "Asia/Shanghai" as const },
    };
    const retryOwner = await target();
    await addWatchlistSource({ userId: retryOwner.userId, targetId: retryOwner.targetId, careersUrl: "https://boards.greenhouse.io/window-retry", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    await addConfirmedProfileFact(retryOwner.userId);
    const queue = new Queue();
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const runPreflight = await realPreflight();
    const runs = createAgentRunCommands({ db: database, queue, auditTrail, id: () => crypto.randomUUID(), clock: () => now, executionMode: "greenhouse", runPreflight });
    const retryService = createJobDiscoverySchedules({ db: database, runs, auditTrail, id: () => crypto.randomUUID(), clock: () => now });
    const retrySchedule = await retryService.set({ userId: retryOwner.userId, targetId: retryOwner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } });
    await database.update(jobDiscoverySchedules).set({ nextRunAt: new Date("2026-08-27T01:30:00.000Z") }).where(eq(jobDiscoverySchedules.id, retrySchedule.scheduleId));
    const [retryOccurrence] = await retryService.materializeDue({ limit: 1 });
    await runs.start({ userId: retryOwner.userId, requestId: crypto.randomUUID(), command: { targetId: retryOwner.targetId, idempotencyKey: retryOccurrence!.occurrenceId }, trigger: { kind: "schedule", occurrenceId: retryOccurrence!.occurrenceId, scheduledFor: new Date(retryOccurrence!.scheduledFor) } });
    const [frozenRun] = await database.select({ id: agentRuns.id, revision: agentRuns.accountPolicyRevisionNumber }).from(agentRuns).where(and(eq(agentRuns.userId, retryOwner.userId), eq(agentRuns.idempotencyKey, retryOccurrence!.occurrenceId)));
    expect(frozenRun).toMatchObject({ revision: 0 });
    await policy.save({ userId: retryOwner.userId, command: { expectedVersion: 0, settings: tightenedSettings } });
    await database.update(jobDiscoveryScheduleOccurrences).set({ status: "pending", runId: null, skipReason: null }).where(eq(jobDiscoveryScheduleOccurrences.id, retryOccurrence!.occurrenceId));
    await retryService.dispatchPending({ limit: 1 });
    await expect(database.select({ status: jobDiscoveryScheduleOccurrences.status, runId: jobDiscoveryScheduleOccurrences.runId }).from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, retryOccurrence!.occurrenceId))).resolves.toEqual([{ status: "dispatched", runId: frozenRun!.id }]);
    await expect(database.select({ revision: agentRuns.accountPolicyRevisionNumber }).from(agentRuns).where(and(eq(agentRuns.userId, retryOwner.userId), eq(agentRuns.idempotencyKey, retryOccurrence!.occurrenceId)))).resolves.toEqual([{ revision: 0 }]);
  });

  it("停机跨越多个时点只物化一个 occurrence，并把下一时点推进到当前之后", async () => {
    const owner = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/catchup", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const occurrence = await dueOccurrence(owner);

    expect(occurrence).toMatchObject({ targetId: owner.targetId, status: "pending", scheduledFor: "2026-08-27T01:30:00.000Z" });
    await expect(database.select({ nextRunAt: jobDiscoverySchedules.nextRunAt }).from(jobDiscoverySchedules).where(and(eq(jobDiscoverySchedules.userId, owner.userId), eq(jobDiscoverySchedules.targetId, owner.targetId)))).resolves.toEqual([{ nextRunAt: new Date("2026-08-31T01:30:00.000Z") }]);
  });

  it("两个 scanner 并发物化同一到期计划时只写一个 occurrence", async () => {
    const owner = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/concurrent", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const { service: first } = schedules();
    const { service: second } = schedules();
    const created = await first.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } });
    await database.update(jobDiscoverySchedules).set({ nextRunAt: new Date("2026-08-27T01:30:00.000Z") }).where(eq(jobDiscoverySchedules.id, created.scheduleId));

    const materialized = await Promise.all([first.materializeDue({ limit: 10 }), second.materializeDue({ limit: 10 })]);
    expect(materialized.flat()).toHaveLength(1);
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.scheduleId, created.scheduleId))).resolves.toHaveLength(1);
  });

  it("物化事务以一个绝对 deadline 覆盖多条慢写入", async () => {
    const owner = await target();
    const at = new Date();
    const { service } = schedules(new Queue(), at);
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/deadline-first", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const first = await service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } });
    const secondTargetId = crypto.randomUUID();
    await database.insert(jobTargets).values({ id: secondTargetId, userId: owner.userId, version: 1, priority: "secondary", state: "active", activeSlot: 1, createdAt: at, updatedAt: at });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId: owner.userId, targetId: secondTargetId, version: 1, priority: "secondary", state: "active", constraints, createdAt: at });
    await addWatchlistSource({ userId: owner.userId, targetId: secondTargetId, careersUrl: "https://boards.greenhouse.io/deadline-second", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const second = await service.set({ userId: owner.userId, targetId: secondTargetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } });
    await database.update(jobDiscoverySchedules).set({ nextRunAt: new Date(at.getTime() - 1_000) }).where(sql`${jobDiscoverySchedules.id} in (${first.scheduleId}, ${second.scheduleId})`);

    await database.execute(sql.raw(`
      create function test_schedule_occurrence_delay() returns trigger language plpgsql as $$
      begin perform pg_sleep(0.08); return new; end;
      $$;
      create trigger test_schedule_occurrence_delay before insert on job_discovery_schedule_occurrences
      for each row execute function test_schedule_occurrence_delay();
    `));
    try {
      expect(await materializeInDeadlineProcess(container.getConnectionUri())).not.toBe(0);
      await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.userId, owner.userId))).resolves.toEqual([]);
    } finally {
      await database.execute(sql.raw("drop trigger if exists test_schedule_occurrence_delay on job_discovery_schedule_occurrences; drop function if exists test_schedule_occurrence_delay();"));
    }
  }, 10_000);

  it("将同一 occurrence 两次派发到同一 public run，队列唤醒失败也保留可恢复运行", async () => {
    const owner = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const occurrence = await dueOccurrence(owner);
    const queue = new Queue();
    queue.fail = true;
    const { service } = schedules(queue);

    await service.dispatchPending({ limit: 10 });
    await service.dispatchPending({ limit: 10 });

    const [persisted] = await database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, occurrence.occurrenceId));
    expect(persisted).toMatchObject({ status: "dispatched", runId: expect.any(String), skipReason: null });
    await expect(database.select().from(agentRuns).where(eq(agentRuns.id, persisted!.runId!))).resolves.toEqual([expect.objectContaining({
      status: "queued", idempotencyKey: occurrence.occurrenceId, adapter: "greenhouse",
      sourceScope: expect.objectContaining({ sources: [expect.objectContaining({ watchlistItemId: expect.any(String), canonicalCompanyName: "Example AI", careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "example" })] }),
    })]);
    await expect(database.select().from(auditEvents).where(eq(auditEvents.userId, owner.userId))).resolves.toSatisfy((events) => !JSON.stringify(events).includes("boards.greenhouse.io"));
  });

  it("无既有运行时，计划派发只以创建事务内当前 preflight blocker 标记 occurrence", async () => {
    const owner = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/preflight-blocked", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const occurrence = await dueOccurrence(owner);
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const runs = createAgentRunCommands({ db: database, queue: new Queue(), auditTrail, id: () => crypto.randomUUID(), clock: () => now, executionMode: "greenhouse", runPreflight: await realPreflight() });
    const service = createJobDiscoverySchedules({ db: database, runs, auditTrail, id: () => crypto.randomUUID(), clock: () => now });

    await service.dispatchPending({ limit: 1 });

    await expect(database.select({ status: jobDiscoveryScheduleOccurrences.status, runId: jobDiscoveryScheduleOccurrences.runId, skipReason: jobDiscoveryScheduleOccurrences.skipReason }).from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, occurrence.occurrenceId))).resolves.toEqual([{ status: "skipped", runId: null, skipReason: "RUN_PREFLIGHT_BLOCKED" }]);
    await expect(database.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.idempotencyKey, occurrence.occurrenceId)))).resolves.toEqual([]);
  });

  it("计划 warning 自动继续，并冻结同一次真实 preflight 的报告与策略", async () => {
    const owner = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/preflight-warning", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    await addConfirmedProfileFact(owner.userId);
    const occurrence = await dueOccurrence(owner);
    const queue = new Queue(); const auditTrail = createAuditTrail({ db: database, clock: () => now }); const runPreflight = await realPreflight();
    const expected = await database.transaction((tx) => runPreflight.evaluate(tx, { userId: owner.userId, targetId: owner.targetId, workflow: "discovery", trigger: "schedule", scheduledFor: new Date(occurrence.scheduledFor) }));
    expect(expected.report.status).toBe("ready_with_warnings");
    const runs = createAgentRunCommands({ db: database, queue, auditTrail, id: () => crypto.randomUUID(), clock: () => now, executionMode: "greenhouse", runPreflight });
    const service = createJobDiscoverySchedules({ db: database, runs, auditTrail, id: () => crypto.randomUUID(), clock: () => now });

    await service.dispatchPending({ limit: 1 });

    const [run] = await database.select({ preflightSnapshot: agentRuns.preflightSnapshot, accountPolicySnapshot: agentRuns.accountPolicySnapshot, accountPolicyRevisionNumber: agentRuns.accountPolicyRevisionNumber }).from(agentRuns).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.idempotencyKey, occurrence.occurrenceId)));
    expect(run).toEqual({ preflightSnapshot: expected.report, accountPolicySnapshot: expected.policy.snapshot, accountPolicyRevisionNumber: expected.policy.revisionNumber });
    expect(run!.preflightSnapshot).toMatchObject({ status: "ready_with_warnings", warningFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("v4 无 Watchlist 的 occurrence 仍派发一个冻结五条 general/site query 的 run，重放不重复创建", async () => {
    const owner = await target();
    await database.insert(jobProfiles).values({ id: crypto.randomUUID(), userId: owner.userId, version: 1, createdAt: now, updatedAt: now });
    const queue = new Queue();
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const runs = createAgentRunCommands({
      db: database,
      queue,
      auditTrail,
      id: () => crypto.randomUUID(),
      clock: () => now,
      executionMode: "layered_public",
      runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }),
    });
    const service = createJobDiscoverySchedules({
      db: database,
      runs,
      auditTrail,
      id: () => crypto.randomUUID(),
      clock: () => now,
      executionMode: "layered_public",
    });

    const schedule = await service.set({
      userId: owner.userId,
      targetId: owner.targetId,
      requestId: crypto.randomUUID(),
      command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" },
    });
    await database.update(jobDiscoverySchedules)
      .set({ nextRunAt: new Date("2026-08-27T01:30:00.000Z") })
      .where(eq(jobDiscoverySchedules.id, schedule.scheduleId));
    const [occurrence] = await service.materializeDue({ limit: 10 });
    await service.dispatchPending({ limit: 10 });
    await service.dispatchPending({ limit: 10 });

    const [persisted] = await database.select().from(jobDiscoveryScheduleOccurrences)
      .where(eq(jobDiscoveryScheduleOccurrences.id, occurrence!.occurrenceId));
    const runsForOccurrence = await database.select().from(agentRuns)
      .where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.idempotencyKey, occurrence!.occurrenceId)));

    expect(persisted).toMatchObject({ status: "dispatched", runId: expect.any(String), skipReason: null });
    expect(runsForOccurrence).toHaveLength(1);
    expect(runsForOccurrence[0]).toMatchObject({
      workflowVersion: "layered-public-job-discovery-v1",
      adapter: "layered-public",
      profileSnapshot: { targetId: owner.targetId },
      watchlistSnapshot: { targetId: owner.targetId, version: 0, companies: [] },
      sourceScope: {
        kind: "layered_public",
        trustedSources: [],
        publicDiscovery: { queries: expect.arrayContaining([
          expect.objectContaining({ kind: "general" }),
          expect.objectContaining({ kind: "site_constrained" }),
        ]) },
      },
    });
    expect((runsForOccurrence[0]!.sourceScope as { publicDiscovery: { queries: unknown[] } }).publicDiscovery.queries)
      .toHaveLength(5);
    expect(queue.jobs).toEqual([{ version: 1, userId: owner.userId, runId: persisted!.runId }]);
  });

  it("v4 无 Watchlist 仍向 UI 报告可启用，而缺失 profile 时拒绝启用并允许补全后重试", async () => {
    const owner = await target();
    const queue = new Queue();
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const service = createJobDiscoverySchedules({
      db: database,
      runs: createAgentRunCommands({ db: database, queue, auditTrail, id: () => crypto.randomUUID(), clock: () => now, executionMode: "layered_public", runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }) }),
      auditTrail, id: () => crypto.randomUUID(), clock: () => now, executionMode: "layered_public",
    });
    await expect(service.get(owner)).resolves.toMatchObject({ sourceSupport: { status: "executable", supportedSourceCount: 0 } });
    await expect(service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } }))
      .rejects.toMatchObject({ code: "PROFILE_UNAVAILABLE" });
    await database.insert(jobProfiles).values({ id: crypto.randomUUID(), userId: owner.userId, version: 1, createdAt: now, updatedAt: now });
    await expect(service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } })).resolves.toMatchObject({ state: "enabled" });
  });

  it("既有分层计划在账户关闭全部来源后稳定跳过 occurrence", async () => {
    const owner = await target();
    await database.insert(jobProfiles).values({ id: crypto.randomUUID(), userId: owner.userId, version: 1, createdAt: now, updatedAt: now });
    const queue = new Queue();
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const service = createJobDiscoverySchedules({
      db: database,
      runs: createAgentRunCommands({ db: database, queue, auditTrail, id: () => crypto.randomUUID(), clock: () => now, executionMode: "layered_public", runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }) }),
      auditTrail, id: () => crypto.randomUUID(), clock: () => now, executionMode: "layered_public",
    });
    const schedule = await service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } });
    await database.update(jobDiscoverySchedules).set({ nextRunAt: new Date("2026-08-27T01:30:00.000Z") }).where(eq(jobDiscoverySchedules.id, schedule.scheduleId));
    const [occurrence] = await service.materializeDue({ limit: 1 });
    const settings = structuredClone(systemAccountRunPolicy().effective);
    settings.discovery = { trustedSourceLimit: 0, publicQueryLimit: 0, verificationCandidateLimit: 0, enabledProviders: [] };
    await createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now }).save({ userId: owner.userId, command: { expectedVersion: 0, settings } });

    await service.dispatchPending({ limit: 1 });
    await expect(database.select({ status: jobDiscoveryScheduleOccurrences.status, skipReason: jobDiscoveryScheduleOccurrences.skipReason, runId: jobDiscoveryScheduleOccurrences.runId }).from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, occurrence!.occurrenceId)))
      .resolves.toEqual([{ status: "skipped", skipReason: "NO_SUPPORTED_SOURCE", runId: null }]);
  });

  it("Greenhouse 计划在可信来源额度收紧为零后跳过，并向 UI 报告不可执行", async () => {
    const owner = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/zero-limit", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/second-limit", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], expectedVersion: 1, companyName: "Second Limit" });
    const { service } = schedules();
    const oneSource = structuredClone(systemAccountRunPolicy().effective);
    oneSource.discovery.trustedSourceLimit = 1;
    const policies = createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now });
    await policies.save({ userId: owner.userId, command: { expectedVersion: 0, settings: oneSource } });
    await expect(service.get(owner)).resolves.toMatchObject({ sourceSupport: { status: "executable", supportedSourceCount: 1 } });
    const schedule = await service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } });
    await database.update(jobDiscoverySchedules).set({ nextRunAt: new Date("2026-08-27T01:30:00.000Z") }).where(eq(jobDiscoverySchedules.id, schedule.scheduleId));
    const [occurrence] = await service.materializeDue({ limit: 1 });
    const settings = structuredClone(oneSource);
    settings.discovery.trustedSourceLimit = 0;
    await policies.save({ userId: owner.userId, command: { expectedVersion: 1, settings } });

    await service.dispatchPending({ limit: 1 });
    await expect(database.select({ status: jobDiscoveryScheduleOccurrences.status, skipReason: jobDiscoveryScheduleOccurrences.skipReason }).from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, occurrence!.occurrenceId)))
      .resolves.toEqual([{ status: "skipped", skipReason: "NO_SUPPORTED_SOURCE" }]);
    await expect(service.get(owner)).resolves.toMatchObject({ sourceSupport: { status: "unsupported" } });
  });

  it("派发状态与绑定事务中的审计写入在审计失败时一起回滚", async () => {
    const owner = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/audit-rollback", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const occurrence = await dueOccurrence(owner);
    const realAuditTrail = createAuditTrail({ db: database, clock: () => now });
    const auditTrail: AuditTrail = {
      append: realAuditTrail.append,
      query: realAuditTrail.query,
      bind(transaction) {
        const bound = realAuditTrail.bind(transaction);
        return {
          append: async (event) => {
            await bound.append(event);
            throw new Error("bound audit interrupted");
          },
          query: bound.query,
          bind: bound.bind,
        };
      },
    };
    const queue = new Queue();
    const service = createJobDiscoverySchedules({
      db: database,
      runs: createAgentRunCommands({ db: database, queue, auditTrail: realAuditTrail, id: () => crypto.randomUUID(), clock: () => now, executionMode: "greenhouse", runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }) }),
      auditTrail,
      id: () => crypto.randomUUID(),
      clock: () => now,
    });

    await expect(service.dispatchPending({ limit: 10 })).rejects.toThrow("bound audit interrupted");
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, occurrence.occurrenceId)))
      .resolves.toEqual([expect.objectContaining({ status: "pending", runId: null, skipReason: null })]);
    await expect(database.select().from(auditEvents).where(and(eq(auditEvents.resourceId, occurrence.occurrenceId), eq(auditEvents.eventType, "job_discovery.occurrence_dispatched"))))
      .resolves.toEqual([]);
  });

  it("物化后目标停用会稳定跳过，缺失精确 Greenhouse API 授权也不创建 run", async () => {
    const inactiveOwner = await target();
    await addWatchlistSource({ userId: inactiveOwner.userId, targetId: inactiveOwner.targetId, careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const inactiveOccurrence = await dueOccurrence(inactiveOwner);
    await database.update(jobTargets).set({ state: "inactive" }).where(eq(jobTargets.id, inactiveOwner.targetId));
    await schedules().service.dispatchPending({ limit: 10 });
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, inactiveOccurrence.occurrenceId))).resolves.toEqual([expect.objectContaining({ status: "skipped", skipReason: "TARGET_INACTIVE", runId: null })]);

    const policyOwner = await target();
    await addWatchlistSource({ userId: policyOwner.userId, targetId: policyOwner.targetId, careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io"] });
    const policyScheduleId = crypto.randomUUID();
    await database.insert(jobDiscoverySchedules).values({ id: policyScheduleId, userId: policyOwner.userId, targetId: policyOwner.targetId, version: 1, state: "enabled", dailyTime: "09:30", timeZone: "Asia/Shanghai", nextRunAt: new Date("2026-08-27T01:30:00.000Z"), createdAt: now, updatedAt: now });
    const [policyOccurrence] = await schedules().service.materializeDue({ limit: 10 });
    await schedules().service.dispatchPending({ limit: 10 });
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, policyOccurrence.occurrenceId))).resolves.toEqual([expect.objectContaining({ status: "skipped", skipReason: "SOURCE_POLICY_REQUIRED", runId: null })]);
    await expect(database.select().from(agentRuns).where(and(eq(agentRuns.userId, policyOwner.userId), lt(agentRuns.createdAt, new Date("2026-09-01T00:00:00.000Z"))))).resolves.toHaveLength(0);

    const unsupportedOwner = await target();
    await addWatchlistSource({ userId: unsupportedOwner.userId, targetId: unsupportedOwner.targetId, careersUrl: "https://careers.example.test/jobs", allowedDomains: ["careers.example.test"] });
    const unsupportedScheduleId = crypto.randomUUID();
    await database.insert(jobDiscoverySchedules).values({ id: unsupportedScheduleId, userId: unsupportedOwner.userId, targetId: unsupportedOwner.targetId, version: 1, state: "enabled", dailyTime: "09:30", timeZone: "Asia/Shanghai", nextRunAt: new Date("2026-08-27T01:30:00.000Z"), createdAt: now, updatedAt: now });
    const [unsupportedOccurrence] = await schedules().service.materializeDue({ limit: 10 });
    await schedules().service.dispatchPending({ limit: 10 });
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, unsupportedOccurrence.occurrenceId))).resolves.toEqual([expect.objectContaining({ status: "skipped", skipReason: "NO_SUPPORTED_SOURCE", runId: null })]);
  });

  it("绑定崩溃后即使目标变更也优先复用 occurrence 已创建的 run", async () => {
    const owner = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const occurrence = await dueOccurrence(owner);
    const queue = new Queue();
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const real = createAgentRunCommands({ db: database, queue, auditTrail, id: () => crypto.randomUUID(), clock: () => now, executionMode: "greenhouse", runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }) });
    let failAfterCommit = true;
    const runs: AgentRunStarter = { start: async (input) => {
      const started = await real.start(input);
      if (failAfterCommit) { failAfterCommit = false; throw new Error("bind interrupted"); }
      return started;
    } };
    const service = createJobDiscoverySchedules({ db: database, runs, auditTrail, id: () => crypto.randomUUID(), clock: () => now });

    await expect(service.dispatchPending({ limit: 10 })).rejects.toThrow("bind interrupted");
    await database.update(jobTargets).set({ state: "inactive" }).where(eq(jobTargets.id, owner.targetId));
    await service.dispatchPending({ limit: 10 });

    const [persisted] = await database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, occurrence.occurrenceId));
    expect(persisted).toMatchObject({ status: "dispatched", runId: expect.any(String), skipReason: null });
    await expect(database.select().from(agentRuns).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.idempotencyKey, occurrence.occurrenceId)))).resolves.toHaveLength(1);
  });

  it("并发 dispatcher 在 occurrence 行锁期间不会基于旧快照跳过已提交的 run", async () => {
    const owner = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const occurrence = await dueOccurrence(owner);
    const queue = new Queue();
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const real = createAgentRunCommands({ db: database, queue, auditTrail, id: () => crypto.randomUUID(), clock: () => now, executionMode: "greenhouse", runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }) });
    let startCalls = 0;
    let firstStartCommitted!: () => void;
    let releaseFirstBind!: () => void;
    const firstStartCommittedPromise = new Promise<void>((resolve) => { firstStartCommitted = resolve; });
    const releaseFirstBindPromise = new Promise<void>((resolve) => { releaseFirstBind = resolve; });
    const runs: AgentRunStarter = { start: async (input) => {
      startCalls += 1;
      const started = await real.start(input);
      if (startCalls === 1) {
        firstStartCommitted();
        await releaseFirstBindPromise;
      }
      return started;
    } };
    const first = createJobDiscoverySchedules({ db: database, runs, auditTrail, id: () => crypto.randomUUID(), clock: () => now });
    const second = createJobDiscoverySchedules({ db: database, runs, auditTrail, id: () => crypto.randomUUID(), clock: () => now });

    const firstDispatch = first.dispatchPending({ limit: 1 });
    await firstStartCommittedPromise;
    const secondDispatch = second.dispatchPending({ limit: 1 });
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, expectedVersion: 1, companyName: "Changed source", careersUrl: "https://boards.greenhouse.io/changed", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    await database.update(jobTargets).set({ state: "inactive" }).where(eq(jobTargets.id, owner.targetId));
    releaseFirstBind();
    await Promise.all([firstDispatch, secondDispatch]);

    const [persisted] = await database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, occurrence.occurrenceId));
    expect(startCalls).toBe(1);
    expect(persisted).toMatchObject({ status: "dispatched", runId: expect.any(String), skipReason: null });
    await expect(database.select().from(agentRuns).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.idempotencyKey, occurrence.occurrenceId)))).resolves.toHaveLength(1);
  });

  it("混合 Watchlist 中任一未授权 Greenhouse source 阻止启用和新 occurrence 派发", async () => {
    const owner = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/allowed", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, expectedVersion: 1, companyName: "Policy Required", careersUrl: "https://job-boards.greenhouse.io/blocked", allowedDomains: ["job-boards.greenhouse.io"] });
    const { service } = schedules();

    await expect(service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } })).rejects.toMatchObject({ code: "SOURCE_POLICY_REQUIRED" });
    await database.insert(jobDiscoverySchedules).values({ id: crypto.randomUUID(), userId: owner.userId, targetId: owner.targetId, version: 1, state: "enabled", dailyTime: "09:30", timeZone: "Asia/Shanghai", nextRunAt: new Date("2026-08-27T01:30:00.000Z"), createdAt: now, updatedAt: now });
    const [occurrence] = await service.materializeDue({ limit: 10 });
    await service.dispatchPending({ limit: 10 });
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, occurrence!.occurrenceId))).resolves.toEqual([expect.objectContaining({ status: "skipped", skipReason: "SOURCE_POLICY_REQUIRED", runId: null })]);
  });

  it("重复 board token 只持久化 Watchlist 优先的一个 public source，并可由查询响应严格序列化", async () => {
    const owner = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/shared", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, expectedVersion: 1, companyName: "Second Company", careersUrl: "https://job-boards.greenhouse.io/shared", allowedDomains: ["job-boards.greenhouse.io", "boards-api.greenhouse.io"] });
    await expect(schedules().service.get(owner)).resolves.toMatchObject({ sourceSupport: { status: "executable", supportedSourceCount: 1 } });
    const occurrence = await dueOccurrence(owner);
    await schedules().service.dispatchPending({ limit: 10 });
    const [run] = await database.select().from(agentRuns).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.idempotencyKey, occurrence.occurrenceId)));

    expect(run!.sourceScope).toMatchObject({ sources: [expect.objectContaining({ sourceId: "greenhouse:shared", canonicalCompanyName: "Example AI" })] });
    expect((run!.sourceScope as { sources: unknown[] }).sources).toHaveLength(1);
    await expect(createAgentRunQueries({ db: database }).get({ userId: owner.userId, runId: run!.id })).resolves.toMatchObject({ adapter: "greenhouse", sourceScope: expect.objectContaining({ sources: [expect.any(Object)] }) });
  });

  it("账户停止后把已物化的计划 occurrence 标记为停止跳过且不创建运行", async () => {
    const owner = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/stopped", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const occurrence = await dueOccurrence(owner);
    await createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: crypto.randomUUID, clock: () => now })
      .control({ userId: owner.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    await schedules().service.dispatchPending({ limit: 10 });
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, occurrence.occurrenceId)))
      .resolves.toEqual([expect.objectContaining({ status: "skipped", skipReason: "ACCOUNT_RUN_STOPPED", runId: null })]);
    await expect(database.select().from(agentRuns).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.idempotencyKey, occurrence.occurrenceId)))).resolves.toEqual([]);
  });

  it("离线期间停止再释放后，旧到期计划只记录停止跳过并推进到未来", async () => {
    const stoppedAt = new Date("2026-08-30T00:00:00.000Z");
    const releasedAt = new Date("2026-08-30T02:00:00.000Z");
    const workerAt = new Date("2026-08-30T03:00:00.000Z");
    const staleScheduledFor = new Date("2026-08-30T01:00:00.000Z");
    const owner = await target();
    const other = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/offline-owner", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    await addWatchlistSource({ userId: other.userId, targetId: other.targetId, careersUrl: "https://boards.greenhouse.io/offline-other", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const queue = new Queue();
    const setup = schedules(queue, stoppedAt);
    const ownerSchedule = await setup.service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:00" } });
    const otherSchedule = await setup.service.set({ userId: other.userId, targetId: other.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:00" } });
    await database.update(jobDiscoverySchedules).set({ nextRunAt: staleScheduledFor }).where(eq(jobDiscoverySchedules.id, ownerSchedule.scheduleId));
    await database.update(jobDiscoverySchedules).set({ nextRunAt: staleScheduledFor }).where(eq(jobDiscoverySchedules.id, otherSchedule.scheduleId));
    const control = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => stoppedAt }), id: crypto.randomUUID, clock: () => stoppedAt });
    await control.control({ userId: owner.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    await createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => releasedAt }), id: crypto.randomUUID, clock: () => releasedAt })
      .control({ userId: owner.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 1, action: "release" } });

    const worker = schedules(queue, workerAt).service;
    const created = await worker.materializeDue({ limit: 10 });
    await worker.dispatchPending({ limit: 10 });

    const ownerOccurrence = created.find((item) => item.scheduleId === ownerSchedule.scheduleId)!;
    const otherOccurrence = created.find((item) => item.scheduleId === otherSchedule.scheduleId)!;
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, ownerOccurrence.occurrenceId)))
      .resolves.toEqual([expect.objectContaining({ status: "skipped", skipReason: "ACCOUNT_RUN_SCHEDULE_SKIPPED", runId: null, scheduledFor: staleScheduledFor })]);
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, otherOccurrence.occurrenceId)))
      .resolves.toEqual([expect.objectContaining({ status: "dispatched", skipReason: null, runId: expect.any(String) })]);
    await expect(database.select({ nextRunAt: jobDiscoverySchedules.nextRunAt }).from(jobDiscoverySchedules).where(eq(jobDiscoverySchedules.id, ownerSchedule.scheduleId)))
      .resolves.toEqual([expect.objectContaining({ nextRunAt: expect.any(Date) })]);
    const [ownerScheduleAfter] = await database.select().from(jobDiscoverySchedules).where(eq(jobDiscoverySchedules.id, ownerSchedule.scheduleId));
    expect(ownerScheduleAfter!.nextRunAt!.getTime()).toBeGreaterThan(workerAt.getTime());
    await expect(database.select().from(agentRuns).where(eq(agentRuns.userId, owner.userId))).resolves.toEqual([]);
  });

  it("重复停止释放后的 cutoff 阻止早于或恰在 cutoff 的待派发 occurrence，且不影响另一账户", async () => {
    const stoppedAt = new Date("2026-08-30T00:00:00.000Z");
    const firstReleaseAt = new Date("2026-08-30T02:00:00.000Z");
    const secondStopAt = new Date("2026-08-30T02:30:00.000Z");
    const secondReleaseAt = new Date("2026-08-30T03:00:00.000Z");
    const workerAt = new Date("2026-08-30T04:00:00.000Z");
    const owner = await target();
    const other = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/cutoff-owner", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    await addWatchlistSource({ userId: other.userId, targetId: other.targetId, careersUrl: "https://boards.greenhouse.io/cutoff-other", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const setup = schedules(new Queue(), stoppedAt);
    const ownerSchedule = await setup.service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:00" } });
    const otherSchedule = await setup.service.set({ userId: other.userId, targetId: other.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:00" } });
    const beforeCutoffId = crypto.randomUUID();
    const atCutoffId = crypto.randomUUID();
    const otherOccurrenceId = crypto.randomUUID();
    await database.insert(jobDiscoveryScheduleOccurrences).values([
      { id: beforeCutoffId, userId: owner.userId, targetId: owner.targetId, scheduleId: ownerSchedule.scheduleId, scheduledFor: new Date("2026-08-30T01:00:00.000Z"), status: "pending" as const, runId: null, skipReason: null, createdAt: stoppedAt },
      { id: atCutoffId, userId: owner.userId, targetId: owner.targetId, scheduleId: ownerSchedule.scheduleId, scheduledFor: secondReleaseAt, status: "pending" as const, runId: null, skipReason: null, createdAt: stoppedAt },
      { id: otherOccurrenceId, userId: other.userId, targetId: other.targetId, scheduleId: otherSchedule.scheduleId, scheduledFor: secondReleaseAt, status: "pending" as const, runId: null, skipReason: null, createdAt: stoppedAt },
    ]);
    const firstControl = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => stoppedAt }), id: crypto.randomUUID, clock: () => stoppedAt });
    await firstControl.control({ userId: owner.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    const release = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => firstReleaseAt }), id: crypto.randomUUID, clock: () => firstReleaseAt });
    await release.control({ userId: owner.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 1, action: "release" } });
    await release.control({ userId: owner.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 2, action: "release" } });
    const secondControl = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => secondStopAt }), id: crypto.randomUUID, clock: () => secondStopAt });
    await secondControl.control({ userId: owner.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 2, action: "stop" } });
    await createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => secondReleaseAt }), id: crypto.randomUUID, clock: () => secondReleaseAt })
      .control({ userId: owner.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 3, action: "release" } });

    await schedules(new Queue(), workerAt).service.dispatchPending({ limit: 10 });

    const [controlState] = await database.select().from(accountRunPolicies).where(eq(accountRunPolicies.userId, owner.userId));
    expect(controlState!.scheduleResumeAfter).toEqual(secondReleaseAt);
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(and(eq(jobDiscoveryScheduleOccurrences.userId, owner.userId), eq(jobDiscoveryScheduleOccurrences.status, "skipped"))))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: beforeCutoffId, skipReason: "ACCOUNT_RUN_SCHEDULE_SKIPPED", runId: null }),
        expect.objectContaining({ id: atCutoffId, skipReason: "ACCOUNT_RUN_SCHEDULE_SKIPPED", runId: null }),
      ]));
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, otherOccurrenceId)))
      .resolves.toEqual([expect.objectContaining({ status: "dispatched", skipReason: null, runId: expect.any(String) })]);
  });

  it("停止释放不会复活已关联 occurrence 的暂停幂等运行，回放只补 dispatched", async () => {
    const stoppedAt = new Date("2026-08-30T00:00:00.000Z");
    const releasedAt = new Date("2026-08-30T02:00:00.000Z");
    const workerAt = new Date("2026-08-30T03:00:00.000Z");
    const owner = await target();
    await addWatchlistSource({ userId: owner.userId, targetId: owner.targetId, careersUrl: "https://boards.greenhouse.io/idempotent-paused", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const setup = schedules(new Queue(), stoppedAt);
    const schedule = await setup.service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:00" } });
    const occurrenceId = crypto.randomUUID();
    await database.insert(jobDiscoveryScheduleOccurrences).values({ id: occurrenceId, userId: owner.userId, targetId: owner.targetId, scheduleId: schedule.scheduleId, scheduledFor: new Date("2026-08-30T01:00:00.000Z"), status: "pending", runId: null, skipReason: null, createdAt: stoppedAt });
    const started = await setup.commands.start({ userId: owner.userId, requestId: crypto.randomUUID(), command: { targetId: owner.targetId, idempotencyKey: occurrenceId }, trigger: { kind: "schedule", occurrenceId, scheduledFor: new Date("2026-08-30T01:00:00.000Z") } });
    await createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => stoppedAt }), id: () => crypto.randomUUID(), clock: () => stoppedAt })
      .control({ userId: owner.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    await createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => releasedAt }), id: () => crypto.randomUUID(), clock: () => releasedAt })
      .control({ userId: owner.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 1, action: "release" } });

    await schedules(new Queue(), workerAt).service.dispatchPending({ limit: 10 });

    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, occurrenceId)))
      .resolves.toEqual([expect.objectContaining({ status: "dispatched", runId: started.runId, skipReason: null })]);
    await expect(database.select().from(agentRuns).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.idempotencyKey, occurrenceId))))
      .resolves.toEqual([expect.objectContaining({ id: started.runId, status: "paused" })]);
  });
});
