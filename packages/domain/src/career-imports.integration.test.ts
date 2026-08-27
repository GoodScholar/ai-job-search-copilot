import { createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  candidateFacts,
  careerDocuments,
  careerImports,
  createDatabase,
  jobAccounts,
  migrateDatabase,
  type Database,
} from "@job-copilot/database";
import type { CareerImportJob } from "@job-copilot/contracts/career-import";
import { createAuditTrail, type AuditTrail } from "./audit-trail";
import {
  CareerImportError,
  createCareerImportCommands,
  createCareerImportProcessor,
  createCareerImportQueries,
  type CareerDocumentParser,
  type CareerDocumentStore,
  type CareerImportQueue,
} from "./career-imports";

const userId = "d12a48e4-a405-4412-bb3e-4f2201aa4041";
const otherUserId = "59c51a20-1e09-4e52-af34-17b2df6ad937";
const now = new Date("2026-08-27T12:00:00.000Z");
const markdown = ["# 候选人", "", "## 技能", "", "", "- TypeScript"].join("\n");
const bytes = new TextEncoder().encode(markdown);

class MemoryStore implements CareerDocumentStore {
  readonly puts: Array<{ objectKey: string; bytes: Uint8Array; documentId: string }> = [];
  private readonly objects = new Map<string, Uint8Array>();

  async put(input: { objectKey: string; bytes: Uint8Array; mediaType: "text/markdown"; documentId: string }): Promise<void> {
    this.puts.push(input);
    this.objects.set(input.objectKey, input.bytes);
  }

  async get({ objectKey }: { objectKey: string }): Promise<Uint8Array> {
    const object = this.objects.get(objectKey);
    if (!object) throw new Error("object missing");
    return object;
  }

  replace(objectKey: string, value: Uint8Array): void {
    this.objects.set(objectKey, value);
  }
}

class MemoryQueue implements CareerImportQueue {
  readonly jobs: CareerImportJob[] = [];
  failNext = false;

  async enqueue(job: CareerImportJob): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("queue unavailable");
    }
    this.jobs.push(job);
  }
}

function ids(...values: string[]): () => string {
  return () => {
    const value = values.shift();
    if (!value) throw new Error("test ids exhausted");
    return value;
  };
}

function parser(output: unknown): CareerDocumentParser {
  return { parse: async () => output };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  return { promise: new Promise<T>((accept, decline) => { resolve = accept; reject = decline; }), resolve, reject };
}

function validOutput() {
  return {
    adapter: "fake",
    parserVersion: "fake-career-parser-v1",
    promptVersion: "career-import-prompt-v1",
    outputSchemaVersion: "career-facts-v1",
    facts: [{
      factType: "skill",
      factValue: { name: "TypeScript" },
      confidenceBasisPoints: 10_000,
      grounding: "quoted",
      evidence: { locatorType: "markdown_lines", startLine: 6, endLine: 6, excerpt: "- TypeScript" },
    }],
  };
}

