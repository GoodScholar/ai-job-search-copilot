import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  jobAccounts,
  jobOpportunities,
  jobOpportunitySources,
  jobSourcePostingVersions,
  jobSourcePostings,
  migrateDatabase,
  recommendationExclusions,
  type Database,
} from "@job-copilot/database";
import { and, eq } from "drizzle-orm";
import { createAuditTrail } from "./audit-trail";
import { createJobOpportunityArchiveCommands, createJobOpportunityArchiveQueries, JobOpportunityArchiveError } from "./job-opportunity-archives";

const now = new Date("2026-09-15T08:00:00.000Z");

describe("job opportunity archives", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = createDatabase(container.getConnectionUri());
    await migrateDatabase(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await container?.stop();
  });

  async function opportunity(userId = crypto.randomUUID(), title = "前端工程师") {
    const sourcePostingId = crypto.randomUUID();
    const sourcePostingVersionId = crypto.randomUUID();
    const opportunityId = crypto.randomUUID();
    const digest = sourcePostingId.replaceAll("-", "").padEnd(64, "a");
    await db.insert(jobAccounts).values({ id: userId }).onConflictDoNothing();
    await db.insert(jobSourcePostings).values({
      id: sourcePostingId, userId, sourceType: "user_import", sourceIdentifier: digest,
      sourceIdentity: { hash: digest }, isOfficial: false, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now,
    });
    await db.insert(jobSourcePostingVersions).values({
      id: sourcePostingVersionId, userId, sourcePostingId, version: 1, contentSha256: digest,
      rawContentSha256: digest, rawObjectReference: { key: "safe" }, normalizedData: {}, retrievedAt: now, availability: "open", createdAt: now,
    });
    await db.insert(jobOpportunities).values({
      id: opportunityId, userId, importId: null, sourcePostingVersionId, canonicalOpportunityId: null, dedupKey: digest,
      company: "示例科技", title, location: "上海", postedAt: null, deadline: null, description: "保留的岗位正文",
      normalizedData: {}, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now,
    });
    await db.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId, opportunityId, sourcePostingVersionId, createdAt: now });
    return { userId, opportunityId, sourcePostingVersionId };
  }

  function commands() {
    return createJobOpportunityArchiveCommands({ db, auditTrail: createAuditTrail({ db, clock: () => now }), clock: () => now });
  }

  it("归档只改变当前投影，默认清单排除并保留来源和既有推荐排除证据", async () => {
    const fixture = await opportunity();
    const archive = await commands().change({
      userId: fixture.userId, requestId: crypto.randomUUID(), opportunityId: fixture.opportunityId,
      command: { action: "archive", commandId: crypto.randomUUID(), expectedVersion: 0 },
    });

    expect(archive).toMatchObject({ applied: true, state: { archivedAt: now.toISOString(), version: 1 } });
    await expect(createJobOpportunityArchiveQueries({ db }).list({ userId: fixture.userId, filter: "active", limit: 20 }))
      .resolves.toMatchObject({ items: [], counts: { active: 0, archived: 1 } });
    await expect(createJobOpportunityArchiveQueries({ db }).list({ userId: fixture.userId, filter: "archived", limit: 20 }))
      .resolves.toMatchObject({ items: [{ opportunityId: fixture.opportunityId, title: "前端工程师", archivedAt: now.toISOString(), version: 1 }], counts: { active: 0, archived: 1 } });
    await expect(db.select().from(jobOpportunitySources).where(and(eq(jobOpportunitySources.userId, fixture.userId), eq(jobOpportunitySources.opportunityId, fixture.opportunityId))))
      .resolves.toHaveLength(1);
    await expect(db.select().from(recommendationExclusions).where(eq(recommendationExclusions.userId, fixture.userId))).resolves.toHaveLength(0);
    await expect(createAuditTrail({ db, clock: () => now }).query({ userId: fixture.userId })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "job.opportunity_archived", resourceId: fixture.opportunityId, metadata: { opportunityId: fixture.opportunityId, action: "archive", version: 1 } }),
    ]));
  });

  it("命令键回放保持原响应，恢复后旧归档命令不会再次归档", async () => {
    const fixture = await opportunity();
    const archiveCommandId = crypto.randomUUID();
    const first = await commands().change({ userId: fixture.userId, requestId: crypto.randomUUID(), opportunityId: fixture.opportunityId, command: { action: "archive", commandId: archiveCommandId, expectedVersion: 0 } });
    const restored = await commands().change({ userId: fixture.userId, requestId: crypto.randomUUID(), opportunityId: fixture.opportunityId, command: { action: "restore", commandId: crypto.randomUUID(), expectedVersion: 1 } });
    const replayed = await commands().change({ userId: fixture.userId, requestId: crypto.randomUUID(), opportunityId: fixture.opportunityId, command: { action: "archive", commandId: archiveCommandId, expectedVersion: 0 } });

    expect(restored).toMatchObject({ applied: true, state: { archivedAt: null, version: 2 } });
    expect(replayed).toEqual(first);
    await expect(createJobOpportunityArchiveQueries({ db }).get({ userId: fixture.userId, opportunityId: fixture.opportunityId }))
      .resolves.toMatchObject({ archivedAt: null, version: 2 });
  });

  it("重复归档和恢复在当前版本上幂等，并且并发旧版本命令只有一个生效", async () => {
    const fixture = await opportunity();
    const [first, competing] = await Promise.allSettled([
      commands().change({ userId: fixture.userId, requestId: crypto.randomUUID(), opportunityId: fixture.opportunityId, command: { action: "archive", commandId: crypto.randomUUID(), expectedVersion: 0 } }),
      commands().change({ userId: fixture.userId, requestId: crypto.randomUUID(), opportunityId: fixture.opportunityId, command: { action: "archive", commandId: crypto.randomUUID(), expectedVersion: 0 } }),
    ]);
    expect([first, competing].filter((result) => result.status === "fulfilled")).toEqual([expect.objectContaining({ value: expect.objectContaining({ applied: true, state: expect.objectContaining({ version: 1 }) }) })]);
    expect([first, competing].filter((result) => result.status === "rejected")).toEqual([expect.objectContaining({ reason: new JobOpportunityArchiveError("JOB_OPPORTUNITY_ARCHIVE_VERSION_CONFLICT") })]);

    await expect(commands().change({ userId: fixture.userId, requestId: crypto.randomUUID(), opportunityId: fixture.opportunityId, command: { action: "archive", commandId: crypto.randomUUID(), expectedVersion: 1 } }))
      .resolves.toMatchObject({ applied: false, state: { version: 1 } });
    await expect(commands().change({ userId: fixture.userId, requestId: crypto.randomUUID(), opportunityId: fixture.opportunityId, command: { action: "restore", commandId: crypto.randomUUID(), expectedVersion: 1 } }))
      .resolves.toMatchObject({ applied: true, state: { archivedAt: null, version: 2 } });
    await expect(commands().change({ userId: fixture.userId, requestId: crypto.randomUUID(), opportunityId: fixture.opportunityId, command: { action: "restore", commandId: crypto.randomUUID(), expectedVersion: 2 } }))
      .resolves.toMatchObject({ applied: false, state: { archivedAt: null, version: 2 } });
  });

  it("当前工作区仅投影 canonical root，归档和恢复不改变 alias 历史", async () => {
    const root = await opportunity();
    const alias = await opportunity(root.userId, "历史别名岗位");
    await db.update(jobOpportunities).set({ canonicalOpportunityId: root.opportunityId }).where(eq(jobOpportunities.id, alias.opportunityId));
    const queries = createJobOpportunityArchiveQueries({ db });

    await expect(queries.list({ userId: root.userId, filter: "active", limit: 20 }))
      .resolves.toMatchObject({ items: [{ opportunityId: root.opportunityId }], counts: { active: 1, archived: 0 } });
    await expect(commands().change({ userId: root.userId, requestId: crypto.randomUUID(), opportunityId: alias.opportunityId, command: { action: "archive", commandId: crypto.randomUUID(), expectedVersion: 0 } }))
      .rejects.toEqual(new JobOpportunityArchiveError("JOB_OPPORTUNITY_NOT_FOUND"));

    await commands().change({ userId: root.userId, requestId: crypto.randomUUID(), opportunityId: root.opportunityId, command: { action: "archive", commandId: crypto.randomUUID(), expectedVersion: 0 } });
    await expect(queries.list({ userId: root.userId, filter: "archived", limit: 20 }))
      .resolves.toMatchObject({ items: [{ opportunityId: root.opportunityId }], counts: { active: 0, archived: 1 } });
    await expect(db.select({ canonicalOpportunityId: jobOpportunities.canonicalOpportunityId, archivedAt: jobOpportunities.archivedAt }).from(jobOpportunities).where(eq(jobOpportunities.id, alias.opportunityId)))
      .resolves.toEqual([{ canonicalOpportunityId: root.opportunityId, archivedAt: null }]);

    await commands().change({ userId: root.userId, requestId: crypto.randomUUID(), opportunityId: root.opportunityId, command: { action: "restore", commandId: crypto.randomUUID(), expectedVersion: 1 } });
    await expect(queries.list({ userId: root.userId, filter: "active", limit: 20 }))
      .resolves.toMatchObject({ items: [{ opportunityId: root.opportunityId }], counts: { active: 1, archived: 0 } });
  });

  it("版本冲突和跨账户资源都给出稳定且不泄露的失败", async () => {
    const owner = await opportunity();
    const other = crypto.randomUUID();
    await db.insert(jobAccounts).values({ id: other });

    await expect(commands().change({ userId: owner.userId, requestId: crypto.randomUUID(), opportunityId: owner.opportunityId, command: { action: "archive", commandId: crypto.randomUUID(), expectedVersion: 3 } }))
      .rejects.toEqual(new JobOpportunityArchiveError("JOB_OPPORTUNITY_ARCHIVE_VERSION_CONFLICT"));
    await expect(commands().change({ userId: other, requestId: crypto.randomUUID(), opportunityId: owner.opportunityId, command: { action: "archive", commandId: crypto.randomUUID(), expectedVersion: 0 } }))
      .rejects.toEqual(new JobOpportunityArchiveError("JOB_OPPORTUNITY_NOT_FOUND"));
    await expect(createJobOpportunityArchiveQueries({ db }).get({ userId: other, opportunityId: owner.opportunityId })).resolves.toBeNull();
    await expect(createJobOpportunityArchiveQueries({ db }).list({ userId: other, filter: "active", cursor: owner.opportunityId, limit: 20 }))
      .rejects.toEqual(new JobOpportunityArchiveError("JOB_OPPORTUNITY_ARCHIVE_CURSOR_INVALID"));
    await expect(createJobOpportunityArchiveQueries({ db }).list({ userId: other, filter: "active", cursor: crypto.randomUUID(), limit: 20 }))
      .rejects.toEqual(new JobOpportunityArchiveError("JOB_OPPORTUNITY_ARCHIVE_CURSOR_INVALID"));
  });
});
