import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agentRuns, auditEvents, calibrationProposalEvidence, calibrationProposalRevisions, calibrationProposals, createDatabase, jobAccounts, jobMatchVersions, jobOpportunities, jobOpportunitySources,
  jobProfiles, jobSourcePostingVersions, jobSourcePostings, jobTargets, jobTargetRevisions, jobTriageVersions, migrateDatabase, profileFactRevisions, profileFacts, recommendationDecisionEvents, recommendationDecisionResponses, recommendationListItems,
  recommendationLists, recommendationRuleVersions, type Database,
} from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createDeepMatchRunStarter } from "./deep-match-agent-runs";
import { createDeepMatchCommands, createDeepMatchQueries } from "./deep-match-persistence";
import { DEEP_MATCH_DIMENSIONS, FakeDeepMatchAdapter } from "@job-copilot/contracts/deep-match";
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
      await db.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId, sourcePostingId, version: 1, contentSha256: hash, rawContentSha256: hash, rawObjectReference: { key: "redacted" }, normalizedData: { qualifications: { workMode: null, relocationRequired: null, salary: null, seniority: null, education: null, languages: null, workEligibility: null, industry: null, employmentType: null, requiredSkills: { value: ["TypeScript"], evidence: { field: "requiredSkills", path: "技能", value: "TypeScript" } } } }, retrievedAt: now, availability: "open", createdAt: now });
      await db.insert(jobOpportunities).values({ id: opportunityId, userId, importId: null, sourcePostingVersionId, canonicalOpportunityId: null, dedupKey: hash, company: "示例公司", title: `岗位 ${index}`, location: "上海", postedAt: null, deadline: null, description: null, normalizedData: {}, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
      await db.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId, opportunityId, sourcePostingVersionId, createdAt: now });
      await db.insert(jobTriageVersions).values({ id: triageId, userId, opportunityId, sourcePostingVersionId, profileId, profileVersion: 1, targetId, targetVersion: 1, qualificationRuleVersion: "q1", coarseRuleVersion: "c1", overallVerdict: "pass", gateResults: {}, pendingItems: [], deadlineStatus: "valid", confidenceBasisPoints: 10_000, dimensionScores: {}, overallScore: 90, threshold: 70, sequence: 1, createdAt: now });
      await db.insert(jobMatchVersions).values({ id: matchId, userId, opportunityId, sourcePostingVersionId, triageVersionId: triageId, profileId, profileVersion: 1, targetId, targetVersion: 1, ruleVersion: "recommendation-rule-v0", promptVersion: "p1", adapter: "fake", adapterVersion: "1", model: "fake", outputSchemaVersion: "1", overallScore: 90, displayBand: "highly_matched", assessment: { opportunityId, overallScore: 90, dimensions: DEEP_MATCH_DIMENSIONS.map((dimension) => dimension === "skills" || dimension === "career_direction" ? { dimension, score: 90, judgment: "evidence_backed_inference", jobEvidenceIds: ["job"], profileEvidenceIds: ["profile"], summary: "有双方证据支持" } : { dimension, score: 50, judgment: "insufficient_evidence", jobEvidenceIds: [], profileEvidenceIds: [], summary: "证据不足" }) }, sequence: 1, createdAt: now });
      await db.insert(recommendationListItems).values({ id: itemId, userId, recommendationListId: listId, matchVersionId: matchId, ordinal: index + 1, highlighted: false, createdAt: now });
      items.push({ itemId, matchId, opportunityId });
    }
    return { userId, targetId, listId, items };
  }

  function commands() {
    return createRecommendationFeedbackCommands({ db, id: () => crypto.randomUUID(), clock: () => now, auditTrail: createAuditTrail({ db, clock: () => now }) });
  }

  const acceptableAssessment = (candidate: Awaited<ReturnType<ReturnType<typeof createDeepMatchQueries>["getFrozenCandidates"]>>[number]) => ({
    opportunityId: candidate.opportunityId, overallScore: 90,
    dimensions: DEEP_MATCH_DIMENSIONS.map((dimension) => dimension === "skills" || dimension === "career_direction" ? { dimension, score: 90, judgment: "evidence_backed_inference" as const, jobEvidenceIds: [candidate.jobEvidence.find((item) => item.dimensions.includes(dimension))!.id], profileEvidenceIds: [candidate.profileEvidence.find((item) => item.dimensions.includes(dimension))!.id], summary: "有双方证据支持" } : { dimension, score: 50, judgment: "insufficient_evidence" as const, jobEvidenceIds: [], profileEvidenceIds: [], summary: "证据不足" }),
    evidenceSnapshot: { jobEvidence: candidate.jobEvidence.map(({ id, value, provenance }) => ({ id, value, ...(provenance ? { provenance } : {}) })), profileEvidence: candidate.profileEvidence.map((evidence) => evidence.kind === "profile_fact" ? { id: evidence.id, value: evidence.value, kind: evidence.kind, profileFactRevisionId: evidence.profileFactRevisionId } : { id: evidence.id, value: evidence.value, kind: evidence.kind, targetRevisionId: evidence.targetRevisionId }) },
    opportunitySnapshot: candidate.opportunitySnapshot,
  });

  it("以 owner-bound 不可变事件记录全部反馈边界，并在三条当前忽略时只创建一次建议", async () => {
    const data = await fixture(8); const service = commands();
    await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: data.items[0]!.itemId, command: { decision: "ignored", expectedVersion: 0, idempotencyKey: crypto.randomUUID(), note: "x".repeat(500) } });
    for (const item of data.items.slice(1, 4)) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "LOCATION", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    const proposals = await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId });
    expect(proposals).toHaveLength(1); expect(proposals[0]).toMatchObject({ evidenceCount: 3, revision: { revisionNumber: 1, strategy: "require_related_evidence", impactPreview: { estimatedAffectedCount: 3 } } });
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
    const revisionCommand = { expectedVersion: 1, idempotencyKey: crypto.randomUUID(), strategy: "exclude_evidence_opportunities" as const };
    const revision = await service.reviseCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command: revisionCommand });
    await expect(service.reviseCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command: revisionCommand })).resolves.toEqual(revision);
    expect(revision).toEqual({ proposalId: proposal!.proposalId, revisionId: expect.any(String), revisionNumber: 2 });
    const resolution = { action: "approved" as const, expectedVersion: 2, idempotencyKey: crypto.randomUUID() };
    await expect(service.resolveCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command: resolution })).resolves.toMatchObject({ status: "approved", ruleVersion: "recommendation-rule-v1" });
    await expect(service.resolveCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command: resolution })).resolves.toMatchObject({ status: "approved", ruleVersion: "recommendation-rule-v1" });
    await expect(service.resolveCalibrationProposal({ userId: data.userId, proposalId: secondProposal!.proposalId, command: { action: "rejected", expectedVersion: 1, idempotencyKey: resolution.idempotencyKey } })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(db.select().from(recommendationRuleVersions).where(eq(recommendationRuleVersions.proposalId, proposal!.proposalId))).resolves.toHaveLength(1);
    await expect(db.select({ version: jobTargets.version }).from(jobTargets).where(eq(jobTargets.id, data.targetId))).resolves.toEqual([{ version: 1 }]);
    await expect(db.execute(sql`update calibration_proposal_revisions set strategy = 'require_related_evidence' where id = ${revision!.revisionId}`)).rejects.toBeDefined();
    await expect(db.execute(sql`delete from recommendation_rule_versions where proposal_id = ${proposal!.proposalId}`)).rejects.toBeDefined();
  });

  it("已解决建议始终读取其批准时的不可变 revision，而不随之后规则版本投影变化", async () => {
    const data = await fixture(6); const service = commands();
    for (const item of data.items.slice(0, 3)) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "SALARY", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    for (const item of data.items.slice(3)) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "LOCATION", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    const queries = createRecommendationFeedbackQueries({ db });
    const proposals = await queries.listCalibrationProposals({ userId: data.userId, targetId: data.targetId });
    const first = proposals.find((item) => item.revision.strategy === "raise_quality_bar")!;
    const second = proposals.find((item) => item.proposalId !== first.proposalId)!;
    const immutable = structuredClone(first.revision);

    await service.resolveCalibrationProposal({ userId: data.userId, proposalId: first.proposalId, command: { action: "approved", expectedVersion: 1, idempotencyKey: crypto.randomUUID() } });
    const afterFirstApproval = (await queries.listCalibrationProposals({ userId: data.userId, targetId: data.targetId })).find((item) => item.proposalId === first.proposalId)!;
    expect(afterFirstApproval).toMatchObject({ status: "approved", reviewState: "resolved", availableStrategies: [], revision: immutable });

    await service.rebaseCalibrationProposal({ userId: data.userId, proposalId: second.proposalId, command: { expectedVersion: 1, idempotencyKey: crypto.randomUUID() } });
    await service.resolveCalibrationProposal({ userId: data.userId, proposalId: second.proposalId, command: { action: "approved", expectedVersion: 2, idempotencyKey: crypto.randomUUID() } });
    const afterSecondApproval = (await queries.listCalibrationProposals({ userId: data.userId, targetId: data.targetId })).find((item) => item.proposalId === first.proposalId)!;
    expect(afterSecondApproval).toMatchObject({ status: "approved", reviewState: "resolved", availableStrategies: [], revision: immutable });
    expect(afterSecondApproval.revision).toEqual(immutable);
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
    expect(published.items).toHaveLength(1);
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

  it("决策重放精确返回首次响应，而不被后续 evidence 改写", async () => {
    const data = await fixture(); const service = commands();
    const commandsByItem = data.items.map(() => ({ decision: "ignored" as const, reason: "LOCATION" as const, expectedVersion: 0, idempotencyKey: crypto.randomUUID() }));
    const first = [] as Awaited<ReturnType<typeof service.recordDecision>>[];
    for (const [index, item] of data.items.entries()) first.push(await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: commandsByItem[index]! }));
    expect(first.map((result) => result.proposal)).toEqual([null, null, expect.objectContaining({ proposalId: expect.any(String) })]);
    for (const [index, item] of data.items.entries()) await expect(service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: commandsByItem[index]! })).resolves.toEqual(first[index]);
  });

  it("同一 assessment 在批准规则前可发布，在冻结的质量规则后被排除", async () => {
    const data = await fixture(4); const starter = createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now });
    const publish = async (runId: string, ruleConfig?: { minimumOverallScore: number; minimumEvidenceDimensions: number; requiredEvidenceDimensions: string[]; excludedOpportunityIds: string[] }) => {
      const claimToken = crypto.randomUUID(); await db.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" }).where(eq(agentRuns.id, runId));
      const [candidate] = await createDeepMatchQueries({ db }).getFrozenCandidates({ userId: data.userId, runId }); const deepMatch = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });
      const assessment = acceptableAssessment(candidate!); await deepMatch.stageValidatedAssessment({ userId: data.userId, runId, claimToken, candidate: candidate!, assessment, usage: { inputTokens: 32, outputTokens: 48, latencyMs: 1 } });
      return deepMatch.publishStagedRun({ userId: data.userId, targetId: data.targetId, runId, fence: { claimToken }, selectionExclusions: [], ...(ruleConfig ? { ruleConfig } : {}) });
    };
    const before = await starter.start({ userId: data.userId, targetId: data.targetId, opportunityId: data.items[3]!.opportunityId, idempotencyKey: crypto.randomUUID(), trigger: "manual" });
    const baseline = await publish(before.runId); expect(baseline.items).toHaveLength(1);
    const baselineListId = baseline.recommendationListId; const baselineMatchIds = (await db.select({ id: jobMatchVersions.id }).from(jobMatchVersions).where(eq(jobMatchVersions.userId, data.userId))).map((row) => row.id);
    const feedback = commands(); for (const item of data.items.slice(0, 3)) await feedback.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "SALARY", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    const [proposal] = await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId });
    await feedback.resolveCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command: { action: "approved", expectedVersion: 1, idempotencyKey: crypto.randomUUID() } });
    const after = await starter.start({ userId: data.userId, targetId: data.targetId, opportunityId: data.items[3]!.opportunityId, idempotencyKey: crypto.randomUUID(), trigger: "manual" });
    const [frozen] = await db.select({ ruleVersion: agentRuns.ruleVersion, sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.id, after.runId));
    const config = (frozen!.sourceScope as { recommendationRuleConfig: { minimumOverallScore: number; minimumEvidenceDimensions: number; requiredEvidenceDimensions: string[]; excludedOpportunityIds: string[] } }).recommendationRuleConfig;
    expect(frozen!.ruleVersion).toBe("recommendation-rule-v1"); expect(config.minimumOverallScore).toBe(91);
    await expect(publish(after.runId, config)).resolves.toMatchObject({ items: [] });
    await expect(db.select().from(recommendationListItems).where(eq(recommendationListItems.recommendationListId, baselineListId))).resolves.toHaveLength(1);
    await expect(db.select({ id: jobMatchVersions.id }).from(jobMatchVersions).where(eq(jobMatchVersions.userId, data.userId))).resolves.toEqual(expect.arrayContaining(baselineMatchIds.map((id) => ({ id }))));
    await expect(db.select({ ruleVersion: jobMatchVersions.ruleVersion }).from(jobMatchVersions).where(and(eq(jobMatchVersions.userId, data.userId), eq(jobMatchVersions.opportunityId, data.items[3]!.opportunityId)))).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ ruleVersion: "recommendation-rule-v1" })]));
  });

  it("修改建议相对 active rule 累计展示完整差异与影响预览", async () => {
    const data = await fixture(); const service = commands();
    for (const item of data.items) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "SALARY", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    const [proposal] = await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId });
    await service.reviseCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command: { strategy: "exclude_evidence_opportunities", expectedVersion: 1, idempotencyKey: crypto.randomUUID() } });
    const [revised] = await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId });
    expect(revised!.revision.impactPreview).toMatchObject({ estimatedAffectedCount: 3, ruleDiff: { minimumOverallScore: { from: 0, to: 91 }, excludedOpportunityIds: { from: [], to: expect.arrayContaining(data.items.map((item) => item.opportunityId)) } } });
  });

  it("交错提案以 immutable 基准重放累计收紧，过期批准冲突而重算后仅创建 v2", async () => {
    const data = await fixture(6); const service = commands();
    for (const item of data.items.slice(0, 3)) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "SALARY", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    for (const item of data.items.slice(3)) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "LOCATION", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    const proposals = await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId });
    const p1 = proposals.find((proposal) => proposal.reason === "SALARY")!; const p2 = proposals.find((proposal) => proposal.reason === "LOCATION")!;
    await service.resolveCalibrationProposal({ userId: data.userId, proposalId: p1.proposalId, command: { action: "approved", expectedVersion: 1, idempotencyKey: crypto.randomUUID() } });
    await expect(service.resolveCalibrationProposal({ userId: data.userId, proposalId: p2.proposalId, command: { action: "approved", expectedVersion: 1, idempotencyKey: crypto.randomUUID() } })).rejects.toThrow("RULE_VERSION_CONFLICT");
    await expect(db.select().from(recommendationRuleVersions).where(eq(recommendationRuleVersions.targetId, data.targetId))).resolves.toHaveLength(1);
    const rebased = await service.reviseCalibrationProposal({ userId: data.userId, proposalId: p2.proposalId, command: { strategy: "exclude_evidence_opportunities", expectedVersion: 1, idempotencyKey: crypto.randomUUID() } });
    const [persistedRebase] = await db.select({ ruleConfig: calibrationProposalRevisions.ruleConfig }).from(calibrationProposalRevisions).where(eq(calibrationProposalRevisions.id, rebased!.revisionId));
    expect(persistedRebase!.ruleConfig).toMatchObject({ minimumOverallScore: 91, requiredEvidenceDimensions: ["location_logistics"] });
    expect((persistedRebase!.ruleConfig as { excludedOpportunityIds: string[] }).excludedOpportunityIds.slice().sort()).toEqual(data.items.slice(3).map((item) => item.opportunityId).sort());
    await expect(service.resolveCalibrationProposal({ userId: data.userId, proposalId: p2.proposalId, command: { action: "approved", expectedVersion: 2, idempotencyKey: crypto.randomUUID() } })).resolves.toMatchObject({ ruleVersion: "recommendation-rule-v2" });
    await expect(db.select().from(recommendationRuleVersions).where(eq(recommendationRuleVersions.targetId, data.targetId))).resolves.toHaveLength(2);
  });

  it("无可选策略的 stale 建议仍可重新计算一次并绑定最新 active 规则", async () => {
    const data = await fixture(3); const service = commands();
    for (const item of data.items) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "LOCATION", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    const [proposal] = await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId });
    const activeProposalId = crypto.randomUUID(); const activeRevisionId = crypto.randomUUID();
    const activeConfig = { minimumOverallScore: 91, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: [], excludedOpportunityIds: data.items.map((item) => item.opportunityId) };
    await db.insert(calibrationProposals).values({ id: activeProposalId, userId: data.userId, targetId: data.targetId, reason: "SALARY", status: "approved", version: 2, createdAt: now, updatedAt: now });
    await db.insert(calibrationProposalRevisions).values({ id: activeRevisionId, userId: data.userId, proposalId: activeProposalId, revisionNumber: 1, baseRuleVersion: 0, strategy: "raise_quality_bar", ruleConfig: activeConfig, impactPreview: { sampleSize: 3, estimatedAffectedCount: 3, ruleDiff: {} }, idempotencyKey: crypto.randomUUID(), commandSummary: "a".repeat(64), createdAt: now });
    await db.insert(recommendationRuleVersions).values({ id: crypto.randomUUID(), userId: data.userId, targetId: data.targetId, proposalId: activeProposalId, proposalRevisionId: activeRevisionId, version: 1, config: activeConfig, createdAt: now });

    const [stale] = (await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId })).filter((item) => item.proposalId === proposal!.proposalId);
    expect(stale).toMatchObject({ reviewState: "stale_rebase_required", availableStrategies: [] });
    const command = { expectedVersion: 1, idempotencyKey: "00000000-0000-4000-8000-000000000099" };
    const rebased = await service.rebaseCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command });
    await expect(service.rebaseCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command })).resolves.toEqual(rebased);
    await expect(service.rebaseCalibrationProposal({ userId: crypto.randomUUID(), proposalId: proposal!.proposalId, command: { expectedVersion: 2, idempotencyKey: crypto.randomUUID() } })).rejects.toThrow("PROPOSAL_NOT_FOUND");
    expect(rebased).toEqual({ proposalId: proposal!.proposalId, revisionId: expect.any(String), revisionNumber: 2 });
    const [persistedRebase] = await db.select().from(calibrationProposalRevisions).where(and(eq(calibrationProposalRevisions.userId, data.userId), eq(calibrationProposalRevisions.id, rebased!.revisionId)));
    expect(persistedRebase).toMatchObject({ baseRuleVersion: 1, ruleConfig: { minimumOverallScore: 91, requiredEvidenceDimensions: ["location_logistics"], excludedOpportunityIds: data.items.map((item) => item.opportunityId) }, impactPreview: { sampleSize: 3, ruleDiff: { requiredEvidenceDimensions: { from: [], to: ["location_logistics"] } } } });
    await expect(db.select().from(calibrationProposalRevisions).where(and(eq(calibrationProposalRevisions.userId, data.userId), eq(calibrationProposalRevisions.proposalId, proposal!.proposalId)))).resolves.toHaveLength(2);
    await expect(db.select().from(auditEvents).where(and(eq(auditEvents.userId, data.userId), eq(auditEvents.resourceId, proposal!.proposalId), eq(auditEvents.eventType, "recommendation.calibration_proposal")))).resolves.toHaveLength(2);
    const [fresh] = (await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId })).filter((item) => item.proposalId === proposal!.proposalId);
    expect(fresh).toMatchObject({ reviewState: "current", availableStrategies: [] });
    await expect(service.resolveCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command: { action: "approved", expectedVersion: 2, idempotencyKey: crypto.randomUUID() } })).resolves.toMatchObject({ ruleVersion: "recommendation-rule-v2" });
  });

  it("排除容量不可表示时仍提交三条 ignored 决策，97 加三条时仍可审核", async () => {
    for (const existingExclusions of [99, 97]) {
      const data = await fixture(3); const service = commands();
      const proposalId = crypto.randomUUID(); const revisionId = crypto.randomUUID(); const config = { minimumOverallScore: 0, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: [], excludedOpportunityIds: Array.from({ length: existingExclusions }, () => crypto.randomUUID()) };
      await db.insert(calibrationProposals).values({ id: proposalId, userId: data.userId, targetId: data.targetId, reason: "EXPIRED", status: "approved", version: 2, createdAt: now, updatedAt: now });
      await db.insert(calibrationProposalRevisions).values({ id: revisionId, userId: data.userId, proposalId, revisionNumber: 1, baseRuleVersion: 0, strategy: "exclude_evidence_opportunities", ruleConfig: config, impactPreview: { sampleSize: 0, estimatedAffectedCount: 0, ruleDiff: {} }, idempotencyKey: crypto.randomUUID(), commandSummary: "a".repeat(64), createdAt: now });
      await db.insert(recommendationRuleVersions).values({ id: crypto.randomUUID(), userId: data.userId, targetId: data.targetId, proposalId, proposalRevisionId: revisionId, version: 1, config, createdAt: now });
      const results = [] as Awaited<ReturnType<typeof service.recordDecision>>[];
      for (const item of data.items) results.push(await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "EXPIRED", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } }));
      expect(await db.select().from(recommendationDecisionEvents).where(eq(recommendationDecisionEvents.userId, data.userId))).toHaveLength(3);
      expect(await db.select().from(recommendationDecisionResponses).where(eq(recommendationDecisionResponses.userId, data.userId))).toHaveLength(3);
      if (existingExclusions === 99) expect(results[2]!.proposal).toBeNull();
      else expect(results[2]!.proposal).toEqual(expect.objectContaining({ proposalId: expect.any(String) }));
    }
  });

  it("已生效的同原因反馈仍为每个成功事件写唯一不可变响应，第三条不生成 no-op proposal", async () => {
    const data = await fixture(6); const service = commands();
    for (const item of data.items.slice(0, 3)) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "LOCATION", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    const [proposal] = await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId });
    await service.resolveCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command: { action: "approved", expectedVersion: 1, idempotencyKey: crypto.randomUUID() } });
    const commandsByItem = data.items.slice(3).map(() => ({ decision: "ignored" as const, reason: "LOCATION" as const, expectedVersion: 0, idempotencyKey: crypto.randomUUID() }));
    const results = [] as Awaited<ReturnType<typeof service.recordDecision>>[];
    for (const [index, item] of data.items.slice(3).entries()) results.push(await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: commandsByItem[index]! }));
    expect(results[2]!.proposal).toBeNull();
    await expect(service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: data.items[5]!.itemId, command: commandsByItem[2]! })).resolves.toEqual(results[2]);
    const responses = await db.select().from(recommendationDecisionResponses).where(eq(recommendationDecisionResponses.userId, data.userId));
    expect(responses).toHaveLength(6); expect(new Set(responses.map((response) => response.decisionEventId)).size).toBe(6);
    const events = await db.select().from(recommendationDecisionEvents).where(eq(recommendationDecisionEvents.userId, data.userId));
    const laterEventIds = new Set(events.filter((event) => data.items.slice(3).some((item) => item.itemId === event.recommendationListItemId)).map((event) => event.id));
    expect(responses.filter((response) => laterEventIds.has(response.decisionEventId)).every((response) => response.proposalId === null)).toBe(true);
  });

  it("响应 proposal 的 nullable owner FK 允许同 owner/null，并拒绝悬空与跨 owner", async () => {
    const data = await fixture(5); const service = commands();
    for (const item of data.items.slice(0, 3)) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason: "LOCATION", expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
    const [proposal] = await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId });
    const persisted = await db.select().from(recommendationDecisionResponses).where(eq(recommendationDecisionResponses.userId, data.userId));
    expect(persisted.some((response) => response.proposalId === null)).toBe(true); expect(persisted.some((response) => response.proposalId === proposal!.proposalId)).toBe(true);
    const createEvent = async (item: typeof data.items[number]) => db.insert(recommendationDecisionEvents).values({ id: crypto.randomUUID(), userId: data.userId, targetId: data.targetId, recommendationListId: data.listId, recommendationListItemId: item.itemId, matchVersionId: item.matchId, decision: "saved", reason: null, note: null, idempotencyKey: crypto.randomUUID(), commandSummary: "a".repeat(64), expectedVersion: 0, version: 1, createdAt: now }).returning();
    const [crossEvent] = await createEvent(data.items[3]!); const [danglingEvent] = await createEvent(data.items[4]!);
    const other = await fixture(1); const otherProposalId = crypto.randomUUID(); await db.insert(calibrationProposals).values({ id: otherProposalId, userId: other.userId, targetId: other.targetId, reason: "LOCATION", status: "pending", version: 1, createdAt: now, updatedAt: now });
    await expect(db.insert(recommendationDecisionResponses).values({ id: crypto.randomUUID(), userId: data.userId, decisionEventId: crossEvent!.id, proposalId: otherProposalId, createdAt: now })).rejects.toBeDefined();
    await expect(db.insert(recommendationDecisionResponses).values({ id: crypto.randomUUID(), userId: data.userId, decisionEventId: danglingEvent!.id, proposalId: crypto.randomUUID(), createdAt: now })).rejects.toBeDefined();
  });

  it("九类原因的同策略修改均为 no-op：不创建 revision", async () => {
    const reasons = ["ROLE_DIRECTION", "LOCATION", "SALARY", "COMPANY", "INDUSTRY", "SENIORITY", "MISMATCH", "EXPIRED", "ALREADY_HANDLED"] as const;
    for (const reason of reasons) {
      const data = await fixture(); const service = commands();
      for (const item of data.items) await service.recordDecision({ userId: data.userId, recommendationListId: data.listId, recommendationListItemId: item.itemId, command: { decision: "ignored", reason, expectedVersion: 0, idempotencyKey: crypto.randomUUID() } });
      const [proposal] = await createRecommendationFeedbackQueries({ db }).listCalibrationProposals({ userId: data.userId, targetId: data.targetId });
      await expect(service.reviseCalibrationProposal({ userId: data.userId, proposalId: proposal!.proposalId, command: { strategy: proposal!.revision.strategy as "require_related_evidence" | "raise_quality_bar" | "exclude_evidence_opportunities", expectedVersion: 1, idempotencyKey: crypto.randomUUID() } })).rejects.toThrow("PROPOSAL_NO_EFFECT");
      await expect(db.select().from(calibrationProposalRevisions).where(eq(calibrationProposalRevisions.userId, data.userId))).resolves.toHaveLength(1);
    }
  });
});
