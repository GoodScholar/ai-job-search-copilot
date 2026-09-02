import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentRuns, createDatabase, deepMatchRunCandidates, jobAccounts, jobMatchVersions, jobOpportunities, jobProfiles, jobSourcePostingVersions, jobSourcePostings, recommendationListItems, recommendationLists,
  jobTargetRevisions, jobTargets, jobTriageVersions, migrateDatabase, profileFactRevisions, profileFacts, recommendationExclusions, type Database,
} from "@job-copilot/database";
import { and, eq } from "drizzle-orm";
import { DEEP_MATCH_DIMENSIONS, DeepMatchAdapterError, FakeDeepMatchAdapter } from "@job-copilot/contracts/deep-match";
import { createDeepMatchRunStarter } from "./deep-match-agent-runs";
import { DeepMatchClaimLostError, createDeepMatchCommands, createDeepMatchQueries } from "./deep-match-persistence";

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

  it("creates a new immutable match version and a new same-day recommendation-list sequence on every rerun", async () => {
    const input = await fixture();
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });
    const candidate = (await createDeepMatchQueries({ db }).selectCandidates({ userId: input.userId, targetId: input.targetId }))[0]!;
    const first = await commands.createMatch({ userId: input.userId, targetId: input.targetId, candidate, modelCall: modelCall() });
    const second = await commands.createMatch({ userId: input.userId, targetId: input.targetId, candidate, modelCall: modelCall() });
    const firstList = await commands.createDailyList({ userId: input.userId, targetId: input.targetId, matchVersionIds: [first.matchVersionId] });
    const secondList = await commands.createDailyList({ userId: input.userId, targetId: input.targetId, matchVersionIds: [second.matchVersionId] });

    expect(second).toMatchObject({ sequence: first.sequence + 1 });
    expect(second.matchVersionId).not.toBe(first.matchVersionId);
    expect(firstList).toMatchObject({ sequence: 1, items: [expect.objectContaining({ highlighted: true })] });
    expect(secondList).toMatchObject({ sequence: 2, items: [expect.objectContaining({ matchVersionId: second.matchVersionId })] });
  });

  it("freezes triage and quality exclusions plus both evidence sides into the historical list", async () => {
    const eligible = await fixture({ score: 90 });
    const owner = { userId: eligible.userId, profileId: eligible.profileId, targetId: eligible.targetId };
    await fixture({ owner, verdict: "fail" });
    const query = createDeepMatchQueries({ db });
    const selection = await query.selectCandidateSelection({ userId: eligible.userId, targetId: eligible.targetId });
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });
    const match = await commands.createMatch({ userId: eligible.userId, targetId: eligible.targetId, candidate: selection.candidates[0]!, modelCall: modelCall() });
    const list = await commands.createDailyList({ userId: eligible.userId, targetId: eligible.targetId, matchVersionIds: [match.matchVersionId], selectionExclusions: selection.exclusions });
    await db.update(jobOpportunities).set({ title: "已变更岗位标题", description: "已变更岗位描述" }).where(and(eq(jobOpportunities.userId, eligible.userId), eq(jobOpportunities.id, eligible.opportunityId)));

    const historical = await query.getLatestList({ userId: eligible.userId, targetId: eligible.targetId });
    expect(historical?.recommendationListId).toBe(list.recommendationListId);
    expect(historical?.items[0]).toMatchObject({ company: "示例科技", title: "前端工程师", location: "上海" });
    expect(historical?.items[0]?.jobEvidence.map((evidence) => evidence.value).join(" ")).toContain("需要 TypeScript");
    expect(historical?.items[0]?.profileEvidence.map((evidence) => evidence.value).join(" ")).toContain("TypeScript");
    expect(historical?.exclusions).toEqual(expect.arrayContaining([expect.objectContaining({ reasonCode: "TRIAGE_NOT_PASS" })]));
    await expect(db.select().from(recommendationExclusions).where(eq(recommendationExclusions.recommendationListId, list.recommendationListId))).resolves.toHaveLength(1);
  });

  it("paginates more than twenty immutable histories and more than twenty-five exclusions without loss or cross-owner cursors", async () => {
    const input = await fixture();
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });
    const candidate = (await createDeepMatchQueries({ db }).selectCandidates({ userId: input.userId, targetId: input.targetId }))[0]!;
    const match = await commands.createMatch({ userId: input.userId, targetId: input.targetId, candidate, modelCall: modelCall() });
    const owner = { userId: input.userId, profileId: input.profileId, targetId: input.targetId };
    const exclusions = [] as Array<{ opportunityId: string; reasonCode: "TRIAGE_NOT_PASS" }>;
    for (let index = 0; index < 26; index += 1) exclusions.push({ opportunityId: (await fixture({ owner, verdict: "fail" })).opportunityId, reasonCode: "TRIAGE_NOT_PASS" });
    for (let index = 0; index < 21; index += 1) await commands.createDailyList({ userId: input.userId, targetId: input.targetId, matchVersionIds: [match.matchVersionId], selectionExclusions: index === 0 ? exclusions : [] });

    const queries = createDeepMatchQueries({ db });
    const first = await queries.getListHistoryPage({ userId: input.userId, targetId: input.targetId, limit: 20 });
    const second = await queries.getListHistoryPage({ userId: input.userId, targetId: input.targetId, cursor: first.nextCursor!, limit: 20 });
    expect([...first.items, ...second.items].map((list) => list.recommendationListId)).toHaveLength(21);
    expect(new Set([...first.items, ...second.items].map((list) => list.recommendationListId)).size).toBe(21);
    const excludedListId = [...first.items, ...second.items].find((list) => list.sequence === 1)!.recommendationListId;
    const exclusionsFirst = await queries.getListExclusionsPage({ userId: input.userId, targetId: input.targetId, recommendationListId: excludedListId, limit: 25 });
    const exclusionsSecond = await queries.getListExclusionsPage({ userId: input.userId, targetId: input.targetId, recommendationListId: excludedListId, cursor: exclusionsFirst.nextCursor!, limit: 25 });
    expect([...exclusionsFirst.items, ...exclusionsSecond.items]).toHaveLength(26);
    await expect(queries.getListHistoryPage({ userId: crypto.randomUUID(), targetId: input.targetId, cursor: first.nextCursor!, limit: 20 })).rejects.toThrow("RECOMMENDATION_HISTORY_CURSOR_INVALID");
  }, 60_000);

  it("serializes two independent transactions that both try to add a fourth highlighted item", async () => {
    const input = await fixture();
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });
    const candidate = (await createDeepMatchQueries({ db }).selectCandidates({ userId: input.userId, targetId: input.targetId }))[0]!;
    const matches = await Promise.all(Array.from({ length: 5 }, () => commands.createMatch({ userId: input.userId, targetId: input.targetId, candidate, modelCall: modelCall() })));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const list = await commands.createDailyList({ userId: input.userId, targetId: input.targetId, matchVersionIds: matches.slice(0, 2).map((match) => match.matchVersionId) });
      const insert = (matchVersionId: string, ordinal: number) => db.transaction((transaction) => transaction.insert(recommendationListItems).values({ id: crypto.randomUUID(), userId: input.userId, recommendationListId: list.recommendationListId, matchVersionId, ordinal, highlighted: true, createdAt: now }));
      const outcome = await Promise.allSettled([insert(matches[2]!.matchVersionId, 3), insert(matches[3]!.matchVersionId, 4)]);
      expect(outcome.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(outcome.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(db.select().from(recommendationListItems).where(eq(recommendationListItems.recommendationListId, list.recommendationListId))).resolves.toHaveLength(3);
      const highlighted = await db.select().from(recommendationListItems).where(and(eq(recommendationListItems.recommendationListId, list.recommendationListId), eq(recommendationListItems.highlighted, true)));
      expect(highlighted).toHaveLength(3);
    }
  }, 60_000);

  it.each(["pause_requested", "cancel_requested"] as const)("refuses match and list writes after %s between model and persistence", async (controlState) => {
    const input = await fixture();
    const run = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "automatic", discoveryRunId: crypto.randomUUID() });
    const claimToken = crypto.randomUUID();
    await db.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, run.runId)));
    const commands = createDeepMatchCommands({ db, id: crypto.randomUUID, clock: () => now });
    const candidate = (await createDeepMatchQueries({ db }).selectCandidates({ userId: input.userId, targetId: input.targetId }))[0]!;
    await expect(commands.createMatch({ userId: input.userId, targetId: input.targetId, candidate, modelCall: modelCall(), fence: { runId: run.runId, claimToken } })).rejects.toBeInstanceOf(DeepMatchClaimLostError);
    await expect(commands.createDailyList({ userId: input.userId, targetId: input.targetId, matchVersionIds: [], fence: { runId: run.runId, claimToken } })).rejects.toBeInstanceOf(DeepMatchClaimLostError);
    await expect(db.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId))).resolves.toHaveLength(0);
    await expect(db.select().from(recommendationLists).where(eq(recommendationLists.userId, input.userId))).resolves.toHaveLength(0);
  });

  it("rejects an adapter assessment for a different opportunity before persistence", async () => {
    const input = await fixture();
    const candidate = (await createDeepMatchQueries({ db }).selectCandidates({ userId: input.userId, targetId: input.targetId }))[0]!;
    const commands = createDeepMatchCommands({ db, id: crypto.randomUUID, clock: () => now, adapter: {
      adapter: "test", adapterVersion: "v1", model: "test", reservedUsage: { inputTokens: 1, outputTokens: 1 },
      async assess() { return { assessments: [{ opportunityId: crypto.randomUUID(), overallScore: 80, dimensions: DEEP_MATCH_DIMENSIONS.map((dimension) => ({ dimension, score: 80, judgment: "evidence_backed_inference" as const, jobEvidenceIds: [candidate.jobEvidence[0]!.id], profileEvidenceIds: [candidate.profileEvidence[0]!.id], summary: "wrong identity" })) }], usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 } }; },
    } });
    await expect(commands.createMatch({ userId: input.userId, targetId: input.targetId, candidate, modelCall: modelCall() })).rejects.toThrow("DEEP_MATCH_OPPORTUNITY_IDENTITY_INVALID");
  });

  it("rejects every source/triage/profile/target tuple mismatch before a direct match can persist", async () => {
    const input = await fixture();
    const owner = { userId: input.userId, profileId: input.profileId, targetId: input.targetId };
    const other = await fixture({ owner });
    const candidate = (await createDeepMatchQueries({ db }).selectCandidates({ userId: input.userId, targetId: input.targetId, opportunityId: input.opportunityId }))[0]!;
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });

    await expect(commands.createMatch({ userId: input.userId, targetId: input.targetId, candidate: { ...candidate, sourcePostingVersionId: other.sourcePostingVersionId }, modelCall: modelCall() })).rejects.toThrow("DEEP_MATCH_TUPLE_INVALID");
    await expect(db.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId))).resolves.toHaveLength(0);
  });

  it("maps malformed adapter result envelopes to a stable model-invalid error before persistence", async () => {
    const input = await fixture();
    const candidate = (await createDeepMatchQueries({ db }).selectCandidates({ userId: input.userId, targetId: input.targetId }))[0]!;
    const commands = createDeepMatchCommands({ db, id: crypto.randomUUID, clock: () => now, adapter: {
      adapter: "test", adapterVersion: "v1", model: "test", reservedUsage: { inputTokens: 1, outputTokens: 1 },
      async assess() { return { assessments: [], usage: { inputTokens: -1, outputTokens: 1, latencyMs: 1 } } as never; },
    } });
    await expect(commands.createMatch({ userId: input.userId, targetId: input.targetId, candidate, modelCall: modelCall() }))
      .rejects.toMatchObject({ constructor: DeepMatchAdapterError, category: "invalid_output" });
    await expect(db.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId))).resolves.toHaveLength(0);
  });
});
