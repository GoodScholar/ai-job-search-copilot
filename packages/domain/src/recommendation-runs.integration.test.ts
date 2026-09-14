import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agentInboxItemActions, agentInboxItems, agentRunControlCommands, agentRunEvents, agentRunSteps, agentRuns, auditEvents, createDatabase, jobAccounts, jobDiscoverySourceIssues, jobProfiles, jobTargets, jobTargetRevisions, migrateDatabase, modelDiagnosticResults, profileFactRevisions, profileFacts, recommendationLists, recommendationResults, recommendationRunControlCommands, recommendationRunStartCommands, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createAccountRunControl } from "./account-run-control";
import { createModelDiagnosticProjectionReader, createRunPreflightEvaluator } from "./run-preflight";
import { createRecommendationRunCommands, createRecommendationRunQueries, RecommendationRunError } from "./recommendation-runs";
import { createAgentRunCommands } from "./agent-run-control";
import { createReadyRunPreflightEvaluator } from "./testing/run-preflight";
import { createAgentRunRecoveryQueries } from "./agent-run-processor";
import { createAgentInbox } from "./agent-inbox";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import type { SourceCapabilityAdapter } from "./source-capabilities";

const now = new Date("2026-09-13T12:00:00.000Z");
const constraints = { roleFamily: "AI 应用工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } };
const capabilityAdapter: SourceCapabilityAdapter = { adapter: "greenhouse", adapterVersion: "test-v1", declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test-v1", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring"] }) };

async function waitUntilAConnectionIsWaitingForAccountAdvisoryLock(database: Database) {
  await expect.poll(async () => {
    const [row] = await database.execute<{ waiting: boolean }>(sql`
      select exists(
        select 1 from pg_stat_activity
        where wait_event_type = 'Lock'
          and wait_event = 'advisory'
          and query like '%pg_advisory_xact_lock%'
      ) as waiting
    `);
    return row?.waiting ?? false;
  }, { timeout: 2_000, interval: 10 }).toBe(true);
}

