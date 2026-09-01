import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase, jobAccounts, jobOpportunities, jobProfiles, jobSourcePostingVersions, jobSourcePostings,
  jobTargetRevisions, jobTargets, jobTriageVersions, migrateDatabase, profileFactRevisions, profileFacts, type Database,
} from "@job-copilot/database";
import { createDeepMatchCommands, createDeepMatchQueries } from "./deep-match-persistence";

const now = new Date("2026-09-01T02:00:00.000Z");
const hash = "a".repeat(64);

describe("deep match persistence", () => {
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

  async function fixture(input: { score?: number; verdict?: "pass" | "fail"; deadlineStatus?: "valid" | "expired"; owner?: { userId: string; profileId: string; targetId: string } } = {}) {
    const userId = input.owner?.userId ?? crypto.randomUUID();
    const profileId = input.owner?.profileId ?? crypto.randomUUID();
    const targetId = input.owner?.targetId ?? crypto.randomUUID();
    const sourcePostingId = crypto.randomUUID();
    const sourceHash = sourcePostingId.replaceAll("-", "").padEnd(64, "a");
    const sourcePostingVersionId = crypto.randomUUID();
    const opportunityId = crypto.randomUUID();
    const factId = crypto.randomUUID();
    const factRevisionId = crypto.randomUUID();
    if (!input.owner) {
      await db.insert(jobAccounts).values({ id: userId });
      await db.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
      await db.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
      await db.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints: { roleFamily: "frontend", seniority: null, locations: [], workModes: [], relocation: "unknown", salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } }, createdAt: now });
      await db.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
      await db.insert(profileFactRevisions).values({ id: factRevisionId, userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "TypeScript" }, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
    }
    await db.insert(jobSourcePostings).values({ id: sourcePostingId, userId, sourceType: "user_import", sourceIdentifier: sourceHash, sourceIdentity: { hash: sourceHash }, isOfficial: false, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await db.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId, sourcePostingId, version: 1, contentSha256: sourceHash, rawContentSha256: sourceHash, rawObjectReference: { key: "safe" }, normalizedData: {}, retrievedAt: now, availability: "open", createdAt: now });
    await db.insert(jobOpportunities).values({ id: opportunityId, userId, importId: null, sourcePostingVersionId, canonicalOpportunityId: null, dedupKey: sourceHash, company: "示例科技", title: "前端工程师", location: "上海", postedAt: null, deadline: new Date("2026-09-20T00:00:00.000Z"), description: "需要 TypeScript", normalizedData: { qualifications: { requiredSkills: { value: ["TypeScript"], evidence: { field: "requiredSkills", path: "技能", value: "TypeScript" } } } }, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    const verdict = input.verdict ?? "pass";
    const scored = verdict === "pass" && (input.deadlineStatus ?? "valid") !== "expired";
    await db.insert(jobTriageVersions).values({ id: crypto.randomUUID(), userId, opportunityId, sourcePostingVersionId, profileId, profileVersion: 1, targetId, targetVersion: 1, qualificationRuleVersion: "q1", coarseRuleVersion: "c1", overallVerdict: verdict, gateResults: {}, pendingItems: [], deadlineStatus: input.deadlineStatus ?? "valid", confidenceBasisPoints: 10_000, dimensionScores: scored ? {} : null, overallScore: scored ? (input.score ?? 80) : null, threshold: scored ? 70 : null, sequence: 1, createdAt: now });
    return { userId, profileId, targetId, opportunityId, sourcePostingVersionId, factRevisionId };
  }

  it("selects only owner-bound latest passing, valid and above-threshold triage candidates in stable score order", async () => {
    const eligible = await fixture({ score: 90 });
    const owner = { userId: eligible.userId, profileId: eligible.profileId, targetId: eligible.targetId };
    await fixture({ owner, score: 60 });
    await fixture({ owner, deadlineStatus: "expired" });
    await fixture({ owner, verdict: "fail" });
    const other = await fixture({ score: 99 });

    const selected = await createDeepMatchQueries({ db }).selectCandidates({ userId: eligible.userId, targetId: eligible.targetId });

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ opportunityId: eligible.opportunityId, sourcePostingVersionId: eligible.sourcePostingVersionId, overallScore: 90 });
    expect(selected.some((candidate) => candidate.opportunityId === other.opportunityId)).toBe(false);
  });

  it("creates a new immutable match version and a new same-day recommendation-list sequence on every rerun", async () => {
    const input = await fixture();
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });
    const candidate = (await createDeepMatchQueries({ db }).selectCandidates({ userId: input.userId, targetId: input.targetId }))[0]!;
    const first = await commands.createMatch({ userId: input.userId, targetId: input.targetId, candidate });
    const second = await commands.createMatch({ userId: input.userId, targetId: input.targetId, candidate });
    const firstList = await commands.createDailyList({ userId: input.userId, targetId: input.targetId, matchVersionIds: [first.matchVersionId] });
    const secondList = await commands.createDailyList({ userId: input.userId, targetId: input.targetId, matchVersionIds: [second.matchVersionId] });

    expect(second).toMatchObject({ sequence: first.sequence + 1 });
    expect(second.matchVersionId).not.toBe(first.matchVersionId);
    expect(firstList).toMatchObject({ sequence: 1, items: [expect.objectContaining({ highlighted: true })] });
    expect(secondList).toMatchObject({ sequence: 2, items: [expect.objectContaining({ matchVersionId: second.matchVersionId })] });
  });
});
