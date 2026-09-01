import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase, jobAccounts, jobOpportunities, jobProfiles, jobSourcePostingVersions, jobSourcePostings,
  jobTargetRevisions, jobTargets, migrateDatabase, profileFactRevisions, profileFacts, type Database,
} from "@job-copilot/database";
import { eq } from "drizzle-orm";
import { createAuditTrail } from "./audit-trail";
import { createJobTriageCommands, createJobTriageQueries } from "./job-triage-persistence";

const now = new Date("2026-09-01T00:00:00.000Z");
const hash = "a".repeat(64);

describe("job triage persistence", () => {
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

  async function fixture() {
    const userId = crypto.randomUUID();
    const profileId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const sourcePostingId = crypto.randomUUID();
    const sourcePostingVersionId = crypto.randomUUID();
    const opportunityId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({
      id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", createdAt: now,
      constraints: { roleFamily: "frontend", seniority: "senior", locations: ["上海"], workModes: ["remote"], relocation: "not_willing", salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } },
    });
    for (const [factType, factValue] of [["education", { summary: "本科" }], ["language", { name: "英语", level: "C1" }], ["work_eligibility", { summary: "中国工作许可" }], ["skill", { name: "TypeScript" }]] as const) {
      const factId = crypto.randomUUID();
      await database.insert(profileFacts).values({ id: factId, userId, profileId, factType, createdAt: now });
      await database.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType, factValue, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
    }
    await database.insert(jobSourcePostings).values({ id: sourcePostingId, userId, sourceType: "user_import", sourceIdentifier: hash, sourceIdentity: { contentFingerprint: hash }, isOfficial: false, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    const normalizedData = {
      normalizerVersion: "fake-job-normalizer-v2", company: "示例科技", title: "frontend engineer", location: "上海", postedAt: null, deadline: "2026-09-12T00:00:00.000Z", deadlineProvenance: null, description: null,
      qualifications: {
        workMode: { value: "remote", evidence: { field: "workMode", path: "工作方式", value: "远程" } }, relocationRequired: { value: false, evidence: { field: "relocationRequired", path: "是否需要搬迁", value: "否" } }, salary: null,
        seniority: { value: "senior", evidence: { field: "seniority", path: "级别", value: "senior" } }, education: { value: "本科", evidence: { field: "education", path: "学历", value: "本科" } }, languages: { value: [{ name: "英语", level: "C1" }], evidence: { field: "languages", path: "语言", value: "英语(C1)" } }, workEligibility: { value: "中国工作许可", evidence: { field: "workEligibility", path: "工作资格", value: "中国工作许可" } }, industry: null, employmentType: null, requiredSkills: { value: ["TypeScript"], evidence: { field: "requiredSkills", path: "必备技能", value: "TypeScript" } },
      },
    };
    // 导入 worker 将完整规范化结果写入 current opportunity；source version 的
    // 原始 JSON 不能被评估流程误当成规范化快照。
    await database.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId, sourcePostingId, version: 1, contentSha256: hash, rawContentSha256: hash, rawObjectReference: { objectKey: "safe" }, normalizedData: {}, retrievedAt: now, availability: "open", createdAt: now });
    await database.insert(jobOpportunities).values({ id: opportunityId, userId, importId: null, sourcePostingVersionId, canonicalOpportunityId: null, dedupKey: hash, company: "示例科技", title: "frontend engineer", location: "上海", postedAt: null, deadline: new Date("2026-09-12T00:00:00.000Z"), description: null, normalizedData, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    return { userId, targetId, opportunityId };
  }

  it("creates an immutable triage snapshot once and reuses it for the same input versions", async () => {
    const { userId, targetId, opportunityId } = await fixture();
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const commands = createJobTriageCommands({ db: database, auditTrail, id: () => crypto.randomUUID(), clock: () => now });
    const first = await commands.create({ userId, requestId: crypto.randomUUID(), opportunityId, command: { targetId } });
    const replay = await commands.create({ userId, requestId: crypto.randomUUID(), opportunityId, command: { targetId } });

    expect(first).toMatchObject({ overallVerdict: "pass", overallScore: expect.any(Number), reused: false });
    expect(replay).toMatchObject({ triageVersionId: first.triageVersionId, reused: true });
    await expect(auditTrail.query({ userId })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "job.triage_created", resourceId: first.triageVersionId, metadata: expect.objectContaining({ opportunityId, targetId }) }),
    ]));
    await expect(createJobTriageQueries({ db: database }).getLatest({ userId, opportunityId, targetId })).resolves.toMatchObject({ triageVersionId: first.triageVersionId });
  });

  it("creates a new immutable version when the confirmed profile revision changes and serializes concurrent reuse", async () => {
    const { userId, targetId, opportunityId } = await fixture();
    const commands = createJobTriageCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    const [first, concurrent] = await Promise.all([
      commands.create({ userId, requestId: crypto.randomUUID(), opportunityId, command: { targetId } }),
      commands.create({ userId, requestId: crypto.randomUUID(), opportunityId, command: { targetId } }),
    ]);
    expect(first.triageVersionId).toBe(concurrent.triageVersionId);
    expect([first.reused, concurrent.reused].sort()).toEqual([false, true]);

    await database.update(jobProfiles).set({ version: 2, updatedAt: now }).where(eq(jobProfiles.userId, userId));
    const revised = await commands.create({ userId, requestId: crypto.randomUUID(), opportunityId, command: { targetId } });
    expect(revised).toMatchObject({ reused: false });
    expect(revised.triageVersionId).not.toBe(first.triageVersionId);
    await expect(createJobTriageQueries({ db: database }).get({ userId, opportunityId, triageVersionId: revised.triageVersionId })).resolves.toMatchObject({ triageVersionId: revised.triageVersionId });
    await expect(createJobTriageQueries({ db: database }).getLatest({ userId: crypto.randomUUID(), opportunityId, targetId })).resolves.toBeNull();
  });

  it("rejects inactive targets and an empty confirmed profile before creating a version", async () => {
    const { userId, targetId, opportunityId } = await fixture();
    const commands = createJobTriageCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await database.update(jobTargets).set({ state: "inactive", updatedAt: now }).where(eq(jobTargets.id, targetId));
    await expect(commands.create({ userId, requestId: crypto.randomUUID(), opportunityId, command: { targetId } })).rejects.toMatchObject({ code: "JOB_TRIAGE_TARGET_INACTIVE" });

    await database.update(jobTargets).set({ state: "active", updatedAt: now }).where(eq(jobTargets.id, targetId));
    await database.update(profileFactRevisions).set({ state: "removed" }).where(eq(profileFactRevisions.userId, userId));
    await expect(commands.create({ userId, requestId: crypto.randomUUID(), opportunityId, command: { targetId } })).rejects.toMatchObject({ code: "JOB_TRIAGE_PROFILE_EMPTY" });
  });

  it("returns latest snapshots only for the requested active target with a monotonic sequence", async () => {
    const { userId, targetId, opportunityId } = await fixture();
    const secondTargetId = crypto.randomUUID();
    await database.insert(jobTargets).values({ id: secondTargetId, userId, version: 1, priority: "secondary", state: "active", activeSlot: 1, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId: secondTargetId, version: 1, priority: "secondary", state: "active", createdAt: now,
      constraints: { roleFamily: "frontend", seniority: "senior", locations: ["上海"], workModes: ["remote"], relocation: "not_willing", salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } },
    });
    const commands = createJobTriageCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    const first = await commands.create({ userId, requestId: crypto.randomUUID(), opportunityId, command: { targetId } });
    const second = await commands.create({ userId, requestId: crypto.randomUUID(), opportunityId, command: { targetId: secondTargetId } });
    const queries = createJobTriageQueries({ db: database });
    await expect(queries.getLatest({ userId, opportunityId, targetId })).resolves.toMatchObject({ triageVersionId: first.triageVersionId, targetId, sequence: 1 });
    await expect(queries.getLatest({ userId, opportunityId, targetId: secondTargetId })).resolves.toMatchObject({ triageVersionId: second.triageVersionId, targetId: secondTargetId, sequence: 2 });
  });
});