describe("推荐运行领域边界", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;
  beforeAll(async () => { container = await new PostgreSqlContainer("postgres:17-alpine").start(); database = createDatabase(container.getConnectionUri()); await migrateDatabase(database); }, 60_000);
  afterAll(async () => { await database?.$client.end(); await container?.stop(); });

  async function account() {
    const userId = randomUUID(); const targetId = randomUUID(); const profileId = randomUUID(); const factId = randomUUID(); const fingerprint = randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now });
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
    await database.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
    await database.insert(profileFactRevisions).values({ id: randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "TypeScript" }, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: now });
    return { userId, targetId, profileId, fingerprint };
  }
  function commands(fingerprint: string) {
    const preflight = createRunPreflightEvaluator({ capabilityAdapter, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }), discoveryExecutionMode: "layered_public", id: randomUUID, clock: () => now });
    return createRecommendationRunCommands({ db: database, queue: { enqueue: async () => undefined }, auditTrail: createAuditTrail({ db: database, clock: () => now }), runPreflight: preflight, executionMode: "layered_public", id: randomUUID, clock: () => now });
  }
  async function command(owner: { userId: string; fingerprint: string }, idempotencyKey: string, mode: "fake" | "greenhouse" | "layered_public" = "layered_public") {
    const preflight = createRunPreflightEvaluator({ capabilityAdapter, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: owner.fingerprint }), discoveryExecutionMode: mode, id: randomUUID, clock: () => now });
    const report = await preflight.evaluate(database, { userId: owner.userId, workflow: "recommendation", trigger: "manual" });
    return { idempotencyKey, warningFingerprint: report.report.warningFingerprint };
  }
  async function completeRootAndInsertChild(rootId: string, db: any = database) {
    const [root] = await db.select().from(agentRuns).where(eq(agentRuns.id, rootId));
    if (!root) throw new Error("missing root fixture");
    const childId = randomUUID();
    await db.update(agentRuns).set({ status: "completed", currentStep: "completed", controlState: "none", startedAt: now, completedAt: now, terminationKind: "completed", updatedAt: now }).where(eq(agentRuns.id, rootId));
    await db.update(agentRunSteps).set({ status: "completed", startedAt: now, completedAt: now }).where(eq(agentRunSteps.runId, rootId));
    await db.insert(agentRuns).values({
      id: childId, userId: root.userId, targetId: root.targetId, parentRunId: root.id, runPurpose: "recommendation", recommendationContext: null, idempotencyKey: randomUUID(), targetVersion: root.targetVersion, targetSnapshot: root.targetSnapshot, profileSnapshot: null, watchlistSnapshot: null, sourceScope: { trigger: "automatic" }, budgetSnapshot: root.budgetSnapshot, accountPolicyRevisionNumber: root.accountPolicyRevisionNumber, accountPolicySnapshot: root.accountPolicySnapshot, preflightSnapshot: root.preflightSnapshot, workflowVersion: "deep-match-v1", ruleVersion: "deep-match-rules-v1", adapter: "fake-deep-match", adapterVersion: "fake-deep-match-v1", outputSchemaVersion: "deep-match-result-v1", toolAllowlist: [], modelSnapshot: { provider: "fake", model: "fake-deep-match-model-v1" }, status: "queued", currentStep: "queued", controlState: "none", version: 1, attemptCount: 0, activeDurationMs: 0, toolCallCount: 0, sourceRequestCount: 0, modelCallCount: 0, inputTokenCount: 0, outputTokenCount: 0, totalTokenCount: 0, resultCount: 0, usageComplete: false, queuedAt: now, createdAt: now, updatedAt: now,
    });
    await db.insert(agentRunSteps).values(["select_candidates", "assess_matches", "create_recommendations"].map((stepKey, index) => ({ id: randomUUID(), userId: root.userId, runId: childId, stepKey, ordinal: index + 1, status: "pending", attemptCount: 0 })));
    return { root, childId };
  }
  function resultEvidence(root: typeof agentRuns.$inferSelect, count: number) {
    const sourceScope = root.sourceScope as { trustedSources?: readonly unknown[]; publicDiscovery?: { queries?: readonly unknown[] } };
    const plannedTrustedSourceCount = sourceScope.trustedSources?.length ?? 0;
    const plannedPublicQueryCount = sourceScope.publicDiscovery?.queries?.length ?? 0;
    return {
      discovery: { discoveredJobCount: count },
      sourceCoverage: { plannedTrustedSourceCount, plannedPublicQueryCount, checkedBranchCount: 1, credibleBranchCount: 1, verifiedJobCount: count },
      coverageLosses: [],
      qualification: { evaluatedCount: count, rejectedCount: 0, insufficientInformationCount: 0, expiredCount: 0 },
      coarseRanking: { eligibleCount: count, belowThresholdCount: 0, candidateLimitExcludedCount: 0, deepMatchCandidateCount: count },
      deepMatching: { evaluatedCount: count, qualityInsufficientCount: 0, finalRecommendationCount: count },
      suggestedActions: [],
    };
  }
  async function insertRecommendationListItem(owner: { userId: string; targetId: string; profileId: string }, listId: string) {
    const [postingId, postingVersionId, opportunityId, triageId, matchId] = Array.from({ length: 5 }, randomUUID);
    await database.execute(sql`insert into job_source_postings (id, user_id, source_type, source_identifier, source_identity) values (${postingId}, ${owner.userId}, 'fake', ${postingId}, '{}'::jsonb)`);
    await database.execute(sql`insert into job_source_posting_versions (id, user_id, source_posting_id, version, content_sha256, raw_content_sha256, raw_object_reference, retrieved_at) values (${postingVersionId}, ${owner.userId}, ${postingId}, 1, ${"a".repeat(64)}, ${"b".repeat(64)}, '{}'::jsonb, now())`);
    await database.execute(sql`insert into job_opportunities (id, user_id, source_posting_version_id, dedup_key, normalized_data) values (${opportunityId}, ${owner.userId}, ${postingVersionId}, ${randomUUID().replaceAll("-", "").repeat(2)}, '{}'::jsonb)`);
    await database.execute(sql`insert into job_triage_versions (id, user_id, opportunity_id, source_posting_version_id, profile_id, profile_version, target_id, target_version, qualification_rule_version, coarse_rule_version, overall_verdict, gate_results, pending_items, deadline_status, confidence_basis_points, dimension_scores, overall_score, threshold, sequence) values (${triageId}, ${owner.userId}, ${opportunityId}, ${postingVersionId}, ${owner.profileId}, 1, ${owner.targetId}, 1, 'qualification-v1', 'coarse-v1', 'pass', '{}'::jsonb, '[]'::jsonb, 'valid', 10000, '{}'::jsonb, 90, 70, 1)`);
    await database.execute(sql`insert into job_match_versions (id, user_id, opportunity_id, source_posting_version_id, triage_version_id, profile_id, profile_version, target_id, target_version, rule_version, prompt_version, adapter, adapter_version, model, output_schema_version, overall_score, display_band, assessment, sequence) values (${matchId}, ${owner.userId}, ${opportunityId}, ${postingVersionId}, ${triageId}, ${owner.profileId}, 1, ${owner.targetId}, 1, 'rules-v1', 'prompt-v1', 'fake', 'fake-v1', 'fake-model', 'result-v1', 90, 'highly_matched', '{}'::jsonb, 1)`);
    await database.execute(sql`insert into recommendation_list_items (id, user_id, recommendation_list_id, match_version_id, ordinal, highlighted, created_at) values (${randomUUID()}, ${owner.userId}, ${listId}, ${matchId}, 1, true, now())`);
  }

  it("不同启动键并发时复用一个活动逻辑根运行", async () => {
    const owner = await account(); const service = commands(owner.fingerprint);
    const [first, second] = await Promise.all([service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) }), service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) })]);
    expect(first.run.runId).toBe(second.run.runId);
    expect([first.reused, second.reused]).toContain(true);
    await expect(database.select().from(agentRuns).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.runPurpose, "recommendation")))).resolves.toHaveLength(1);
  });

  it("同键重放返回根运行的最新投影而不重复启动", async () => {
    const owner = await account(); const service = commands(owner.fingerprint); const key = randomUUID();
    const first = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, key) });
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", startedAt: now, updatedAt: new Date(now.getTime() + 1_000) }).where(eq(agentRuns.id, first.run.runId));
    const replay = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, key) });
    expect(replay).toMatchObject({ reused: true, run: { runId: first.run.runId, status: "running", currentStage: "discovery" } });
  });

  it("同键异义稳定冲突，终态根运行允许新的启动键创建新根", async () => {
    const owner = await account(); const service = commands(owner.fingerprint); const key = randomUUID();
    const first = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, key) });
    await expect(service.start({ userId: owner.userId, requestId: randomUUID(), command: { idempotencyKey: key, warningFingerprint: "a".repeat(64) } })).rejects.toThrow("RECOMMENDATION_RUN_COMMAND_ID_CONFLICT");
    await service.control({ userId: owner.userId, requestId: randomUUID(), runId: first.run.runId, command: { commandId: randomUUID(), action: "cancel" } });
    const second = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    expect(second).toMatchObject({ reused: false });
    expect(second.run.runId).not.toBe(first.run.runId);
    const roots = await database.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.runPurpose, "recommendation"))).orderBy(desc(agentRuns.createdAt), desc(agentRuns.id));
    await expect(createRecommendationRunQueries({ db: database }).latest({ userId: owner.userId })).resolves.toMatchObject({ runId: roots[0]!.id });
  });

  it("根运行提交后队列唤醒失败由恢复扫描重新投递且不重复事实", async () => {
    const owner = await account(); const preflight = createRunPreflightEvaluator({ capabilityAdapter, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: owner.fingerprint }), discoveryExecutionMode: "layered_public", id: randomUUID, clock: () => now });
    const service = createRecommendationRunCommands({ db: database, queue: { enqueue: async () => { throw new Error("queue unavailable"); } }, auditTrail: createAuditTrail({ db: database, clock: () => now }), runPreflight: preflight, executionMode: "layered_public", id: randomUUID, clock: () => now });
    const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    const jobs = await createAgentRunRecoveryQueries({ db: database, clock: () => now }).listRecoverable(); const redelivered: Array<{ version: number; runId: string; userId: string }> = [];
    const recoveryQueue = { enqueue: async (job: { version: number; runId: string; userId: string }) => { redelivered.push(job); } };
    await Promise.all(jobs.filter((job) => job.runId === started.run.runId).map((job) => recoveryQueue.enqueue(job)));
    expect(redelivered).toEqual([{ version: 1, runId: started.run.runId, userId: owner.userId }]);
    await expect(Promise.all([
      database.select().from(recommendationRunStartCommands).where(eq(recommendationRunStartCommands.rootRunId, started.run.runId)),
      database.select().from(agentRunSteps).where(eq(agentRunSteps.runId, started.run.runId)),
      database.select().from(agentRunEvents).where(eq(agentRunEvents.runId, started.run.runId)),
      database.select().from(auditEvents).where(eq(auditEvents.resourceId, started.run.runId)),
    ])).resolves.toEqual([[expect.any(Object)], [expect.any(Object), expect.any(Object), expect.any(Object)], [expect.any(Object)], [expect.any(Object)]]);
  });

  it("控制命令重放读取首次物理命令事实而不再次改变根运行", async () => {
    const owner = await account(); const service = commands(owner.fingerprint); const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) }); const commandId = randomUUID();
    const first = await service.control({ userId: owner.userId, requestId: randomUUID(), runId: started.run.runId, command: { commandId, action: "pause" } });
    const replay = await service.control({ userId: owner.userId, requestId: randomUUID(), runId: started.run.runId, command: { commandId, action: "pause" } });
    expect(first).toMatchObject({ applied: true, run: { status: "paused", currentStage: "discovery" } });
    expect(replay).toMatchObject({ applied: true, run: { runId: started.run.runId, status: "paused" } });
    await expect(Promise.all([
      database.select().from(recommendationRunControlCommands).where(eq(recommendationRunControlCommands.rootRunId, started.run.runId)),
      database.select().from(agentRunControlCommands).where(eq(agentRunControlCommands.runId, started.run.runId)),
      database.select({ version: agentRuns.version }).from(agentRuns).where(eq(agentRuns.id, started.run.runId)),
    ])).resolves.toEqual([[expect.any(Object)], [expect.any(Object)], [{ version: 2 }]]);
  });

  it("根到子运行切换后控制重放不作用于新子运行", async () => {
    const owner = await account(); const service = commands(owner.fingerprint); const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) }); const commandId = randomUUID();
    await service.control({ userId: owner.userId, requestId: randomUUID(), runId: started.run.runId, command: { commandId, action: "pause" } });
    const [root] = await database.select().from(agentRuns).where(eq(agentRuns.id, started.run.runId)); const childId = randomUUID();
    await database.update(agentRuns).set({ status: "completed", currentStep: "completed", controlState: "none", startedAt: now, completedAt: now, terminationKind: "completed", updatedAt: now }).where(eq(agentRuns.id, started.run.runId));
    await database.update(agentRunSteps).set({ status: "completed", startedAt: now, completedAt: now }).where(eq(agentRunSteps.runId, started.run.runId));
    await database.insert(agentRuns).values({
      id: childId, userId: root!.userId, targetId: root!.targetId, parentRunId: root!.id, runPurpose: "recommendation", recommendationContext: null, idempotencyKey: randomUUID(), targetVersion: root!.targetVersion, targetSnapshot: root!.targetSnapshot, profileSnapshot: null, watchlistSnapshot: null, sourceScope: { trigger: "automatic" }, budgetSnapshot: root!.budgetSnapshot, accountPolicyRevisionNumber: root!.accountPolicyRevisionNumber, accountPolicySnapshot: root!.accountPolicySnapshot, preflightSnapshot: root!.preflightSnapshot, workflowVersion: "deep-match-v1", ruleVersion: "deep-match-rules-v1", adapter: "fake-deep-match", adapterVersion: "fake-deep-match-v1", outputSchemaVersion: "deep-match-result-v1", toolAllowlist: [], modelSnapshot: { provider: "fake", model: "fake-deep-match-model-v1" }, status: "queued", currentStep: "queued", controlState: "none", version: 1, attemptCount: 0, activeDurationMs: 0, toolCallCount: 0, sourceRequestCount: 0, modelCallCount: 0, inputTokenCount: 0, outputTokenCount: 0, totalTokenCount: 0, resultCount: 0, usageComplete: false, queuedAt: now, createdAt: now, updatedAt: now,
    });
    await database.insert(agentRunSteps).values(["select_candidates", "assess_matches", "create_recommendations"].map((stepKey, index) => ({ id: randomUUID(), userId: owner.userId, runId: childId, stepKey, ordinal: index + 1, status: "pending", attemptCount: 0 })));
    const replay = await service.control({ userId: owner.userId, requestId: randomUUID(), runId: started.run.runId, command: { commandId, action: "pause" } });
    expect(replay).toMatchObject({ applied: true, run: { runId: started.run.runId } });
    await expect(database.select({ status: agentRuns.status, version: agentRuns.version }).from(agentRuns).where(eq(agentRuns.id, childId))).resolves.toEqual([{ status: "queued", version: 1 }]);
  });

  it("账户锁竞争中的根到子切换会作用新子，终态子稳定拒绝新控制", async () => {
    const owner = await account(); const service = commands(owner.fingerprint); const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    const observerDatabase = createDatabase(container.getConnectionUri());
    let entered!: () => void; const enteredBarrier = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const releaseBarrier = new Promise<void>((resolve) => { release = resolve; });
    let childId = "";
    const transition = database.transaction(async (transaction) => {
      await acquireAccountAdvisoryLock(transaction, owner.userId); entered();
      ({ childId } = await completeRootAndInsertChild(started.run.runId, transaction));
      await releaseBarrier;
    });
    await enteredBarrier;
    const control = service.control({ userId: owner.userId, requestId: randomUUID(), runId: started.run.runId, command: { commandId: randomUUID(), action: "pause" } });
    try {
      await waitUntilAConnectionIsWaitingForAccountAdvisoryLock(observerDatabase);
      release(); await transition;
      await expect(control).resolves.toMatchObject({ applied: true, run: { status: "paused", currentStage: "deep_matching" } });
      await expect(database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, childId))).resolves.toEqual([{ status: "paused" }]);
      await database.update(agentRuns).set({ status: "completed", currentStep: "completed", startedAt: now, completedAt: now, terminationKind: "completed", updatedAt: now }).where(eq(agentRuns.id, childId));
      await database.update(agentRunSteps).set({ status: "completed", startedAt: now, completedAt: now }).where(eq(agentRunSteps.runId, childId));
      await expect(service.control({ userId: owner.userId, requestId: randomUUID(), runId: started.run.runId, command: { commandId: randomUUID(), action: "resume" } })).rejects.toThrow("RECOMMENDATION_RUN_CONTROL_CONFLICT");
    } finally {
      release();
      await Promise.allSettled([transition, control]);
      await observerDatabase.$client.end();
    }
  });

  it("持久化的根完成而缺少子运行时读取稳定交接失败投影", async () => {
    const owner = await account(); const service = commands(owner.fingerprint); const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    await database.update(agentRuns).set({ status: "completed", currentStep: "completed", startedAt: now, completedAt: now, terminationKind: "completed", updatedAt: now }).where(eq(agentRuns.id, started.run.runId));
    await database.update(agentRunSteps).set({ status: "completed", startedAt: now, completedAt: now }).where(eq(agentRunSteps.runId, started.run.runId));
    await expect(createRecommendationRunQueries({ db: database }).get({ userId: owner.userId, runId: started.run.runId })).resolves.toMatchObject({ status: "failed", currentStage: "qualification", failure: { code: "RECOMMENDATION_HANDOFF_FAILED", stage: "qualification", retryable: false, suggestedActions: [] } });
  });

  it("逻辑失败只采用同一物理根的持久来源能力诊断", async () => {
    const owner = await account(); const service = commands(owner.fingerprint);
    const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    await database.update(agentRuns).set({ status: "failed", currentStep: "failed", startedAt: now, failedAt: now, failureCode: "AGENT_RUN_ADAPTER_FAILED", terminationKind: "source_failed", usageComplete: true, updatedAt: now }).where(eq(agentRuns.id, started.run.runId));
    await database.update(agentRunSteps).set({ status: "failed", startedAt: now, failedAt: now, failureCode: "AGENT_RUN_ADAPTER_FAILED" }).where(and(eq(agentRunSteps.runId, started.run.runId), eq(agentRunSteps.stepKey, "batch_search")));
    await database.insert(jobDiscoverySourceIssues).values({ id: randomUUID(), userId: owner.userId, runId: started.run.runId, provider: "greenhouse", code: "SOURCE_CAPABILITY_UNSUPPORTED", affectedCount: 1, createdAt: now });
    await expect(createRecommendationRunQueries({ db: database }).get({ userId: owner.userId, runId: started.run.runId })).resolves.toMatchObject({
      failure: { code: "AGENT_RUN_ADAPTER_FAILED", retryable: false, suggestedActions: ["review_source_health"] },
    });
  });

  it("B2 可信空结果 Inbox 只投影 owner-bound result、root 与 target", async () => {
    const owner = await account(); const service = commands(owner.fingerprint);
    const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    const { root, childId } = await completeRootAndInsertChild(started.run.runId);
    const resultId = randomUUID(); const itemId = randomUUID();
    await database.insert(recommendationResults).values({ id: resultId, userId: owner.userId, targetId: owner.targetId, rootRunId: root.id, producerRunId: childId, kind: "no_recommendations", recommendationListId: null, itemCount: 0, evidence: resultEvidence(root, 0), createdAt: now });
    await database.insert(agentInboxItems).values({ id: itemId, userId: owner.userId, recommendationResultId: resultId, kind: "recommendation_result", status: "unread", reasonCode: "NO_RECOMMENDATIONS_PUBLISHED", budgetDimension: null, createdAt: now });
    const inbox = createAgentInbox({ db: database, commands: {} as never, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now });
    await expect(inbox.list({ userId: owner.userId, status: "pending" })).resolves.toMatchObject({ items: [{
      itemId, runId: null, kind: "recommendation_result", retryable: false, suggestedActions: [],
      target: { type: "recommendation_result", recommendationResultId: resultId, rootRunId: root.id, targetId: owner.targetId, href: `/recommendations?runId=${root.id}&resultId=${resultId}#recommendation-result` },
    }] });
  });

  it("推荐 child 失败保留物理归属、链接逻辑 root，并拒绝伪造 restart", async () => {
    const owner = await account(); const service = commands(owner.fingerprint);
    const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    const { root, childId } = await completeRootAndInsertChild(started.run.runId);
    await database.update(agentRuns).set({ status: "failed", currentStep: "failed", startedAt: now, failedAt: now, failureCode: "AGENT_RUN_MODEL_AUTH_FAILED", terminationKind: "source_failed", usageComplete: true }).where(eq(agentRuns.id, childId));
    const itemId = randomUUID();
    await database.insert(agentInboxItems).values({ id: itemId, userId: owner.userId, runId: childId, triggerEventSequence: 1, kind: "run_failed", status: "unread", reasonCode: "AGENT_RUN_MODEL_AUTH_FAILED", budgetDimension: null, createdAt: now });
    const inbox = createAgentInbox({ db: database, commands: {} as never, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now });
    await expect(inbox.list({ userId: owner.userId, status: "pending" })).resolves.toMatchObject({ items: [{
      itemId, runId: childId, retryable: false, suggestedActions: ["run_model_diagnostic"], availableActions: ["mark_read", "dismiss"],
      target: { type: "recommendation_run", physicalRunId: childId, rootRunId: root.id, targetId: owner.targetId, href: `/home?runId=${root.id}#recommendation-run` },
    }] });
    await expect(inbox.act({ userId: owner.userId, requestId: randomUUID(), itemId, command: { actionId: randomUUID(), action: "restart_run" } })).rejects.toMatchObject({ code: "AGENT_INBOX_ACTION_CONFLICT" });
    await expect(database.select().from(agentInboxItemActions).where(eq(agentInboxItemActions.itemId, itemId))).resolves.toEqual([]);
    const pendingActionId = randomUUID();
    await database.insert(agentInboxItemActions).values({ id: randomUUID(), userId: owner.userId, itemId, actionId: pendingActionId, action: "restart_run", outcome: "pending", relatedRunId: null, reasonCode: null, createdAt: now });
    await expect(inbox.act({ userId: owner.userId, requestId: randomUUID(), itemId, command: { actionId: pendingActionId, action: "restart_run" } })).rejects.toMatchObject({ code: "AGENT_INBOX_ACTION_CONFLICT" });
    await expect(database.select({ outcome: agentInboxItemActions.outcome }).from(agentInboxItemActions).where(and(eq(agentInboxItemActions.itemId, itemId), eq(agentInboxItemActions.actionId, pendingActionId)))).resolves.toEqual([{ outcome: "pending" }]);
  });

  it("合法的清单与暂无推荐结果均能由 get、latest 与启动重放投影", async () => {
    const noRecommendationsOwner = await account(); const noRecommendationsService = commands(noRecommendationsOwner.fingerprint); const noRecommendationsKey = randomUUID();
    const noRecommendationsStarted = await noRecommendationsService.start({ userId: noRecommendationsOwner.userId, requestId: randomUUID(), command: await command(noRecommendationsOwner, noRecommendationsKey) });
    const noRecommendationsFacts = await completeRootAndInsertChild(noRecommendationsStarted.run.runId);
    await database.update(agentRuns).set({ status: "completed", currentStep: "completed", startedAt: now, completedAt: now, terminationKind: "completed", updatedAt: now }).where(eq(agentRuns.id, noRecommendationsFacts.childId));
    await database.update(agentRunSteps).set({ status: "completed", startedAt: now, completedAt: now }).where(eq(agentRunSteps.runId, noRecommendationsFacts.childId));
    await database.insert(recommendationResults).values({ id: randomUUID(), userId: noRecommendationsOwner.userId, targetId: noRecommendationsOwner.targetId, rootRunId: noRecommendationsStarted.run.runId, producerRunId: noRecommendationsFacts.childId, kind: "no_recommendations", recommendationListId: null, itemCount: 0, evidence: resultEvidence(noRecommendationsFacts.root, 0), createdAt: now });
    const noRecommendationsQueries = createRecommendationRunQueries({ db: database });
    await expect(noRecommendationsQueries.get({ userId: noRecommendationsOwner.userId, runId: noRecommendationsStarted.run.runId })).resolves.toMatchObject({ status: "completed", result: { kind: "no_recommendations" } });
    await expect(noRecommendationsQueries.latest({ userId: noRecommendationsOwner.userId })).resolves.toMatchObject({ runId: noRecommendationsStarted.run.runId, result: { kind: "no_recommendations" } });
    await expect(noRecommendationsService.start({ userId: noRecommendationsOwner.userId, requestId: randomUUID(), command: await command(noRecommendationsOwner, noRecommendationsKey) })).resolves.toMatchObject({ reused: true, run: { result: { kind: "no_recommendations" } } });

    const listOwner = await account(); const listService = commands(listOwner.fingerprint); const listKey = randomUUID();
    const listStarted = await listService.start({ userId: listOwner.userId, requestId: randomUUID(), command: await command(listOwner, listKey) });
    const listFacts = await completeRootAndInsertChild(listStarted.run.runId); const listId = randomUUID();
    await database.update(agentRuns).set({ status: "completed", currentStep: "completed", startedAt: now, completedAt: now, terminationKind: "completed", updatedAt: now }).where(eq(agentRuns.id, listFacts.childId));
    await database.update(agentRunSteps).set({ status: "completed", startedAt: now, completedAt: now }).where(eq(agentRunSteps.runId, listFacts.childId));
    await database.insert(recommendationLists).values({ id: listId, userId: listOwner.userId, targetId: listOwner.targetId, localDate: "2026-09-13", sequence: 1, createdAt: now });
    await insertRecommendationListItem(listOwner, listId);
    await database.insert(recommendationResults).values({ id: listId, userId: listOwner.userId, targetId: listOwner.targetId, rootRunId: listStarted.run.runId, producerRunId: listFacts.childId, kind: "recommendation_list", recommendationListId: listId, itemCount: 1, evidence: resultEvidence(listFacts.root, 1), createdAt: now });
    const listQueries = createRecommendationRunQueries({ db: database });
    await expect(listQueries.get({ userId: listOwner.userId, runId: listStarted.run.runId })).resolves.toMatchObject({ status: "completed", result: { kind: "recommendation_list", resultId: listId, recommendationListId: listId, itemCount: 1 } });
    await expect(listQueries.latest({ userId: listOwner.userId })).resolves.toMatchObject({ runId: listStarted.run.runId, result: { kind: "recommendation_list", recommendationListId: listId } });
    await expect(listService.start({ userId: listOwner.userId, requestId: randomUUID(), command: await command(listOwner, listKey) })).resolves.toMatchObject({ reused: true, run: { result: { kind: "recommendation_list", recommendationListId: listId } } });
  });

  it("latestPublished 在新的未发布 root 出现后仍读取最近已发布结果", async () => {
    const owner = await account();
    const service = commands(owner.fingerprint);
    const published = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    const publishedFacts = await completeRootAndInsertChild(published.run.runId);
    await database.update(agentRuns).set({ status: "completed", currentStep: "completed", startedAt: now, completedAt: now, terminationKind: "completed", updatedAt: now }).where(eq(agentRuns.id, publishedFacts.childId));
    await database.update(agentRunSteps).set({ status: "completed", startedAt: now, completedAt: now }).where(eq(agentRunSteps.runId, publishedFacts.childId));
    await database.insert(recommendationResults).values({ id: randomUUID(), userId: owner.userId, targetId: owner.targetId, rootRunId: published.run.runId, producerRunId: publishedFacts.childId, kind: "no_recommendations", recommendationListId: null, itemCount: 0, evidence: resultEvidence(publishedFacts.root, 0), createdAt: now });
    await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });

    await expect(createRecommendationRunQueries({ db: database }).latestPublished({ userId: owner.userId }))
      .resolves.toMatchObject({ runId: published.run.runId, result: { kind: "no_recommendations" } });
  });

  it("latestPublished 对无结果、不同 owner 与账户停止/解除保持只读语义", async () => {
    const owner = await account(); const other = await account(); const service = commands(owner.fingerprint);
    const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    const queries = createRecommendationRunQueries({ db: database });
    await expect(queries.latestPublished({ userId: owner.userId })).resolves.toBeNull();
    const facts = await completeRootAndInsertChild(started.run.runId);
    await database.update(agentRuns).set({ status: "completed", currentStep: "completed", startedAt: now, completedAt: now, terminationKind: "completed", updatedAt: now }).where(eq(agentRuns.id, facts.childId));
    await database.update(agentRunSteps).set({ status: "completed", startedAt: now, completedAt: now }).where(eq(agentRunSteps.runId, facts.childId));
    await database.insert(recommendationResults).values({ id: randomUUID(), userId: owner.userId, targetId: owner.targetId, rootRunId: started.run.runId, producerRunId: facts.childId, kind: "no_recommendations", recommendationListId: null, itemCount: 0, evidence: resultEvidence(facts.root, 0), createdAt: now });
    const control = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now });
    await control.control({ userId: owner.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 0, action: "stop" } });
    await expect(queries.latestPublished({ userId: owner.userId })).resolves.toMatchObject({ runId: started.run.runId });
    await expect(queries.latestPublished({ userId: other.userId })).resolves.toBeNull();
    await control.control({ userId: owner.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 1, action: "release" } });
    await expect(queries.latestPublished({ userId: owner.userId })).resolves.toMatchObject({ runId: started.run.runId });
  });

  it.each(["running", "failed"] as const)("latestPublished 不被新的 %s root 遮蔽", async (status) => {
    const owner = await account(); const service = commands(owner.fingerprint); const first = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) }); const facts = await completeRootAndInsertChild(first.run.runId);
    await database.update(agentRuns).set({ status: "completed", currentStep: "completed", startedAt: now, completedAt: now, terminationKind: "completed", updatedAt: now }).where(eq(agentRuns.id, facts.childId)); await database.update(agentRunSteps).set({ status: "completed", startedAt: now, completedAt: now }).where(eq(agentRunSteps.runId, facts.childId));
    await database.insert(recommendationResults).values({ id: randomUUID(), userId: owner.userId, targetId: owner.targetId, rootRunId: first.run.runId, producerRunId: facts.childId, kind: "no_recommendations", recommendationListId: null, itemCount: 0, evidence: resultEvidence(facts.root, 0), createdAt: new Date("2026-09-13T12:00:00.000Z") });
    const next = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    if (status === "failed") await database.update(agentRuns).set({ status: "failed", currentStep: "failed", startedAt: new Date("2026-09-14T11:00:00.000Z"), failedAt: new Date("2026-09-14T12:00:00.000Z"), failureCode: "AGENT_RUN_ADAPTER_FAILED", terminationKind: "source_failed", usageComplete: true, updatedAt: new Date("2026-09-14T12:00:00.000Z") }).where(eq(agentRuns.id, next.run.runId));
    else await database.update(agentRuns).set({ status: "running", startedAt: new Date("2026-09-14T12:00:00.000Z"), updatedAt: new Date("2026-09-14T12:00:00.000Z") }).where(eq(agentRuns.id, next.run.runId));
    await expect(createRecommendationRunQueries({ db: database }).latestPublished({ userId: owner.userId })).resolves.toMatchObject({ runId: first.run.runId });
  });

  it.each(["running", "paused", "failed", "cancelled", "completed"] as const)("公开 get 为 create_recommendations 的 %s 持久事实输出严格闭合投影", async (publicationStatus) => {
    const owner = await account(); const service = commands(owner.fingerprint); const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    const { childId } = await completeRootAndInsertChild(started.run.runId);
    await database.update(agentRunSteps).set({ status: "completed", startedAt: now, completedAt: now }).where(and(eq(agentRunSteps.runId, childId), sql`${agentRunSteps.stepKey} in ('select_candidates', 'assess_matches')`));
    if (publicationStatus === "running" || publicationStatus === "paused") {
      await database.update(agentRuns).set({ status: publicationStatus, currentStep: "create_recommendations", startedAt: now, updatedAt: now }).where(eq(agentRuns.id, childId));
      await database.update(agentRunSteps).set({ status: "running", startedAt: now }).where(and(eq(agentRunSteps.runId, childId), eq(agentRunSteps.stepKey, "create_recommendations")));
    } else if (publicationStatus === "failed") {
      await database.update(agentRuns).set({ status: "failed", currentStep: "failed", startedAt: now, failedAt: now, failureCode: "AGENT_RUN_PERSIST_FAILED", terminationKind: "persistence_failed", usageComplete: true, updatedAt: now }).where(eq(agentRuns.id, childId));
      await database.update(agentRunSteps).set({ status: "failed", startedAt: now, failedAt: now }).where(and(eq(agentRunSteps.runId, childId), eq(agentRunSteps.stepKey, "create_recommendations")));
    } else if (publicationStatus === "cancelled") {
      await database.update(agentRuns).set({ status: "cancelled", currentStep: "cancelled", cancelledAt: now, updatedAt: now }).where(eq(agentRuns.id, childId));
    } else {
      await database.update(agentRuns).set({ status: "completed", currentStep: "completed", startedAt: now, completedAt: now, terminationKind: "completed", updatedAt: now }).where(eq(agentRuns.id, childId));
      await database.update(agentRunSteps).set({ status: "completed", startedAt: now, completedAt: now }).where(and(eq(agentRunSteps.runId, childId), eq(agentRunSteps.stepKey, "create_recommendations")));
    }
    const run = await createRecommendationRunQueries({ db: database }).get({ userId: owner.userId, runId: started.run.runId });
    expect(run).not.toBeNull();
    expect(run!.stages.map((stage) => stage.status)).toEqual(publicationStatus === "running" || publicationStatus === "paused"
      ? ["completed", "completed", "completed", "completed", "running"]
      : publicationStatus === "failed" || publicationStatus === "completed"
        ? ["completed", "completed", "completed", "completed", "failed"]
        : ["completed", "completed", "completed", "completed", "cancelled"]);
    if (publicationStatus === "running" || publicationStatus === "paused") expect(run).toMatchObject({ status: publicationStatus, currentStage: "result_publication", failure: null });
    if (publicationStatus === "failed") expect(run).toMatchObject({ status: "failed", currentStage: "result_publication", failure: { code: "AGENT_RUN_PERSIST_FAILED", stage: "result_publication" } });
    if (publicationStatus === "cancelled") expect(run).toMatchObject({ status: "cancelled", currentStage: null, failure: null });
    if (publicationStatus === "completed") expect(run).toMatchObject({ status: "failed", currentStage: "result_publication", failure: { code: "RECOMMENDATION_PUBLICATION_FAILED", stage: "result_publication" } });
  });

  it("恢复后的 queued root 保留已开始 discovery 阶段", async () => {
    const owner = await account(); const service = commands(owner.fingerprint); const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    await database.update(agentRuns).set({ status: "paused", currentStep: "fetch_details", startedAt: now, updatedAt: now }).where(eq(agentRuns.id, started.run.runId));
    await database.update(agentRunSteps).set({ status: "completed", startedAt: now, completedAt: now }).where(and(eq(agentRunSteps.runId, started.run.runId), eq(agentRunSteps.stepKey, "batch_search")));
    const resumed = await service.control({ userId: owner.userId, requestId: randomUUID(), runId: started.run.runId, command: { commandId: randomUUID(), action: "resume" } });
    expect(resumed).toMatchObject({ applied: true, run: { status: "running", currentStage: "discovery" } });
    expect(resumed.run.stages).toContainEqual(expect.objectContaining({ key: "discovery", status: "running" }));
  });

  it.each(["fake", "greenhouse", "layered_public"] as const)("%s 模式中 prepare 后账户停止会阻止新启动且不创建运行", async (mode) => {
    const owner = await account();
    const preflight = createRunPreflightEvaluator({ capabilityAdapter, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: owner.fingerprint }), discoveryExecutionMode: mode, id: randomUUID, clock: () => now });
    const service = createRecommendationRunCommands({ db: database, queue: { enqueue: async () => undefined }, auditTrail: createAuditTrail({ db: database, clock: () => now }), runPreflight: preflight, executionMode: mode, id: randomUUID, clock: () => now });
    const preparedCommand = await command(owner, randomUUID(), mode);
    await createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now }).control({ userId: owner.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 0, action: "stop" } });
    await expect(service.start({ userId: owner.userId, requestId: randomUUID(), command: preparedCommand })).rejects.toThrow("RUN_PREFLIGHT_BLOCKED");
    await expect(Promise.all([database.select().from(agentRuns).where(eq(agentRuns.userId, owner.userId)), database.select().from(recommendationRunStartCommands).where(eq(recommendationRunStartCommands.userId, owner.userId))])).resolves.toEqual([[], []]);
  });

  it("停止后仅旧启动键可重放，释放不自动恢复且可显式恢复", async () => {
    const owner = await account(); const enqueued: string[] = [];
    const preflight = createRunPreflightEvaluator({ capabilityAdapter, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: owner.fingerprint }), discoveryExecutionMode: "layered_public", id: randomUUID, clock: () => now });
    const service = createRecommendationRunCommands({ db: database, queue: { enqueue: async (job) => { enqueued.push(job.runId); } }, auditTrail: createAuditTrail({ db: database, clock: () => now }), runPreflight: preflight, executionMode: "layered_public", id: randomUUID, clock: () => now });
    const oldKey = randomUUID(); const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, oldKey) });
    const accountControl = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now });
    await accountControl.control({ userId: owner.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 0, action: "stop" } });
    await expect(service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, oldKey) })).resolves.toMatchObject({ reused: true, run: { runId: started.run.runId, status: "paused" } });
    await expect(service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) })).rejects.toThrow("RUN_PREFLIGHT_BLOCKED");
    await accountControl.control({ userId: owner.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 1, action: "release" } });
    await expect(database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, started.run.runId))).resolves.toEqual([{ status: "paused" }]);
    await expect(service.control({ userId: owner.userId, requestId: randomUUID(), runId: started.run.runId, command: { commandId: randomUUID(), action: "resume" } })).resolves.toMatchObject({ applied: true, run: { status: "queued", currentStage: "discovery" } });
    expect(enqueued).toEqual([started.run.runId, started.run.runId]);
  });

  it("同一控制键的不同动作稳定冲突且不重放物理控制", async () => {
    const owner = await account(); const service = commands(owner.fingerprint); const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) }); const commandId = randomUUID();
    await service.control({ userId: owner.userId, requestId: randomUUID(), runId: started.run.runId, command: { commandId, action: "pause" } });
    await expect(service.control({ userId: owner.userId, requestId: randomUUID(), runId: started.run.runId, command: { commandId, action: "resume" } })).rejects.toThrow("RECOMMENDATION_RUN_COMMAND_ID_CONFLICT");
    await expect(database.select().from(agentRunControlCommands).where(and(eq(agentRunControlCommands.runId, started.run.runId), eq(agentRunControlCommands.commandId, commandId)))).resolves.toHaveLength(1);
  });

  it("只投影所属账户的 recommendation 根运行", async () => {
    const owner = await account(); const other = await account(); const started = await commands(owner.fingerprint).start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    const queries = createRecommendationRunQueries({ db: database });
    await expect(queries.get({ userId: other.userId, runId: started.run.runId })).resolves.toBeNull();
    await expect(queries.get({ userId: owner.userId, runId: started.run.runId })).resolves.toMatchObject({ runId: started.run.runId });
    await expect(queries.latest({ userId: owner.userId })).resolves.toMatchObject({ runId: started.run.runId });
  });

  it("推荐失败 Inbox restart 创建新的 recommendation root，重放不写 legacy retry 关联", async () => {
    const owner = await account();
    const service = commands(owner.fingerprint);
    const original = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    await database.update(agentRuns).set({ status: "failed", currentStep: "failed", startedAt: now, completedAt: null, failedAt: now, failureCode: "AGENT_RUN_ADAPTER_RETRYABLE", terminationKind: "source_failed", usageComplete: true }).where(eq(agentRuns.id, original.run.runId));
    const itemId = randomUUID();
    await database.insert(agentInboxItems).values({ id: itemId, userId: owner.userId, runId: original.run.runId, triggerEventSequence: 1, kind: "run_failed", status: "unread", reasonCode: "AGENT_RUN_ADAPTER_RETRYABLE", budgetDimension: null, createdAt: now });
    const inbox = createAgentInbox({
      db: database,
      commands: {
        async start() { throw new Error("legacy start must not run for recommendation Inbox"); },
        async control() { throw new Error("legacy control must not run for recommendation restart"); },
      },
      recommendationCommands: service,
      auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now,
    });
    const actionId = randomUUID();
    const warningFingerprint = (await command(owner, randomUUID())).warningFingerprint;

    const first = await inbox.act({ userId: owner.userId, requestId: randomUUID(), itemId, command: { actionId, action: "restart_run", warningFingerprint } });
    const replay = await inbox.act({ userId: owner.userId, requestId: randomUUID(), itemId, command: { actionId, action: "restart_run", warningFingerprint } });

    expect(first).toMatchObject({ applied: true, item: { status: "resolved" }, run: { status: "queued" } });
    expect(replay).toEqual(first);
    expect(first.run!.runId).not.toBe(original.run.runId);
    await expect(database.select({ id: agentRuns.id, runPurpose: agentRuns.runPurpose, retryOfRunId: agentRuns.retryOfRunId }).from(agentRuns).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.id, first.run!.runId)))).resolves.toEqual([{ id: first.run!.runId, runPurpose: "recommendation", retryOfRunId: null }]);
    await expect(database.select().from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, owner.userId), eq(agentInboxItemActions.itemId, itemId), eq(agentInboxItemActions.actionId, actionId)))).resolves.toHaveLength(1);
  });

  it("推荐 restart 命中活动 child alias 时不改任一 physical retryOfRunId", async () => {
    const owner = await account(); const service = commands(owner.fingerprint);
    const failed = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    await database.update(agentRuns).set({ status: "failed", currentStep: "failed", startedAt: now, failedAt: now, failureCode: "AGENT_RUN_ADAPTER_RETRYABLE", terminationKind: "source_failed", usageComplete: true }).where(eq(agentRuns.id, failed.run.runId));
    const active = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    const { childId } = await completeRootAndInsertChild(active.run.runId);
    const itemId = randomUUID();
    await database.insert(agentInboxItems).values({ id: itemId, userId: owner.userId, runId: failed.run.runId, triggerEventSequence: 1, kind: "run_failed", status: "unread", reasonCode: "AGENT_RUN_ADAPTER_RETRYABLE", budgetDimension: null, createdAt: now });
    const inbox = createAgentInbox({ db: database, commands: { async start() { throw new Error("legacy start must not run for recommendation Inbox"); }, async control() { throw new Error("legacy control must not run for recommendation restart"); } }, recommendationCommands: service, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now });
    const physicalBefore = await database.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.userId, owner.userId)).orderBy(agentRuns.id);

    const response = await inbox.act({ userId: owner.userId, requestId: randomUUID(), itemId, command: { actionId: randomUUID(), action: "restart_run", warningFingerprint: (await command(owner, randomUUID())).warningFingerprint } });

    expect(response).toMatchObject({ applied: true, run: { runId: active.run.runId } });
    await expect(database.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.userId, owner.userId)).orderBy(agentRuns.id)).resolves.toEqual(physicalBefore);
    await expect(database.select({ id: agentRuns.id, retryOfRunId: agentRuns.retryOfRunId }).from(agentRuns).where(and(eq(agentRuns.userId, owner.userId), inArray(agentRuns.id, [active.run.runId, childId]))).orderBy(agentRuns.id)).resolves.toEqual([{ id: childId, retryOfRunId: null }, { id: active.run.runId, retryOfRunId: null }].sort((left, right) => left.id.localeCompare(right.id)));
  });

  it("推荐 restart 被账户停止预检拒绝时释放同一 actionId，恢复后可重新启动", async () => {
    const owner = await account(); const service = commands(owner.fingerprint);
    const original = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    await database.update(agentRuns).set({ status: "failed", currentStep: "failed", startedAt: now, failedAt: now, failureCode: "AGENT_RUN_ADAPTER_RETRYABLE", terminationKind: "source_failed", usageComplete: true }).where(eq(agentRuns.id, original.run.runId));
    const itemId = randomUUID();
    await database.insert(agentInboxItems).values({ id: itemId, userId: owner.userId, runId: original.run.runId, triggerEventSequence: 1, kind: "run_failed", status: "unread", reasonCode: "AGENT_RUN_ADAPTER_RETRYABLE", budgetDimension: null, createdAt: now });
    const inbox = createAgentInbox({ db: database, commands: { async start() { throw new Error("legacy start must not run for recommendation Inbox"); }, async control() { throw new Error("legacy control must not run for recommendation restart"); } }, recommendationCommands: service, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now });
    const accountControl = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now });
    await accountControl.control({ userId: owner.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 0, action: "stop" } });
    const actionId = randomUUID();

    await expect(inbox.act({ userId: owner.userId, requestId: randomUUID(), itemId, command: { actionId, action: "restart_run" } })).rejects.toMatchObject({ code: "RUN_PREFLIGHT_BLOCKED" });
    await expect(database.select().from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, owner.userId), eq(agentInboxItemActions.itemId, itemId), eq(agentInboxItemActions.actionId, actionId)))).resolves.toEqual([]);
    await accountControl.control({ userId: owner.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 1, action: "release" } });
    await expect(inbox.act({ userId: owner.userId, requestId: randomUUID(), itemId, command: { actionId, action: "restart_run", warningFingerprint: (await command(owner, randomUUID())).warningFingerprint } })).resolves.toMatchObject({ applied: true, item: { status: "resolved" }, run: { status: "queued" } });
  });

  it("推荐 restart 的 warning 确认释放同一 actionId，携 fingerprint 后创建完整推荐", async () => {
    const owner = await account(); const service = commands(owner.fingerprint);
    const original = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    await database.update(agentRuns).set({ status: "failed", currentStep: "failed", startedAt: now, failedAt: now, failureCode: "AGENT_RUN_ADAPTER_RETRYABLE", terminationKind: "source_failed", usageComplete: true }).where(eq(agentRuns.id, original.run.runId));
    const itemId = randomUUID();
    await database.insert(agentInboxItems).values({ id: itemId, userId: owner.userId, runId: original.run.runId, triggerEventSequence: 1, kind: "run_failed", status: "unread", reasonCode: "AGENT_RUN_ADAPTER_RETRYABLE", budgetDimension: null, createdAt: now });
    const inbox = createAgentInbox({ db: database, commands: { async start() { throw new Error("legacy start must not run for recommendation Inbox"); }, async control() { throw new Error("legacy control must not run for recommendation restart"); } }, recommendationCommands: service, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now });
    const actionId = randomUUID();

    await expect(inbox.act({ userId: owner.userId, requestId: randomUUID(), itemId, command: { actionId, action: "restart_run" } })).rejects.toMatchObject({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED" });
    await expect(database.select().from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, owner.userId), eq(agentInboxItemActions.itemId, itemId), eq(agentInboxItemActions.actionId, actionId)))).resolves.toEqual([]);
    await expect(inbox.act({ userId: owner.userId, requestId: randomUUID(), itemId, command: { actionId, action: "restart_run", warningFingerprint: (await command(owner, randomUUID())).warningFingerprint } })).resolves.toMatchObject({ applied: true, item: { status: "resolved" }, run: { status: "queued" } });
  });

  it("推荐命令冲突只释放自身 pending restart claim，不删除其他事项或已结算 action", async () => {
    const owner = await account(); const service = commands(owner.fingerprint);
    const original = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    await database.update(agentRuns).set({ status: "failed", currentStep: "failed", startedAt: now, failedAt: now, failureCode: "AGENT_RUN_ADAPTER_RETRYABLE", terminationKind: "source_failed", usageComplete: true }).where(eq(agentRuns.id, original.run.runId));
    const itemId = randomUUID(); const otherItemId = randomUUID(); const settledActionId = randomUUID(); const otherActionId = randomUUID();
    await database.insert(agentInboxItems).values([
      { id: itemId, userId: owner.userId, runId: original.run.runId, triggerEventSequence: 1, kind: "run_failed", status: "unread", reasonCode: "AGENT_RUN_ADAPTER_RETRYABLE", budgetDimension: null, createdAt: now },
      { id: otherItemId, userId: owner.userId, runId: original.run.runId, triggerEventSequence: 2, kind: "run_failed", status: "unread", reasonCode: "AGENT_RUN_ADAPTER_RETRYABLE", budgetDimension: null, createdAt: now },
    ]);
    await database.insert(agentInboxItemActions).values([
      { id: randomUUID(), userId: owner.userId, itemId, actionId: settledActionId, action: "mark_read", outcome: "applied", relatedRunId: null, reasonCode: "AGENT_RUN_ADAPTER_RETRYABLE", createdAt: now },
      { id: randomUUID(), userId: owner.userId, itemId: otherItemId, actionId: otherActionId, action: "restart_run", outcome: "pending", relatedRunId: null, reasonCode: null, createdAt: now },
    ]);
    const inbox = createAgentInbox({ db: database, commands: { async start() { throw new Error("legacy start must not run for recommendation Inbox"); }, async control() { throw new Error("legacy control must not run for recommendation restart"); } }, recommendationCommands: { async start() { throw new RecommendationRunError("RECOMMENDATION_RUN_COMMAND_ID_CONFLICT"); } }, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now });
    const actionId = randomUUID();

    await expect(inbox.act({ userId: owner.userId, requestId: randomUUID(), itemId, command: { actionId, action: "restart_run" } })).rejects.toMatchObject({ code: "RECOMMENDATION_RUN_COMMAND_ID_CONFLICT" });
    await expect(database.select({ itemId: agentInboxItemActions.itemId, actionId: agentInboxItemActions.actionId, outcome: agentInboxItemActions.outcome }).from(agentInboxItemActions).where(eq(agentInboxItemActions.userId, owner.userId)).orderBy(agentInboxItemActions.itemId, agentInboxItemActions.actionId)).resolves.toEqual([
      { itemId, actionId: settledActionId, outcome: "applied" },
      { itemId: otherItemId, actionId: otherActionId, outcome: "pending" },
    ].sort((left, right) => `${left.itemId}:${left.actionId}`.localeCompare(`${right.itemId}:${right.actionId}`)));
  });

  it("历史推荐暂停事项始终控制原 physical root，不迁移到后续 child", async () => {
    const owner = await account(); const service = commands(owner.fingerprint);
    const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    const { childId } = await completeRootAndInsertChild(started.run.runId);
    const itemId = randomUUID();
    await database.insert(agentInboxItems).values({ id: itemId, userId: owner.userId, runId: started.run.runId, triggerEventSequence: 1, kind: "decision_required", status: "unread", reasonCode: "AGENT_RUN_PAUSED", budgetDimension: null, createdAt: now });
    const legacyCommands = createAgentRunCommands({ db: database, queue: { enqueue: async () => undefined }, auditTrail: createAuditTrail({ db: database, clock: () => now }), runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }), id: randomUUID, clock: () => now });
    const inbox = createAgentInbox({ db: database, commands: legacyCommands, recommendationCommands: service, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now });

    await expect(inbox.act({ userId: owner.userId, requestId: randomUUID(), itemId, command: { actionId: randomUUID(), action: "resume_run" } })).rejects.toMatchObject({ code: "AGENT_INBOX_ACTION_FAILED" });
    await expect(database.select({ status: agentRuns.status, version: agentRuns.version }).from(agentRuns).where(eq(agentRuns.id, childId))).resolves.toEqual([{ status: "queued", version: 1 }]);
  });
});