describe("career imports", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
    await database.insert(jobAccounts).values([{ id: userId }, { id: otherUserId }]);
  }, 60_000);

  afterAll(async () => {
    await database?.$client.end();
    await container?.stop();
  });

  function commandsFor(documentStore: MemoryStore, queue: MemoryQueue, nextId: () => string) {
    return createCareerImportCommands({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore,
      queue,
      id: nextId,
      clock: () => now,
    });
  }

  async function createImport(input: {
    documentStore: MemoryStore;
    queue: MemoryQueue;
    ids: () => string;
    requestId: string;
    userId?: string;
    sourceBytes?: Uint8Array;
  }) {
    return commandsFor(input.documentStore, input.queue, input.ids).createOrReuse({
      userId: input.userId ?? userId,
      requestId: input.requestId,
      bytes: input.sourceBytes ?? new TextEncoder().encode(`${markdown}\n<!-- ${input.requestId} -->`),
      originalFilename: "resume.md",
      mediaType: "text/markdown",
    });
  }

  it("reuses a same-account checksum, stores it once, and re-enqueues a queued import", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const commands = commandsFor(store, queue, ids(
      "c0fb8c03-680b-4c59-bc99-8988780c4923",
      "4367ff09-16c5-4a27-93c6-46b0efb9423a",
    ));

    const first = await commands.createOrReuse({
      userId,
      requestId: "64ea6ab2-2793-479b-9981-b48e8c32c5e0",
      bytes,
      originalFilename: "resume.md",
      mediaType: "text/markdown",
    });
    const duplicate = await commands.createOrReuse({
      userId,
      requestId: "e9d4e78b-991f-4c1a-ad93-9fd8958ba628",
      bytes,
      originalFilename: "renamed.md",
      mediaType: "text/markdown",
    });

    expect(first).toMatchObject({ status: "queued", reused: false, shouldReturnAccepted: true });
    expect(duplicate).toMatchObject({
      importId: first.importId,
      documentId: first.documentId,
      status: "queued",
      reused: true,
      shouldReturnAccepted: false,
    });
    expect(queue.jobs).toEqual([
      expect.objectContaining({ importId: first.importId, userId }),
      expect.objectContaining({ importId: first.importId, userId }),
    ]);
    expect(store.puts).toHaveLength(1);
  });

  it("creates and accepts a new import when an owned document exists without one", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const sourceBytes = new TextEncoder().encode("## 技能\n- Existing document");
    const documentId = "fe5ea64c-d7b7-423c-8f2e-07d97e7e4385";
    await database.insert(careerDocuments).values({
      id: documentId,
      userId,
      checksumSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      objectKey: `accounts/${userId}/career-documents/${documentId}/source.md`,
      originalFilename: "existing.md",
      mediaType: "text/markdown",
      byteSize: sourceBytes.byteLength,
    });

    const result = await commandsFor(store, queue, ids("ec2dbf66-9eb3-463a-9d26-b0fef10e19aa")).createOrReuse({
      userId,
      requestId: "ff7f5dd4-c572-4f26-84fa-e6c09fec363b",
      bytes: sourceBytes,
      originalFilename: "renamed.md",
      mediaType: "text/markdown",
    });

    expect(result).toMatchObject({ documentId, status: "queued", reused: false, shouldReturnAccepted: true });
    expect(queue.jobs).toEqual([expect.objectContaining({ importId: result.importId, userId })]);
  });

  it("does not reuse a checksum across job accounts", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const first = await createImport({
      documentStore: store,
      queue,
      ids: ids("2e7d5512-8c22-4f20-bb4e-bc2a6a6a1383", "0910e662-67e6-4f6a-96a2-685444552d5d"),
      requestId: "41e47c48-055b-4a46-bd32-3c6483394bc1",
    });
    const second = await createImport({
      documentStore: store,
      queue,
      ids: ids("f5f5037d-5c27-47fc-8460-9613a034974d", "944293db-4306-4d22-95f2-a7e35b65fa63"),
      requestId: "90d8f6ff-15b0-4389-8c8d-e9ea307af65f",
      userId: otherUserId,
    });

    expect(second).toMatchObject({ reused: false, shouldReturnAccepted: true });
    expect(second.documentId).not.toBe(first.documentId);
    expect(store.puts).toHaveLength(2);
  });

  it("writes an object only once when concurrent requests reserve the same checksum", async () => {
    const firstPutStarted = deferred<void>();
    const releaseFirstPut = deferred<void>();
    const secondPutStarted = deferred<void>();
    const objects = new Map<string, Uint8Array>();
    const puts: string[] = [];
    const store: CareerDocumentStore = {
      put: async ({ objectKey, bytes: sourceBytes }) => {
        puts.push(objectKey);
        if (puts.length === 1) {
          firstPutStarted.resolve();
          await releaseFirstPut.promise;
        } else {
          secondPutStarted.resolve();
        }
        objects.set(objectKey, sourceBytes);
      },
      get: async ({ objectKey }) => objects.get(objectKey)!,
    };
    const queue = new MemoryQueue();
    const commands = createCareerImportCommands({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      queue,
      id: ids("5f813441-9b95-4bf0-b6c9-25e0f7f0d995", "57c83fce-87d9-42f9-b4f4-a750fac1cbb9", "5f415f5d-5d62-4663-a949-d5f375c4d56a", "1fba8e3e-9731-4d4f-a8aa-d2a9e448db77"),
      clock: () => now,
    });
    const input = {
      userId,
      bytes: new TextEncoder().encode("## 技能\n- Concurrent object"),
      originalFilename: "resume.md" as const,
      mediaType: "text/markdown" as const,
    };

    const first = commands.createOrReuse({ ...input, requestId: "431d5b82-6956-4dfa-9b1b-ece9414a3b0b" });
    await firstPutStarted.promise;
    const second = commands.createOrReuse({ ...input, requestId: "e29f8a75-7676-44f7-8fa7-7e4de1f4a558" });
    expect(await Promise.race([
      secondPutStarted.promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 75)),
    ])).toBe(false);
    releaseFirstPut.resolve();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.documentId).toBe(secondResult.documentId);
    expect(puts).toHaveLength(1);
  });

  it("lets the database reject a cross-account import relation", async () => {
    const sourceBytes = new TextEncoder().encode("## 技能\n- Cross account fallback");
    const checksumSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const documentId = "55120b0b-5f42-4136-8710-55ec76c43b71";
    await database.insert(careerDocuments).values({
      id: documentId, userId, checksumSha256, objectKey: `accounts/${userId}/career-documents/${documentId}/source.md`,
      originalFilename: "resume.md", mediaType: "text/markdown", byteSize: sourceBytes.byteLength,
    });
    await expect(database.insert(careerImports).values({
      id: "487751a6-6f9d-4604-9e04-fd178a9e66c2", userId: otherUserId, careerDocumentId: documentId,
      originatingRequestId: "efeb44e8-1c16-46a4-9c92-d7987255f6a5",
    })).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("marks a queue failure as retryable and atomically returns the same failed import to queued", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    queue.failNext = true;
    const commands = commandsFor(store, queue, ids(
      "a504bd72-9bc4-4ba1-bc85-da55f4feec4a",
      "cbff2458-5f51-432f-bfa2-00a8e2d6c29c",
    ));
    const requestId = "d81a9a12-b372-41fb-98f3-1273478ba2c5";

    await expect(commands.createOrReuse({
      userId,
      requestId,
      bytes: new TextEncoder().encode("## 技能\n- Queue failure"),
      originalFilename: "resume.md",
      mediaType: "text/markdown",
    })).rejects.toMatchObject({ code: "CAREER_IMPORT_QUEUE_UNAVAILABLE" } satisfies Partial<CareerImportError>);

    const [failed] = await database.select().from(careerImports)
      .where(eq(careerImports.originatingRequestId, requestId));
    expect(failed).toMatchObject({ status: "failed", failureCode: "CAREER_IMPORT_QUEUE_UNAVAILABLE" });

    const retried = await commands.createOrReuse({
      userId,
      requestId: "c480341e-b071-46ef-a497-91bdd59db64a",
      bytes: new TextEncoder().encode("## 技能\n- Queue failure"),
      originalFilename: "renamed.md",
      mediaType: "text/markdown",
    });
    expect(retried).toMatchObject({ importId: failed?.id, status: "queued", reused: true, shouldReturnAccepted: true });
    expect(queue.jobs).toEqual([expect.objectContaining({ importId: failed?.id, userId })]);
  });

  it("audits the persisted attempt count when a failed import cannot be re-enqueued", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store,
      queue,
      ids: ids("ceb03b55-104d-402d-b997-a1a40ac18ef1", "c70cff11-6d8e-46e5-b214-bae5fe0c19fb"),
      requestId: "162bf6b6-a764-4823-987e-8a8d815ad51d",
      sourceBytes: new TextEncoder().encode("## 技能\n- Audit attempt"),
    });
    await database.update(careerImports).set({
      status: "failed",
      failureCode: "CAREER_DOCUMENT_READ_FAILED",
      attemptCount: 2,
    }).where(eq(careerImports.id, created.importId));
    queue.failNext = true;

    await expect(commandsFor(store, queue, ids()).createOrReuse({
      userId,
      requestId: "73d043bc-8083-451a-9457-207b7b7e899e",
      bytes: new TextEncoder().encode("## 技能\n- Audit attempt"),
      originalFilename: "resume.md",
      mediaType: "text/markdown",
    })).rejects.toMatchObject({ code: "CAREER_IMPORT_QUEUE_UNAVAILABLE" } satisfies Partial<CareerImportError>);

    const events = await createAuditTrail({ db: database, clock: () => now }).query({ userId });
    expect(events.filter((event) => event.resourceId === created.importId && event.reasonCode === "CAREER_IMPORT_QUEUE_UNAVAILABLE").at(-1))
      .toMatchObject({ metadata: { attemptCount: 2, failureCode: "CAREER_IMPORT_QUEUE_UNAVAILABLE" } });
  });

  it("re-reads and re-enqueues the authoritative queued state when a failed requeue CAS loses", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store,
      queue,
      ids: ids("f87b9b12-d7fe-4458-9f73-f50530926816", "fcef1493-46b0-4a54-947c-ddd4d3743616"),
      requestId: "5fc0d12c-cc27-40e4-9db9-51eb52a0c6cf",
      sourceBytes: new TextEncoder().encode("## 技能\n- Requeue race"),
    });
    await database.update(careerImports).set({ status: "failed", failureCode: "CAREER_DOCUMENT_READ_FAILED" })
      .where(eq(careerImports.id, created.importId));
    const enteredFirstAudit = deferred<void>();
    const releaseFirstAudit = deferred<void>();
    let blocked = false;
    const baseAuditTrail = createAuditTrail({ db: database, clock: () => now });
    const auditTrail: AuditTrail = {
      append: (event) => baseAuditTrail.append(event),
      query: (input) => baseAuditTrail.query(input),
      bind(transaction) {
        const bound = baseAuditTrail.bind(transaction);
        return {
          ...bound,
          bind: auditTrail.bind,
          append: async (event) => {
            if (event.eventType === "career.document_import_queued" && !blocked) {
              blocked = true;
              enteredFirstAudit.resolve();
              await releaseFirstAudit.promise;
            }
            await bound.append(event);
          },
        };
      },
    };
    const commands = createCareerImportCommands({
      db: database, auditTrail, documentStore: store, queue,
      id: ids("8d2dd82c-f174-4769-9c2a-5d4b3a7f5c97", "4871faf6-a6bc-4fea-b26f-88b20a13d821"), clock: () => now,
    });
    const input = {
      userId, bytes: new TextEncoder().encode("## 技能\n- Requeue race"), originalFilename: "resume.md" as const,
      mediaType: "text/markdown" as const,
    };

    const first = commands.createOrReuse({ ...input, requestId: "c8530edc-965d-456d-8c44-b9d0a3477879" });
    await enteredFirstAudit.promise;
    const second = commands.createOrReuse({ ...input, requestId: "7657b7e6-9f0f-4783-9a7f-79a8c3f64a7d" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFirstAudit.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ importId: created.importId, status: "queued", shouldReturnAccepted: true }),
      expect.objectContaining({ importId: created.importId, status: "queued", shouldReturnAccepted: false }),
    ]);
    expect(queue.jobs.filter((job) => job.importId === created.importId)).toHaveLength(3);
  });

  it("never enqueues a completed import when it is uploaded again", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store,
      queue,
      ids: ids("ccfbc8a5-e7e5-4141-a889-ee303c68efce", "b66a3f70-43f0-438c-9cf2-6e166c1c6ae4"),
      requestId: "4c4a1b96-edb0-4167-8dd1-20b7033ed9a9",
      sourceBytes: new TextEncoder().encode("## 技能\n- Completed only"),
    });
    const queries = createCareerImportQueries({ db: database });
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      parser: parser({ ...validOutput(), facts: [{ ...validOutput().facts[0], factValue: { name: "Completed only" }, evidence: { locatorType: "markdown_lines", startLine: 2, endLine: 2, excerpt: "- Completed only" } }] }),
      id: ids("0e3bcdd3-6750-4bb8-97af-a0e1dc16fb77", "3e516f0c-99e1-4844-bdbe-b6ba19d08846"),
      clock: () => now,
    });
    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("completed");

    const duplicate = await createImport({
      documentStore: store,
      queue,
      ids: ids("92f3e6aa-59fe-405e-981f-3b1ffc262bcd"),
      requestId: "973fe2fa-6e83-4b1e-80ea-32a66c3ee91a",
      sourceBytes: new TextEncoder().encode("## 技能\n- Completed only"),
    });
    expect(duplicate).toMatchObject({ importId: created.importId, status: "completed", reused: true, shouldReturnAccepted: false });
    expect(queue.jobs).toHaveLength(1);
    await expect(queries.get({ userId, importId: created.importId })).resolves.toMatchObject({ status: "completed" });
  });

  it("re-enqueues a processing import on a repeated upload without changing its HTTP semantics", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const sourceBytes = new TextEncoder().encode("## 技能\n- Repair processing");
    const created = await createImport({
      documentStore: store, queue,
      ids: ids("8fe7c5dc-1a65-4e82-970b-8e807d24e58b", "ae9a0e29-b5d5-4cb8-b224-a5fd7d0328cb"),
      requestId: "b3c93594-8c7d-483b-a380-47db6765f37f", sourceBytes,
    });
    await database.update(careerImports).set({ status: "processing" }).where(eq(careerImports.id, created.importId));

    const repeated = await createImport({
      documentStore: store, queue, ids: ids("9bf7169a-fd22-48af-91a3-aac0ac4ce463"),
      requestId: "fd746cca-df9e-425e-a3aa-6e23a4639f1b", sourceBytes,
    });
    expect(repeated).toMatchObject({ importId: created.importId, status: "processing", reused: true, shouldReturnAccepted: false });
    expect(queue.jobs.filter((job) => job.importId === created.importId)).toHaveLength(2);
  });

  it("commits quoted facts, evidence, completion, and redacted completion audit together", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store,
      queue,
      ids: ids("3462f8f8-12fa-4e81-a513-824dad646f5a", "c8bded26-a439-4d4b-99bf-671bb1d9878f"),
      requestId: "b94c03c2-67c2-461a-b3bf-1c1e9d69fa91",
    });
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      parser: parser(validOutput()),
      id: ids("1d337eb5-51ce-4d81-8c3b-05cbfd5a50ef", "7b9c4b9c-3e58-44a3-b5fb-bcb7c7cc4374"),
      clock: () => now,
    });
    const queries = createCareerImportQueries({ db: database });

    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("completed");
    await expect(queries.list({ userId })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ importId: created.importId, candidateFactCount: 1 }),
    ]));
    await expect(queries.get({ userId, importId: created.importId })).resolves.toMatchObject({
      status: "completed",
      facts: [expect.objectContaining({
        confirmationStatus: "pending",
        factValue: { name: "TypeScript" },
        evidence: expect.objectContaining({ startLine: 6, endLine: 6, excerpt: "- TypeScript" }),
      })],
    });
  });

  it("rolls back facts and completion when the transaction-bound completion audit rejects", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store,
      queue,
      ids: ids("13530687-aaf2-49e3-b6e6-bf5d9988a631", "cb440432-8750-405a-8868-07f472899ba1"),
      requestId: "a50842b5-c35c-4086-9b52-8e6063ed6ea9",
    });
    const unboundAuditTrail = createAuditTrail({ db: database, clock: () => now });
    const rejectingBoundAuditTrail: AuditTrail = {
      append: async () => { throw new Error("completion audit unavailable"); },
      bind: () => rejectingBoundAuditTrail,
      query: async () => [],
    };
    const auditTrail: AuditTrail = {
      ...unboundAuditTrail,
      bind: () => rejectingBoundAuditTrail,
    };
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail,
      documentStore: store,
      parser: parser(validOutput()),
      id: ids("0c17b971-6a1f-4e28-8a7f-16b3783a9844", "5569bf1e-1f31-4522-b7da-2f6ea5fc6a31"),
      clock: () => now,
    });

    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .rejects.toThrow(/completion audit unavailable/);
    await expect(database.select().from(candidateFacts).where(eq(candidateFacts.careerImportId, created.importId)))
      .resolves.toEqual([]);
    await expect(createCareerImportQueries({ db: database }).get({ userId, importId: created.importId }))
      .resolves.toMatchObject({ status: "processing", facts: [] });
  });

  it("persists only quoted facts whose evidence matches their declared lines", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store,
      queue,
      ids: ids("0e7efc1d-e3b5-4b69-9821-20df5eccdeea", "8902e5fa-d1ae-4a73-98cf-a1e5949f1881"),
      requestId: "f5d6ecee-518b-4cd5-b9d2-a70629864655",
      sourceBytes: new TextEncoder().encode("## 技能\n- TypeScript\n- Rust"),
    });
    const output = validOutput();
    output.facts = [
      { ...output.facts[0], evidence: { locatorType: "markdown_lines", startLine: 2, endLine: 2, excerpt: "- TypeScript" } },
      { ...output.facts[0], factValue: { name: "Rust" }, evidence: { locatorType: "markdown_lines", startLine: 3, endLine: 3, excerpt: "- Go" } },
    ];
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      parser: parser(output),
      id: ids("c4652439-6b49-4452-aee1-bf5d633e6535", "69eb21c8-5dcc-416c-ace4-f68e6410e1be", "6fd96967-8bcc-4edf-a478-3c715ec0f84c", "f5169193-1263-4f08-8b3d-8fa6d271a092"),
      clock: () => now,
    });

    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("completed");
    await expect(createCareerImportQueries({ db: database }).get({ userId, importId: created.importId }))
      .resolves.toMatchObject({ status: "completed", facts: [expect.objectContaining({ factValue: { name: "TypeScript" } })] });
    await expect(database.select().from(candidateFacts).where(eq(candidateFacts.careerImportId, created.importId)))
      .resolves.toHaveLength(1);
  });

  it("rejects a quoted fact when its value is not parsed from its exact evidence line", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store,
      queue,
      ids: ids("b9518fd1-d279-491c-a2d7-e048c519a109", "dc0caeae-2dcd-4e04-9d4b-4347b6db66a4"),
      requestId: "bbf5710c-01f5-41ea-b913-50106bb80b29",
      sourceBytes: new TextEncoder().encode("## 技能\n- TypeScript"),
    });
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      parser: parser({ ...validOutput(), facts: [{
        ...validOutput().facts[0],
        factValue: { name: "Rust" },
        evidence: { locatorType: "markdown_lines", startLine: 2, endLine: 2, excerpt: "- TypeScript" },
      }] }),
      id: ids("9b983e90-5c30-459f-8749-36a050c770e2", "2c3d9128-43bf-4ddb-9f09-2df90f946bfe"),
      clock: () => now,
    });

    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("failed");
    await expect(createCareerImportQueries({ db: database }).get({ userId, importId: created.importId }))
      .resolves.toMatchObject({ status: "failed", failureCode: "NO_SUPPORTED_FACTS", facts: [] });
  });

  it("persists exact indented and trailing-whitespace evidence from the fake parser form", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store,
      queue,
      ids: ids("2cbf991c-5237-43a3-a6cf-c1e49da05986", "c17d9083-fec5-428c-8eb3-4024cce1dcfb"),
      requestId: "f1656d30-d2f1-4f1a-8473-53a6deeb29be",
      sourceBytes: new TextEncoder().encode("## 技能\n  - TypeScript  "),
    });
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      parser: parser({ ...validOutput(), facts: [{
        ...validOutput().facts[0],
        evidence: { locatorType: "markdown_lines", startLine: 2, endLine: 2, excerpt: "  - TypeScript  " },
      }] }),
      id: ids("0c5c9f44-dc69-49bf-b801-fa3bb19f0a7d", "b8579e64-a038-4073-aec2-0227220c87e2"),
      clock: () => now,
    });

    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("completed");
    await expect(createCareerImportQueries({ db: database }).get({ userId, importId: created.importId }))
      .resolves.toMatchObject({ facts: [expect.objectContaining({ evidence: expect.objectContaining({ excerpt: "  - TypeScript  " }) })] });
  });

  it("fails an over-limit raw parser output once without persisting facts", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store,
      queue,
      ids: ids("4b21c803-087a-44c7-8fc9-73196da43a7c", "55fd4433-c959-4eef-b1a8-7ff26a86f6ce"),
      requestId: "0a7ec9b3-0f2f-48ca-b52a-aae5d368a941",
      sourceBytes: new TextEncoder().encode("## 技能\n- Invalid parser overflow source"),
    });
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      parser: parser({ ...validOutput(), facts: Array.from({ length: 501 }, () => validOutput().facts[0]) }),
      id: ids("63590df1-e94f-4111-bfc9-580400ecc253"),
      clock: () => now,
    });

    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("failed");
    await expect(createCareerImportQueries({ db: database }).get({ userId, importId: created.importId }))
      .resolves.toMatchObject({ status: "failed", failureCode: "CAREER_IMPORT_FACT_LIMIT_EXCEEDED", facts: [] });
    await expect(database.select({ attemptCount: careerImports.attemptCount }).from(careerImports)
      .where(eq(careerImports.id, created.importId))).resolves.toEqual([{ attemptCount: 1 }]);
    await expect(database.select().from(candidateFacts).where(eq(candidateFacts.careerImportId, created.importId)))
      .resolves.toEqual([]);
  });

  it("accepts a C# project heading as exact quoted evidence", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store,
      queue,
      ids: ids("d6b0ee7c-4013-44ce-a459-5bfdf29cbe7b", "89af2577-058e-4a4d-b98f-8decd85ef293"),
      requestId: "9cae85bd-398a-4a15-8e25-d5461206ef2d",
      sourceBytes: new TextEncoder().encode("## 项目经历\n### C# ###"),
    });
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      parser: parser({ ...validOutput(), facts: [{
        ...validOutput().facts[0],
        factType: "project",
        factValue: { summary: "C#" },
        evidence: { locatorType: "markdown_lines", startLine: 2, endLine: 2, excerpt: "### C# ###" },
      }] }),
      id: ids("6d7b4ac8-4c41-4319-a195-685fb5e0ca21", "c26a6095-af41-4a55-9324-321d6e0e9e41"),
      clock: () => now,
    });

    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("completed");
  });

  it.each([
    ["inferred grounding", { ...validOutput(), facts: [{ ...validOutput().facts[0], grounding: "inferred" }] }, "CAREER_PARSER_OUTPUT_INVALID"],
    ["missing evidence", { ...validOutput(), facts: [{ ...validOutput().facts[0], evidence: undefined }] }, "CAREER_PARSER_OUTPUT_INVALID"],
    ["unknown parser field", { ...validOutput(), privateEmail: "secret@example.test" }, "CAREER_PARSER_OUTPUT_INVALID"],
    ["out of range evidence", { ...validOutput(), facts: [{ ...validOutput().facts[0], evidence: { locatorType: "markdown_lines", startLine: 7, endLine: 7, excerpt: "- TypeScript" } }] }, "NO_SUPPORTED_FACTS"],
    ["empty valid fact list", { ...validOutput(), facts: [] }, "NO_SUPPORTED_FACTS"],
  ])("persists no facts for %s", async (_name, output, failureCode) => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store,
      queue,
      ids: ids(crypto.randomUUID(), crypto.randomUUID()),
      requestId: crypto.randomUUID(),
    });
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      parser: parser(output),
      id: ids(crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()),
      clock: () => now,
    });

    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("failed");
    await expect(createCareerImportQueries({ db: database }).get({ userId, importId: created.importId }))
      .resolves.toMatchObject({ status: "failed", failureCode, facts: [] });
  });

  it("rejects an evidence end line beyond the document even when slicing would match its excerpt", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store, queue,
      ids: ids("4d6fc1ed-49b5-4d4b-9eb9-4622d27e5fed", "f1e986e2-2535-4a1d-ae81-b896712cc4c6"),
      requestId: "9ca309ac-f7d7-4dfc-8a8b-4478847829dd",
      sourceBytes: new TextEncoder().encode("# Another\n\n## Skills\n\n\n- TypeScript"),
    });
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      parser: parser({ ...validOutput(), facts: [{
        ...validOutput().facts[0],
        evidence: { locatorType: "markdown_lines", startLine: 6, endLine: 99, excerpt: "- TypeScript" },
      }] }),
      id: ids("5c3c7dcb-e5b4-419f-94a7-832796bce17a"), clock: () => now,
    });

    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("failed");
    await expect(createCareerImportQueries({ db: database }).get({ userId, importId: created.importId }))
      .resolves.toMatchObject({ status: "failed", failureCode: "NO_SUPPORTED_FACTS", facts: [] });
  });

  it("fails checksum mismatches without parsing facts", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store,
      queue,
      ids: ids("2f312a5d-d322-422e-89a9-79e2d3977077", "d596cd7c-33c7-42ed-8ac8-bf18b45c7b8e"),
      requestId: "dbe4816f-a3f3-44fb-8c80-5bea1a383497",
    });
    const [document] = store.puts;
    store.replace(document!.objectKey, new TextEncoder().encode("tampered"));
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      parser: parser(validOutput()),
      id: ids("e0ee05ce-a26e-4f7b-aec6-d649d514152a"),
      clock: () => now,
    });

    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("failed");
    await expect(createCareerImportQueries({ db: database }).get({ userId, importId: created.importId }))
      .resolves.toMatchObject({ status: "failed", failureCode: "CAREER_DOCUMENT_CHECKSUM_MISMATCH", facts: [] });
  });

  it("rejects invalid UTF-8 before handing career content to the parser", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store,
      queue,
      ids: ids("a9f9014d-fbb4-4692-ba16-63a27143303b", "ee69751e-05c9-446b-8845-9ccd6932639d"),
      requestId: "37da01c2-c7f7-4a94-a4f2-4217d0648b38",
      sourceBytes: new Uint8Array([0xff, 0xfe]),
    });
    let parserCalls = 0;
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      parser: { parse: async () => { parserCalls += 1; return validOutput(); } },
      id: ids("36a4c9c2-e095-4290-88df-0b2c23490614"),
      clock: () => now,
    });

    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("failed");
    expect(parserCalls).toBe(0);
    await expect(createCareerImportQueries({ db: database }).get({ userId, importId: created.importId }))
      .resolves.toMatchObject({ status: "failed", failureCode: "CAREER_PARSER_OUTPUT_INVALID", facts: [] });
  });

  it("recovers a processing retry, increments every execution, and makes completed jobs noop", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store,
      queue,
      ids: ids("8ab34dec-9710-4c24-ab43-7a3c94058039", "67471c46-377d-4b3a-9dc6-99ae10024305"),
      requestId: "5b8e94b1-fbfd-4f52-b098-2243c74aa1a3",
    });
    await database.update(careerImports).set({ status: "processing" }).where(eq(careerImports.id, created.importId));
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      parser: parser(validOutput()),
      id: ids("70e2e5ed-4fcd-4027-a9cc-312af81d00fa", "d983c71d-0e1c-4301-a41f-5501b4f324e8"),
      clock: () => now,
    });

    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("completed");
    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("noop");
    const [stored] = await database.select({ attemptCount: careerImports.attemptCount, status: careerImports.status })
      .from(careerImports).where(eq(careerImports.id, created.importId));
    expect(stored).toEqual({ attemptCount: 1, status: "completed" });
  });

  it("does not resume a processing attempt that became completed before its conditional claim", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store, queue,
      ids: ids("4bbcf401-0650-4e03-9c01-1e5b41eaf175", "fe061f23-d215-43ca-86ba-0a28ff99447d"),
      requestId: "b8421168-4482-4a3d-b837-4b9743d425e2",
    });
    await database.update(careerImports).set({ status: "processing" }).where(eq(careerImports.id, created.importId));
    const resumeClaimReached = deferred<void>();
    const releaseResumeClaim = deferred<void>();
    const pausedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "update" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...updateArgs: unknown[]) => {
          const update = value.apply(target, updateArgs);
          return new Proxy(update, {
            get(updateBuilder, updateProperty, updateReceiver) {
              const updateValue = Reflect.get(updateBuilder, updateProperty, updateReceiver);
              if (updateProperty !== "set" || typeof updateValue !== "function") return updateValue;
              return (...setArgs: unknown[]) => {
                const set = updateValue.apply(updateBuilder, setArgs);
                return new Proxy(set, {
                  get(setBuilder, setProperty, setReceiver) {
                    const setValue = Reflect.get(setBuilder, setProperty, setReceiver);
                    if (setProperty !== "where" || typeof setValue !== "function") return setValue;
                    return (...whereArgs: unknown[]) => {
                      const where = setValue.apply(setBuilder, whereArgs);
                      return new Proxy(where, {
                        get(whereBuilder, whereProperty, whereReceiver) {
                          const whereValue = Reflect.get(whereBuilder, whereProperty, whereReceiver);
                          if (whereProperty !== "returning" || typeof whereValue !== "function") return whereValue;
                          return (...returningArgs: unknown[]) => {
                            const result = whereValue.apply(whereBuilder, returningArgs);
                            resumeClaimReached.resolve();
                            return releaseResumeClaim.promise.then(() => result);
                          };
                        },
                      });
                    };
                  },
                });
              };
            },
          });
        };
      },
    }) as Database;
    let staleStoreReads = 0;
    let staleParserCalls = 0;
    const staleProcessor = createCareerImportProcessor({
      db: pausedDatabase,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: {
        put: store.put.bind(store),
        get: async (input) => { staleStoreReads += 1; return store.get(input); },
      },
      parser: { parse: async () => { staleParserCalls += 1; return validOutput(); } },
      id: ids("1e1b517d-9bcb-48e8-8129-27d7daf31ff1", "960a3a7c-1bc3-4527-8507-776847a66337"),
      clock: () => now,
    });
    const completingProcessor = createCareerImportProcessor({
      db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), documentStore: store,
      parser: parser(validOutput()),
      id: ids("fb66df44-4df1-49be-aa19-c474a89e45a2", "49bec9f4-fc01-466a-8a2f-32d5842f47d1"),
      clock: () => now,
    });

    const stale = staleProcessor.process({ version: 1, importId: created.importId, userId, finalAttempt: false });
    await resumeClaimReached.promise;
    await expect(completingProcessor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("completed");
    releaseResumeClaim.resolve();

    await expect(stale).resolves.toBe("noop");
    expect(staleStoreReads).toBe(0);
    expect(staleParserCalls).toBe(0);
    const [stored] = await database.select({ status: careerImports.status, attemptCount: careerImports.attemptCount })
      .from(careerImports).where(eq(careerImports.id, created.importId));
    expect(stored).toEqual({ status: "completed", attemptCount: 1 });
  });

  it("returns noop when a stale executor tries to complete after a newer processing attempt", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store, queue,
      ids: ids("5fc9b441-15c2-45f8-a334-b8b2bb53cd14", "b486cb54-4488-4ad7-9c2e-483b1ed6f2f6"),
      requestId: "15ccb9e0-926f-4102-afdf-a58f97b82bf8",
    });
    const firstParserEntered = deferred<void>();
    const releaseFirstParser = deferred<void>();
    let parserCalls = 0;
    const processor = createCareerImportProcessor({
      db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), documentStore: store,
      parser: {
        parse: async () => {
          parserCalls += 1;
          if (parserCalls === 1) {
            firstParserEntered.resolve();
            await releaseFirstParser.promise;
          }
          return validOutput();
        },
      },
      id: ids(
        "3407116c-9a71-4dca-ae87-5d1c47f04f9a", "49f73f2c-097e-47d3-b13c-ce40d5c7fd4d",
        "3e7f166f-a401-4547-bb93-b9a8c36db18d", "c87bba3c-b776-4fcc-9afc-ca4f7f9011b9",
      ), clock: () => now,
    });

    const stale = processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false });
    await firstParserEntered.promise;
    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("completed");
    releaseFirstParser.resolve();

    await expect(stale).resolves.toBe("noop");
    await expect(createCareerImportQueries({ db: database }).get({ userId, importId: created.importId }))
      .resolves.toMatchObject({ status: "completed", facts: [expect.objectContaining({ factValue: { name: "TypeScript" } })] });
  });

  it("returns noop when a stale executor tries to fail after a newer attempt completes", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store, queue,
      ids: ids("b4b4d6c0-3f2d-4c77-96e7-67ee35dea08f", "5ee0c9c2-a2c3-4efa-b44e-49023d178a7f"),
      requestId: "0b63de4e-dc3f-47e8-a2a9-e8d75db566c9",
    });
    const firstParserEntered = deferred<void>();
    const releaseFirstParser = deferred<void>();
    let parserCalls = 0;
    const processor = createCareerImportProcessor({
      db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), documentStore: store,
      parser: {
        parse: async () => {
          parserCalls += 1;
          if (parserCalls === 1) {
            firstParserEntered.resolve();
            await releaseFirstParser.promise;
            return {};
          }
          return validOutput();
        },
      },
      id: ids(
        "c4f34d1a-73ca-422b-b511-b550492d2a90", "59a0c6bf-f5be-4c2d-85b0-2f109868454b",
      ), clock: () => now,
    });

    const stale = processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false });
    await firstParserEntered.promise;
    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("completed");
    releaseFirstParser.resolve();

    await expect(stale).resolves.toBe("noop");
    await expect(createCareerImportQueries({ db: database }).get({ userId, importId: created.importId }))
      .resolves.toMatchObject({ status: "completed", failureCode: null, facts: [expect.anything()] });
  });

  it("keeps a transient document read failure retryable until the final attempt", async () => {
    const store: CareerDocumentStore = {
      put: async () => undefined,
      get: async () => { throw new Error("object store temporarily unavailable"); },
    };
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store as MemoryStore,
      queue,
      ids: ids("6c3c9b7e-a1de-4de7-ab81-4df13755b3c1", "366eb9b5-261c-4aee-8d89-11ea182044fb"),
      requestId: "25ae2a69-27d3-4baa-a4c3-4ed3e5e46f66",
    });
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      parser: parser(validOutput()),
      id: ids("d4f9be97-e012-4a48-a9b5-8cb91ba0b59b"),
      clock: () => now,
    });

    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .rejects.toThrow(/temporarily unavailable/);
    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: true }))
      .resolves.toBe("failed");
    const [stored] = await database.select({ attemptCount: careerImports.attemptCount, failureCode: careerImports.failureCode })
      .from(careerImports).where(eq(careerImports.id, created.importId));
    expect(stored).toEqual({ attemptCount: 2, failureCode: "CAREER_DOCUMENT_READ_FAILED" });
  });

  it("fails a missing document immediately instead of consuming another retry", async () => {
    const missing = Object.assign(new Error("object missing"), { code: "CAREER_DOCUMENT_NOT_FOUND" });
    const store: CareerDocumentStore = {
      put: async () => undefined,
      get: async () => { throw missing; },
    };
    const queue = new MemoryQueue();
    const created = await createImport({
      documentStore: store as MemoryStore,
      queue,
      ids: ids("284dc145-1809-4c8a-a9d6-dbbf7af85fe9", "4171a5d1-04f5-43de-89c6-9f8e7a2591f7"),
      requestId: "912c66b0-f0f0-4be0-bb93-9784ff5c372b",
    });
    const processor = createCareerImportProcessor({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      documentStore: store,
      parser: parser(validOutput()),
      id: ids("f035e369-f09c-4878-aae1-fbbd9f49b5d1"),
      clock: () => now,
    });

    await expect(processor.process({ version: 1, importId: created.importId, userId, finalAttempt: false }))
      .resolves.toBe("failed");
    await expect(createCareerImportQueries({ db: database }).get({ userId, importId: created.importId }))
      .resolves.toMatchObject({ status: "failed", failureCode: "CAREER_DOCUMENT_NOT_FOUND", facts: [] });
  });

  it("only returns imports and facts owned by the requesting account", async () => {
    const queries = createCareerImportQueries({ db: database });
    const list = await queries.list({ userId });
    expect(list.length).toBeGreaterThan(0);
    const otherImport = (await queries.list({ userId: otherUserId }))[0];
    if (otherImport) {
      await expect(queries.get({ userId, importId: otherImport.importId })).resolves.toBeNull();
    }
  });
});
