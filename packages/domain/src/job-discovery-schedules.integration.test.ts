import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, lt } from "drizzle-orm";
import {
  agentRuns,
  auditEvents,
  createDatabase,
  jobAccounts,
  jobDiscoveryScheduleOccurrences,
  jobDiscoverySchedules,
  jobTargetRevisions,
  jobTargets,
  migrateDatabase,
  type Database,
} from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createAgentRunCommands, type AgentRunQueue } from "./agent-runs";
import { createCompanyWatchlistCommands } from "./company-watchlists";
import { JobDiscoveryScheduleError, createJobDiscoverySchedules } from "./job-discovery-schedules";

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
      commands: createAgentRunCommands({ db: database, queue, auditTrail, id: () => crypto.randomUUID(), clock: () => at }),
      service: createJobDiscoverySchedules({
        db: database,
        runs: createAgentRunCommands({ db: database, queue, auditTrail, id: () => crypto.randomUUID(), clock: () => at }),
        auditTrail,
        id: () => crypto.randomUUID(),
        clock: () => at,
      }),
    };
  }

  async function addWatchlistSource(input: { userId: string; targetId: string; careersUrl: string; allowedDomains: string[] }) {
    await createCompanyWatchlistCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).addItem({
      userId: input.userId, targetId: input.targetId, requestId: crypto.randomUUID(),
      command: { expectedVersion: 0, canonicalCompanyName: "Example AI", careersUrl: input.careersUrl, allowedDomains: input.allowedDomains, sourceNote: null },
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
    const { service } = schedules();

    const created = await service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } });
    expect(created).toMatchObject({ targetId: owner.targetId, version: 1, state: "enabled", dailyTime: "09:30", timeZone: "Asia/Shanghai", nextRunAt: "2026-08-31T01:30:00.000Z" });
    await expect(service.get({ userId: other.userId, targetId: owner.targetId })).resolves.toBeNull();
    await expect(service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "10:00" } })).rejects.toMatchObject({ code: "JOB_DISCOVERY_SCHEDULE_VERSION_CONFLICT" } satisfies Partial<JobDiscoveryScheduleError>);
    await expect(service.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 1, state: "disabled", dailyTime: "10:00" } })).resolves.toMatchObject({ version: 2, state: "disabled", dailyTime: "10:00", nextRunAt: null });

    const inactive = await target("inactive");
    await expect(service.set({ userId: inactive.userId, targetId: inactive.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } })).rejects.toMatchObject({ code: "JOB_DISCOVERY_SCHEDULE_TARGET_INACTIVE" } satisfies Partial<JobDiscoveryScheduleError>);
  });

  it("停机跨越多个时点只物化一个 occurrence，并把下一时点推进到当前之后", async () => {
    const owner = await target();
    const occurrence = await dueOccurrence(owner);

    expect(occurrence).toMatchObject({ targetId: owner.targetId, status: "pending", scheduledFor: "2026-08-27T01:30:00.000Z" });
    await expect(database.select({ nextRunAt: jobDiscoverySchedules.nextRunAt }).from(jobDiscoverySchedules).where(and(eq(jobDiscoverySchedules.userId, owner.userId), eq(jobDiscoverySchedules.targetId, owner.targetId)))).resolves.toEqual([{ nextRunAt: new Date("2026-08-31T01:30:00.000Z") }]);
  });

  it("两个 scanner 并发物化同一到期计划时只写一个 occurrence", async () => {
    const owner = await target();
    const { service: first } = schedules();
    const { service: second } = schedules();
    const created = await first.set({ userId: owner.userId, targetId: owner.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } });
    await database.update(jobDiscoverySchedules).set({ nextRunAt: new Date("2026-08-27T01:30:00.000Z") }).where(eq(jobDiscoverySchedules.id, created.scheduleId));

    const materialized = await Promise.all([first.materializeDue({ limit: 10 }), second.materializeDue({ limit: 10 })]);
    expect(materialized.flat()).toHaveLength(1);
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.scheduleId, created.scheduleId))).resolves.toHaveLength(1);
  });

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

  it("物化后目标停用会稳定跳过，缺失精确 Greenhouse API 授权也不创建 run", async () => {
    const inactiveOwner = await target();
    await addWatchlistSource({ userId: inactiveOwner.userId, targetId: inactiveOwner.targetId, careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] });
    const inactiveOccurrence = await dueOccurrence(inactiveOwner);
    await database.update(jobTargets).set({ state: "inactive" }).where(eq(jobTargets.id, inactiveOwner.targetId));
    await schedules().service.dispatchPending({ limit: 10 });
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, inactiveOccurrence.occurrenceId))).resolves.toEqual([expect.objectContaining({ status: "skipped", skipReason: "TARGET_INACTIVE", runId: null })]);

    const policyOwner = await target();
    await addWatchlistSource({ userId: policyOwner.userId, targetId: policyOwner.targetId, careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io"] });
    const policyOccurrence = await dueOccurrence(policyOwner);
    await schedules().service.dispatchPending({ limit: 10 });
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, policyOccurrence.occurrenceId))).resolves.toEqual([expect.objectContaining({ status: "skipped", skipReason: "SOURCE_POLICY_REQUIRED", runId: null })]);
    await expect(database.select().from(agentRuns).where(and(eq(agentRuns.userId, policyOwner.userId), lt(agentRuns.createdAt, new Date("2026-09-01T00:00:00.000Z"))))).resolves.toHaveLength(0);

    const unsupportedOwner = await target();
    await addWatchlistSource({ userId: unsupportedOwner.userId, targetId: unsupportedOwner.targetId, careersUrl: "https://careers.example.test/jobs", allowedDomains: ["careers.example.test"] });
    const unsupportedOccurrence = await dueOccurrence(unsupportedOwner);
    await schedules().service.dispatchPending({ limit: 10 });
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, unsupportedOccurrence.occurrenceId))).resolves.toEqual([expect.objectContaining({ status: "skipped", skipReason: "NO_SUPPORTED_SOURCE", runId: null })]);
  });
});
