import { createHash, randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { Client as MinioClient } from "minio";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  candidateFacts,
  candidateFactEvidence,
  careerDocuments,
  careerImports,
  createDatabase,
  jobAccounts,
  migrateDatabase,
  type Database,
} from "@job-copilot/database";
import { CAREER_IMPORT_JOB_NAME, CAREER_IMPORT_QUEUE } from "@job-copilot/contracts/career-import";
import { createAuditTrail } from "@job-copilot/domain/audit-trail";
import { createCareerImportProcessor, type CareerDocumentStore } from "@job-copilot/domain/career-imports";
import { CareerImportConsumer } from "./career-import-consumer.js";
import { FakeCareerDocumentParser } from "./fake-career-document-parser.js";
import { MinioCareerDocumentStore } from "./minio-career-document-store.js";

const minioImage = "minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const minioAccessKey = "worker-test-access-key";
const minioSecretKey = "worker-test-secret-key";
const minioBucket = "career-documents";
const userId = "20f93bda-36c0-4f61-968b-7f1b03d445d9";
const markdown = [
  "# 职业资料",
  "## 技能",
  "- TypeScript",
  "- PostgreSQL",
  "## 工作经历",
  "- 在 Job Copilot 负责后台服务",
].join("\n");

function checksum(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for career import processing");
}

class TransientReadStore implements CareerDocumentStore {
  private reads = 0;

  constructor(private readonly store: CareerDocumentStore, private readonly failures: number) {}

  put(input: Parameters<CareerDocumentStore["put"]>[0]): Promise<void> {
    return this.store.put(input);
  }

  async get(input: Parameters<CareerDocumentStore["get"]>[0]): Promise<Uint8Array> {
    this.reads += 1;
    if (this.reads <= this.failures) throw new Error("temporary object-store read failure");
    return this.store.get(input);
  }
}

describe("CareerImportConsumer", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let minioContainer: StartedTestContainer;
  let database: Database;
  let redisUrl: string;
  let minio: MinioClient;
  let queue: Queue;
  let consumer: CareerImportConsumer | undefined;
  let store: CareerDocumentStore;

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
      endPoint: minioContainer.getHost(),
      port: minioContainer.getMappedPort(9000),
      useSSL: false,
      accessKey: minioAccessKey,
      secretKey: minioSecretKey,
    });
    await minio.makeBucket(minioBucket);
    queue = new Queue(CAREER_IMPORT_QUEUE, { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }) });
  }, 90_000);

  beforeEach(async () => {
    await consumer?.close();
    consumer = undefined;
    await queue.drain(true);
    await database.delete(candidateFactEvidence);
    await database.delete(candidateFacts);
    await database.delete(careerImports);
    await database.delete(careerDocuments);
    store = new MinioCareerDocumentStore(minio, minioBucket);
  });

  afterAll(async () => {
    await consumer?.close();
    await queue?.close();
    await database?.$client.end();
    await minioContainer?.stop();
    await redisContainer?.stop();
    await postgres?.stop();
  });

  function startConsumer(documentStore: CareerDocumentStore): void {
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => new Date() }),
      documentStore,
      parser: new FakeCareerDocumentParser(),
      id: randomUUID,
      clock: () => new Date(),
    });
    consumer = new CareerImportConsumer({ redisUrl, processor });
  }

  async function createQueuedImport(): Promise<{ importId: string; documentId: string; objectKey: string }> {
    const importId = randomUUID();
    const documentId = randomUUID();
    const bytes = new TextEncoder().encode(markdown);
    const objectKey = `accounts/${userId}/career-documents/${documentId}/source.md`;
    await minio.putObject(minioBucket, objectKey, Buffer.from(bytes), bytes.byteLength, {
      "content-type": "text/markdown",
      "x-amz-meta-document-id": documentId,
      "x-amz-meta-byte-size": String(bytes.byteLength),
    });
    await database.insert(careerDocuments).values({
      id: documentId,
      userId,
      checksumSha256: checksum(bytes),
      objectKey,
      originalFilename: "private-resume.md",
      mediaType: "text/markdown",
      byteSize: bytes.byteLength,
    });
    await database.insert(careerImports).values({
      id: importId,
      userId,
      careerDocumentId: documentId,
      status: "queued",
      originatingRequestId: randomUUID(),
    });
    return { importId, documentId, objectKey };
  }

  async function enqueue(importId: string): Promise<void> {
    await queue.add(CAREER_IMPORT_JOB_NAME, { version: 1, importId, userId }, {
      jobId: importId,
      attempts: 3,
      backoff: { type: "fixed", delay: 1 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  it("用真实队列、对象存储和数据库写入带精确行号的候选事实，且 Redis 载荷不含职业资料", async () => {
    const item = await createQueuedImport();
    await enqueue(item.importId);
    const queuedJob = await queue.getJob(item.importId);
    const payload = JSON.stringify(queuedJob?.data);
    expect(payload).not.toContain(markdown);
    expect(payload).not.toContain("private-resume.md");
    expect(payload).not.toContain("evidence");
    expect(payload).not.toContain("@example.com");

    startConsumer(store);
    await waitFor(async () => (await database.select({ status: careerImports.status }).from(careerImports)).at(0)?.status === "completed");

    const facts = await database.select({ factType: candidateFacts.factType, factValue: candidateFacts.factValue })
      .from(candidateFacts);
    expect(facts).toEqual(expect.arrayContaining([
      { factType: "skill", factValue: { name: "TypeScript" } },
      { factType: "skill", factValue: { name: "PostgreSQL" } },
      { factType: "experience", factValue: { summary: "在 Job Copilot 负责后台服务" } },
    ]));
    const [detail] = await database.execute<{ start_line: number; end_line: number; excerpt: string }>(
      `select start_line, end_line, excerpt from candidate_fact_evidence order by start_line limit 1`,
    );
    expect(detail).toEqual({ start_line: 3, end_line: 3, excerpt: "- TypeScript" });

    await enqueue(item.importId);
    await waitFor(async () => (await queue.getJob(item.importId)) === undefined);
    const storedFacts = await database.select({ id: candidateFacts.id }).from(candidateFacts)
      ;
    expect(storedFacts).toHaveLength(3);
  });

  it("在第一次临时读取错误后从 processing 恢复，并把真实尝试次数记为二", async () => {
    const item = await createQueuedImport();
    startConsumer(new TransientReadStore(store, 1));
    await enqueue(item.importId);

    await waitFor(async () => (await database.select({ status: careerImports.status }).from(careerImports)).at(0)?.status === "completed");
    const [result] = await database.select({ status: careerImports.status, attemptCount: careerImports.attemptCount })
      .from(careerImports);
    expect(result).toEqual({ status: "completed", attemptCount: 2 });
  });

  it("三次临时读取错误后以稳定失败码结束且不写入候选事实", async () => {
    const item = await createQueuedImport();
    startConsumer(new TransientReadStore(store, 3));
    await enqueue(item.importId);

    await waitFor(async () => (await database.select({ status: careerImports.status }).from(careerImports)).at(0)?.status === "failed");
    const [result] = await database.select({ status: careerImports.status, failureCode: careerImports.failureCode, attemptCount: careerImports.attemptCount })
      .from(careerImports);
    expect(result).toEqual({ status: "failed", failureCode: "CAREER_DOCUMENT_READ_FAILED", attemptCount: 3 });
    const facts = await database.select({ id: candidateFacts.id }).from(candidateFacts)
      ;
    expect(facts).toHaveLength(0);
  });
});
