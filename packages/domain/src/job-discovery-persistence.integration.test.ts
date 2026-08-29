import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  agentRunJobResults,
  agentRunSteps,
  agentRuns,
  createDatabase,
  jobAccounts,
  jobOpportunities,
  jobSourcePostingVersions,
  jobTargetRevisions,
  jobTargets,
  migrateDatabase,
  type Database,
} from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createAgentRunCommands, type AgentRunQueue } from "./agent-run-control";
import { createJobDiscoveryPersistence } from "./job-discovery-persistence";

const firstSeen = new Date("2026-08-30T00:00:00.000Z");
const later = new Date("2026-08-31T00:00:00.000Z");
const constraints = {
  roleFamily: "AI 应用工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const,
  salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
};

class Queue implements AgentRunQueue { async enqueue() {} }

describe("job discovery persistence lifecycle", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);
  afterAll(async () => { await database?.$client.end(); await container?.stop(); });

  async function claimRun(userId: string, targetId: string, now: Date) {
    const started = await createAgentRunCommands({ db: database, queue: new Queue(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    const claimToken = crypto.randomUUID();
    const [run] = await database.update(agentRuns).set({ status: "running", currentStep: "persist_results", adapter: "greenhouse", claimToken, attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimExpiresAt: new Date(now.getTime() + 30_000) })
      .where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, started.runId))).returning();
    if (!run) throw new Error("run was not claimed");
    await database.update(agentRunSteps).set({ status: "running", startedAt: now, attemptCount: 1 })
      .where(and(eq(agentRunSteps.userId, userId), eq(agentRunSteps.runId, started.runId), eq(agentRunSteps.stepKey, "persist_results")));
    return { ...run, claimToken };
  }

  it("完整空扫描关闭来源时追加生命周期版本并复用上一原始对象", async () => {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const firstRun = await claimRun(userId, targetId, firstSeen);

    await persistence.persistSuccessfulDiscovery({
      run: firstRun,
      details: [{ sourceId: "greenhouse:fictional-labs", detailId: "701", company: "Fictional Labs", title: "AI Engineer", location: "Shanghai", postedAt: "2026-08-30T00:00:00.000Z", deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: { id: 701, content: "first" } }],
      scans: [{ sourceId: "greenhouse:fictional-labs", observedDetailIds: ["701"], complete: true }],
      storedObjects: [{ sourceId: "greenhouse:fictional-labs", detailId: "701", objectKey: "first.json", rawContentSha256: "a".repeat(64) }],
      now: firstSeen,
    });
    const secondRun = await claimRun(userId, targetId, later);

    await persistence.persistSuccessfulDiscovery({ run: secondRun, details: [], scans: [{ sourceId: "greenhouse:fictional-labs", observedDetailIds: [], complete: true }], storedObjects: [], now: later });

    const versions = await database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId)).orderBy(asc(jobSourcePostingVersions.version));
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.availability)).toEqual(["open", "closed"]);
    expect(versions[1]?.rawObjectReference).toEqual(versions[0]?.rawObjectReference);
    await expect(database.select({ availability: jobOpportunities.availability }).from(jobOpportunities).where(eq(jobOpportunities.userId, userId))).resolves.toEqual([{ availability: "closed" }]);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, secondRun.id))).resolves.toHaveLength(0);
  });

  it("仅比较来源最新版本：相同内容复用，正文变化和 reopened 生命周期各追加一版", async () => {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const base = { sourceId: "greenhouse:fictional-labs", detailId: "702", company: "Fictional Labs", title: "AI Engineer", location: "Shanghai", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true };
    const persist = async (run: Awaited<ReturnType<typeof claimRun>>, detail: typeof base & { rawPayload: Record<string, unknown> }, objectKey: string, rawContentSha256: string) => persistence.persistSuccessfulDiscovery({ run, details: [detail], scans: [{ sourceId: base.sourceId, observedDetailIds: [base.detailId], complete: true }], storedObjects: [{ sourceId: base.sourceId, detailId: base.detailId, objectKey, rawContentSha256 }], now: later });

    await persist(await claimRun(userId, targetId, firstSeen), { ...base, rawPayload: { body: "first" } }, "first.json", "b".repeat(64));
    const repeat = await persist(await claimRun(userId, targetId, later), { ...base, rawPayload: { body: "first" } }, "repeat.json", "b".repeat(64));
    expect(repeat.cleanupObjectKeys).toEqual(["repeat.json"]);
    await persist(await claimRun(userId, targetId, later), { ...base, title: "Senior AI Engineer", rawPayload: { body: "changed" } }, "changed.json", "c".repeat(64));
    await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, later), details: [], scans: [{ sourceId: base.sourceId, observedDetailIds: [], complete: true }], storedObjects: [], now: later });
    await persist(await claimRun(userId, targetId, later), { ...base, title: "Senior AI Engineer", rawPayload: { body: "changed" } }, "reopened.json", "c".repeat(64));

    const versions = await database.select({ version: jobSourcePostingVersions.version, availability: jobSourcePostingVersions.availability }).from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId)).orderBy(asc(jobSourcePostingVersions.version));
    expect(versions).toEqual([{ version: 1, availability: "open" }, { version: 2, availability: "open" }, { version: 3, availability: "closed" }, { version: 4, availability: "open" }]);
    await expect(database.select({ title: jobOpportunities.title, normalizedData: jobOpportunities.normalizedData }).from(jobOpportunities).where(eq(jobOpportunities.userId, userId)))
      .resolves.toEqual([{ title: "Senior AI Engineer", normalizedData: expect.objectContaining({ title: "Senior AI Engineer" }) }]);
  });

  it("不完整扫描不关闭，过期详情不写 run result，全部来源关闭后机会关闭", async () => {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const sourceA = "greenhouse:fictional-labs";
    const sourceB = "greenhouse:fictional-labs-secondary";
    const details = [
      { sourceId: sourceA, detailId: "703", company: "Fictional Labs", title: "AI Engineer", location: "Shanghai", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: { source: "a" } },
      { sourceId: sourceB, detailId: "704", company: "Fictional Labs", title: "AI Engineer", location: "Shanghai", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: { source: "b" } },
    ];
    await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, firstSeen), details, scans: [{ sourceId: sourceA, observedDetailIds: ["703"], complete: true }, { sourceId: sourceB, observedDetailIds: ["704"], complete: true }], storedObjects: [{ sourceId: sourceA, detailId: "703", objectKey: "a.json", rawContentSha256: "d".repeat(64) }, { sourceId: sourceB, detailId: "704", objectKey: "b.json", rawContentSha256: "e".repeat(64) }], now: firstSeen });
    await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, later), details: [], scans: [{ sourceId: sourceA, observedDetailIds: [], complete: false }], storedObjects: [], now: later });
    await expect(database.select({ availability: jobOpportunities.availability }).from(jobOpportunities).where(eq(jobOpportunities.userId, userId))).resolves.toEqual([{ availability: "open" }]);
    await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, later), details: [], scans: [{ sourceId: sourceA, observedDetailIds: [], complete: true }, { sourceId: sourceB, observedDetailIds: ["704"], complete: true }], storedObjects: [], now: later });
    await expect(database.select({ availability: jobOpportunities.availability }).from(jobOpportunities).where(eq(jobOpportunities.userId, userId))).resolves.toEqual([{ availability: "open" }]);
    await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, later), details: [], scans: [{ sourceId: sourceB, observedDetailIds: [], complete: true }], storedObjects: [], now: later });
    await expect(database.select({ availability: jobOpportunities.availability }).from(jobOpportunities).where(eq(jobOpportunities.userId, userId))).resolves.toEqual([{ availability: "closed" }]);
  });

  it("expired 最新详情标为 expired 且不为该运行写结果", async () => {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: later, updatedAt: later });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: later });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const run = await claimRun(userId, targetId, later);
    await persistence.persistSuccessfulDiscovery({ run, details: [{ sourceId: "greenhouse:fictional-labs", detailId: "705", company: "Fictional Labs", title: "Expired role", location: null, postedAt: null, deadline: "2026-08-29T00:00:00.000Z", sourceType: "company_careers", isOfficial: true, rawPayload: { expired: true } }], scans: [{ sourceId: "greenhouse:fictional-labs", observedDetailIds: ["705"], complete: true }], storedObjects: [{ sourceId: "greenhouse:fictional-labs", detailId: "705", objectKey: "expired.json", rawContentSha256: "f".repeat(64) }], now: later });
    await expect(database.select({ availability: jobOpportunities.availability }).from(jobOpportunities).where(eq(jobOpportunities.userId, userId))).resolves.toEqual([{ availability: "expired" }]);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, run.id))).resolves.toHaveLength(0);
  });

  it("完整扫描中仍观察到、但未进入本轮详情预算的历史岗位按结构化截止日期过期", async () => {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const sourceId = "greenhouse:deadline-history";
    const detail = { sourceId, detailId: "707", company: "Fictional Labs", title: "AI Engineer", location: null, postedAt: null, deadline: "2026-08-30T12:00:00.000Z", sourceType: "company_careers", isOfficial: true, rawPayload: { id: 707 } };
    await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, firstSeen), details: [detail], scans: [{ sourceId, observedDetailIds: [detail.detailId], complete: true }], storedObjects: [{ sourceId, detailId: detail.detailId, objectKey: "deadline.json", rawContentSha256: "7".repeat(64) }], now: firstSeen });

    const expiryRun = await claimRun(userId, targetId, later);
    await persistence.persistSuccessfulDiscovery({ run: expiryRun, details: [], scans: [{ sourceId, observedDetailIds: [detail.detailId], complete: true }], storedObjects: [], now: later });

    const versions = await database.select({ availability: jobSourcePostingVersions.availability, rawObjectReference: jobSourcePostingVersions.rawObjectReference }).from(jobSourcePostingVersions)
      .where(eq(jobSourcePostingVersions.userId, userId)).orderBy(asc(jobSourcePostingVersions.version));
    expect(versions).toEqual([{ availability: "open", rawObjectReference: { objectKey: "deadline.json" } }, { availability: "expired", rawObjectReference: { objectKey: "deadline.json" } }]);
    await expect(database.select({ availability: jobOpportunities.availability }).from(jobOpportunities).where(eq(jobOpportunities.userId, userId))).resolves.toEqual([{ availability: "expired" }]);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, expiryRun.id))).resolves.toHaveLength(0);
  });

  it("complete scan 不会关闭同一 sourceId 的其他 sourceType", async () => {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const sourceId = "greenhouse:shared-source-id";
    const detail = { sourceId, detailId: "708", company: "Fictional Labs", title: "AI Engineer", location: null, postedAt: null, deadline: null, sourceType: "aggregator", isOfficial: false, rawPayload: { id: 708 } };
    await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, firstSeen), details: [detail], scans: [{ sourceId, observedDetailIds: [detail.detailId], complete: true }], storedObjects: [{ sourceId, detailId: detail.detailId, objectKey: "aggregator.json", rawContentSha256: "8".repeat(64) }], now: firstSeen });
    await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, later), details: [], scans: [{ sourceId, observedDetailIds: [], complete: true }], storedObjects: [], now: later });
    await expect(database.select({ availability: jobOpportunities.availability }).from(jobOpportunities).where(eq(jobOpportunities.userId, userId))).resolves.toEqual([{ availability: "open" }]);
  });

  it("同一官方 posting 更新规范字段后，另一来源的新版 identity 聚合到原机会", async () => {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const fields = { company: "Fictional Labs", location: "Shanghai", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true };
    const sourceA = "greenhouse:identity-a";
    const sourceB = "greenhouse:identity-b";
    const persist = async (sourceId: string, detailId: string, title: string, raw: string) => persistence.persistSuccessfulDiscovery({
      run: await claimRun(userId, targetId, later),
      details: [{ sourceId, detailId, ...fields, title, rawPayload: { raw } }],
      scans: [{ sourceId, observedDetailIds: [detailId], complete: true }],
      storedObjects: [{ sourceId, detailId, objectKey: `${raw}.json`, rawContentSha256: raw.repeat(64) }], now: later,
    });
    await persist(sourceA, "a", "AI Engineer", "a");
    await persist(sourceA, "a", "Senior AI Engineer", "b");
    await persist(sourceB, "b", "Senior AI Engineer", "c");

    await expect(database.select({ title: jobOpportunities.title }).from(jobOpportunities).where(eq(jobOpportunities.userId, userId))).resolves.toEqual([{ title: "Senior AI Engineer" }]);
  });

  it("持久化失败回滚详情与完整扫描 reconciliation", async () => {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const detail = { sourceId: "greenhouse:fictional-labs", detailId: "706", company: "Fictional Labs", title: "AI Engineer", location: null, postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: { id: 706 } };
    await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, firstSeen), details: [detail], scans: [{ sourceId: detail.sourceId, observedDetailIds: [detail.detailId], complete: true }], storedObjects: [{ sourceId: detail.sourceId, detailId: detail.detailId, objectKey: "initial.json", rawContentSha256: "0".repeat(64) }], now: firstSeen });
    await expect(persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, later), details: [detail], scans: [{ sourceId: detail.sourceId, observedDetailIds: [], complete: true }], storedObjects: [], now: later })).rejects.toThrow("AGENT_RUN_PERSIST_FAILED");
    await expect(database.select({ availability: jobOpportunities.availability }).from(jobOpportunities).where(eq(jobOpportunities.userId, userId))).resolves.toEqual([{ availability: "open" }]);
    await expect(database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId))).resolves.toHaveLength(1);
  });
});
