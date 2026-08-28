import { createHash, randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { Client as MinioClient } from "minio";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  jobAccounts,
  jobImports,
  jobOpportunities,
  jobOpportunitySources,
  jobSourcePostingVersions,
  migrateDatabase,
  type Database,
} from "@job-copilot/database";
import { JOB_IMPORT_JOB_NAME, JOB_IMPORT_QUEUE } from "@job-copilot/contracts/job-imports";
import { createAuditTrail } from "@job-copilot/domain/audit-trail";
import { createJobImportProcessor, type JobContentStore } from "@job-copilot/domain/job-imports";
import { FakeJobPostingNormalizer } from "./fake-job-posting-normalizer.js";
import { JobImportConsumer } from "./job-import-consumer.js";

const minioImage = "minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const minioAccessKey = "worker-test-access-key";
const minioSecretKey = "worker-test-secret-key";
const minioBucket = "career-documents";
const userId = "20f93bda-36c0-4f61-968b-7f1b03d445d9";

function checksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for job import processing");
}

class MinioStore implements JobContentStore {
  constructor(private readonly client: MinioClient) {}

  async put(input: { objectKey: string; bytes: Uint8Array; mediaType: "text/markdown"; importId: string }): Promise<void> {
    await this.client.putObject(minioBucket, input.objectKey, Buffer.from(input.bytes), input.bytes.byteLength);
  }

  async get({ objectKey }: { objectKey: string }): Promise<Uint8Array> {
    const stream = await this.client.getObject(minioBucket, objectKey);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(new Uint8Array(chunk));
    return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  }

  async delete({ objectKey }: { objectKey: string }): Promise<void> {
    await this.client.removeObject(minioBucket, objectKey);
  }
}

class AlwaysFailingReadStore implements JobContentStore {
  reads = 0;

  constructor(private readonly store: JobContentStore) {}

  put(input: Parameters<JobContentStore["put"]>[0]): Promise<void> { return this.store.put(input); }
  delete(input: Parameters<JobContentStore["delete"]>[0]): Promise<void> { return this.store.delete(input); }
  async get(_input: Parameters<JobContentStore["get"]>[0]): Promise<Uint8Array> {
    this.reads += 1;
    throw new Error("object storage temporarily unavailable");
  }
}

describe("JobImportConsumer", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let minioContainer: StartedTestContainer;
  let database: Database;
  let redisUrl: string;
  let minio: MinioClient;
  let queue: Queue;
  let consumer: JobImportConsumer | undefined;
  let store: JobContentStore;

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
    await database.insert(jobAccounts).values({ id: userId });
    redisUrl = redisContainer.getConnectionUrl();
    minio = new MinioClient({
      endPoint: minioContainer.getHost(), port: minioContainer.getMappedPort(9000), useSSL: false,
      accessKey: minioAccessKey, secretKey: minioSecretKey,
    });
    await minio.makeBucket(minioBucket);
    queue = new Queue(JOB_IMPORT_QUEUE, { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }) });
  }, 90_000);

  beforeEach(async () => {
    await consumer?.close();
    consumer = undefined;
    await queue.drain(true);
    await database.delete(jobOpportunitySources);
    await database.delete(jobOpportunities);
    await database.delete(jobSourcePostingVersions);
    await database.delete(jobImports);
    store = new MinioStore(minio);
  });

  afterAll(async () => {
    await consumer?.close();
    await queue?.close();
    await database?.$client.end();
    await minioContainer?.stop();
    await redisContainer?.stop();
    await postgres?.stop();
  });

  function startConsumer(contentStore: JobContentStore): void {
    consumer = new JobImportConsumer({
      redisUrl,
      processor: createJobImportProcessor({
        db: database,
        auditTrail: createAuditTrail({ db: database, clock: () => new Date() }),
        contentStore,
        normalizer: new FakeJobPostingNormalizer(),
        id: randomUUID,
        clock: () => new Date(),
      }),
    });
  }

  async function createNormalizingImport(content: string): Promise<{ importId: string; objectKey: string }> {
    const importId = randomUUID();
    const objectKey = `accounts/${userId}/job-imports/${importId}/source.md`;
    await store.put({ objectKey, bytes: new TextEncoder().encode(content), mediaType: "text/markdown", importId });
    await database.insert(jobImports).values({
      id: importId, userId, inputType: "pasted_text", contentSha256: checksum(content), status: "normalizing",
    });
    return { importId, objectKey };
  }

  async function enqueue(importId: string, attempts = 3): Promise<void> {
    await queue.add(JOB_IMPORT_JOB_NAME, { version: 1, importId, userId }, {
      jobId: importId, attempts, backoff: { type: "fixed", delay: 1 }, removeOnComplete: true, removeOnFail: true,
    });
  }

  it("处理只含 ID 的队列任务，将 normalizing 岗位导入完成并保持至少一次投递幂等", async () => {
    const content = "# 高级前端工程师\n公司：示例科技\n地点：上海\n未知字段：保持 nullable";
    const item = await createNormalizingImport(content);
    await enqueue(item.importId);
    const queuedJob = await queue.getJob(item.importId);
    expect(JSON.stringify(queuedJob?.data)).toEqual(JSON.stringify({ version: 1, importId: item.importId, userId }));
    expect(JSON.stringify(queuedJob?.data)).not.toContain(content);

    startConsumer(store);
    await waitFor(async () => (await database.select({ status: jobImports.status }).from(jobImports)).at(0)?.status === "completed");
    const [opportunity] = await database.select({ title: jobOpportunities.title, company: jobOpportunities.company, location: jobOpportunities.location, description: jobOpportunities.description })
      .from(jobOpportunities);
    expect(opportunity).toEqual({ title: "高级前端工程师", company: "示例科技", location: "上海", description: null });

    await enqueue(item.importId);
    await waitFor(async () => (await queue.getJob(item.importId)) === undefined);
    await expect(database.select({ id: jobOpportunities.id }).from(jobOpportunities)).resolves.toHaveLength(1);
    await expect(database.select({ id: jobSourcePostingVersions.id }).from(jobSourcePostingVersions)).resolves.toHaveLength(1);
  });

  it("在第三次对象存储读取失败后以最终稳定失败码结束", async () => {
    const item = await createNormalizingImport("# 任意岗位");
    const failingStore = new AlwaysFailingReadStore(store);
    startConsumer(failingStore);
    await enqueue(item.importId);

    await waitFor(async () => (await database.select({ status: jobImports.status }).from(jobImports)).at(0)?.status === "failed");
    const [result] = await database.select({ status: jobImports.status, failureCode: jobImports.failureCode }).from(jobImports);
    expect(result).toEqual({ status: "failed", failureCode: "JOB_IMPORT_CONTENT_READ_FAILED" });
    expect(failingStore.reads).toBe(3);
  });
});
