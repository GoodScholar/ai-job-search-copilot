import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import Redis from "ioredis";
import { Client as MinioClient } from "minio";
import { NestFactory } from "@nestjs/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentRunJobResults,
  agentRuns,
  createDatabase,
  jobDiscoveryScheduleOccurrences,
  jobDiscoverySchedules,
  jobAccounts,
  jobOpportunities,
  jobSourcePostingVersions,
  jobSourcePostings,
  jobTargetRevisions,
  jobTargets,
  migrateDatabase,
  type Database,
} from "@job-copilot/database";
import { AGENT_RUN_JOB_NAME, AGENT_RUN_QUEUE } from "@job-copilot/contracts/agent-runs";
import { createAgentRunCommands, createAgentRunProcessor, createAgentRunQueries, createAgentRunRecoveryQueries } from "@job-copilot/domain/agent-runs";
import { createAuditTrail } from "@job-copilot/domain/audit-trail";
import { createCompanyWatchlistCommands } from "@job-copilot/domain/company-watchlists";
import { createJobDiscoverySchedules } from "@job-copilot/domain/job-discovery-schedules";

import { AppModule } from "../app.module.js";
import { AGENT_RUN_CONSUMER } from "./agent-run.module.js";
import type { AgentRunConsumer } from "./agent-run-consumer.js";
import { agentRunQueueJobOptions } from "./agent-run-reconciler.js";
import { AgentRunScheduler, type AgentRunScheduleFailure } from "./agent-run-scheduler.js";
import { createJobDiscoveryAdapterResolver } from "./job-discovery-adapter-resolver.js";
import { MinioDiscoveryContentStore } from "./minio-discovery-content-store.js";

