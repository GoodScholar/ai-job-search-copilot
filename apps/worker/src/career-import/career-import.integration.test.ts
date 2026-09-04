import { createHash, randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { Client as MinioClient } from "minio";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentInboxItems,
  candidateFacts,
  candidateFactEvidence,
  careerDocuments,
  careerImports,
  createDatabase,
  jobAccounts,
  migrateDatabase,
  protectedCareerDocuments,
  type Database,
} from "@job-copilot/database";
import { CAREER_DOCUMENT_MAX_BYTES, CAREER_IMPORT_JOB_NAME, CAREER_IMPORT_QUEUE } from "@job-copilot/contracts/career-import";
import { CAREER_PRIVACY_SCAN_VERSION } from "@job-copilot/contracts/career-document-privacy";
import { createAuditTrail } from "@job-copilot/domain/audit-trail";
import {
  createCareerImportProcessor,
  createCareerImportQueries,
  type CareerDocumentParser,
  type CareerDocumentStore,
} from "@job-copilot/domain/career-imports";
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
    await database.delete(agentInboxItems);
    await database.delete(candidateFactEvidence);
    await database.delete(candidateFacts);
    await database.delete(careerImports);
    await database.delete(protectedCareerDocuments);
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

  function startConsumer(
    documentStore: CareerDocumentStore,
    parser: CareerDocumentParser = new FakeCareerDocumentParser(),
  ): void {
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => new Date() }),
      documentStore,
      parser,
      id: randomUUID,
      clock: () => new Date(),
    });
    consumer = new CareerImportConsumer({ redisUrl, processor });
  }

  async function createQueuedImport(
    sourceMarkdown = markdown,
    protectedOriginal?: string,
    sourceFormat: "markdown" | "docx" = "markdown",
  ): Promise<{ importId: string; documentId: string; objectKey: string }> {
    const importId = randomUUID();
    const documentId = randomUUID();
    const bytes = new TextEncoder().encode(sourceMarkdown);
    const objectKey = `accounts/${userId}/career-documents/${documentId}/processing.${sourceFormat === "docx" ? "txt" : "md"}`;
    await minio.putObject(minioBucket, objectKey, Buffer.from(bytes), bytes.byteLength, {
      "content-type": sourceFormat === "docx" ? "text/plain" : "text/markdown",
      "x-amz-meta-document-id": documentId,
      "x-amz-meta-byte-size": String(bytes.byteLength),
    });
    await database.insert(careerDocuments).values({
      id: documentId,
      userId,
      checksumSha256: checksum(bytes),
      objectKey,
      originalFilename: sourceFormat === "docx" ? "private-resume.docx" : "private-resume.md",
      mediaType: sourceFormat === "docx" ? "text/plain" : "text/markdown",
      sourceFormat,
      byteSize: bytes.byteLength,
      privacyScanVersion: CAREER_PRIVACY_SCAN_VERSION,
    });
    if (protectedOriginal !== undefined) {
      const protectedId = randomUUID();
      const protectedBytes = new TextEncoder().encode(protectedOriginal);
      const protectedObjectKey = `accounts/${userId}/protected-career-documents/${protectedId}/original.md`;
      await minio.putObject(minioBucket, protectedObjectKey, Buffer.from(protectedBytes), protectedBytes.byteLength, {
        "content-type": "text/markdown",
        "x-amz-meta-document-id": protectedId,
        "x-amz-meta-byte-size": String(protectedBytes.byteLength),
      });
      await database.insert(protectedCareerDocuments).values({
        id: protectedId,
        userId,
        processingDocumentId: documentId,
        checksumSha256: checksum(protectedBytes),
        objectKey: protectedObjectKey,
        originalFilename: "private-resume.md",
        mediaType: "text/markdown",
        byteSize: protectedBytes.byteLength,
      });
    }
    await database.insert(careerImports).values({
      id: importId,
      userId,
      careerDocumentId: documentId,
      status: "queued",
      originatingRequestId: randomUUID(),
    });
    return { importId, documentId, objectKey };
  }

  async function enqueue(importId: string, backoffDelay = 1): Promise<void> {
    await queue.add(CAREER_IMPORT_JOB_NAME, { version: 1, importId, userId }, {
      jobId: importId,
      attempts: 3,
      backoff: { type: "fixed", delay: backoffDelay },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  it("用真实队列、对象存储和数据库写入带精确行号的候选事实，且 Redis 载荷不含职业资料", async () => {
    const protectedOriginal = `# 张三\n邮箱：secret@example.com\n${markdown}`;
    const processingCopy = `# [姓名]\n邮箱：[邮箱]\n${markdown}`;
    const item = await createQueuedImport(processingCopy, protectedOriginal);
    await enqueue(item.importId);
    const queuedJob = await queue.getJob(item.importId);
    const payload = JSON.stringify(queuedJob?.data);
    expect(payload).not.toContain(markdown);
    expect(payload).not.toContain("private-resume.md");
    expect(payload).not.toContain("evidence");
    expect(payload).not.toContain("@example.com");

    const [protectedRecord] = await database.select({ objectKey: protectedCareerDocuments.objectKey })
      .from(protectedCareerDocuments);
    expect(protectedRecord?.objectKey).toContain("/protected-career-documents/");
    expect(item.objectKey).toContain("/career-documents/");

    startConsumer(store);
    await waitFor(async () => (await database.select({ status: careerImports.status }).from(careerImports)).at(0)?.status === "completed");

    const facts = await database.select({ factType: candidateFacts.factType, factValue: candidateFacts.factValue })
      .from(candidateFacts);
    expect(facts).toEqual(expect.arrayContaining([
      { factType: "skill", factValue: { name: "TypeScript" } },
      { factType: "skill", factValue: { name: "PostgreSQL" } },
      { factType: "experience", factValue: { summary: "在 Job Copilot 负责后台服务" } },
    ]));
    expect(JSON.stringify(facts)).not.toContain("张三");
    expect(JSON.stringify(facts)).not.toContain("secret@example.com");
    const [detail] = await database.execute<{ start_line: number; end_line: number; excerpt: string }>(
      `select start_line, end_line, excerpt from candidate_fact_evidence order by start_line limit 1`,
    );
    expect(detail).toEqual({ start_line: 5, end_line: 5, excerpt: "- TypeScript" });

    await enqueue(item.importId);
    await waitFor(async () => (await queue.getJob(item.importId)) === undefined);
    const storedFacts = await database.select({ id: candidateFacts.id }).from(candidateFacts)
      ;
    expect(storedFacts).toHaveLength(3);
  });

  it("DOCX 导入时 Worker 只读取 text/plain 脱敏处理副本，并给出可复核的段落证据", async () => {
    const item = await createQueuedImport("## 技能\n- TypeScript", undefined, "docx");
    const document = (await database.select({ id: careerDocuments.id, mediaType: careerDocuments.mediaType, sourceFormat: careerDocuments.sourceFormat, objectKey: careerDocuments.objectKey })
      .from(careerDocuments)).find((record) => record.id === item.documentId);
    expect(document).toMatchObject({ mediaType: "text/plain", sourceFormat: "docx", objectKey: item.objectKey });
    expect(item.objectKey).toMatch(/processing\.txt$/);

    startConsumer(store);
    await enqueue(item.importId);
    await waitFor(async () => (await database.select({ id: careerImports.id, status: careerImports.status }).from(careerImports)).find((record) => record.id === item.importId)?.status === "completed");

    const detail = await createCareerImportQueries({ db: database }).get({ userId, importId: item.importId });
    expect(detail?.facts).toHaveLength(1);
    const persistedEvidence = (await database.select({ careerDocumentId: candidateFactEvidence.careerDocumentId, locatorType: candidateFactEvidence.locatorType })
      .from(candidateFactEvidence)).filter((evidence) => evidence.careerDocumentId === item.documentId);
    expect(persistedEvidence).toEqual([{ careerDocumentId: item.documentId, locatorType: "docx_paragraphs" }]);
    expect(detail?.facts[0]?.evidence).toEqual({
      documentId: item.documentId, sourceFilename: "private-resume.docx", locatorType: "docx_paragraphs",
      startParagraph: 2, endParagraph: 2, excerpt: "- TypeScript",
    });
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

  it("Parser 异常进入 Redis 前会移除职业资料正文", async () => {
    const processingCopy = "# [姓名]\n邮箱：[邮箱]\n## 技能\n- TypeScript";
    const protectedOriginal = "# 张三\n邮箱：secret@example.com\n## 技能\n- TypeScript";
    const item = await createQueuedImport(processingCopy, protectedOriginal);
    startConsumer(store, {
      parse: async (source) => { throw new Error(`parser rejected: ${source}`); },
    });
    await enqueue(item.importId, 10_000);

    await waitFor(async () => (await queue.getJob(item.importId))?.attemptsMade === 1);
    const retryingJob = await queue.getJob(item.importId);
    const serializedFailure = JSON.stringify({
      failedReason: retryingJob?.failedReason,
      stacktrace: retryingJob?.stacktrace,
    });
    expect(retryingJob?.failedReason).toBe("career import temporarily unavailable");
    expect(serializedFailure).not.toContain(processingCopy);
    expect(serializedFailure).not.toContain("TypeScript");
    expect(serializedFailure).not.toContain("secret@example.com");
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

  it("将 Fake Parser 的过长事实在首次任务中稳定标记为无效且不重试", async () => {
    const item = await createQueuedImport(`## 技能\n- ${"x".repeat(501)}`);
    startConsumer(store);
    await enqueue(item.importId);

    await waitFor(async () => (await database.select({ status: careerImports.status }).from(careerImports)).at(0)?.status === "failed");
    const [result] = await database.select({ status: careerImports.status, failureCode: careerImports.failureCode, attemptCount: careerImports.attemptCount })
      .from(careerImports);
    expect(result).toEqual({ status: "failed", failureCode: "CAREER_PARSER_OUTPUT_INVALID", attemptCount: 1 });
    await expect(database.select({ id: candidateFacts.id }).from(candidateFacts)).resolves.toEqual([]);
  });

  it("将近 512 KiB 短列表的第 501 条事实稳定标记为事实数超限", async () => {
    const prefix = "## 技能\n";
    const source = prefix + "- x\n".repeat(Math.floor((CAREER_DOCUMENT_MAX_BYTES - Buffer.byteLength(prefix)) / 4));
    expect(Buffer.byteLength(source)).toBeLessThanOrEqual(CAREER_DOCUMENT_MAX_BYTES);
    const item = await createQueuedImport(source);
    startConsumer(store);
    await enqueue(item.importId);

    await waitFor(async () => (await database.select({ status: careerImports.status }).from(careerImports)).at(0)?.status === "failed");
    const [result] = await database.select({ status: careerImports.status, failureCode: careerImports.failureCode, attemptCount: careerImports.attemptCount })
      .from(careerImports);
    expect(result).toEqual({ status: "failed", failureCode: "CAREER_IMPORT_FACT_LIMIT_EXCEEDED", attemptCount: 1 });
    await expect(database.select({ id: candidateFacts.id }).from(candidateFacts)).resolves.toEqual([]);
  });

});
