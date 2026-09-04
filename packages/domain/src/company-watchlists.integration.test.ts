import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companyWatchlistRevisions,
  companyWatchlists,
  createDatabase,
  jobAccounts,
  jobSourceHealthChecks,
  jobTargetRevisions,
  jobTargets,
  migrateDatabase,
  type Database,
} from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createAgentRunCommands } from "./agent-run-control";
import { createCompanyWatchlistCommands, createCompanyWatchlistQueries } from "./company-watchlists";
import { createSourceHealthQueries } from "./source-health";
import { createSourceCapabilityProjectionQueries } from "./source-capability-projections";

const now = new Date("2026-08-30T12:00:00.000Z");

describe("company watchlists", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);

  afterAll(async () => {
    await database?.$client.end();
    await container?.stop();
  });

  async function activeTarget(state: "active" | "inactive" = "active") {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({
      id: targetId, userId, version: 1, priority: "primary", state, activeSlot: null, createdAt: now, updatedAt: now,
    });
    await database.insert(jobTargetRevisions).values({
      id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state,
      constraints: {
        roleFamily: "AI 应用工程师", seniority: null, locations: [], workModes: [], relocation: "unknown", salary: null, industries: [],
        dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
      },
      createdAt: now,
    });
    return { userId, targetId };
  }

  function commands() {
    return createCompanyWatchlistCommands({
      db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
  }

  async function addItems(userId: string, targetId: string, count: number, startIndex = 1) {
    let result = await createCompanyWatchlistQueries({ db: database }).get({ userId, targetId });
    for (let index = startIndex; index < startIndex + count; index += 1) {
      result = await commands().addItem({
        userId, targetId, requestId: crypto.randomUUID(),
        command: {
          expectedVersion: result.version, canonicalCompanyName: `Company ${index}`, careersUrl: `https://jobs.example${index}.test/openings/${index}`,
          allowedDomains: [`example${index}.test`], sourceNote: index === 2 ? "第二项备注" : null,
        },
      });
    }
    return result;
  }

  it("将空 Watchlist 读取为虚拟版本零，并持久化首项及不可变 revision", async () => {
    const { userId, targetId } = await activeTarget();

    await expect(createCompanyWatchlistQueries({ db: database }).get({ userId, targetId })).resolves.toEqual({
      target: { targetId, targetVersion: 1, targetState: "active", roleFamily: "AI 应用工程师" }, version: 0, items: [],
    });

    const added = await commands().addItem({
      userId, targetId, requestId: crypto.randomUUID(),
      command: {
        expectedVersion: 0, canonicalCompanyName: "  Example AI  ", careersUrl: "https://jobs.example.test/openings",
        allowedDomains: ["EXAMPLE.TEST"], sourceNote: "重点关注",
      },
    });

    expect(added).toMatchObject({
      target: { targetId, targetVersion: 1, targetState: "active", roleFamily: "AI 应用工程师" },
      version: 1,
      items: [{ canonicalCompanyName: "Example AI", careersUrl: "https://jobs.example.test/openings", allowedDomains: ["example.test"], sourceNote: "重点关注", state: "enabled", position: 1 }],
    });
    expect(added.items[0]?.itemId).toEqual(expect.any(String));

    const revisions = await database.select().from(companyWatchlistRevisions).where(eq(companyWatchlistRevisions.targetId, targetId));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ version: 1, items: added.items });

    const events = await createAuditTrail({ db: database, clock: () => now }).query({ userId });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
      eventType: "profile.company_watchlist_maintained", reasonCode: "COMPANY_WATCHLIST_ITEM_ADDED", resourceId: targetId,
      metadata: { targetId, action: "item_added", version: 1, itemId: added.items[0]!.itemId, itemCount: 1 },
    })]));
    expect(JSON.stringify(events)).not.toContain("Example AI");
    expect(JSON.stringify(events)).not.toContain("jobs.example.test");
    expect(JSON.stringify(events)).not.toContain("重点关注");

    await expect(createCompanyWatchlistQueries({ db: database }).get({ userId, targetId })).resolves.toEqual(added);
  });

  it("编辑、排序和启停只改变允许的字段并为每次命令追加不可变 revision", async () => {
    const { userId, targetId } = await activeTarget();
    const initial = await addItems(userId, targetId, 3);
    const [first, second, third] = initial.items;
    const before = await database.select().from(companyWatchlistRevisions).where(eq(companyWatchlistRevisions.targetId, targetId));
    const beforeJson = before.map((revision) => JSON.stringify(revision.items));

    const revised = await commands().reviseItem({
      userId, targetId, requestId: crypto.randomUUID(), itemId: second!.itemId,
      command: { expectedVersion: 3, canonicalCompanyName: "Revised Company", careersUrl: "https://careers.revised.test/listings", allowedDomains: ["revised.test"], sourceNote: "修订备注" },
    });
    expect(revised.version).toBe(4);
    expect(revised.items[1]).toEqual({
      itemId: second!.itemId, canonicalCompanyName: "Revised Company", careersUrl: "https://careers.revised.test/listings",
      allowedDomains: ["revised.test"], sourceNote: "修订备注", state: "enabled", position: 2,
    });

    const reordered = await commands().reorder({
      userId, targetId, requestId: crypto.randomUUID(),
      command: { expectedVersion: 4, orderedItemIds: [third!.itemId, second!.itemId, first!.itemId] },
    });
    expect(reordered.version).toBe(5);
    expect(reordered.items.map(({ itemId, position }) => ({ itemId, position }))).toEqual([
      { itemId: third!.itemId, position: 1 }, { itemId: second!.itemId, position: 2 }, { itemId: first!.itemId, position: 3 },
    ]);

    const disabled = await commands().setItemState({
      userId, targetId, requestId: crypto.randomUUID(), itemId: second!.itemId, command: { expectedVersion: 5, state: "disabled" },
    });
    expect(disabled.version).toBe(6);
    expect(disabled.items[1]).toEqual({ ...revised.items[1], state: "disabled" });
    const enabled = await commands().setItemState({
      userId, targetId, requestId: crypto.randomUUID(), itemId: second!.itemId, command: { expectedVersion: 6, state: "enabled" },
    });
    expect(enabled.version).toBe(7);
    expect(enabled.items[1]).toEqual(revised.items[1]);

    const after = await database.select().from(companyWatchlistRevisions).where(eq(companyWatchlistRevisions.targetId, targetId));
    expect(after).toHaveLength(7);
    expect(after.slice(0, 3).map((revision) => JSON.stringify(revision.items))).toEqual(beforeJson);
  });

  it("拒绝重复、无效排列、缺失条目和第 51 项且不追加 revision", async () => {
    const { userId, targetId } = await activeTarget();
    const initial = await addItems(userId, targetId, 2);
    const [first, second] = initial.items;
    const revisionCount = async () => (await database.select().from(companyWatchlistRevisions).where(eq(companyWatchlistRevisions.targetId, targetId))).length;
    expect(await revisionCount()).toBe(2);

    await expect(commands().addItem({ userId, targetId, requestId: crypto.randomUUID(), command: {
      expectedVersion: 2, canonicalCompanyName: "company 1", careersUrl: "https://careers.duplicate.test", allowedDomains: ["duplicate.test"], sourceNote: null,
    } })).rejects.toMatchObject({ code: "COMPANY_WATCHLIST_DUPLICATE_COMPANY" });
    await expect(commands().addItem({ userId, targetId, requestId: crypto.randomUUID(), command: {
      expectedVersion: 2, canonicalCompanyName: "Different Company", careersUrl: "https://JOBS.EXAMPLE1.TEST/openings/1", allowedDomains: first!.allowedDomains, sourceNote: null,
    } })).rejects.toMatchObject({ code: "COMPANY_WATCHLIST_DUPLICATE_SOURCE" });
    await expect(commands().addItem({ userId, targetId, requestId: crypto.randomUUID(), command: {
      expectedVersion: 2, canonicalCompanyName: "Fragment Duplicate", careersUrl: "https://jobs.example1.test/openings/1#alternate", allowedDomains: first!.allowedDomains, sourceNote: null,
    } })).rejects.toMatchObject({ code: "COMPANY_WATCHLIST_DUPLICATE_SOURCE" });
    await expect(commands().reviseItem({ userId, targetId, requestId: crypto.randomUUID(), itemId: crypto.randomUUID(), command: {
      expectedVersion: 2, canonicalCompanyName: "Missing", careersUrl: "https://missing.test", allowedDomains: ["missing.test"], sourceNote: null,
    } })).rejects.toMatchObject({ code: "COMPANY_WATCHLIST_ITEM_NOT_FOUND" });
    await expect(commands().reorder({ userId, targetId, requestId: crypto.randomUUID(), command: {
      expectedVersion: 2, orderedItemIds: [second!.itemId],
    } })).rejects.toMatchObject({ code: "COMPANY_WATCHLIST_ITEM_NOT_FOUND" });
    expect(await revisionCount()).toBe(2);

    const full = await addItems(userId, targetId, 48, 3);
    await expect(commands().addItem({ userId, targetId, requestId: crypto.randomUUID(), command: {
      expectedVersion: full.version, canonicalCompanyName: "Company 51", careersUrl: "https://jobs.example51.test/openings/51", allowedDomains: ["example51.test"], sourceNote: null,
    } })).rejects.toMatchObject({ code: "COMPANY_WATCHLIST_LIMIT" });
    expect(await revisionCount()).toBe(50);
  });

  it("同版本并发写入只允许一项成功，陈旧命令不改变当前状态或 revision", async () => {
    const { userId, targetId } = await activeTarget();
    const initial = await addItems(userId, targetId, 1);
    const itemId = initial.items[0]!.itemId;
    const writes = await Promise.allSettled([
      commands().addItem({ userId, targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 1, canonicalCompanyName: "Concurrent A", careersUrl: "https://concurrent-a.test", allowedDomains: ["concurrent-a.test"], sourceNote: null } }),
      commands().addItem({ userId, targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 1, canonicalCompanyName: "Concurrent B", careersUrl: "https://concurrent-b.test", allowedDomains: ["concurrent-b.test"], sourceNote: null } }),
    ]);
    expect(writes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(writes.filter(({ status }) => status === "rejected")[0]).toMatchObject({ reason: { code: "COMPANY_WATCHLIST_VERSION_CONFLICT" } });
    const current = await createCompanyWatchlistQueries({ db: database }).get({ userId, targetId });
    const revisionCount = (await database.select().from(companyWatchlistRevisions).where(eq(companyWatchlistRevisions.targetId, targetId))).length;
    expect(current.version).toBe(2);
    expect(revisionCount).toBe(2);

    await expect(commands().reviseItem({ userId, targetId, requestId: crypto.randomUUID(), itemId, command: { expectedVersion: 1, canonicalCompanyName: "Stale", careersUrl: "https://stale.test", allowedDomains: ["stale.test"], sourceNote: null } }))
      .rejects.toMatchObject({ code: "COMPANY_WATCHLIST_VERSION_CONFLICT" });
    await expect(commands().reorder({ userId, targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 1, orderedItemIds: current.items.map(({ itemId: id }) => id) } }))
      .rejects.toMatchObject({ code: "COMPANY_WATCHLIST_VERSION_CONFLICT" });
    await expect(commands().setItemState({ userId, targetId, requestId: crypto.randomUUID(), itemId, command: { expectedVersion: 1, state: "disabled" } }))
      .rejects.toMatchObject({ code: "COMPANY_WATCHLIST_VERSION_CONFLICT" });
    await expect(createCompanyWatchlistQueries({ db: database }).get({ userId, targetId })).resolves.toEqual(current);
    await expect(database.select().from(companyWatchlistRevisions).where(eq(companyWatchlistRevisions.targetId, targetId))).resolves.toHaveLength(revisionCount);
  });

  it("将跨账户目标视为不存在，并在 inactive 目标上拒绝写入", async () => {
    const owned = await activeTarget();
    const existing = await addItems(owned.userId, owned.targetId, 1);
    const otherUserId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: otherUserId });

    await expect(createCompanyWatchlistQueries({ db: database }).get({ userId: otherUserId, targetId: owned.targetId }))
      .rejects.toMatchObject({ code: "COMPANY_WATCHLIST_TARGET_NOT_FOUND" });
    await expect(commands().reviseItem({ userId: otherUserId, targetId: owned.targetId, requestId: crypto.randomUUID(), itemId: existing.items[0]!.itemId, command: {
      expectedVersion: 1, canonicalCompanyName: "Enumeration", careersUrl: "https://enumeration.test", allowedDomains: ["enumeration.test"], sourceNote: null,
    } })).rejects.toMatchObject({ code: "COMPANY_WATCHLIST_TARGET_NOT_FOUND" });

    const inactive = await activeTarget("inactive");
    await expect(commands().addItem({ userId: inactive.userId, targetId: inactive.targetId, requestId: crypto.randomUUID(), command: {
      expectedVersion: 0, canonicalCompanyName: "Inactive", careersUrl: "https://inactive.test", allowedDomains: ["inactive.test"], sourceNote: null,
    } })).rejects.toMatchObject({ code: "COMPANY_WATCHLIST_TARGET_INACTIVE" });
    await expect(database.select().from(companyWatchlists).where(eq(companyWatchlists.targetId, inactive.targetId))).resolves.toEqual([]);
  });

  it("来源健康查询只投影当前 Watchlist：未检查、停用覆盖与外部所有者均安全", async () => {
    const { userId, targetId } = await activeTarget();
    const initial = await commands().addItem({ userId, targetId, requestId: crypto.randomUUID(), command: {
      expectedVersion: 0, canonicalCompanyName: "Health Board", careersUrl: "https://boards.greenhouse.io/health-board",
      allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null,
    } });
    const item = initial.items[0]!;
    const queries = createSourceHealthQueries({ db: database });

    await expect(queries.get({ userId, targetId })).resolves.toMatchObject({ targetId, watchlistVersion: 1, sources: [{
      watchlistItemId: item.itemId, sourceId: "greenhouse:health-board", state: "enabled", status: null,
      runId: null, reasonCodes: [], impact: { scope: "none", affectedCount: null }, lastCheckedAt: null, suggestedAction: "wait_for_next_run",
    }] });
    const disabled = await commands().setItemState({ userId, targetId, itemId: item.itemId, requestId: crypto.randomUUID(), command: { expectedVersion: 1, state: "disabled" } });
    await expect(queries.get({ userId, targetId })).resolves.toMatchObject({ watchlistVersion: disabled.version, sources: [{
      watchlistItemId: item.itemId, state: "disabled", status: "disabled", runId: null, reasonCodes: [], lastCheckedAt: null, suggestedAction: "reenable_source",
    }] });
    const foreignUserId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: foreignUserId });
    await expect(queries.get({ userId: foreignUserId, targetId })).rejects.toMatchObject({ code: "COMPANY_WATCHLIST_TARGET_NOT_FOUND" });
  });

  it("不把旧来源身份的健康证据继承给当前修订来源", async () => {
    const { userId, targetId } = await activeTarget();
    const initial = await commands().addItem({ userId, targetId, requestId: crypto.randomUUID(), command: {
      expectedVersion: 0, canonicalCompanyName: "Stale Board", careersUrl: "https://boards.greenhouse.io/stale-board", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null,
    } });
    const item = initial.items[0]!;
    const started = await createAgentRunCommands({ db: database, queue: { enqueue: async () => {} }, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await database.insert(jobSourceHealthChecks).values({ id: crypto.randomUUID(), userId, runId: started.runId, targetId, watchlistItemId: item.itemId, sourceId: "greenhouse:stale-board", status: "healthy", reasonCodes: [], impactScope: "none", impactAffectedCount: null, observedPostingCount: 1, selectedDetailCount: 1, validDetailCount: 1, requestAttemptCount: 1, checkedAt: now });
    const revised = await commands().reviseItem({ userId, targetId, itemId: item.itemId, requestId: crypto.randomUUID(), command: {
      expectedVersion: 1, canonicalCompanyName: "Stale Board", careersUrl: "https://boards.greenhouse.io/replacement-board", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null,
    } });
    await expect(createSourceHealthQueries({ db: database }).get({ userId, targetId })).resolves.toMatchObject({ watchlistVersion: revised.version, sources: [{ sourceId: "greenhouse:replacement-board", status: null, runId: null, reasonCodes: [], lastCheckedAt: null, suggestedAction: "wait_for_next_run" }] });
  });

  it("能力投影只绑定 owner 的当前 Watchlist 与服务端适配器声明，不读取健康事实", async () => {
    const { userId, targetId } = await activeTarget();
    const overview = await commands().addItem({ userId, targetId, requestId: crypto.randomUUID(), command: {
      expectedVersion: 0, canonicalCompanyName: "Capability Board", careersUrl: "https://boards.greenhouse.io/capability-board",
      allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null,
    } });
    const item = overview.items[0]!;
    const projection = createSourceCapabilityProjectionQueries({ db: database, capabilityAdapter: {
      adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2",
      declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2", contractVersion: "source-capabilities-v1", capabilities: ["continuous_monitoring"] }),
    } });
    const started = await createAgentRunCommands({ db: database, queue: { enqueue: async () => {} }, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    await database.insert(jobSourceHealthChecks).values({ id: crypto.randomUUID(), userId, runId: started.runId, targetId, watchlistItemId: item.itemId, sourceId: "greenhouse:capability-board", status: "rate_limited", reasonCodes: ["SOURCE_RATE_LIMITED"], impactScope: "entire_source", impactAffectedCount: null, observedPostingCount: 0, selectedDetailCount: 0, validDetailCount: 0, requestAttemptCount: 1, checkedAt: now });
    await expect(projection.get({ userId, targetId })).resolves.toMatchObject({
      targetId, watchlistVersion: overview.version,
      sources: [{ watchlistItemId: item.itemId, name: "Capability Board", state: "enabled", declaration: {
        sourceId: "greenhouse:capability-board", adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2",
        contractVersion: "source-capabilities-v1", capabilities: ["continuous_monitoring"],
      } }],
    });
    const foreignUserId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: foreignUserId });
    await expect(projection.get({ userId: foreignUserId, targetId })).rejects.toMatchObject({ code: "COMPANY_WATCHLIST_TARGET_NOT_FOUND" });
  });
});
