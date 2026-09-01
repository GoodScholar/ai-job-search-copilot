import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase, jobAccounts, jobOpportunities, jobProfiles, jobSourcePostingVersions, jobSourcePostings,
  jobTargetRevisions, jobTargets, migrateDatabase, profileFactRevisions, profileFacts, type Database,
} from "@job-copilot/database";
import { eq } from "drizzle-orm";
import { JobTriageVersionSchema, type JobTriageVersion } from "@job-copilot/contracts/job-triage";
import type { JobTargetConstraints } from "@job-copilot/contracts/job-targets";
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

  async function fixture(options: { requiredSkills?: string[]; skillNames?: string[]; title?: string; company?: string; location?: string; industry?: string | null; workMode?: "onsite" | "hybrid" | "remote"; target?: Partial<Pick<JobTargetConstraints, "locations" | "workModes" | "industries" | "dealBreakers">> } = {}) {
    const userId = crypto.randomUUID();
    const profileId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const sourcePostingId = crypto.randomUUID();
    const sourcePostingVersionId = crypto.randomUUID();
    const opportunityId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    const constraints = {
      roleFamily: "frontend", seniority: "senior", locations: ["上海"], workModes: ["remote"], relocation: "not_willing" as const, salary: null, industries: [],
      dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
      ...options.target,
    } satisfies JobTargetConstraints;
    await database.insert(jobTargetRevisions).values({
      id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", createdAt: now,
      constraints,
    });
    const skillNames = options.skillNames ?? ["TypeScript"];
    const requiredSkills = options.requiredSkills ?? skillNames;
    for (const [factType, factValue] of [["education", { summary: "本科" }], ["language", { name: "英语", level: "C1" }], ["work_eligibility", { summary: "中国工作许可" }]] as const) {
      const factId = crypto.randomUUID();
      await database.insert(profileFacts).values({ id: factId, userId, profileId, factType, createdAt: now });
      await database.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType, factValue, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
    }
    for (const name of skillNames) {
      const factId = crypto.randomUUID();
      await database.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
      await database.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name }, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
    }
    await database.insert(jobSourcePostings).values({ id: sourcePostingId, userId, sourceType: "user_import", sourceIdentifier: hash, sourceIdentity: { contentFingerprint: hash }, isOfficial: false, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    const normalizedData = {
      normalizerVersion: "fake-job-normalizer-v2", company: options.company ?? "示例科技", title: options.title ?? "frontend engineer", location: options.location ?? "上海", postedAt: null, deadline: "2026-09-12T00:00:00.000Z", deadlineProvenance: null, description: null,
      qualifications: {
        workMode: { value: options.workMode ?? "remote", evidence: { field: "workMode", path: "工作方式", value: options.workMode ?? "远程" } }, relocationRequired: { value: false, evidence: { field: "relocationRequired", path: "是否需要搬迁", value: "否" } }, salary: null,
        seniority: { value: "senior", evidence: { field: "seniority", path: "级别", value: "senior" } }, education: { value: "本科", evidence: { field: "education", path: "学历", value: "本科" } }, languages: { value: [{ name: "英语", level: "C1" }], evidence: { field: "languages", path: "语言", value: "英语(C1)" } }, workEligibility: { value: "中国工作许可", evidence: { field: "workEligibility", path: "工作资格", value: "中国工作许可" } }, industry: options.industry ? { value: options.industry, evidence: { field: "industry", path: "行业", value: options.industry } } : null, employmentType: null, requiredSkills: { value: requiredSkills, evidence: { field: "requiredSkills", path: "必备技能", value: requiredSkills.join("、") } },
      },
    };
    // 导入 worker 将完整规范化结果写入 current opportunity；source version 的
    // 原始 JSON 不能被评估流程误当成规范化快照。
    await database.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId, sourcePostingId, version: 1, contentSha256: hash, rawContentSha256: hash, rawObjectReference: { objectKey: "safe" }, normalizedData: {}, retrievedAt: now, availability: "open", createdAt: now });
    await database.insert(jobOpportunities).values({ id: opportunityId, userId, importId: null, sourcePostingVersionId, canonicalOpportunityId: null, dedupKey: hash, company: options.company ?? "示例科技", title: options.title ?? "frontend engineer", location: options.location ?? "上海", postedAt: null, deadline: new Date("2026-09-12T00:00:00.000Z"), description: null, normalizedData, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
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

  it.each([21, 100])("projects only twenty relevant skill facts from %i valid confirmed skill facts", async (skillFactCount) => {
    const requiredSkills = Array.from({ length: 21 }, (_, index) => `相关技能${index + 1}`);
    const skillNames = Array.from({ length: skillFactCount }, (_, index) => index < requiredSkills.length ? requiredSkills[index] : `无关技能${index + 1}`);
    const { userId, targetId, opportunityId } = await fixture({ requiredSkills, skillNames });
    const commands = createJobTriageCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    const created = await commands.create({ userId, requestId: crypto.randomUUID(), opportunityId, command: { targetId } });
    const persisted = await createJobTriageQueries({ db: database }).get({ userId, opportunityId, triageVersionId: created.triageVersionId });
    const evidence = created.dimensionScores!.technical.candidateEvidence;
    expect(created.dimensionScores!.technical).toMatchObject({ score: 100, missing: [] });
    expect(evidence).toHaveLength(20);
    expect(evidence.map((item) => item.value)).toEqual(requiredSkills.slice(0, 20));
    expect(evidence.every((item) => requiredSkills.includes(item.value))).toBe(true);
    expect(persisted?.dimensionScores?.technical.candidateEvidence).toEqual(evidence);
  });

  it.each([21, 100])("persists all %i unmatched required skills as one bounded, count-preserving evidence gap", async (skillCount) => {
    const requiredSkills = Array.from({ length: skillCount }, (_, index) => `s${String(index + 1).padStart(3, "0")}`);
    const { userId, targetId, opportunityId } = await fixture({ requiredSkills, skillNames: [] });
    const commands = createJobTriageCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    const created = await commands.create({ userId, requestId: crypto.randomUUID(), opportunityId, command: { targetId } });
    const persisted = await createJobTriageQueries({ db: database }).get({ userId, opportunityId, triageVersionId: created.triageVersionId });
    expect(created.dimensionScores?.technical).toMatchObject({ score: 50, missing: [{ kind: "profile_skills", count: skillCount, examples: requiredSkills.slice(0, 20) }] });
    expect(created.dimensionScores?.technical.missing).toHaveLength(1);
    expect(created.confidenceBasisPoints).toBe(0);
    const { reused: _reused, ...createdVersion } = created;
    expect(JobTriageVersionSchema.parse(createdVersion as JobTriageVersion)).toMatchObject({ dimensionScores: { technical: { missing: [{ kind: "profile_skills", count: skillCount }] } } });
    expect(persisted?.dimensionScores?.technical.missing).toEqual(created.dimensionScores?.technical.missing);
  });

  it("持久化合法最大目标列表、不可接受条件和岗位标题的有界证据", async () => {
    const values = (prefix: string) => Array.from({ length: 20 }, (_, index) => `${prefix}${index + 1}${"甲".repeat(195)}`);
    const locations = values("地点");
    const industries = values("行业");
    const title = `frontend ${"x".repeat(19_991)}`;
    const passFixture = await fixture({ title, location: locations[0], industry: industries[0], workMode: "onsite", target: { locations, workModes: ["onsite"], industries } });
    const commands = createJobTriageCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    const created = await commands.create({ userId: passFixture.userId, requestId: crypto.randomUUID(), opportunityId: passFixture.opportunityId, command: { targetId: passFixture.targetId } });
    const targetAlignment = created.dimensionScores!.targetAlignment;
    expect(created.gateResults.location.candidateEvidence?.value).toHaveLength(256);
    expect(targetAlignment.candidateEvidence.find((item) => item.kind === "target_constraint" && item.path === "industries")?.value).toHaveLength(256);
    expect(targetAlignment.jobEvidence.find((item) => item.field === "title")?.value).toHaveLength(512);
    const { reused: _createdReused, ...createdVersion } = created;
    expect(JobTriageVersionSchema.parse(createdVersion as JobTriageVersion)).toEqual(createdVersion);

    const companies = values("公司");
    const failFixture = await fixture({ company: companies[0], target: { dealBreakers: { excludedCompanies: companies, excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } } });
    const failed = await commands.create({ userId: failFixture.userId, requestId: crypto.randomUUID(), opportunityId: failFixture.opportunityId, command: { targetId: failFixture.targetId } });
    expect(failed.gateResults.deal_breakers.candidateEvidence?.value).toHaveLength(256);
    const { reused: _failedReused, ...failedVersion } = failed;
    expect(JobTriageVersionSchema.parse(failedVersion as JobTriageVersion)).toEqual(failedVersion);
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
