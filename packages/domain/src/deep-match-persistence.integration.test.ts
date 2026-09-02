import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentRuns, createDatabase, deepMatchRunCandidates, jobAccounts, jobMatchVersions, jobOpportunities, jobOpportunitySources, jobProfiles, jobSourcePostingVersions, jobSourcePostings, recommendationListItems, recommendationLists,
  jobTargetRevisions, jobTargets, jobTriageVersions, migrateDatabase, profileFactRevisions, profileFacts, recommendationExclusions, type Database,
} from "@job-copilot/database";
import { and, eq } from "drizzle-orm";
import { FakeDeepMatchAdapter } from "@job-copilot/contracts/deep-match";
import { createDeepMatchRunStarter } from "./deep-match-agent-runs";
import { createAgentRunRecoveryQueries } from "./agent-run-processor";
import { createDeepMatchCommands, createDeepMatchQueries } from "./deep-match-persistence";

const now = new Date("2026-09-01T02:00:00.000Z");
const hash = "a".repeat(64);
const modelCall = () => ({ signal: new AbortController().signal, usageKey: "test-model-call", budget: { maxTokens: 20_000, reservedInputTokens: 32, reservedOutputTokens: 48 } });

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
    await db.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId, sourcePostingId, version: 1, contentSha256: sourceHash, rawContentSha256: sourceHash, rawObjectReference: { key: "safe" }, normalizedData: { qualifications: { requiredSkills: ["TypeScript"] } }, retrievedAt: now, availability: "open", createdAt: now });
    await db.insert(jobOpportunities).values({ id: opportunityId, userId, importId: null, sourcePostingVersionId, canonicalOpportunityId: null, dedupKey: sourceHash, company: "示例科技", title: "前端工程师", location: "上海", postedAt: null, deadline: new Date("2026-09-20T00:00:00.000Z"), description: "需要 TypeScript", normalizedData: { qualifications: { requiredSkills: { value: ["TypeScript"], evidence: { field: "requiredSkills", path: "技能", value: "TypeScript" } } } }, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await db.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId, opportunityId, sourcePostingVersionId, createdAt: now });
    const verdict = input.verdict ?? "pass";
    const scored = verdict === "pass" && (input.deadlineStatus ?? "valid") !== "expired";
    const triageVersionId = crypto.randomUUID();
    await db.insert(jobTriageVersions).values({ id: triageVersionId, userId, opportunityId, sourcePostingVersionId, profileId, profileVersion: 1, targetId, targetVersion: 1, qualificationRuleVersion: "q1", coarseRuleVersion: "c1", overallVerdict: verdict, gateResults: {}, pendingItems: [], deadlineStatus: input.deadlineStatus ?? "valid", confidenceBasisPoints: 10_000, dimensionScores: scored ? {} : null, overallScore: scored ? (input.score ?? 80) : null, threshold: scored ? 70 : null, sequence: 1, createdAt: now });
    return { userId, profileId, targetId, opportunityId, sourcePostingVersionId, triageVersionId, factRevisionId };
  }

  it("selects only owner-bound latest passing, valid and above-threshold triage candidates in stable score order", async () => {
    const eligible = await fixture({ score: 90 });
    const owner = { userId: eligible.userId, profileId: eligible.profileId, targetId: eligible.targetId };
    await fixture({ owner, score: 60 });
    await fixture({ owner, deadlineStatus: "expired" });
    await fixture({ owner, verdict: "fail" });
    const other = await fixture({ score: 99 });

    const selected = await createDeepMatchQueries({ db }).selectCandidateSelection({ userId: eligible.userId, targetId: eligible.targetId });

    expect(selected.candidates).toHaveLength(1);
    expect(selected.candidates[0]).toMatchObject({ opportunityId: eligible.opportunityId, sourcePostingVersionId: eligible.sourcePostingVersionId, overallScore: 90 });
    expect(selected.candidates.some((candidate) => candidate.opportunityId === other.opportunityId)).toBe(false);
    expect(selected.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: "SCORE_BELOW_THRESHOLD" }),
      expect.objectContaining({ reasonCode: "DEADLINE_EXPIRED" }),
      expect.objectContaining({ reasonCode: "TRIAGE_NOT_PASS" }),
    ]));
  });

  it("retains every selection exclusion instead of silently truncating the historical decision set", async () => {
    const eligible = await fixture({ score: 90 });
    const owner = { userId: eligible.userId, profileId: eligible.profileId, targetId: eligible.targetId };
    for (let index = 0; index < 11; index += 1) await fixture({ owner, verdict: "fail" });

    const selected = await createDeepMatchQueries({ db }).selectCandidateSelection({ userId: eligible.userId, targetId: eligible.targetId });

    expect(selected.exclusions.filter((item) => item.reasonCode === "TRIAGE_NOT_PASS")).toHaveLength(11);
  });

  it("persists exactly one recoverable matching child run when queue delivery fails and retries delivery on duplicate trigger", async () => {
    const input = await fixture();
    const queue = { calls: 0, fail: true, async enqueue() { this.calls += 1; if (this.fail) throw new Error("QUEUE_DOWN"); } };
    const starter = createDeepMatchRunStarter({ db, queue, id: () => crypto.randomUUID(), clock: () => now });
    const key = crypto.randomUUID();
    const discoveryRunId = crypto.randomUUID();
    const first = await starter.start({ userId: input.userId, targetId: input.targetId, idempotencyKey: key, trigger: "automatic", discoveryRunId });
    queue.fail = false;
    const second = await starter.start({ userId: input.userId, targetId: input.targetId, idempotencyKey: key, trigger: "automatic", discoveryRunId });
    expect(first).toMatchObject({ reused: false });
    expect(second).toMatchObject({ runId: first.runId, reused: true });
    expect(queue.calls).toBe(2);
    await expect(db.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.idempotencyKey, key)))).resolves.toHaveLength(1);
    await expect(db.select().from(deepMatchRunCandidates).where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, first.runId)))).resolves.toHaveLength(1);
  });

  it("freezes the complete candidate tuple once for a matching run", async () => {
    const input = await fixture();
    const starter = createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now });
    const run = await starter.start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "manual", opportunityId: input.opportunityId });
    const candidates = await createDeepMatchQueries({ db }).selectCandidates({ userId: input.userId, targetId: input.targetId, opportunityId: input.opportunityId });
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });

    await (commands as any).freezeCandidates({ userId: input.userId, runId: run.runId, candidates });

    await expect(db.select({ opportunityId: deepMatchRunCandidates.opportunityId, candidateSnapshot: deepMatchRunCandidates.candidateSnapshot })
      .from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, run.runId))).resolves.toEqual([
      expect.objectContaining({ opportunityId: input.opportunityId, candidateSnapshot: expect.objectContaining({ opportunityId: input.opportunityId }) }),
    ]);
  });

  it("does not publish a partial matching run when a staged candidate is missing its assessment", async () => {
    const input = await fixture();
    const run = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "manual", opportunityId: input.opportunityId });
    const claimToken = crypto.randomUUID();
    await db.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" })
      .where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, run.runId)));
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });

    await expect((commands as any).publishStagedRun({ userId: input.userId, targetId: input.targetId, runId: run.runId, fence: { claimToken }, selectionExclusions: [] }))
      .rejects.toThrow("DEEP_MATCH_STAGE_INCOMPLETE");
    await expect(db.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId))).resolves.toHaveLength(0);
    await expect(db.select().from(recommendationLists).where(eq(recommendationLists.userId, input.userId))).resolves.toHaveLength(0);
  });

  it("reuses the first staged candidate result without a second model call before one atomic publish", async () => {
    const input = await fixture();
    const run = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "manual", opportunityId: input.opportunityId });
    const claimToken = crypto.randomUUID();
    await db.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" })
      .where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, run.runId)));
    const fake = new FakeDeepMatchAdapter(); let calls = 0;
    const adapter = { ...fake, assess: async (...args: Parameters<FakeDeepMatchAdapter["assess"]>) => { calls += 1; return fake.assess(...args); } };
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now, adapter });
    const candidate = (await createDeepMatchQueries({ db }).getFrozenCandidates({ userId: input.userId, runId: run.runId }))[0]!;
    const first = await commands.assessAndStage({ userId: input.userId, runId: run.runId, candidate, modelCall: modelCall(), fence: { claimToken } });
    const restored = await commands.assessAndStage({ userId: input.userId, runId: run.runId, candidate, modelCall: modelCall(), fence: { claimToken } });

    expect(first.reused).toBe(false); expect(restored.reused).toBe(true); expect(calls).toBe(1);
    await expect(db.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId))).resolves.toHaveLength(0);
    await expect(db.select().from(recommendationLists).where(eq(recommendationLists.userId, input.userId))).resolves.toHaveLength(0);
    await commands.publishStagedRun({ userId: input.userId, targetId: input.targetId, runId: run.runId, fence: { claimToken }, selectionExclusions: [] });
    await expect(db.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId))).resolves.toHaveLength(1);
    await expect(db.select().from(recommendationLists).where(eq(recommendationLists.userId, input.userId))).resolves.toHaveLength(1);
  });

  it("rolls back the child and its candidate snapshot when initialization crashes after insertion", async () => {
    const input = await fixture();
    let calls = 0;
    const id = () => { calls += 1; if (calls === 3) throw new Error("CHILD_INIT_CRASH"); return crypto.randomUUID(); };
    const starter = createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id, clock: () => now });

    await expect(starter.start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "automatic", discoveryRunId: crypto.randomUUID() })).rejects.toThrow("CHILD_INIT_CRASH");
    await expect(Promise.all([
      db.select().from(agentRuns).where(eq(agentRuns.userId, input.userId)),
      db.select().from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.userId, input.userId)),
    ])).resolves.toEqual([[], []]);
  });

  it("never offers a manually inserted uninitialized matching row to the reconciler race", async () => {
    const input = await fixture();
    const child = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "automatic", discoveryRunId: crypto.randomUUID() });
    await db.update(agentRuns).set({ sourceScope: { kind: "deep_match", trigger: "automatic", opportunityId: null, discoveryRunId: crypto.randomUUID() } }).where(eq(agentRuns.id, child.runId));
    await expect(createAgentRunRecoveryQueries({ db, clock: () => now }).listRecoverable()).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ runId: child.runId })]));
  });

  it("marks a legitimate zero-candidate child initialized and retains its frozen exclusions across retry", async () => {
    const input = await fixture({ verdict: "fail" });
    const starter = createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now });
    const child = await starter.start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "automatic", discoveryRunId: crypto.randomUUID() });
    const [first] = await db.select().from(agentRuns).where(eq(agentRuns.id, child.runId));
    expect(first?.sourceScope).toMatchObject({ initialized: true, selectionExclusions: [{ opportunityId: input.opportunityId, reasonCode: "TRIAGE_NOT_PASS" }] });
    await expect(db.select().from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, child.runId))).resolves.toEqual([]);

    await db.update(jobTriageVersions).set({ overallVerdict: "pass", dimensionScores: {}, overallScore: 99, threshold: 70 }).where(eq(jobTriageVersions.id, input.triageVersionId));
    const replay = await starter.start({ userId: input.userId, targetId: input.targetId, idempotencyKey: first!.idempotencyKey, trigger: "automatic", discoveryRunId: (first!.sourceScope as { discoveryRunId: string }).discoveryRunId });
    expect(replay).toMatchObject({ runId: child.runId, reused: true });
    const [unchanged] = await db.select().from(agentRuns).where(eq(agentRuns.id, child.runId));
    expect(unchanged?.sourceScope).toEqual(first?.sourceScope);
  });

  it("publishes the frozen source tuple after the opportunity current source pointer moves", async () => {
    const input = await fixture();
    const child = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "automatic", discoveryRunId: crypto.randomUUID() });
    const claimToken = crypto.randomUUID();
    await db.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" }).where(eq(agentRuns.id, child.runId));
    const newerSource = crypto.randomUUID();
    const [original] = await db.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.id, input.sourcePostingVersionId));
    await db.insert(jobSourcePostingVersions).values({ ...original!, id: newerSource, version: 2, contentSha256: "b".repeat(64), rawContentSha256: "b".repeat(64), createdAt: new Date(now.getTime() + 1_000) });
    await db.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId: input.userId, opportunityId: input.opportunityId, sourcePostingVersionId: newerSource, createdAt: new Date(now.getTime() + 1_000) });
    await db.update(jobOpportunities).set({ sourcePostingVersionId: newerSource }).where(eq(jobOpportunities.id, input.opportunityId));

    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });
    const candidate = (await createDeepMatchQueries({ db }).getFrozenCandidates({ userId: input.userId, runId: child.runId }))[0]!;
    await commands.assessAndStage({ userId: input.userId, runId: child.runId, candidate, modelCall: modelCall(), fence: { claimToken } });
    await commands.publishStagedRun({ userId: input.userId, targetId: input.targetId, runId: child.runId, fence: { claimToken }, selectionExclusions: [] });
    await expect(db.select({ sourcePostingVersionId: jobMatchVersions.sourcePostingVersionId }).from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId))).resolves.toEqual([{ sourcePostingVersionId: input.sourcePostingVersionId }]);
  });

  it("keeps the 0034 fourth-highlight rejection under three independent staged-publish rounds", async () => {
    const input = await fixture();
    const publish = async () => {
      const run = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now })
        .start({ userId: input.userId, targetId: input.targetId, opportunityId: input.opportunityId, idempotencyKey: crypto.randomUUID(), trigger: "manual" });
      const claimToken = crypto.randomUUID();
      await db.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" }).where(eq(agentRuns.id, run.runId));
      const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });
      const candidate = (await createDeepMatchQueries({ db }).getFrozenCandidates({ userId: input.userId, runId: run.runId }))[0]!;
      await commands.assessAndStage({ userId: input.userId, runId: run.runId, candidate, modelCall: modelCall(), fence: { claimToken } });
      return commands.publishStagedRun({ userId: input.userId, targetId: input.targetId, runId: run.runId, fence: { claimToken }, selectionExclusions: [] });
    };
    for (let round = 0; round < 3; round += 1) {
      const published = await Promise.all([publish(), publish(), publish(), publish()]);
      const listId = published[0]!.recommendationListId;
      const ids = published.map((result) => result.items[0]!.matchVersionId);
      await db.transaction((transaction) => transaction.insert(recommendationListItems).values({ id: crypto.randomUUID(), userId: input.userId, recommendationListId: listId, matchVersionId: ids[1]!, ordinal: 2, highlighted: true, createdAt: now }));
      const insert = (matchVersionId: string, ordinal: number) => db.transaction((transaction) => transaction.insert(recommendationListItems).values({ id: crypto.randomUUID(), userId: input.userId, recommendationListId: listId, matchVersionId, ordinal, highlighted: true, createdAt: now }));
      const outcome = await Promise.allSettled([insert(ids[2]!, 3), insert(ids[3]!, 4)]);
      expect(outcome.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(outcome.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(db.select().from(recommendationListItems).where(eq(recommendationListItems.recommendationListId, listId))).resolves.toHaveLength(3);
    }
  }, 60_000);

  it("keyset-paginates fixture histories and exclusions without duplicate cursor rows", async () => {
    const input = await fixture();
    const listIds = Array.from({ length: 21 }, () => crypto.randomUUID());
    await db.insert(recommendationLists).values(listIds.map((id, index) => ({ id, userId: input.userId, targetId: input.targetId, localDate: "2026-09-01", sequence: index + 1, createdAt: now })));
    const owner = { userId: input.userId, profileId: input.profileId, targetId: input.targetId };
    const exclusions = await Promise.all(Array.from({ length: 26 }, async () => ({ opportunityId: (await fixture({ owner, verdict: "fail" })).opportunityId })));
    await db.insert(recommendationExclusions).values(exclusions.map((entry) => ({ id: crypto.randomUUID(), userId: input.userId, targetId: input.targetId, recommendationListId: listIds[0]!, opportunityId: entry.opportunityId, reasonCode: "TRIAGE_NOT_PASS", createdAt: now })));
    const queries = createDeepMatchQueries({ db });
    const first = await queries.getListHistoryPage({ userId: input.userId, targetId: input.targetId, limit: 20 });
    const second = await queries.getListHistoryPage({ userId: input.userId, targetId: input.targetId, cursor: first.nextCursor!, limit: 20 });
    expect(new Set([...first.items, ...second.items].map((item) => item.recommendationListId)).size).toBe(21);
    const pageOne = await queries.getListExclusionsPage({ userId: input.userId, targetId: input.targetId, recommendationListId: listIds[0]!, limit: 25 });
    const pageTwo = await queries.getListExclusionsPage({ userId: input.userId, targetId: input.targetId, recommendationListId: listIds[0]!, cursor: pageOne.nextCursor!, limit: 25 });
    expect(new Set([...pageOne.items, ...pageTwo.items].map((item) => item.opportunityId)).size).toBe(26);
  }, 60_000);

});
