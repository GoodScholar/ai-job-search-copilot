import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  agentRunEvents,
  agentRunJobResults,
  agentRunSteps,
  agentRunUsageEntries,
  agentRuns,
  auditEvents,
  createDatabase,
  jobAccounts,
  jobOpportunities,
  jobSourceHealthChecks,
  jobOpportunitySources,
  jobSourcePostings,
  jobSourcePostingVersions,
  jobTargetRevisions,
  jobTargets,
  migrateDatabase,
  type Database,
} from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createAgentRunCommands, type AgentRunQueue } from "./agent-run-control";
import { createJobDiscoveryPersistence, discoverySourceIdentifier } from "./job-discovery-persistence";

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
  let statementCount = 0;
  let observedStatements: Array<{ query: string; params: unknown[] }> = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri(), { observer: { onQuery: (query, params) => { statementCount += 1; observedStatements.push({ query, params }); } } });
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

  it("normalized-only 与 raw-only 变化各自追加一个来源版本", async () => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const sourceId = "greenhouse:hashes"; const base = { sourceId, detailId: "hash", company: "Fictional", title: "AI Engineer", location: null, postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: {} };
    const persist = async (detail: typeof base, rawContentSha256: string) => persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, later), details: [detail], scans: [{ sourceId, observedDetailIds: [base.detailId], complete: true }], storedObjects: [{ sourceId, detailId: base.detailId, objectKey: `${rawContentSha256}.json`, rawContentSha256 }], now: later });
    await persist(base, "a".repeat(64));
    await persist({ ...base, title: "Senior AI Engineer" }, "a".repeat(64));
    await persist({ ...base, title: "Senior AI Engineer" }, "b".repeat(64));
    await expect(database.select({ version: jobSourcePostingVersions.version }).from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId)).orderBy(asc(jobSourcePostingVersions.version))).resolves.toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
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

  it("K2 已由另一来源占用时，官方 A 从 K1 更新到 K2 保留不可变历史并只投影 canonical", async () => {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const fields = { company: "Fictional Labs", location: "Shanghai", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true };
    const persist = async (sourceId: string, detailId: string, title: string, raw: string) => {
      const run = await claimRun(userId, targetId, later);
      await persistence.persistSuccessfulDiscovery({
        run, details: [{ sourceId, detailId, ...fields, title, rawPayload: { raw } }],
        scans: [{ sourceId, observedDetailIds: [detailId], complete: true }], storedObjects: [{ sourceId, detailId, objectKey: `${raw}.json`, rawContentSha256: raw.repeat(64) }], now: later,
      });
      return run;
    };
    const bRun = await persist("greenhouse:b", "b", "Senior AI Engineer", "b");
    const aK1Run = await persist("greenhouse:a", "a", "AI Engineer", "a");
    const aK2Run = await persist("greenhouse:a", "a", "Senior AI Engineer", "c");

    const opportunities = await database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, userId));
    const superseded = opportunities.find((opportunity) => opportunity.title === "AI Engineer");
    const canonical = opportunities.find((opportunity) => opportunity.title === "Senior AI Engineer");
    expect(opportunities).toHaveLength(2);
    expect(superseded).toMatchObject({ canonicalOpportunityId: canonical?.id });
    expect(canonical).toMatchObject({ canonicalOpportunityId: null });
    await expect(database.select().from(jobOpportunitySources).where(eq(jobOpportunitySources.userId, userId))).resolves.toHaveLength(3);
    const results = await database.select().from(agentRunJobResults).where(eq(agentRunJobResults.userId, userId));
    expect(results).toHaveLength(3);
    expect(results.find((result) => result.runId === aK1Run.id)?.opportunityId).toBe(superseded?.id);
    expect(results.find((result) => result.runId === bRun.id)?.opportunityId).toBe(canonical?.id);
    expect(results.find((result) => result.runId === aK2Run.id)?.opportunityId).toBe(canonical?.id);
    const aK1AgainRun = await persist("greenhouse:a", "a", "AI Engineer", "d");
    expect((await database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, aK1AgainRun.id)))[0]?.opportunityId).toBe(canonical?.id);
  });

  it("多跳 alias 的来源更新始终写入 current root，并在 cycle 中拒绝写入", async () => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const fields = { company: "Fictional Labs", location: "Shanghai", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true };
    const persist = async (sourceId: string, detailId: string, title: string, raw: string) => {
      const run = await claimRun(userId, targetId, later);
      await persistence.persistSuccessfulDiscovery({
        run, details: [{ sourceId, detailId, ...fields, title, rawPayload: { raw } }],
        scans: [{ sourceId, observedDetailIds: [detailId], complete: true }], storedObjects: [{ sourceId, detailId, objectKey: `${raw}.json`, rawContentSha256: raw.repeat(64) }], now: later,
      });
      return run;
    };
    const aInitialRun = await persist("greenhouse:chain-a", "a", "K1", "a");
    await persist("greenhouse:chain-b", "b", "K2", "b");
    await persist("greenhouse:chain-c", "c", "K3", "c");
    await persist("greenhouse:chain-d", "d", "K4", "d");
    const initial = await database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, userId));
    const byTitle = new Map(initial.map((opportunity) => [opportunity.title, opportunity]));
    const a = byTitle.get("K1")!; const b = byTitle.get("K2")!; const c = byTitle.get("K3")!; const d = byTitle.get("K4")!;
    const [historicalResult] = await database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, aInitialRun.id));
    const [historicalEvidence] = await database.select().from(jobOpportunitySources).where(and(eq(jobOpportunitySources.userId, userId), eq(jobOpportunitySources.opportunityId, a.id)));
    await database.update(jobOpportunities).set({ canonicalOpportunityId: b.id }).where(eq(jobOpportunities.id, a.id));
    await database.update(jobOpportunities).set({ canonicalOpportunityId: c.id }).where(eq(jobOpportunities.id, b.id));
    await database.update(jobOpportunities).set({ canonicalOpportunityId: d.id }).where(eq(jobOpportunities.id, c.id));

    const k5Run = await persist("greenhouse:chain-a", "a", "K5", "e");
    const [k5Result] = await database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, k5Run.id));
    const k5Evidence = await database.select().from(jobOpportunitySources).where(and(eq(jobOpportunitySources.userId, userId), eq(jobOpportunitySources.sourcePostingVersionId, k5Result!.sourcePostingVersionId)));
    expect(k5Result?.opportunityId).toBe(d.id);
    expect(k5Evidence.map((evidence) => evidence.opportunityId)).toEqual([d.id]);
    expect(await database.select({ id: agentRunJobResults.id, opportunityId: agentRunJobResults.opportunityId }).from(agentRunJobResults).where(eq(agentRunJobResults.id, historicalResult!.id))).toEqual([{ id: historicalResult!.id, opportunityId: a.id }]);
    expect(await database.select({ id: jobOpportunitySources.id, opportunityId: jobOpportunitySources.opportunityId }).from(jobOpportunitySources).where(eq(jobOpportunitySources.id, historicalEvidence!.id))).toEqual([{ id: historicalEvidence!.id, opportunityId: a.id }]);
    await expect(database.select().from(jobOpportunities).where(and(eq(jobOpportunities.userId, userId), isNull(jobOpportunities.canonicalOpportunityId)))).resolves.toEqual([expect.objectContaining({ id: d.id })]);

    await database.update(jobOpportunities).set({ canonicalOpportunityId: a.id }).where(eq(jobOpportunities.id, d.id));
    const beforeCycle = await Promise.all([
      database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId)),
      database.select().from(jobOpportunitySources).where(eq(jobOpportunitySources.userId, userId)),
      database.select().from(agentRunJobResults).where(eq(agentRunJobResults.userId, userId)),
    ]);
    await expect(persist("greenhouse:chain-a", "a", "K6", "f")).rejects.toThrow("AGENT_RUN_PERSIST_FAILED");
    const afterCycle = await Promise.all([
      database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId)),
      database.select().from(jobOpportunitySources).where(eq(jobOpportunitySources.userId, userId)),
      database.select().from(agentRunJobResults).where(eq(agentRunJobResults.userId, userId)),
    ]);
    expect(afterCycle.map((rows) => rows.map((row) => row.id).sort())).toEqual(beforeCycle.map((rows) => rows.map((row) => row.id).sort()));
  });

  it("canonical root 解析的 SQL 形状不随 alias 深度增长", async () => {
    const updateFromAliasChain = async (depth: number) => {
      const userId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const sourceId = `greenhouse:deep-alias-${depth}`;
      const postingId = crypto.randomUUID(); const versionId = crypto.randomUUID();
      await database.insert(jobAccounts).values({ id: userId });
      await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
      await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
      await database.insert(jobSourcePostings).values({ id: postingId, userId, sourceType: "company_careers", sourceIdentifier: discoverySourceIdentifier(sourceId, "a"), sourceId, sourceIdentity: { sourceId, detailId: "a" }, applicationDeadline: null, isOfficial: true, availability: "open", availabilityUpdatedAt: firstSeen, createdAt: firstSeen, updatedAt: firstSeen });
      await database.insert(jobSourcePostingVersions).values({ id: versionId, userId, sourcePostingId: postingId, version: 1, contentSha256: "a".repeat(64), rawContentSha256: "b".repeat(64), rawObjectReference: { objectKey: "initial.json" }, normalizedData: { sourceId, detailId: "a", company: "Fictional", title: "Initial", location: null, postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true }, retrievedAt: firstSeen, availability: "open", createdAt: firstSeen });
      await database.execute(sql`
        with generated as (
          select ordinal, gen_random_uuid() as id from generate_series(1, ${depth}) as ordinal
        ), chain as (
          select ordinal, id, lead(id) over (order by ordinal) as canonical_id from generated
        )
        insert into job_opportunities (
          id, user_id, source_posting_version_id, canonical_opportunity_id, dedup_key,
          company, title, location, posted_at, deadline, description, normalized_data,
          availability, availability_updated_at, created_at, updated_at
        )
        select id, ${userId}::uuid, ${versionId}::uuid, canonical_id,
          md5('deep:' || ordinal::text) || md5('deep-extra:' || ordinal::text),
          'Fictional', 'Alias ' || ordinal, null, null, null, null,
          jsonb_build_object('sourceId', ${sourceId}::text, 'detailId', 'a'),
          'open', ${firstSeen.toISOString()}::timestamptz, ${firstSeen.toISOString()}::timestamptz, ${firstSeen.toISOString()}::timestamptz
        from chain
      `);
      const [first] = await database.select({ id: jobOpportunities.id }).from(jobOpportunities).where(and(eq(jobOpportunities.userId, userId), eq(jobOpportunities.title, "Alias 1")));
      const [root] = await database.select({ id: jobOpportunities.id }).from(jobOpportunities).where(and(eq(jobOpportunities.userId, userId), isNull(jobOpportunities.canonicalOpportunityId)));
      await database.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId, opportunityId: first!.id, sourcePostingVersionId: versionId, createdAt: firstSeen });
      const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
      statementCount = 0; observedStatements = [];
      const run = await claimRun(userId, targetId, later);
      statementCount = 0; observedStatements = [];
      await persistence.persistSuccessfulDiscovery({ run, details: [{ sourceId, detailId: "a", company: "Fictional", title: "K5", location: null, postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: { depth } }], scans: [{ sourceId, observedDetailIds: ["a"], complete: true }], storedObjects: [{ sourceId, detailId: "a", objectKey: "updated.json", rawContentSha256: "c".repeat(64) }], now: later });
      const [result] = await database.select({ opportunityId: agentRunJobResults.opportunityId }).from(agentRunJobResults).where(eq(agentRunJobResults.runId, run.id));
      return { rootId: root!.id, resultId: result!.opportunityId, count: statementCount, queries: observedStatements.map((statement) => statement.query), maxParams: Math.max(...observedStatements.map((statement) => statement.params.length)) };
    };

    const shallow = await updateFromAliasChain(3);
    const deep = await updateFromAliasChain(256);
    expect(shallow.resultId).toBe(shallow.rootId);
    expect(deep.resultId).toBe(deep.rootId);
    expect(deep.count).toBeLessThanOrEqual(31);
    expect(deep.count).toBe(shallow.count);
    expect(deep.queries).toEqual(shallow.queries);
    expect(deep.maxParams).toBeLessThanOrEqual(32);
    expect(deep.maxParams).toBe(shallow.maxParams);
  });

  it("官方 A 经关闭和 reopen 后撞入 B 的 K2 时保留所有历史 ID、对象引用和 evidence", async () => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const sourceA = "greenhouse:history-a"; const sourceB = "greenhouse:history-b";
    const fields = { company: "Fictional Labs", location: "Shanghai", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true };
    const persist = async (at: Date, sourceId: string, detailId: string, title: string, raw: string) => {
      const run = await claimRun(userId, targetId, at);
      await persistence.persistSuccessfulDiscovery({
        run,
        details: [{ sourceId, detailId, ...fields, title, rawPayload: { raw } }],
        scans: [{ sourceId, observedDetailIds: [detailId], complete: true }],
        storedObjects: [{ sourceId, detailId, objectKey: `${raw}.json`, rawContentSha256: raw[0]!.repeat(64) }], now: at,
      });
      return run;
    };
    const aFirstRun = await persist(firstSeen, sourceA, "a", "AI Engineer", "a1");
    const [sourceAPosting] = await database.select().from(jobSourcePostings).where(and(eq(jobSourcePostings.userId, userId), eq(jobSourcePostings.sourceId, sourceA)));
    const bRun = await persist(later, sourceB, "b", "Senior AI Engineer", "b1");
    const closeAt = new Date("2026-09-01T00:00:00.000Z");
    await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, closeAt), details: [], scans: [{ sourceId: sourceA, observedDetailIds: [], complete: true }], storedObjects: [], now: closeAt });
    const historicalVersionIds = (await database.select({ id: jobSourcePostingVersions.id }).from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId))).map((version) => version.id);
    const historicalResultIds = (await database.select({ id: agentRunJobResults.id }).from(agentRunJobResults).where(eq(agentRunJobResults.userId, userId))).map((result) => result.id);
    const reopenAt = new Date("2026-09-02T00:00:00.000Z");
    const aReopenRun = await persist(reopenAt, sourceA, "a", "Senior AI Engineer", "a2");

    const postings = await database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId)).orderBy(asc(jobSourcePostingVersions.createdAt), asc(jobSourcePostingVersions.version));
    const sourceAVersions = postings.filter((version) => version.rawObjectReference && (version.rawObjectReference as { objectKey?: string }).objectKey?.startsWith("a"));
    expect(sourceAVersions).toHaveLength(3);
    expect(sourceAVersions.map((version) => version.sourcePostingId)).toEqual([sourceAPosting!.id, sourceAPosting!.id, sourceAPosting!.id]);
    expect(sourceAVersions.map((version) => version.rawObjectReference)).toEqual([{ objectKey: "a1.json" }, { objectKey: "a1.json" }, { objectKey: "a2.json" }]);
    const sourceVersionIds = postings.map((version) => version.id);
    const opportunities = await database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, userId));
    const superseded = opportunities.find((opportunity) => opportunity.title === "AI Engineer");
    const canonical = opportunities.find((opportunity) => opportunity.canonicalOpportunityId === null);
    expect(canonical).toMatchObject({ title: "Senior AI Engineer", availability: "open", sourcePostingVersionId: sourceAVersions[2]!.id });
    expect(superseded).toMatchObject({ canonicalOpportunityId: canonical!.id, availability: "closed" });
    expect(opportunities).toHaveLength(2);
    const evidence = await database.select().from(jobOpportunitySources).where(eq(jobOpportunitySources.userId, userId));
    expect(evidence).toHaveLength(4);
    expect(new Set(evidence.map((row) => row.sourcePostingVersionId))).toEqual(new Set(sourceVersionIds));
    const historicalResults = await database.select().from(agentRunJobResults).where(eq(agentRunJobResults.userId, userId));
    expect(historicalResults).toHaveLength(3);
    expect(new Set(historicalResults.map((row) => row.runId))).toEqual(new Set([aFirstRun.id, bRun.id, aReopenRun.id]));
    expect(historicalResults.map((row) => row.id)).toEqual(expect.arrayContaining(historicalResultIds));
    expect(sourceVersionIds).toEqual(expect.arrayContaining(historicalVersionIds));
    expect(historicalResults.find((row) => row.runId === aFirstRun.id)?.opportunityId).toBe(superseded!.id);
    expect(historicalResults.find((row) => row.runId === bRun.id)?.opportunityId).toBe(canonical!.id);
    expect(historicalResults.find((row) => row.runId === aReopenRun.id)?.opportunityId).toBe(canonical!.id);
    expect(new Set(historicalResults.map((row) => row.sourcePostingVersionId))).toEqual(new Set([sourceAVersions[0]!.id, postings.find((version) => (version.rawObjectReference as { objectKey?: string }).objectKey === "b1.json")!.id, sourceAVersions[2]!.id]));
  });

  it("running claim 的已有 result 冲突不会冒充新插入，并为另一个结果续接 ordinal", async () => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const conflict = { sourceId: "greenhouse:result-conflict", detailId: "conflict", company: "Fictional", title: "Conflict role", location: null, postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: {} };
    await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, firstSeen), details: [conflict], scans: [{ sourceId: conflict.sourceId, observedDetailIds: [conflict.detailId], complete: true }], storedObjects: [{ sourceId: conflict.sourceId, detailId: conflict.detailId, objectKey: "conflict.json", rawContentSha256: "c".repeat(64) }], now: firstSeen });
    const [existing] = await database.select().from(agentRunJobResults).where(eq(agentRunJobResults.userId, userId));
    const run = await claimRun(userId, targetId, later);
    await database.insert(agentRunJobResults).values({ id: crypto.randomUUID(), userId, runId: run.id, opportunityId: existing!.opportunityId, sourcePostingVersionId: existing!.sourcePostingVersionId, ordinal: 1, createdAt: later });
    await database.update(agentRuns).set({ resultCount: 1 }).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, run.id)));
    const fresh = { ...conflict, sourceId: "greenhouse:result-fresh", detailId: "fresh", title: "Fresh role" };
    const outcome = await persistence.persistSuccessfulDiscovery({ run: { ...run, resultCount: 1 }, details: [conflict, fresh], scans: [{ sourceId: conflict.sourceId, observedDetailIds: [conflict.detailId], complete: true }, { sourceId: fresh.sourceId, observedDetailIds: [fresh.detailId], complete: true }], storedObjects: [{ sourceId: conflict.sourceId, detailId: conflict.detailId, objectKey: "repeat.json", rawContentSha256: "c".repeat(64) }, { sourceId: fresh.sourceId, detailId: fresh.detailId, objectKey: "fresh.json", rawContentSha256: "f".repeat(64) }], now: later });

    expect(outcome).toMatchObject({ completed: true, resultCount: 1 });
    const results = await database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, run.id)).orderBy(asc(agentRunJobResults.ordinal));
    expect(results.map((result) => result.ordinal)).toEqual([1, 2]);
    expect(results.filter((result) => result.sourcePostingVersionId === existing!.sourcePostingVersionId)).toHaveLength(1);
    await expect(database.select({ resultCount: agentRuns.resultCount, status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, run.id))).resolves.toEqual([{ resultCount: 2, status: "completed" }]);
    await expect(database.select().from(agentRunUsageEntries).where(and(eq(agentRunUsageEntries.runId, run.id), eq(agentRunUsageEntries.category, "result")))).resolves.toHaveLength(1);
    await expect(database.select({ data: agentRunEvents.data }).from(agentRunEvents).where(and(eq(agentRunEvents.runId, run.id), eq(agentRunEvents.eventType, "run.completed")))).resolves.toEqual([{ data: expect.objectContaining({ resultCount: 2 }) }]);
    await expect(database.select({ metadata: auditEvents.metadata }).from(auditEvents).where(and(eq(auditEvents.resourceId, run.id), eq(auditEvents.eventType, "agent.run_completed")))).resolves.toEqual([{ metadata: expect.objectContaining({ resultCount: 2 }) }]);
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

  it.each([
    ["empty scans", [], []],
    ["duplicate source", [{ sourceId: "greenhouse:invalid", observedDetailIds: [], complete: true }, { sourceId: "greenhouse:invalid", observedDetailIds: [], complete: true }], []],
    ["duplicate observed", [{ sourceId: "greenhouse:invalid", observedDetailIds: ["x", "x"], complete: true }], []],
    ["detail outside observed", [{ sourceId: "greenhouse:invalid", observedDetailIds: [], complete: true }], [{ sourceId: "greenhouse:invalid", detailId: "x", company: "Fictional", title: "AI Engineer", location: null, postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: {} }]],
  ] as const)("Greenhouse seam 对 %s 在任何 lifecycle 写入前失败", async (_name, scans, details) => {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    await expect(persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, later), details: details as any, scans: scans as any, storedObjects: [], now: later })).rejects.toThrow("AGENT_RUN_PERSIST_FAILED");
    await expect(database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId))).resolves.toHaveLength(0);
    await expect(database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, userId))).resolves.toHaveLength(0);
  });

  it("同一 claim 的并发 persistence 由账户锁和 claim 状态保持幂等", async () => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const run = await claimRun(userId, targetId, later);
    const input = { run, details: [{ sourceId: "greenhouse:race", detailId: "race", company: "Fictional", title: "AI Engineer", location: null, postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: {} }], scans: [{ sourceId: "greenhouse:race", observedDetailIds: ["race"], complete: true }], storedObjects: [{ sourceId: "greenhouse:race", detailId: "race", objectKey: "race.json", rawContentSha256: "9".repeat(64) }], now: later };
    const outcomes = await Promise.all([persistence.persistSuccessfulDiscovery(input), persistence.persistSuccessfulDiscovery(input)]);
    expect(outcomes.filter((outcome) => outcome.completed)).toHaveLength(1);
    await expect(database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId))).resolves.toHaveLength(1);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.userId, userId))).resolves.toHaveLength(1);
  });

  it("非官方新来源不接管官方 current evidence，所有来源关闭前机会保持 open", async () => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const fields = { company: "Fictional", title: "AI Engineer", location: null, postedAt: null, deadline: null, sourceType: "company_careers" };
    const official = { sourceId: "greenhouse:official", detailId: "o", ...fields, isOfficial: true, rawPayload: {} };
    const nonofficial = { sourceId: "greenhouse:nonofficial", detailId: "n", ...fields, isOfficial: false, rawPayload: { newer: true } };
    const persist = async (detail: typeof official | typeof nonofficial, raw: string) => persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, later), details: [detail], scans: [{ sourceId: detail.sourceId, observedDetailIds: [detail.detailId], complete: true }], storedObjects: [{ sourceId: detail.sourceId, detailId: detail.detailId, objectKey: `${raw}.json`, rawContentSha256: raw.repeat(64) }], now: later });
    await persist(official, "a"); await persist(nonofficial, "b");
    const [opportunity] = await database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, userId));
    const officialVersion = (await database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId))).find((version) => version.rawContentSha256 === "a".repeat(64));
    expect(opportunity?.sourcePostingVersionId).toBe(officialVersion?.id);
    await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, later), details: [], scans: [{ sourceId: official.sourceId, observedDetailIds: [], complete: true }], storedObjects: [], now: later });
    await expect(database.select({ availability: jobOpportunities.availability }).from(jobOpportunities).where(eq(jobOpportunities.userId, userId))).resolves.toEqual([{ availability: "open" }]);
    await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, later), details: [], scans: [{ sourceId: nonofficial.sourceId, observedDetailIds: [], complete: true }], storedObjects: [], now: later });
    await expect(database.select({ availability: jobOpportunities.availability }).from(jobOpportunities).where(eq(jobOpportunities.userId, userId))).resolves.toEqual([{ availability: "closed" }]);
    await expect(database.select().from(jobOpportunitySources).where(eq(jobOpportunitySources.userId, userId))).resolves.toHaveLength(4);
  });

  it("相同 created_at 的官方 current evidence 以 id 降序稳定选择", async () => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    let nextId = 0;
    const persistence = createJobDiscoveryPersistence({
      db: database,
      id: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
      auditTrail: createAuditTrail({ db: database, clock: () => later }),
    });
    const base = { company: "Fictional", title: "AI Engineer", location: null, postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: {} };
    await persistence.persistSuccessfulDiscovery({
      run: await claimRun(userId, targetId, later),
      details: [{ ...base, sourceId: "greenhouse:tie-a", detailId: "a" }, { ...base, sourceId: "greenhouse:tie-b", detailId: "b" }],
      scans: [{ sourceId: "greenhouse:tie-a", observedDetailIds: ["a"], complete: true }, { sourceId: "greenhouse:tie-b", observedDetailIds: ["b"], complete: true }],
      storedObjects: [{ sourceId: "greenhouse:tie-a", detailId: "a", objectKey: "a.json", rawContentSha256: "a".repeat(64) }, { sourceId: "greenhouse:tie-b", detailId: "b", objectKey: "b.json", rawContentSha256: "b".repeat(64) }],
      now: later,
    });
    const versions = await database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId));
    const [current] = await database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, userId));
    expect(current?.sourcePostingVersionId).toBe([...versions].sort((left, right) => right.id.localeCompare(left.id))[0]?.id);
  });

  it("late audit failure 回滚已执行的 scan close、版本和 run completion", async () => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const normal = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const sourceId = "greenhouse:rollback"; const detail = { sourceId, detailId: "rollback", company: "Fictional", title: "AI Engineer", location: null, postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: {} };
    await normal.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, firstSeen), details: [detail], scans: [{ sourceId, observedDetailIds: [detail.detailId], complete: true }], storedObjects: [{ sourceId, detailId: detail.detailId, objectKey: "before.json", rawContentSha256: "d".repeat(64) }], now: firstSeen });
    const failing = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: { bind: () => ({ append: async (event: { eventType: string }) => { if (event.eventType === "agent.run_completed") throw new Error("late audit"); } }) } as any });
    const run = await claimRun(userId, targetId, later);
    await expect(failing.persistSuccessfulDiscovery({ run, details: [], scans: [{ sourceId, observedDetailIds: [], complete: true }], storedObjects: [], now: later })).rejects.toThrow("late audit");
    await expect(database.select({ availability: jobSourcePostingVersions.availability }).from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId))).resolves.toEqual([{ availability: "open" }]);
    await expect(database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, run.id))).resolves.toEqual([{ status: "running" }]);
  });

  it("complete scan reconciliation 的 SQL statement 数不随同一 board posting 数线性增长", async () => {
    const reconcile = async (count: number) => {
      const userId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const sourceId = `greenhouse:statement-${count}`;
      await database.insert(jobAccounts).values({ id: userId });
      await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
      await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
      const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
      const details = Array.from({ length: count }, (_, index) => ({ sourceId, detailId: String(index), company: "Fictional", title: `AI Engineer ${index}`, location: null, postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: {} }));
      await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, firstSeen), details, scans: [{ sourceId, observedDetailIds: details.map((detail) => detail.detailId), complete: true }], storedObjects: details.map((detail, index) => ({ sourceId, detailId: detail.detailId, objectKey: `${count}-${index}.json`, rawContentSha256: `${index.toString(16)}`.padStart(64, "a").slice(-64) })), now: firstSeen });
      statementCount = 0;
      observedStatements = [];
      await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, later), details: [], scans: [{ sourceId, observedDetailIds: [], complete: true }], storedObjects: [], now: later });
      return { count: statementCount, queries: observedStatements.map((statement) => statement.query), maxParams: Math.max(...observedStatements.map((statement) => statement.params.length)) };
    };
    const one = await reconcile(1);
    const many = await reconcile(12);
    expect(one.count).toBeLessThanOrEqual(31);
    expect(many.count).toBe(one.count);
    expect(many.queries).toEqual(one.queries);
    expect(many.maxParams).toBe(one.maxParams);
  });

  it("数百条完整扫描以常数 SQL 形状关闭并保留 lifecycle evidence", async () => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const sourceId = "greenhouse:large-statement"; const count = 512;
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    await database.execute(sql`
      with generated as (
        select generate_series(1, ${count}) as ordinal, gen_random_uuid() as posting_id,
          gen_random_uuid() as version_id, gen_random_uuid() as opportunity_id, gen_random_uuid() as evidence_id
      ), postings as (
        insert into job_source_postings (id, user_id, source_type, source_identifier, source_id, source_identity, application_deadline, is_official, availability, availability_updated_at, created_at, updated_at)
        select posting_id, ${userId}::uuid, 'company_careers', md5('posting:' || ordinal::text) || md5('posting-extra:' || ordinal::text), ${sourceId},
          jsonb_build_object('sourceId', ${sourceId}::text, 'detailId', ordinal::text), null, true, 'open', ${firstSeen.toISOString()}::timestamptz, ${firstSeen.toISOString()}::timestamptz, ${firstSeen.toISOString()}::timestamptz
        from generated returning id
      ), versions as (
        insert into job_source_posting_versions (id, user_id, source_posting_id, version, content_sha256, raw_content_sha256, raw_object_reference, retrieved_at, availability, created_at)
        select generated.version_id, ${userId}::uuid, generated.posting_id, 1, md5('content:' || generated.ordinal::text) || md5('content-extra:' || generated.ordinal::text), md5('raw:' || generated.ordinal::text) || md5('raw-extra:' || generated.ordinal::text),
          jsonb_build_object('objectKey', 'large-' || generated.ordinal || '.json'), ${firstSeen.toISOString()}::timestamptz, 'open', ${firstSeen.toISOString()}::timestamptz
        from generated join postings on postings.id = generated.posting_id returning id
      ), opportunities as (
        insert into job_opportunities (id, user_id, import_id, source_posting_version_id, dedup_key, company, title, location, posted_at, deadline, description, normalized_data, availability, availability_updated_at, created_at, updated_at)
        select generated.opportunity_id, ${userId}::uuid, null, generated.version_id, md5('opportunity:' || generated.ordinal::text) || md5('opportunity-extra:' || generated.ordinal::text), 'Fictional', 'Large ' || generated.ordinal, null, null, null, null,
          jsonb_build_object('sourceId', ${sourceId}::text, 'detailId', generated.ordinal::text), 'open', ${firstSeen.toISOString()}::timestamptz, ${firstSeen.toISOString()}::timestamptz, ${firstSeen.toISOString()}::timestamptz
        from generated join versions on versions.id = generated.version_id returning id
      )
      insert into job_opportunity_sources (id, user_id, opportunity_id, source_posting_version_id, created_at)
      select generated.evidence_id, ${userId}::uuid, generated.opportunity_id, generated.version_id, ${firstSeen.toISOString()}::timestamptz
      from generated join opportunities on opportunities.id = generated.opportunity_id
    `);
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    statementCount = 0; observedStatements = [];
    await persistence.persistSuccessfulDiscovery({ run: await claimRun(userId, targetId, later), details: [], scans: [{ sourceId, observedDetailIds: [], complete: true }], storedObjects: [], now: later });
    await expect(database.execute(sql`select count(*)::int as count from job_source_postings where user_id = ${userId}::uuid and availability = 'closed'`)).resolves.toEqual([{ count }]);
    await expect(database.execute(sql`select count(*)::int as count from job_source_posting_versions where user_id = ${userId}::uuid`)).resolves.toEqual([{ count: count * 2 }]);
    await expect(database.execute(sql`select count(*)::int as count from job_opportunity_sources where user_id = ${userId}::uuid`)).resolves.toEqual([{ count: count * 2 }]);
    expect(statementCount).toBeLessThanOrEqual(35);
    expect(Math.max(...observedStatements.map((statement) => statement.params.length))).toBeLessThanOrEqual(32);
    expect(observedStatements.some((statement) => statement.query.includes("jsonb_to_recordset"))).toBe(true);
    expect(observedStatements.some((statement) => /\bin\s*\(\s*\$\d+\s*,\s*\$\d+/.test(statement.query))).toBe(false);
  });

  it("仅接受完全相同的来源健康冲突重放，差异冲突回滚当前终态", async () => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const sourceId = "greenhouse:conflict"; const watchlistItemId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: firstSeen, updatedAt: firstSeen });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: firstSeen });
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => later }) });
    const check = (runId: string) => ({ checkId: crypto.randomUUID(), runId, targetId, watchlistItemId, sourceId, status: "zero_valid_results" as const, reasonCodes: [], impact: { scope: "none" as const, affectedCount: null }, observedPostingCount: 0, selectedDetailCount: 0, validDetailCount: 0, requestAttemptCount: 1, checkedAt: later.toISOString() });
    const sameRun = await claimRun(userId, targetId, later); const same = check(sameRun.id);
    await database.insert(jobSourceHealthChecks).values({ id: same.checkId, userId, runId: same.runId, targetId, watchlistItemId, sourceId, status: same.status, reasonCodes: same.reasonCodes, impactScope: same.impact.scope, impactAffectedCount: null, observedPostingCount: 0, selectedDetailCount: 0, validDetailCount: 0, requestAttemptCount: 1, checkedAt: later });
    await expect(persistence.persistSuccessfulDiscovery({ run: sameRun, details: [], scans: [{ sourceId, observedDetailIds: [], complete: true }], storedObjects: [], sourceChecks: [{ ...same, checkId: crypto.randomUUID() }], now: later })).resolves.toMatchObject({ completed: true });
    await expect(database.select().from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, sameRun.id))).resolves.toHaveLength(1);
    const differentRun = await claimRun(userId, targetId, later); const existing = check(differentRun.id);
    await database.insert(jobSourceHealthChecks).values({ id: existing.checkId, userId, runId: existing.runId, targetId, watchlistItemId, sourceId, status: existing.status, reasonCodes: existing.reasonCodes, impactScope: existing.impact.scope, impactAffectedCount: null, observedPostingCount: 0, selectedDetailCount: 0, validDetailCount: 0, requestAttemptCount: 1, checkedAt: later });
    await expect(persistence.persistSuccessfulDiscovery({ run: differentRun, details: [], scans: [{ sourceId, observedDetailIds: [], complete: true }], storedObjects: [], sourceChecks: [{ ...existing, checkId: crypto.randomUUID(), requestAttemptCount: 2 }], now: later })).rejects.toThrow("AGENT_RUN_PERSIST_FAILED");
    await expect(database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, differentRun.id))).resolves.toEqual([{ status: "running" }]);
  });
});
