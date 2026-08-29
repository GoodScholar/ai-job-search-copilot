import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
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
import { createAgentRunCommands, createAgentRunQueries, createAgentRunRecoveryQueries } from "@job-copilot/domain/agent-runs";
import { createAuditTrail } from "@job-copilot/domain/audit-trail";

import { AppModule } from "../app.module.js";
import { AGENT_RUN_CONSUMER } from "./agent-run.module.js";
import type { AgentRunConsumer } from "./agent-run-consumer.js";
import { agentRunQueueJobOptions } from "./agent-run-reconciler.js";
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
    await context?.close();
    await queue?.close();
    if (queueRedis?.status !== "end") await queueRedis.quit();
    await database?.$client.end();
    await minioContainer?.stop();
    await redisContainer?.stop();
    await postgres?.stop();
    for (const [key, value] of Object.entries(originalEnvironment ?? {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function createDurableQueuedRun() {
    return createAgentRunCommands({
      db: database,
      queue: { enqueue: async () => { throw new Error("API queue wakeup unavailable"); } },
      auditTrail: createAuditTrail({ db: database, clock: () => new Date() }),
      id: randomUUID,
      clock: () => new Date(),
    }).start({
      userId,
      requestId: randomUUID(),
      command: { targetId, idempotencyKey: randomUUID() },
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
    expect(firstDetail?.events.map((event) => event.eventType)).toEqual([
      "run.queued", "run.started", "step.started", "step.completed", "step.started",
      "step.completed", "step.started", "step.completed", "run.completed",
    ]);
    expect(firstDetail?.results).toHaveLength(5);
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
          claim_expires_at = now() - interval '1 second', started_at = now() - interval '31 seconds', attempt_count = 1
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
});