const minioImage = "minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const minioAccessKey = "agent-run-test-access-key";
const minioSecretKey = "agent-run-test-secret-key";
const minioBucket = "career-documents";
const userId = "20000000-0000-4000-8000-000000000002";
const targetId = "30000000-0000-4000-8000-000000000003";
const constraints = {
  roleFamily: "工程师",
  seniority: null,
  locations: [],
  workModes: [],
  relocation: "unknown" as const,
  salary: null,
  industries: [],
  dealBreakers: {
    excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false,
    excludeDispatch: false, excludeHeadhunter: false, other: [],
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function waitFor(check: () => Promise<boolean>, message: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

describe("岗位发现 Agent Run Worker", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let minioContainer: StartedTestContainer;
  let database: Database;
  let redisUrl: string;
  let minio: MinioClient;
  let queueRedis: Redis;
  let queue: Queue;
  let context: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  let originalEnvironment: Record<string, string | undefined>;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    redisContainer = await new RedisContainer("redis:7-alpine").start();
    minioContainer = await new GenericContainer(minioImage)
      .withCommand(["server", "/data"])
      .withEnvironment({ MINIO_ROOT_USER: minioAccessKey, MINIO_ROOT_PASSWORD: minioSecretKey })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000))
      .start();
    database = createDatabase(postgres.getConnectionUri());
    await migrateDatabase(database);
    redisUrl = redisContainer.getConnectionUrl();
    minio = new MinioClient({
      endPoint: minioContainer.getHost(),
      port: minioContainer.getMappedPort(9000),
      useSSL: false,
      accessKey: minioAccessKey,
      secretKey: minioSecretKey,
    });
    await minio.makeBucket(minioBucket);
    queueRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue(AGENT_RUN_QUEUE, { connection: queueRedis });
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({
      id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null,
    });
    await database.insert(jobTargetRevisions).values({
      id: randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints,
    });

    originalEnvironment = {
      APP_ENV: process.env.APP_ENV,
      DATABASE_URL: process.env.DATABASE_URL,
      REDIS_URL: process.env.REDIS_URL,
      MINIO_ENDPOINT: process.env.MINIO_ENDPOINT,
      MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY,
      MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY,
      MINIO_BUCKET: process.env.MINIO_BUCKET,
      E2E_AGENT_RUN_SCENARIOS: process.env.E2E_AGENT_RUN_SCENARIOS,
    };
    Object.assign(process.env, {
      APP_ENV: "test",
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: redisUrl,
      MINIO_ENDPOINT: `http://${minioContainer.getHost()}:${minioContainer.getMappedPort(9000)}`,
      MINIO_ACCESS_KEY: minioAccessKey,
      MINIO_SECRET_KEY: minioSecretKey,
      MINIO_BUCKET: minioBucket,
    });
  }, 120_000);

  afterAll(async () => {
    const databaseStatus = async () => {
      try {
        const rows = await database.execute(sql<{ state: string; waitEventType: string | null; waitEvent: string | null; query: string }>`
          select state, wait_event_type as "waitEventType", wait_event as "waitEvent", query
          from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
          order by pid
        `);
        return { connections: rows.map(({ state, waitEventType, waitEvent, query }) => ({ state, waitEventType, waitEvent, query: (typeof query === "string" ? query : String(query)).slice(0, 120) })) };
      } catch (error) {
        return { connectionError: error instanceof Error ? error.message : String(error) };
      }
    };
    const boundary = async (name: string, action: () => Promise<unknown>, status: () => unknown | Promise<unknown>) => {
      const startedAt = Date.now();
      console.info(`[worker teardown] ${name}:start`, await status());
      await action();
      console.info(`[worker teardown] ${name}:done`, { elapsedMs: Date.now() - startedAt, status: await status() });
    };
    await boundary("context.close", () => Promise.resolve(context?.close()), () => ({ created: Boolean(context) }));
    await boundary("queue.close", () => Promise.resolve(queue?.close()), () => ({ created: Boolean(queue), redisStatus: queueRedis?.status ?? "missing" }));
    await boundary("redis.quit", () => Promise.resolve(queueRedis && queueRedis.status !== "end" ? queueRedis.quit() : undefined), () => ({ status: queueRedis?.status ?? "missing" }));
    await boundary("database.close", () => Promise.resolve(database?.$client.end({ timeout: 5 })), databaseStatus);
    await boundary("minio.stop", () => Promise.resolve(minioContainer?.stop()), () => ({ created: Boolean(minioContainer) }));
    await boundary("redis.stop", () => Promise.resolve(redisContainer?.stop()), () => ({ created: Boolean(redisContainer) }));
    await boundary("postgres.stop", () => Promise.resolve(postgres?.stop()), () => ({ created: Boolean(postgres) }));
    for (const [key, value] of Object.entries(originalEnvironment ?? {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, 60_000);

  function commands() {
    return createAgentRunCommands({
      db: database,
      queue: { enqueue: async () => { throw new Error("API queue wakeup unavailable"); } },
      auditTrail: createAuditTrail({ db: database, clock: () => new Date() }),
      id: randomUUID,
      clock: () => new Date(),
    });
  }

  function createDurableQueuedRun(idempotencyKey = randomUUID()) {
    return commands().start({
      userId,
      requestId: randomUUID(),
      command: { targetId, idempotencyKey },
    });
  }

  async function startWorker(): Promise<void> {
    context = await NestFactory.createApplicationContext(AppModule, { logger: false });
    expect(context.get<AgentRunConsumer>(AGENT_RUN_CONSUMER)).toBeDefined();
  }

  async function stopWorker(): Promise<void> {
    await context?.close();
    context = undefined;
  }

  it("MinIO store 仅接受 JSON，并实现真实写入和删除", async () => {
    const store = new MinioDiscoveryContentStore(minio, minioBucket);
    const objectKey = `accounts/${userId}/agent-runs/${randomUUID()}/sources/test/source.json`;
    const bytes = new TextEncoder().encode('{"fixture":true}');

    await expect(store.put({ objectKey, bytes, mediaType: "text/plain" as "application/json", runId: randomUUID() }))
      .rejects.toThrow("application/json");
    await store.put({ objectKey, bytes, mediaType: "application/json", runId: randomUUID() });
    const stream = await minio.getObject(minioBucket, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
    await store.delete({ objectKey });
    await expect(minio.getObject(minioBucket, objectKey)).rejects.toThrow();
  });

  it("扫描无 API 唤醒的 run，完成持久化、抵抗重复交付，并在 Worker 重启后恢复过期租约", async () => {
    const first = await createDurableQueuedRun();

    await startWorker();
    await waitFor(
      async () => (await createAgentRunQueries({ db: database }).get({ userId, runId: first.runId }))?.status === "completed",
      "timed out waiting for reconciled agent run",
    );
    const firstDetail = await createAgentRunQueries({ db: database }).get({ userId, runId: first.runId });
    expect(firstDetail).toMatchObject({
      workflowVersion: "job-discovery-workflow-v1",
      adapterVersion: "fake-job-discovery-v1",
      outputSchemaVersion: "job-discovery-result-v1",
      status: "completed",
      attemptCount: 1,
    });
    expect(firstDetail).not.toBeNull();
    if (!firstDetail) throw new Error("completed run detail is missing");
    expect(firstDetail.sourceScope).toEqual({
      kind: "company_watchlist",
      adapter: "fake",
      adapterVersion: "fake-job-discovery-v1",
      watchlistVersion: 0,
      sources: ["fake:aurora-careers", "fake:orbit-careers"],
    });
    expect(firstDetail.events.filter((event) => event.eventType !== "run.budget_updated").map((event) => event.eventType)).toEqual([
      "run.queued", "run.started", "step.started", "step.completed", "step.started",
      "step.completed", "step.started", "step.completed", "run.completed",
    ]);
    const budgetEvents = firstDetail.events.filter((event) => event.eventType === "run.budget_updated");
    expect(budgetEvents.length).toBeGreaterThan(0);
    for (const [index, event] of budgetEvents.entries()) {
      const prior = budgetEvents[index - 1];
      if (prior) {
        expect(event.sequence).toBeGreaterThan(prior.sequence);
        expect(event.runVersion).toBeGreaterThanOrEqual(prior.runVersion);
      }
      expect(event.data.eventType).toBe("run.budget_updated");
      if (event.data.eventType !== "run.budget_updated") throw new Error("budget event data is missing usage");
      for (const field of ["activeDurationMs", "attempts", "toolCalls", "sourceRequests", "modelCalls", "inputTokens", "outputTokens", "totalTokens", "results"] as const) {
        const priorUsage = prior?.data.eventType === "run.budget_updated" ? prior.data.usage[field] : 0;
        expect(event.data.usage[field]).toBeGreaterThanOrEqual(priorUsage);
      }
    }
    const latestBudgetEvent = budgetEvents.at(-1);
    if (!latestBudgetEvent || latestBudgetEvent.data.eventType !== "run.budget_updated") throw new Error("final budget event is missing usage");
    expect(latestBudgetEvent.data.usage).toEqual(firstDetail.usage);
    expect(firstDetail.results).toHaveLength(5);
    await expect(createAgentRunRecoveryQueries({ db: database, clock: () => new Date() }).listRecoverable())
      .resolves.not.toContainEqual({ version: 1, runId: first.runId, userId });

    const [postings, versions, opportunities, runResults] = await Promise.all([
      database.select().from(jobSourcePostings),
      database.select().from(jobSourcePostingVersions),
      database.select().from(jobOpportunities),
      database.select().from(agentRunJobResults),
    ]);
    expect(postings).toHaveLength(5);
    expect(new Set(postings.map((posting) => (posting.sourceIdentity as { sourceId: string }).sourceId)))
      .toEqual(new Set(["fake:aurora-careers", "fake:orbit-careers"]));
    expect(versions).toHaveLength(5);
    expect(opportunities).toHaveLength(5);
    expect(opportunities.every((opportunity) => opportunity.importId === null)).toBe(true);
    expect(runResults).toHaveLength(5);
    for (const version of versions) {
      const objectKey = (version.rawObjectReference as { objectKey: string }).objectKey;
      expect(objectKey).toMatch(new RegExp(`^accounts/${userId}/agent-runs/${first.runId}/sources/[a-f0-9]{64}/[a-f0-9-]{36}/[a-f0-9]{64}\\.json$`));
      await expect(minio.statObject(minioBucket, objectKey)).resolves.toBeDefined();
    }

    await waitFor(async () => (await queue.getJob(first.runId)) === undefined, "original agent run job was not removed");
    const duplicateJob = await queue.add(
      AGENT_RUN_JOB_NAME,
      { version: 1, runId: first.runId, userId },
      { ...agentRunQueueJobOptions(first.runId), removeOnComplete: false },
    );
    expect(duplicateJob.id).toBe(first.runId);
    await waitFor(async () => (await queue.getJob(first.runId))?.returnvalue === "stale", "duplicate agent run job was not consumed");
    const completedDuplicate = await queue.getJob(first.runId);
    expect(await completedDuplicate?.getState()).toBe("completed");
    expect(completedDuplicate?.returnvalue).toBe("stale");
    await completedDuplicate?.remove();
    await waitFor(async () => (await queue.getJob(first.runId)) === undefined, "duplicate agent run job was not removed");
    await expect(database.select().from(jobSourcePostingVersions)).resolves.toHaveLength(5);
    await expect(database.select().from(jobOpportunities)).resolves.toHaveLength(5);
    await expect(database.select().from(agentRunJobResults)).resolves.toHaveLength(5);

    await stopWorker();
    const recovered = await createDurableQueuedRun();
    const expiredClaimToken = randomUUID();
    await database.execute(`
      update agent_runs
      set status = 'running', current_step = 'batch_search', claim_token = '${expiredClaimToken}',
          claim_expires_at = now() - interval '1 second', active_slice_started_at = now() - interval '31 seconds',
          started_at = now() - interval '31 seconds', attempt_count = 1
      where user_id = '${userId}' and id = '${recovered.runId}'
    `);

    await startWorker();
    await waitFor(
      async () => (await createAgentRunQueries({ db: database }).get({ userId, runId: recovered.runId }))?.status === "completed",
      "timed out waiting for expired agent run recovery",
    );
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: recovered.runId }))
      .resolves.toMatchObject({ status: "completed", attemptCount: 2, results: expect.arrayContaining([expect.objectContaining({ ordinal: 1 })]) });
    await expect(database.select().from(jobSourcePostingVersions)).resolves.toHaveLength(5);
    await expect(database.select().from(jobOpportunities)).resolves.toHaveLength(5);
    await expect(database.select().from(agentRunJobResults)).resolves.toHaveLength(10);
  }, 60_000);

  it("计划扫描由 Worker 物化 Fake occurrence，重复扫描和重复交付不重复持久化", async () => {
    await stopWorker();
    const scheduledUserId = randomUUID();
    const scheduledTargetId = randomUUID();
    await database.insert(jobAccounts).values({ id: scheduledUserId });
    await database.insert(jobTargets).values({ id: scheduledTargetId, userId: scheduledUserId, version: 1, priority: "primary", state: "active", activeSlot: null });
    await database.insert(jobTargetRevisions).values({ id: randomUUID(), userId: scheduledUserId, targetId: scheduledTargetId, version: 1, priority: "primary", state: "active", constraints });
    const auditTrail = createAuditTrail({ db: database, clock: () => new Date() });
    await createCompanyWatchlistCommands({ db: database, auditTrail, id: randomUUID, clock: () => new Date() }).addItem({
      userId: scheduledUserId, targetId: scheduledTargetId, requestId: randomUUID(),
      command: { expectedVersion: 0, canonicalCompanyName: "Schedule Fixture", careersUrl: "https://boards.greenhouse.io/schedule-fixture", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null },
    });
    const schedules = createJobDiscoverySchedules({ db: database, runs: commands(), auditTrail, id: randomUUID, clock: () => new Date() });
    const schedule = await schedules.set({ userId: scheduledUserId, targetId: scheduledTargetId, requestId: randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } });
    await database.update(jobDiscoverySchedules).set({ nextRunAt: new Date(Date.now() - 1_000) }).where(eq(jobDiscoverySchedules.id, schedule.scheduleId));

    const skippedSchedule = async (input: { targetState: "active" | "inactive"; careersUrl: string; allowedDomains: string[] }) => {
      const userId = randomUUID();
      const targetId = randomUUID();
      const scheduleId = randomUUID();
      await database.insert(jobAccounts).values({ id: userId });
      await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: input.targetState, activeSlot: null });
      await database.insert(jobTargetRevisions).values({ id: randomUUID(), userId, targetId, version: 1, priority: "primary", state: input.targetState, constraints });
      if (input.targetState === "active") {
        await createCompanyWatchlistCommands({ db: database, auditTrail, id: randomUUID, clock: () => new Date() }).addItem({
          userId, targetId, requestId: randomUUID(),
          command: { expectedVersion: 0, canonicalCompanyName: `Skip ${scheduleId}`, careersUrl: input.careersUrl, allowedDomains: input.allowedDomains, sourceNote: null },
        });
      }
      await database.insert(jobDiscoverySchedules).values({
        id: scheduleId, userId, targetId, version: 1, state: "enabled", dailyTime: "09:30", timeZone: "Asia/Shanghai",
        nextRunAt: new Date(Date.now() - 1_000), createdAt: new Date(), updatedAt: new Date(),
      });
      return { userId, scheduleId };
    };
    const [inactive, unsupported, policy] = await Promise.all([
      skippedSchedule({ targetState: "inactive", careersUrl: "https://boards.greenhouse.io/inactive-fixture", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"] }),
      skippedSchedule({ targetState: "active", careersUrl: "https://careers.example.test/unsupported", allowedDomains: ["careers.example.test"] }),
      skippedSchedule({ targetState: "active", careersUrl: "https://boards.greenhouse.io/policy-fixture", allowedDomains: ["boards.greenhouse.io"] }),
    ]);

    await startWorker();
    let occurrenceId = "";
    let scheduledRunId = "";
    await waitFor(async () => {
      const [occurrence] = await database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.scheduleId, schedule.scheduleId));
      occurrenceId = occurrence?.id ?? "";
      scheduledRunId = occurrence?.runId ?? "";
      return occurrence?.status === "dispatched" && Boolean(scheduledRunId)
        && (await createAgentRunQueries({ db: database }).get({ userId: scheduledUserId, runId: scheduledRunId }))?.status === "completed";
    }, "timed out waiting for scheduled Fake discovery");

    const detail = await createAgentRunQueries({ db: database }).get({ userId: scheduledUserId, runId: scheduledRunId });
    expect(detail).toMatchObject({ adapter: "fake", adapterVersion: "fake-job-discovery-v1", status: "completed" });
    expect(detail?.results).toHaveLength(5);
    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, occurrenceId))).resolves.toEqual([expect.objectContaining({ status: "dispatched", runId: scheduledRunId })]);
    await expect(database.select().from(agentRuns).where(and(eq(agentRuns.userId, scheduledUserId), eq(agentRuns.idempotencyKey, occurrenceId)))).resolves.toHaveLength(1);

    await waitFor(async () => (await queue.getJob(scheduledRunId)) === undefined, "scheduled agent run job was not removed");
    const duplicate = await queue.add(AGENT_RUN_JOB_NAME, { version: 1, runId: scheduledRunId, userId: scheduledUserId }, { ...agentRunQueueJobOptions(scheduledRunId), removeOnComplete: false });
    await waitFor(async () => (await queue.getJob(duplicate.id!))?.returnvalue === "stale", "duplicate scheduled delivery was not consumed");
    await (await queue.getJob(duplicate.id!))?.remove();
    await schedules.materializeDue({ limit: 10 });
    await schedules.dispatchPending({ limit: 10 });

    await expect(database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.scheduleId, schedule.scheduleId))).resolves.toHaveLength(1);
    await expect(database.select().from(agentRuns).where(and(eq(agentRuns.userId, scheduledUserId), eq(agentRuns.idempotencyKey, occurrenceId)))).resolves.toHaveLength(1);
    await expect(database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, scheduledUserId))).resolves.toHaveLength(5);
    await expect(database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, scheduledUserId))).resolves.toHaveLength(5);
    await expect(database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, scheduledUserId))).resolves.toHaveLength(5);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.userId, scheduledUserId))).resolves.toHaveLength(5);
    await expect.poll(async () => Promise.all([inactive, unsupported, policy].map(async ({ scheduleId }) => {
      const [occurrence] = await database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.scheduleId, scheduleId));
      return occurrence?.skipReason;
    }))).toEqual(["TARGET_INACTIVE", "NO_SUPPORTED_SOURCE", "SOURCE_POLICY_REQUIRED"]);
    await expect(Promise.all([inactive, unsupported, policy].map(({ userId }) => database.select().from(agentRuns).where(eq(agentRuns.userId, userId))))).resolves.toEqual([[], [], []]);
  }, 45_000);

  it("计划扫描的真实 PostgreSQL 锁超时会清理查询，并在下一个 tick 恢复", async () => {
    await stopWorker();
    const locked = deferred<void>();
    const releaseLock = deferred<void>();
    const lock = database.$client.begin(async (connection) => {
      await connection`lock table job_discovery_schedules in access exclusive mode`;
      locked.resolve();
      await releaseLock.promise;
    });
    await locked.promise;

    const failures: AgentRunScheduleFailure[] = [];
    const scheduler = new AgentRunScheduler({
      schedules: createJobDiscoverySchedules({ db: database, runs: commands(), auditTrail: createAuditTrail({ db: database, clock: () => new Date() }), id: randomUUID, clock: () => new Date() }),
      reporter: { report: async (failure) => { failures.push(failure); } },
      scanTimeoutMs: 100,
    });
    try {
      const initializing = scheduler.onModuleInit();
      await waitFor(async () => failures.length === 1, "scheduler did not report materialize failure", 2_000);
      expect(failures).toEqual([{ failureCode: "JOB_DISCOVERY_SCHEDULE_MATERIALIZE_FAILED" }]);
      await initializing;

      await expect(database.execute(sql<{ active: boolean }>`
        select exists(
          select 1 from pg_stat_activity
          where pid <> pg_backend_pid()
            and state = 'active'
            and query like '%from job_discovery_schedules%'
        ) as active
      `)).resolves.toEqual([{ active: false }]);

      releaseLock.resolve();
      await lock;
      const scheduleId = randomUUID();
      await database.insert(jobDiscoverySchedules).values({
        id: scheduleId, userId, targetId, version: 1, state: "enabled", dailyTime: "09:30", timeZone: "Asia/Shanghai",
        nextRunAt: new Date(Date.now() - 1_000), createdAt: new Date(), updatedAt: new Date(),
      });
      await waitFor(async () => (await database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.scheduleId, scheduleId))).length === 1, "scheduler did not recover on the next tick", 3_000);
    } finally {
      releaseLock.resolve();
      await lock.catch(() => undefined);
      await scheduler.onModuleDestroy();
    }
  }, 10_000);

  it("计划派发的真实 PostgreSQL 锁超时报告稳定码且不遗留活动查询", async () => {
    await stopWorker();
    const locked = deferred<void>();
    const releaseLock = deferred<void>();
    const lock = database.$client.begin(async (connection) => {
      await connection`lock table job_discovery_schedule_occurrences in access exclusive mode`;
      locked.resolve();
      await releaseLock.promise;
    });
    await locked.promise;
    const failures: AgentRunScheduleFailure[] = [];
    const scheduler = new AgentRunScheduler({
      schedules: createJobDiscoverySchedules({ db: database, runs: commands(), auditTrail: createAuditTrail({ db: database, clock: () => new Date() }), id: randomUUID, clock: () => new Date() }),
      reporter: { report: async (failure) => { failures.push(failure); } },
      scanTimeoutMs: 100,
    });
    try {
      const initializing = scheduler.onModuleInit();
      await waitFor(async () => failures.length === 1, "scheduler did not report dispatch failure", 2_000);
      expect(failures).toEqual([{ failureCode: "JOB_DISCOVERY_SCHEDULE_DISPATCH_FAILED" }]);
      await initializing;
      await expect(database.execute(sql<{ active: boolean }>`
        select exists(
          select 1 from pg_stat_activity
          where pid <> pg_backend_pid()
            and state = 'active'
            and query like '%from job_discovery_schedule_occurrences%'
        ) as active
      `)).resolves.toEqual([{ active: false }]);
    } finally {
      releaseLock.resolve();
      await lock.catch(() => undefined);
      await scheduler.onModuleDestroy();
    }
  }, 10_000);

  it("计划派发把同一绝对 deadline 传给被账户锁阻塞的 start 事务，并在下一 tick 恢复", async () => {
    await stopWorker();
    const scheduledUserId = randomUUID();
    const scheduledTargetId = randomUUID();
    const auditTrail = createAuditTrail({ db: database, clock: () => new Date() });
    await database.insert(jobAccounts).values({ id: scheduledUserId });
    await database.insert(jobTargets).values({ id: scheduledTargetId, userId: scheduledUserId, version: 1, priority: "primary", state: "active", activeSlot: null });
    await database.insert(jobTargetRevisions).values({ id: randomUUID(), userId: scheduledUserId, targetId: scheduledTargetId, version: 1, priority: "primary", state: "active", constraints });
    await createCompanyWatchlistCommands({ db: database, auditTrail, id: randomUUID, clock: () => new Date() }).addItem({
      userId: scheduledUserId, targetId: scheduledTargetId, requestId: randomUUID(),
      command: { expectedVersion: 0, canonicalCompanyName: "Deadline Fixture", careersUrl: "https://boards.greenhouse.io/deadline-fixture", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null },
    });
    const schedules = createJobDiscoverySchedules({ db: database, runs: commands(), auditTrail, id: randomUUID, clock: () => new Date() });
    const schedule = await schedules.set({ userId: scheduledUserId, targetId: scheduledTargetId, requestId: randomUUID(), command: { expectedVersion: 0, state: "enabled", dailyTime: "09:30" } });
    await database.update(jobDiscoverySchedules).set({ nextRunAt: new Date(Date.now() - 1_000) }).where(eq(jobDiscoverySchedules.id, schedule.scheduleId));
    const [occurrence] = await schedules.materializeDue({ limit: 1 });
    if (!occurrence) throw new Error("expected a pending occurrence");

    const locked = deferred<void>();
    const releaseLock = deferred<void>();
    const holder = database.$client.begin(async (connection) => {
      await connection`select pg_advisory_xact_lock(hashtextextended(${scheduledUserId}, 0))`;
      locked.resolve();
      await releaseLock.promise;
    });
    await locked.promise;
    const failures: AgentRunScheduleFailure[] = [];
    const scheduler = new AgentRunScheduler({
      schedules,
      reporter: { report: async (failure) => { failures.push(failure); } },
      scanTimeoutMs: 100,
    });
    try {
      const initializing = scheduler.onModuleInit();
      await waitFor(async () => Boolean((await database.execute(sql<{ waiting: boolean }>`
        select exists(
          select 1 from pg_stat_activity
          where pid <> pg_backend_pid()
            and state = 'active'
            and wait_event = 'advisory'
            and query like '%pg_advisory_xact_lock%'
        ) as waiting
      `))[0]?.waiting), "start did not wait for the account advisory lock", 2_000);
      await waitFor(async () => failures.length >= 1, "scheduler did not report dispatch failure", 2_000);
      expect(failures[0]).toEqual({ failureCode: "JOB_DISCOVERY_SCHEDULE_DISPATCH_FAILED" });
      await initializing;
      await waitFor(async () => failures.length >= 2, "scheduler single-flight did not clear for the next tick", 3_000);
      await waitFor(async () => !Boolean((await database.execute(sql<{ waiting: boolean }>`
        select exists(
          select 1 from pg_stat_activity
          where pid <> pg_backend_pid()
            and state = 'active'
            and wait_event = 'advisory'
            and query like '%pg_advisory_xact_lock%'
        ) as waiting
      `))[0]?.waiting), "advisory-lock query remained active after deadline", 2_000);

      releaseLock.resolve();
      await holder;
      await waitFor(async () => {
        const [persisted] = await database.select().from(jobDiscoveryScheduleOccurrences).where(eq(jobDiscoveryScheduleOccurrences.id, occurrence.occurrenceId));
        return persisted?.status === "dispatched" && Boolean(persisted.runId);
      }, "scheduler did not recover on the next tick", 3_000);
      await expect(database.select().from(agentRuns).where(and(eq(agentRuns.userId, scheduledUserId), eq(agentRuns.idempotencyKey, occurrence.occurrenceId)))).resolves.toHaveLength(1);
    } finally {
      releaseLock.resolve();
      await holder.catch(() => undefined);
      await scheduler.onModuleDestroy();
    }
  }, 12_000);

  it("暂停 run 不被恢复扫描，恢复后完成，取消的 run 不产生结果", async () => {
    await stopWorker();
    delete process.env.E2E_AGENT_RUN_SCENARIOS;
    const paused = await createDurableQueuedRun();
    await commands().control({ userId, requestId: randomUUID(), runId: paused.runId, command: { commandId: randomUUID(), action: "pause" } });

    await startWorker();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: paused.runId }))
      .resolves.toMatchObject({ status: "paused" });
    await expect(createAgentRunRecoveryQueries({ db: database, clock: () => new Date() }).listRecoverable())
      .resolves.not.toContainEqual({ version: 1, runId: paused.runId, userId });

    await commands().control({ userId, requestId: randomUUID(), runId: paused.runId, command: { commandId: randomUUID(), action: "resume" } });
    await waitFor(
      async () => (await createAgentRunQueries({ db: database }).get({ userId, runId: paused.runId }))?.status === "completed",
      "timed out waiting for resumed agent run",
    );

    const cancelled = await createDurableQueuedRun();
    await commands().control({ userId, requestId: randomUUID(), runId: cancelled.runId, command: { commandId: randomUUID(), action: "cancel" } });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: cancelled.runId }))
      .resolves.toMatchObject({ status: "cancelled", results: [] });
  }, 30_000);

  it("production Worker resolver 能完成精确 legacy Fake v1 的 queued 与 paused 恢复", async () => {
    await stopWorker();
    const queued = await createDurableQueuedRun();
    const paused = await createDurableQueuedRun();
    await commands().control({ userId, requestId: randomUUID(), runId: paused.runId, command: { commandId: randomUUID(), action: "pause" } });
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: createJobDiscoveryAdapterResolver({ APP_ENV: "production" }),
      contentStore: new MinioDiscoveryContentStore(minio, minioBucket),
      auditTrail: createAuditTrail({ db: database, clock: () => new Date() }),
      id: randomUUID,
      clock: () => new Date(),
    });
    await expect(processor.process({ version: 1, userId, runId: queued.runId })).resolves.toBe("completed");
    await commands().control({ userId, requestId: randomUUID(), runId: paused.runId, command: { commandId: randomUUID(), action: "resume" } });
    await expect(processor.process({ version: 1, userId, runId: paused.runId })).resolves.toBe("completed");
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: queued.runId })).resolves.toMatchObject({
      workflowVersion: "job-discovery-workflow-v1", adapter: "fake", adapterVersion: "fake-job-discovery-v1", outputSchemaVersion: "job-discovery-result-v1", status: "completed",
    });
  });

  it("test-only retry 场景经真实 Worker 有限重试：retry_once 成功且 retry_until_budget 终止", async () => {
    await stopWorker();
    const retryOnceKey = randomUUID();
    const retryBudgetKey = randomUUID();
    process.env.E2E_AGENT_RUN_SCENARIOS = JSON.stringify({ [retryOnceKey]: "retry_once", [retryBudgetKey]: "retry_until_budget" });
    const retryOnce = await createDurableQueuedRun(retryOnceKey);
    const retryUntilBudget = await createDurableQueuedRun(retryBudgetKey);

    await startWorker();
    await waitFor(
      async () => (await createAgentRunQueries({ db: database }).get({ userId, runId: retryOnce.runId }))?.status === "completed",
      "timed out waiting for retry_once completion",
      45_000,
    );
    await waitFor(
      async () => (await createAgentRunQueries({ db: database }).get({ userId, runId: retryUntilBudget.runId }))?.termination?.kind === "budget_exhausted",
      "timed out waiting for retry_until_budget termination",
      75_000,
    );
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: retryOnce.runId }))
      .resolves.toMatchObject({ status: "completed", attemptCount: 2 });
    await expect(createAgentRunQueries({ db: database }).get({ userId, runId: retryUntilBudget.runId }))
      .resolves.toMatchObject({ status: "failed", termination: { kind: "budget_exhausted", budgetDimension: "attempts" }, results: [] });
  }, 90_000);
});
