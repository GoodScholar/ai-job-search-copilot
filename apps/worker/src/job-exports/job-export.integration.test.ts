import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import Redis from "ioredis";
import { Client as MinioClient } from "minio";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, jobAccounts, jobExports, jobOpportunities, jobSourcePostingVersions, jobSourcePostings, migrateDatabase, type Database } from "@job-copilot/database";
import { JOB_EXPORT_JOB_NAME, JOB_EXPORT_QUEUE } from "@job-copilot/contracts/job-exports";
import { createJobExportCommands, createJobExportProcessor, createJobExportRecoveryQueries, type JobExportStore } from "@job-copilot/domain/job-exports";
import { JobExportConsumer } from "./job-export-consumer.js";
import { JobExportReconciler } from "./job-export-reconciler.js";
import { MinioJobExportStore } from "./minio-job-export-store.js";

const minioImage = "minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const minioAccessKey = "worker-test-access-key";
const minioSecretKey = "worker-test-secret-key";
const minioBucket = "career-documents";

async function waitFor(check: () => Promise<boolean>, message: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

class FailingPutStore implements JobExportStore {
  puts = 0;
  constructor(private readonly store: JobExportStore, private readonly failures: number) {}
  async put(input: Parameters<JobExportStore["put"]>[0]): Promise<void> { this.puts += 1; if (this.puts <= this.failures) throw new Error("transient MinIO write failure"); return this.store.put(input); }
  get(input: Parameters<JobExportStore["get"]>[0]): Promise<Uint8Array> { return this.store.get(input); }
  delete(input: Parameters<JobExportStore["delete"]>[0]): Promise<void> { return this.store.delete(input); }
}

describe("JobExport Worker integration", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let minioContainer: StartedTestContainer;
  let database: Database;
  let redisUrl: string;
  let minio: MinioClient;
  let queue: Queue;
  let queueRedis: Redis;
  let store: JobExportStore;
  let consumer: JobExportConsumer | undefined;
  let reconciler: JobExportReconciler | undefined;

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
    minio = new MinioClient({ endPoint: minioContainer.getHost(), port: minioContainer.getMappedPort(9000), useSSL: false, accessKey: minioAccessKey, secretKey: minioSecretKey });
    await minio.makeBucket(minioBucket);
    queueRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue(JOB_EXPORT_QUEUE, { connection: queueRedis });
  }, 90_000);

  beforeEach(async () => {
    await reconciler?.close(); reconciler = undefined;
    await consumer?.close(); consumer = undefined;
    await queue.drain(true);
    store = new MinioJobExportStore(minio, minioBucket);
  });

  afterAll(async () => {
    await reconciler?.close(); await consumer?.close(); await queue?.close();
    if (queueRedis && queueRedis.status !== "end") await queueRedis.quit();
    await database?.$client.end(); await minioContainer?.stop(); await redisContainer?.stop(); await postgres?.stop();
  });

  function startConsumer(exportStore: JobExportStore): void {
    consumer = new JobExportConsumer({ redisUrl, processor: createJobExportProcessor({ db: database, store: exportStore, clock: () => new Date() }) });
  }

  async function createSnapshot(): Promise<{ userId: string; exportId: string; objectKey: string }> {
    const userId = randomUUID(); const sourcePostingId = randomUUID(); const sourcePostingVersionId = randomUUID(); const opportunityId = randomUUID(); const digest = sourcePostingId.replaceAll("-", "").padEnd(64, "a"); const now = new Date();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobSourcePostings).values({ id: sourcePostingId, userId, sourceType: "user_import", sourceIdentifier: digest, sourceId: "https://jobs.example.test/worker-export", sourceIdentity: {}, isOfficial: false, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId, sourcePostingId, version: 1, contentSha256: digest, rawContentSha256: digest, rawObjectReference: {}, normalizedData: {}, retrievedAt: now, availability: "open", createdAt: now });
    await database.insert(jobOpportunities).values({ id: opportunityId, userId, importId: null, sourcePostingVersionId, canonicalOpportunityId: null, dedupKey: digest, company: "示例科技", title: "Worker 导出岗位", location: "上海", postedAt: null, deadline: null, description: "绝不进入 CSV", normalizedData: {}, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    const commands = createJobExportCommands({ db: database, queue: { enqueue: async () => undefined }, id: () => randomUUID(), clock: () => now });
    const exported = await commands.create({ userId, command: { commandId: randomUUID(), filter: "active", fieldVersion: 1 } });
    const [record] = await database.select({ objectKey: jobExports.objectKey }).from(jobExports).where(eq(jobExports.id, exported.id));
    return { userId, exportId: exported.id, objectKey: record!.objectKey };
  }

  async function enqueue(input: { userId: string; exportId: string }, attempts = 3): Promise<void> {
    await queue.add(JOB_EXPORT_JOB_NAME, { version: 1, userId: input.userId, exportId: input.exportId }, { jobId: input.exportId, attempts, backoff: { type: "fixed", delay: 50 }, removeOnComplete: true, removeOnFail: true });
  }

  it("真实 BullMQ、Postgres 和 MinIO 从冻结行生成可读取的确定性 CSV", async () => {
    const snapshot = await createSnapshot();
    await enqueue(snapshot); startConsumer(store);
    await waitFor(async () => (await database.select({ status: jobExports.status }).from(jobExports).where(eq(jobExports.id, snapshot.exportId)))[0]?.status === "ready", "export was not generated");
    const first = await store.get({ objectKey: snapshot.objectKey });
    expect(new TextDecoder().decode(first)).toContain("Worker 导出岗位");
    expect(new TextDecoder().decode(first)).not.toContain("绝不进入 CSV");
    await consumer!.close(); consumer = undefined;
    await enqueue(snapshot); startConsumer(store);
    await waitFor(async () => (await queue.getJob(snapshot.exportId)) === undefined, "duplicate export job was not consumed");
    await expect(store.get({ objectKey: snapshot.objectKey })).resolves.toEqual(first);
  });

  it("MinIO 首次写入失败后由 BullMQ 重试并最终成功", async () => {
    const snapshot = await createSnapshot(); const flaky = new FailingPutStore(store, 1);
    startConsumer(flaky); await enqueue(snapshot);
    await waitFor(async () => (await database.select({ status: jobExports.status }).from(jobExports).where(eq(jobExports.id, snapshot.exportId)))[0]?.status === "ready", "retry did not finish export");
    expect(flaky.puts).toBe(2);
    await expect(store.get({ objectKey: snapshot.objectKey })).resolves.toBeInstanceOf(Uint8Array);
  });

  it("连续对象写入失败在最后一次尝试后持久化稳定失败码", async () => {
    const snapshot = await createSnapshot(); const failing = new FailingPutStore(store, 10);
    startConsumer(failing); await enqueue(snapshot);
    await waitFor(async () => (await database.select({ status: jobExports.status }).from(jobExports).where(eq(jobExports.id, snapshot.exportId)))[0]?.status === "failed", "terminal export failure was not persisted");
    await expect(database.select({ status: jobExports.status, failureCode: jobExports.failureCode }).from(jobExports).where(eq(jobExports.id, snapshot.exportId)))
      .resolves.toEqual([{ status: "failed", failureCode: "JOB_EXPORT_GENERATION_FAILED" }]);
    expect(failing.puts).toBe(3);
  });

  it("Reconciler 恢复请求提交后未入队的生成快照，并删除到期对象", async () => {
    const snapshot = await createSnapshot();
    reconciler = new JobExportReconciler({ queries: createJobExportRecoveryQueries({ db: database, clock: () => new Date() }), queue: { enqueue: async (job) => enqueue(job) }, store });
    await reconciler.onModuleInit(); startConsumer(store);
    await waitFor(async () => (await database.select({ status: jobExports.status }).from(jobExports).where(eq(jobExports.id, snapshot.exportId)))[0]?.status === "ready", "reconciler did not enqueue export");

    const expiredUserId = randomUUID(); const expiredExportId = randomUUID(); const expiredKey = `accounts/${expiredUserId}/job-exports/${expiredExportId}.csv`; const now = new Date();
    await database.insert(jobAccounts).values({ id: expiredUserId });
    await database.insert(jobExports).values({ id: expiredExportId, userId: expiredUserId, commandId: randomUUID(), filter: "active", fieldVersion: 1, status: "ready", rowCount: 0, objectKey: expiredKey, queuePublishedAt: now, objectDeletedAt: null, failureCode: null, createdAt: new Date(now.getTime() - 2 * 86_400_000), expiresAt: new Date(now.getTime() - 1), updatedAt: now });
    await store.put({ objectKey: expiredKey, bytes: new TextEncoder().encode("expired"), exportId: expiredExportId });
    await reconciler.close();
    reconciler = new JobExportReconciler({ queries: createJobExportRecoveryQueries({ db: database, clock: () => new Date() }), queue: { enqueue: async (job) => enqueue(job) }, store });
    await reconciler.onModuleInit();
    await waitFor(async () => Boolean((await database.select({ objectDeletedAt: jobExports.objectDeletedAt }).from(jobExports).where(eq(jobExports.id, expiredExportId)))[0]?.objectDeletedAt), "expired export object was not cleaned");
    await expect(minio.statObject(minioBucket, expiredKey)).rejects.toThrow();
  });
});
