import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, jobAccounts, jobOpportunities, jobSourcePostingVersions, jobSourcePostings, migrateDatabase, type Database } from "@job-copilot/database";
import { createJobExportCommands, createJobExportProcessor, createJobExportQueries, createJobExportRecoveryQueries, JobExportError, JobExportProcessingError, renderJobExportCsv, type JobExportStore } from "./job-exports";

const createdAt = new Date("2026-09-19T08:00:00.000Z");

describe("job exports", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let now = createdAt;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = createDatabase(container.getConnectionUri());
    await migrateDatabase(db);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await container?.stop(); });
  beforeEach(() => { now = createdAt; });

  async function opportunity(input: { userId: string; title: string; archivedAt?: Date | null }) {
    const sourcePostingId = crypto.randomUUID(); const sourcePostingVersionId = crypto.randomUUID(); const opportunityId = crypto.randomUUID();
    const digest = sourcePostingId.replaceAll("-", "").padEnd(64, "a");
    await db.insert(jobSourcePostings).values({ id: sourcePostingId, userId: input.userId, sourceType: "user_import", sourceIdentifier: digest, sourceId: null, sourceIdentity: { canonicalUrl: "https://jobs.example.test/opening", hash: digest }, isOfficial: false, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await db.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId: input.userId, sourcePostingId, version: 1, contentSha256: digest, rawContentSha256: digest, rawObjectReference: { key: "safe" }, normalizedData: {}, retrievedAt: now, availability: "open", createdAt: now });
    await db.insert(jobOpportunities).values({ id: opportunityId, userId: input.userId, importId: null, sourcePostingVersionId, canonicalOpportunityId: null, dedupKey: digest, company: "示例科技", title: input.title, location: "上海", postedAt: null, deadline: null, description: "不应导出", normalizedData: {}, availability: "open", availabilityUpdatedAt: now, archivedAt: input.archivedAt ?? null, createdAt: now, updatedAt: now });
    return { opportunityId, sourcePostingVersionId };
  }

  function boundary(queue: { jobs: unknown[] }) {
    return createJobExportCommands({ db, queue: { enqueue: async (job) => { queue.jobs.push(job); } }, id: () => crypto.randomUUID(), clock: () => now });
  }

  function storage(): JobExportStore {
    const objects = new Map<string, Uint8Array>();
    return {
      put: async ({ objectKey, bytes }) => { objects.set(objectKey, bytes.slice()); },
      get: async ({ objectKey }) => { const bytes = objects.get(objectKey); if (!bytes) throw new Error("missing export"); return bytes; },
      delete: async ({ objectKey }) => { objects.delete(objectKey); },
    };
  }

  it("请求时冻结所有匹配岗位，随后岗位变化不改写快照", async () => {
    const userId = crypto.randomUUID(); await db.insert(jobAccounts).values({ id: userId });
    const active = await opportunity({ userId, title: "原始职位" });
    await opportunity({ userId, title: "归档职位", archivedAt: now });
    const queue = { jobs: [] as unknown[] };
    const exported = await boundary(queue).create({ userId, command: { commandId: crypto.randomUUID(), filter: "active", fieldVersion: 1 } });
    await db.update(jobOpportunities).set({ title: "已被修改" }).where(eq(jobOpportunities.id, active.opportunityId));

    const store = storage();
    await createJobExportProcessor({ db, store, clock: () => now }).process({ version: 1, userId, exportId: exported.id, finalAttempt: false });
    const descriptor = await createJobExportQueries({ db, clock: () => now }).download({ userId, exportId: exported.id });
    const csv = new TextDecoder().decode(await store.get(descriptor));
    expect(csv).toContain('"原始职位"');
    expect(csv).toContain('"暂无投递记录"');
    expect(csv).toContain('"https://jobs.example.test/opening"');
    expect(csv).not.toContain("已被修改");
    expect(csv).not.toContain("不应导出");
    expect(exported.rowCount).toBe(1);
    expect(queue.jobs).toEqual([{ version: 1, exportId: exported.id, userId }]);
    await expect(boundary(queue).create({ userId, command: { commandId: crypto.randomUUID(), filter: "all", fieldVersion: 1 } })).resolves.toMatchObject({ rowCount: 2 });
  });

  it("命令幂等、跨账户隐藏和到期投影保持稳定", async () => {
    const userId = crypto.randomUUID(); const other = crypto.randomUUID(); await db.insert(jobAccounts).values([{ id: userId }, { id: other }]);
    await opportunity({ userId, title: "职位" }); const queue = { jobs: [] as unknown[] }; const commandId = crypto.randomUUID();
    const commands = boundary(queue); const first = await commands.create({ userId, command: { commandId, filter: "active", fieldVersion: 1 } });
    await expect(commands.create({ userId, command: { commandId, filter: "active", fieldVersion: 1 } })).resolves.toEqual(first);
    await expect(commands.create({ userId, command: { commandId, filter: "all", fieldVersion: 1 } })).rejects.toEqual(new JobExportError("JOB_EXPORT_COMMAND_ID_CONFLICT"));
    const queries = createJobExportQueries({ db, clock: () => now });
    await expect(queries.get({ userId: other, exportId: first.id })).resolves.toBeNull();
    await expect(queries.download({ userId: other, exportId: first.id })).rejects.toEqual(new JobExportError("JOB_EXPORT_NOT_FOUND"));
    now = new Date(first.expiresAt);
    await expect(queries.get({ userId, exportId: first.id })).resolves.toMatchObject({ status: "expired", failureCode: null });
    await expect(queries.download({ userId, exportId: first.id })).rejects.toEqual(new JobExportError("JOB_EXPORT_EXPIRED"));
    now = createdAt;
  });

  it("同一命令键的并发请求只创建一份快照", async () => {
    const userId = crypto.randomUUID(); await db.insert(jobAccounts).values({ id: userId });
    await opportunity({ userId, title: "并发岗位" });
    const command = { commandId: crypto.randomUUID(), filter: "active" as const, fieldVersion: 1 as const };
    const queue = { jobs: [] as unknown[] };
    const [first, second] = await Promise.all([boundary(queue).create({ userId, command }), boundary(queue).create({ userId, command })]);
    expect(second).toEqual(first);
    expect(queue.jobs).toHaveLength(1);
  });

  it("CSV 始终使用固定列、CRLF、BOM 和公式转义", () => {
    const output = new TextDecoder().decode(renderJobExportCsv([{
      exportId: crypto.randomUUID(), userId: crypto.randomUUID(), ordinal: 1, opportunityId: crypto.randomUUID(), sourcePostingVersionId: crypto.randomUUID(), title: "=HYPERLINK(\"https://evil\")", company: "含\"引号", location: "\tformula", sourceUrl: null, availability: "open", archivedAt: null, recommendationDecision: null, applicationStatus: null, postedAt: null, deadline: null, createdAt,
    }]));
    expect(output.startsWith("\"岗位机会 ID\"")).toBe(true);
    expect(output).toContain("\"'=HYPERLINK(\"\"https://evil\"\")\"");
    expect(output).toContain("\"'\tformula\"");
    expect(output).toContain("\"暂无投递记录\"");
    expect(output).toContain("\r\n");
  });

  it.each(["=1+1", "+1+1", "-1+1", "@SUM(1)", "\tformula", "\rformula", "\nformula", "  =1+1"])("不可信单元格 %j 无法触发公式", (title) => {
    const bytes = renderJobExportCsv([{
      exportId: crypto.randomUUID(), userId: crypto.randomUUID(), ordinal: 1, opportunityId: crypto.randomUUID(), sourcePostingVersionId: crypto.randomUUID(), title, company: null, location: null, sourceUrl: null, availability: "open", archivedAt: null, recommendationDecision: null, applicationStatus: null, postedAt: null, deadline: null, createdAt,
    }]);
    expect(Array.from(bytes.slice(0, 3))).toEqual([239, 187, 191]);
    expect(new TextDecoder().decode(bytes)).toContain(`"'${title}"`);
  });

  it("写入故障重试与处理器重建仍读取最初冻结的内容，终局失败不可下载", async () => {
    const userId = crypto.randomUUID(); await db.insert(jobAccounts).values({ id: userId });
    const current = await opportunity({ userId, title: "冻结的职位" });
    const exported = await boundary({ jobs: [] }).create({ userId, command: { commandId: crypto.randomUUID(), filter: "active", fieldVersion: 1 } });
    const job = { version: 1 as const, userId, exportId: exported.id, finalAttempt: false };
    const store = storage();
    const unavailable = { ...store, put: async () => { throw new Error("secret provider exception"); } };
    await expect(createJobExportProcessor({ db, store: unavailable, clock: () => now }).process(job)).rejects.toEqual(new JobExportProcessingError());
    await db.update(jobOpportunities).set({ title: "之后的职位" }).where(eq(jobOpportunities.id, current.opportunityId));
    await createJobExportProcessor({ db, store, clock: () => now }).process(job);
    const queries = createJobExportQueries({ db, clock: () => now });
    const descriptor = await queries.download({ userId, exportId: exported.id });
    const first = Array.from(await store.get(descriptor));
    await createJobExportProcessor({ db, store: unavailable, clock: () => now }).process({ ...job, finalAttempt: true });
    expect(Array.from(await store.get(descriptor))).toEqual(first);
    expect(new TextDecoder().decode(await store.get(descriptor))).toContain("冻结的职位");
    const failed = await boundary({ jobs: [] }).create({ userId, command: { commandId: crypto.randomUUID(), filter: "active", fieldVersion: 1 } });
    await createJobExportProcessor({ db, store: unavailable, clock: () => now }).process({ ...job, exportId: failed.id, finalAttempt: true });
    await expect(queries.get({ userId, exportId: failed.id })).resolves.toMatchObject({ status: "failed", failureCode: "JOB_EXPORT_GENERATION_FAILED" });
    await expect(queries.download({ userId, exportId: failed.id })).rejects.toEqual(new JobExportError("JOB_EXPORT_NOT_READY"));
  });

  it("生成过程中到期会拒绝下载，清理等待写入结束且重复处理不能复活对象", async () => {
    const userId = crypto.randomUUID(); await db.insert(jobAccounts).values({ id: userId });
    await opportunity({ userId, title: "到期的职位" });
    const exported = await boundary({ jobs: [] }).create({ userId, command: { commandId: crypto.randomUUID(), filter: "active", fieldVersion: 1 } });
    const store = storage();
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const slowStore = { ...store, put: async (input: Parameters<JobExportStore["put"]>[0]) => { entered(); await blocked; await store.put(input); } };
    const job = { version: 1 as const, userId, exportId: exported.id, finalAttempt: false };
    const processing = createJobExportProcessor({ db, store: slowStore, clock: () => now }).process(job);
    await started;
    now = new Date(exported.expiresAt);
    const recovery = createJobExportRecoveryQueries({ db, clock: () => now });
    const expiring = recovery.expire();
    release();
    await Promise.all([processing, expiring]);
    await expect(createJobExportQueries({ db, clock: () => now }).download({ userId, exportId: exported.id })).rejects.toEqual(new JobExportError("JOB_EXPORT_EXPIRED"));
    const pending = (await recovery.listCleanupPending()).find((item) => item.exportId === exported.id)!;
    expect(pending).toBeDefined();
    await store.delete(pending); await recovery.markObjectDeleted(pending);
    await createJobExportProcessor({ db, store, clock: () => now }).process(job);
    await expect(store.get(pending)).rejects.toThrow("missing export");
  });
});
