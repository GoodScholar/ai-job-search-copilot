import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agentRuns, calibrationProposalEvidence, calibrationProposalRevisions, calibrationProposals, createDatabase, jobAccounts, jobMatchVersions, jobOpportunities, jobOpportunitySources,
  jobProfiles, jobSourcePostingVersions, jobSourcePostings, jobTargets, jobTargetRevisions, jobTriageVersions, migrateDatabase, profileFactRevisions, profileFacts, recommendationDecisionEvents, recommendationListItems,
  recommendationLists, recommendationRuleVersions, type Database,
} from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createDeepMatchRunStarter } from "./deep-match-agent-runs";
import { createDeepMatchCommands, createDeepMatchQueries } from "./deep-match-persistence";
import { FakeDeepMatchAdapter } from "@job-copilot/contracts/deep-match";
import { createRecommendationFeedbackCommands, createRecommendationFeedbackQueries } from "./recommendation-feedback";

const now = new Date("2026-09-02T00:00:00.000Z");
const constraints = { roleFamily: "frontend", seniority: null, locations: [], workModes: [], relocation: "unknown", salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } };

describe("recommendation feedback persistence", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = createDatabase(container.getConnectionUri());
    await migrateDatabase(db);
  }, 60_000);

  afterAll(async () => { await db?.$client.end(); await container?.stop(); });

  async function fixture(count = 3) {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const profileId = crypto.randomUUID(); const listId = crypto.randomUUID();
    await db.insert(jobAccounts).values({ id: userId });
    await db.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
    const factId = crypto.randomUUID();
    await db.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
    await db.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "TypeScript" }, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
    await db.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await db.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now });
    await db.insert(recommendationLists).values({ id: listId, userId, targetId, localDate: "2026-09-02", sequence: 1, createdAt: now });
    const items: Array<{ itemId: string; matchId: string; opportunityId: string }> = [];
    for (let index = 0; index < count; index += 1) {
      const sourcePostingId = crypto.randomUUID(); const sourcePostingVersionId = crypto.randomUUID(); const opportunityId = crypto.randomUUID(); const triageId = crypto.randomUUID(); const matchId = crypto.randomUUID(); const itemId = crypto.randomUUID();
      const hash = `${index}`.padStart(64, "a");
      await db.insert(jobSourcePostings).values({ id: sourcePostingId, userId, sourceType: "user_import", sourceIdentifier: hash, sourceIdentity: { hash }, isOfficial: false, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
      await db.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId, sourcePostingId, version: 1, contentSha256: hash, rawContentSha256: hash, rawObjectReference: { key: "redacted" }, normalizedData: {}, retrievedAt: now, availability: "open", createdAt: now });
      await db.insert(jobOpportunities).values({ id: opportunityId, userId, importId: null, sourcePostingVersionId, canonicalOpportunityId: null, dedupKey: hash, company: "示例公司", title: `岗位 ${index}`, location: "上海", postedAt: null, deadline: null, description: null, normalizedData: {}, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
      await db.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId, opportunityId, sourcePostingVersionId, createdAt: now });
      await db.insert(jobTriageVersions).values({ id: triageId, userId, opportunityId, sourcePostingVersionId, profileId, profileVersion: 1, targetId, targetVersion: 1, qualificationRuleVersion: "q1", coarseRuleVersion: "c1", overallVerdict: "pass", gateResults: {}, pendingItems: [], deadlineStatus: "valid", confidenceBasisPoints: 10_000, dimensionScores: {}, overallScore: 90, threshold: 70, sequence: 1, createdAt: now });
      await db.insert(jobMatchVersions).values({ id: matchId, userId, opportunityId, sourcePostingVersionId, triageVersionId: triageId, profileId, profileVersion: 1, targetId, targetVersion: 1, ruleVersion: "recommendation-rule-v0", promptVersion: "p1", adapter: "fake", adapterVersion: "1", model: "fake", outputSchemaVersion: "1", overallScore: 90, displayBand: "highly_matched", assessment: {}, sequence: 1, createdAt: now });
      await db.insert(recommendationListItems).values({ id: itemId, userId, recommendationListId: listId, matchVersionId: matchId, ordinal: index + 1, highlighted: false, createdAt: now });
      items.push({ itemId, matchId, opportunityId });
    }
    return { userId, targetId, listId, items };
  }

  function commands() {
    return createRecommendationFeedbackCommands({ db, id: () => crypto.randomUUID(), clock: () => now, auditTrail: createAuditTrail({ db, clock: () => now }) });
  }

  it("以 owner-bound 不可变事件记录全部反馈边界，并在三条当前忽略时只创建一次建议", async () => {
    const data = await fixture(8); const service = commands();
    await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: data.items[0]!.itemId, command: { decision: "ignored", expectedVersion: 0, idempotencyKey: crypto.randomUUID(), note: "x".repeat(500) } });
    for (const item of data.items.slice(1, 4)) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "LOCATION", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    const proposals = await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId });
    expect(proposals).toHaveLength(1); expect(proposals[0]).toMatchObject({ evidenceCount: 3, revision: { revisionNumber: 1, strategy: "require_related_evidence" } });
    const decisionEvents = await db.select().from(recommendationDecisionEvents).where(eq(recommendationDecisionEvents.userId, data.userId));
    expect(decisionEvents).toHaveLength(4); const noReason = decisionEvents.find((event) => event.reason === null)!; expect(noReason.note).toHaveLength(500);
    expect(decisionEvents.filter((event) => event.reason === "LOCATION").map((event) => event.recommendationListItemId).sort()).toEqual(data.items.slice(1, 4).map((item) => item.itemId).sort());
    const sameKey = crypto.randomUUID(); const replay = { decision: "saved" as const, expectedVersion: 0, idempotencyKey: sameKey };
    await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: data.items[4]!.itemId, command: replay });
    await expect(service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: data.items[4]!.itemId, command: replay })).resolves.toMatchObject({ decision: { status: "saved", version: 1 } });
    await expect(service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: data.items[4]!.itemId, command: { ...replay, decision: "ignored" } as never })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    for (const [item, expectedVersion] of [[data.items[4]!, 1], [data.items[5]!, 0], [data.items[6]!, 0]] as const) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "LOCATION", expectedVersion, idempotencyKey: crypto.randomUUID() } });
    const allProposals = await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId });
    expect(allProposals).toHaveLength(2);
    const evidence = await db.select().from(calibrationProposalEvidence).where(eq(calibrationProposalEvidence.userId, data.userId));
    expect(new Set(evidence.map((item) => item.decisionEventId)).size).toBe(6);
    const concurrent = await Promise.allSettled(["a", "b"].map(() => service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: data.items[7]!.itemId, command: { decision: "saved", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } })));
    expect(concurrent.filter((item) => item.status === "fulfilled")).toHaveLength(1); expect(concurrent.filter((item) => item.status === "rejected")).toHaveLength(1);
    const secondUser = crypto.randomUUID(); await db.insert(jobAccounts).values({ id: secondUser });
    await expect(service.recordDecision({ userId: secondUser, recommendationListId: data.listId, recommendationListItemId: data.items[0]!.itemId, command: { decision: "saved", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } })).rejects.toThrow("RECOMMENDATION_ITEM_NOT_FOUND");
    await expect(db.execute(sql`update recommendation_decision_events set decision = 'saved' where user_id = ${data.userId}`)).rejects.toBeDefined();
    await expect(db.execute(sql`delete from calibration_proposal_evidence where proposal_id = ${proposals[0]!.proposalId}`)).rejects.toBeDefined();
    const audit = await createAuditTrail({ db, clock: () => now }).query({ userId: data.userId });
    expect(JSON.stringify(audit)).not.toContain("x".repeat(20));
  });

  it("revision/resolve 均 CAS 幂等，批准恰好创建一个规则版本且拒绝不改变目标", async () => {
    const data = await fixture(6); const service = commands();
    for (const item of data.items.slice(0, 3)) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "SALARY", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    for (const item of data.items.slice(3)) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "LOCATION", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    const proposals = await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId });
    const proposal = proposals.find((item) => item.revision.strategy === "raise_quality_bar"); const secondProposal = proposals.find((item) => item.proposalId !== proposal!.proposalId);
    const revisionCommand = { expectedVersion: 1, idempotencyKey: crypto.randomUUID(), strategy: "raise_quality_bar" as const, ruleConfig: { minimumOverallScore: 80, minimumEvidenceDimensions: 2, requiredEvidenceDimensions: [], excludedOpportunityIds: [] }, impactPreview: { sampleSize: 3, estimatedAffectedCount: 2, ruleDiff: { minimumOverallScore: { from: 60, to: 80 } } } };
    const revision = await service.reviseCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command: revisionCommand });
    await expect(service.reviseCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command: revisionCommand })).resolves.toMatchObject({ id: revision!.id, revisionNumber: 2 });
    const resolution = { action: "approved" as const, expectedVersion: 2, idempotencyKey: crypto.randomUUID() };
    await expect(service.resolveCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command: resolution })).resolves.toMatchObject({ status: "approved", ruleVersion: "recommendation-rule-v1" });
    await expect(service.resolveCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command: resolution })).resolves.toMatchObject({ status: "approved", ruleVersion: "recommendation-rule-v1" });
    await expect(service.resolveCalibrationProposal({ userId: data.userId, proposalId: secondProposal!.proposalId, command: { action: "rejected", expectedVersion: 1, idempotencyKey: resolution.idempotencyKey } })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(db.select().from(recommendationRuleVersions).where(eq(recommendationRuleVersions.proposalId, proposal!.proposalId))).resolves.toHaveLength(1);
    await expect(db.select({ version: jobTargets.version }).from(jobTargets).where(eq(jobTargets.id, data.targetId))).resolves.toEqual([{ version: 1 }]);
    await expect(db.execute(sql`update calibration_proposal_revisions set strategy = 'require_related_evidence' where id = ${revision!.id}`)).rejects.toBeDefined();
    await expect(db.execute(sql`delete from recommendation_rule_versions where proposal_id = ${proposal!.proposalId}`)).rejects.toBeDefined();
  });

  it("过期反馈把 opportunityId 冻结到规则，未来 run 实际发布且不回写历史", async () => {
    const data = await fixture(4); const service = commands(); const historicalMatchIds = data.items.map((item) => item.matchId);
    for (const item of data.items.slice(0, 3)) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "EXPIRED", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    const [proposal] = await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId });
    const config = proposal!.revision.ruleConfig as { excludedOpportunityIds: string[] };
    expect(config.excludedOpportunityIds.slice().sort()).toEqual(data.items.slice(0, 3).map((item) => item.opportunityId).sort());
    expect(config.excludedOpportunityIds).not.toContain(data.items[2]!.matchId);
    await service.resolveCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command: { action: "approved", expectedVersion: 1, idempotencyKey: crypto.randomUUID() } });
    const started = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now }).start({ userId: data.userId, targetId: data.targetId, idempotencyKey: crypto.randomUUID(), trigger: "automatic", discoveryRunId: crypto.randomUUID() });
    const [run] = await db.select({ ruleVersion: agentRuns.ruleVersion, sourceScope: agentRuns.sourceScope }).from(agentRuns).where(and(eq(agentRuns.userId, data.userId), eq(agentRuns.id, started.runId)));
    expect(run).toMatchObject({ ruleVersion: "recommendation-rule-v1" });
    const sourceScope = run!.sourceScope as { recommendationRuleConfig: { minimumOverallScore: number; minimumEvidenceDimensions: number; requiredEvidenceDimensions: string[]; excludedOpportunityIds: string[] }; selectionExclusions: [] };
    expect(sourceScope.recommendationRuleConfig.excludedOpportunityIds.slice().sort()).toEqual(data.items.slice(0, 3).map((item) => item.opportunityId).sort());
    const claimToken = crypto.randomUUID();
    await db.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" }).where(eq(agentRuns.id, started.runId));
    const [candidate] = await createDeepMatchQueries({ db }).getFrozenCandidates({ userId: data.userId, runId: started.runId });
    expect(candidate?.opportunityId).toBe(data.items[3]!.opportunityId);
    const deepMatch = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now, adapter: new FakeDeepMatchAdapter() });
    const staged = await deepMatch.invokeAndValidate({ userId: data.userId, runId: started.runId, candidate: candidate!, modelCall: { signal: new AbortController().signal, usageKey: "feedback-publish", budget: { maxTokens: 20_000, reservedInputTokens: 32, reservedOutputTokens: 48 } } });
    await deepMatch.stageValidatedAssessment({ userId: data.userId, runId: started.runId, claimToken, candidate: candidate!, assessment: staged.assessment, usage: staged.usage });
    const published = await deepMatch.publishStagedRun({ userId: data.userId, targetId: data.targetId, runId: started.runId, fence: { claimToken }, selectionExclusions: sourceScope.selectionExclusions, ruleConfig: sourceScope.recommendationRuleConfig });
    // Fake adapter deliberately returns a non-recommendable assessment here; publication still
    // persists the one non-excluded match under the frozen approved rule.
    expect(published.items).toHaveLength(0);
    await expect(db.select().from(recommendationListItems).where(eq(recommendationListItems.recommendationListId, data.listId))).resolves.toHaveLength(4);
    await expect(db.select({ id: jobMatchVersions.id, ruleVersion: jobMatchVersions.ruleVersion }).from(jobMatchVersions).where(and(eq(jobMatchVersions.userId, data.userId), eq(jobMatchVersions.opportunityId, data.items[3]!.opportunityId)))).resolves.toEqual(expect.arrayContaining([{ id: data.items[3]!.matchId, ruleVersion: "recommendation-rule-v0" }, expect.objectContaining({ ruleVersion: "recommendation-rule-v1" })]));
    await expect(db.select({ id: jobMatchVersions.id }).from(jobMatchVersions).where(eq(jobMatchVersions.userId, data.userId))).resolves.toEqual(expect.arrayContaining(historicalMatchIds.map((id) => ({ id }))));
  });

  it("只把每个推荐项最高版本的事件作为当前状态，并将幂等键绑定到该项", async () => {
    const data = await fixture(4); const service = commands(); const key = crypto.randomUUID();
    await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: data.items[0]!.itemId, command: { decision: "ignored", reason: "LOCATION", expectedVersion: 0, idempotencyKey: key } });
    await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: data.items[0]!.itemId, command: { decision: "saved", expectedVersion: 1, idempotencyKey: crypto.randomUUID() } });
    for (const item of data.items.slice(1, 3)) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "LOCATION", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    await expect(service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: data.items[0]!.itemId, command: { decision: "ignored", reason: "SALARY", expectedVersion: 2, idempotencyKey: crypto.randomUUID() } })).resolves.toMatchObject({ decision: { version: 3 } });
    await expect(service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: data.items[3]!.itemId, command: { decision: "ignored", reason: "LOCATION", expectedVersion: 1, idempotencyKey: key } })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId })).resolves.toHaveLength(0);
  });
});
