import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createDatabase,
  jobAccounts,
  jobProfiles,
  jobTargetRevisions,
  jobTargets,
  migrateDatabase,
  profileFactRevisions,
  profileFacts,
  type Database,
} from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createJobTargetCommands, createJobTargetQueries } from "./job-targets";

const now = new Date("2026-08-28T12:00:00.000Z");
const constraints = {
  roleFamily: "AI 应用工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const,
  salary: null, industries: [],
  dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
};

describe("job targets", () => {
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

  async function userWithTrustedFacts(inputs: Array<{
    factType: "skill" | "language";
    factValue: { name: string; level?: string };
  }> = [{ factType: "skill", factValue: { name: "React TypeScript" } }]) {
    const userId = crypto.randomUUID();
    const profileId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
    for (const input of inputs) {
      const profileFactId = crypto.randomUUID();
      await database.insert(profileFacts).values({ id: profileFactId, userId, profileId, factType: input.factType, createdAt: now });
      await database.insert(profileFactRevisions).values({
        id: crypto.randomUUID(), userId, profileFactId, revisionNumber: 1, factType: input.factType, factValue: input.factValue,
        state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now,
      });
    }
    return userId;
  }

  function commands() {
    return createJobTargetCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
  }

  it("保留 language 画像事实的等级作为建议证据标签", async () => {
    const userId = await userWithTrustedFacts([{ factType: "language", factValue: { name: "TypeScript", level: "熟练" } }]);

    const overview = await createJobTargetQueries({ db: database }).getOverview({ userId });

    expect(overview.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        roleFamily: "前端工程师",
        evidence: expect.arrayContaining([expect.objectContaining({ label: expect.stringContaining("熟练") })]),
      }),
    ]));
  });

  it("不会因 21 条未匹配可信事实超过回退建议的证据契约上限", async () => {
    const userId = await userWithTrustedFacts(Array.from({ length: 21 }, (_, index) => ({
      factType: "skill" as const,
      factValue: { name: `无关技能 ${index}` },
    })));

    const overview = await createJobTargetQueries({ db: database }).getOverview({ userId });

    expect(overview.suggestions).toHaveLength(3);
    expect(overview.suggestions.every((suggestion) => suggestion.evidence.length <= 20)).toBe(true);
  });

  it("在创建前不持久化建议，并限制一个主目标和两个次目标", async () => {
    const userId = await userWithTrustedFacts();
    const queries = createJobTargetQueries({ db: database });
    await expect(queries.getOverview({ userId })).resolves.toMatchObject({ suggestions: expect.arrayContaining([expect.any(Object)]), targets: [] });
    await expect(database.select().from(jobTargets).where(eq(jobTargets.userId, userId))).resolves.toEqual([]);

    await commands().create({ userId, requestId: crypto.randomUUID(), command: { priority: "primary", constraints } });
    await commands().create({ userId, requestId: crypto.randomUUID(), command: { priority: "secondary", constraints } });
    await commands().create({ userId, requestId: crypto.randomUUID(), command: { priority: "secondary", constraints } });
    await expect(commands().create({ userId, requestId: crypto.randomUUID(), command: { priority: "primary", constraints } }))
      .rejects.toMatchObject({ code: "JOB_TARGET_PRIMARY_LIMIT" });
    await expect(commands().create({ userId, requestId: crypto.randomUUID(), command: { priority: "secondary", constraints } }))
      .rejects.toMatchObject({ code: "JOB_TARGET_SECONDARY_LIMIT" });

    const rows = await database.select({ priority: jobTargets.priority, activeSlot: jobTargets.activeSlot }).from(jobTargets)
      .where(eq(jobTargets.userId, userId));
    expect(rows).toEqual(expect.arrayContaining([
      { priority: "primary", activeSlot: null }, { priority: "secondary", activeSlot: 1 }, { priority: "secondary", activeSlot: 2 },
    ]));
    await expect(database.select().from(jobTargetRevisions).where(eq(jobTargetRevisions.userId, userId))).resolves.toHaveLength(3);
  });

  it("追加修订、拒绝过期和跨账户写入，并保留停用历史", async () => {
    const userId = await userWithTrustedFacts();
    const otherUserId = await userWithTrustedFacts();
    const commandsForUser = commands();
    const created = await commandsForUser.create({ userId, requestId: crypto.randomUUID(), command: { priority: "primary", constraints } });
    const target = created.targets[0]!;
    const revisions = await Promise.allSettled([
      commandsForUser.revise({ userId, requestId: crypto.randomUUID(), targetId: target.targetId, command: { expectedVersion: 1, priority: "secondary", constraints } }),
      commandsForUser.revise({ userId, requestId: crypto.randomUUID(), targetId: target.targetId, command: { expectedVersion: 1, priority: "secondary", constraints } }),
    ]);
    expect(revisions.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(revisions.filter(({ status }) => status === "rejected")[0]).toMatchObject({ reason: { code: "JOB_TARGET_VERSION_CONFLICT" } });
    const revised = await createJobTargetQueries({ db: database }).getOverview({ userId });
    expect(revised.targets).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: target.targetId, version: 2, priority: "secondary", state: "active" })]));
    await expect(commandsForUser.revise({ userId, requestId: crypto.randomUUID(), targetId: target.targetId, command: { expectedVersion: 1, priority: "secondary", constraints } }))
      .rejects.toMatchObject({ code: "JOB_TARGET_VERSION_CONFLICT" });
    await expect(commandsForUser.revise({ userId: otherUserId, requestId: crypto.randomUUID(), targetId: target.targetId, command: { expectedVersion: 2, priority: "secondary", constraints } }))
      .rejects.toMatchObject({ code: "JOB_TARGET_NOT_FOUND" });

    const deactivated = await commandsForUser.deactivate({ userId, requestId: crypto.randomUUID(), targetId: target.targetId, command: { expectedVersion: 2 } });
    expect(deactivated.targets).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: target.targetId, version: 3, state: "inactive" })]));
    await expect(createJobTargetQueries({ db: database }).getActive({ userId })).resolves.toEqual([]);
    await expect(database.select().from(jobTargetRevisions).where(and(eq(jobTargetRevisions.userId, userId), eq(jobTargetRevisions.targetId, target.targetId))))
      .resolves.toHaveLength(3);
  });
});
