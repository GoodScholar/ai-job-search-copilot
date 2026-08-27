import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  candidateFacts,
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
      parser: parser({ ...validOutput(), facts: [{ ...validOutput().facts[0], evidence: { locatorType: "markdown_lines", startLine: 2, endLine: 2, excerpt: "- Completed only" } }] }),
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

  it.each([
    ["inferred grounding", { ...validOutput(), facts: [{ ...validOutput().facts[0], grounding: "inferred" }] }, "CAREER_PARSER_OUTPUT_INVALID"],
    ["missing evidence", { ...validOutput(), facts: [{ ...validOutput().facts[0], evidence: undefined }] }, "CAREER_PARSER_OUTPUT_INVALID"],
    ["unknown parser field", { ...validOutput(), privateEmail: "secret@example.test" }, "CAREER_PARSER_OUTPUT_INVALID"],
    ["out of range evidence", { ...validOutput(), facts: [{ ...validOutput().facts[0], evidence: { locatorType: "markdown_lines", startLine: 7, endLine: 7, excerpt: "- TypeScript" } }] }, "CAREER_PARSER_EVIDENCE_INVALID"],
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
