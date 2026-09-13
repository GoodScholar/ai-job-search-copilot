import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, desc, eq } from "drizzle-orm";
import { agentRunControlCommands, agentRunEvents, agentRunSteps, agentRuns, auditEvents, createDatabase, jobAccounts, jobProfiles, jobTargets, jobTargetRevisions, migrateDatabase, modelDiagnosticResults, profileFactRevisions, profileFacts, recommendationRunControlCommands, recommendationRunStartCommands, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createAccountRunControl } from "./account-run-control";
import { createModelDiagnosticProjectionReader, createRunPreflightEvaluator } from "./run-preflight";
import { createRecommendationRunCommands, createRecommendationRunQueries } from "./recommendation-runs";
import { createAgentRunRecoveryQueries } from "./agent-run-processor";
import type { SourceCapabilityAdapter } from "./source-capabilities";

const now = new Date("2026-09-13T12:00:00.000Z");
const constraints = { roleFamily: "AI 应用工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } };
const capabilityAdapter: SourceCapabilityAdapter = { adapter: "greenhouse", adapterVersion: "test-v1", declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test-v1", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring"] }) };

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
    return { userId, targetId, fingerprint };
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

  it("持久化的根完成而缺少子运行时读取稳定交接失败投影", async () => {
    const owner = await account(); const service = commands(owner.fingerprint); const started = await service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    await database.update(agentRuns).set({ status: "completed", currentStep: "completed", startedAt: now, completedAt: now, terminationKind: "completed", updatedAt: now }).where(eq(agentRuns.id, started.run.runId));
    await database.update(agentRunSteps).set({ status: "completed", startedAt: now, completedAt: now }).where(eq(agentRunSteps.runId, started.run.runId));
    await expect(createRecommendationRunQueries({ db: database }).get({ userId: owner.userId, runId: started.run.runId })).resolves.toMatchObject({ status: "failed", currentStage: "qualification", failure: { code: "RECOMMENDATION_HANDOFF_FAILED", stage: "qualification", retryable: true } });
  });

  it.each(["fake", "greenhouse", "layered_public"] as const)("%s 模式中 prepare 后账户停止会阻止新启动且不创建运行", async (mode) => {
    const owner = await account();
    const preflight = createRunPreflightEvaluator({ capabilityAdapter, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: owner.fingerprint }), discoveryExecutionMode: mode, id: randomUUID, clock: () => now });
    const service = createRecommendationRunCommands({ db: database, queue: { enqueue: async () => undefined }, auditTrail: createAuditTrail({ db: database, clock: () => now }), runPreflight: preflight, executionMode: mode, id: randomUUID, clock: () => now });
    await createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now }).control({ userId: owner.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 0, action: "stop" } });
    await expect(service.start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID(), mode) })).rejects.toThrow("RUN_PREFLIGHT_BLOCKED");
    await expect(database.select().from(agentRuns).where(eq(agentRuns.userId, owner.userId))).resolves.toEqual([]);
  });

  it("只投影所属账户的 recommendation 根运行", async () => {
    const owner = await account(); const other = await account(); const started = await commands(owner.fingerprint).start({ userId: owner.userId, requestId: randomUUID(), command: await command(owner, randomUUID()) });
    const queries = createRecommendationRunQueries({ db: database });
    await expect(queries.get({ userId: other.userId, runId: started.run.runId })).resolves.toBeNull();
    await expect(queries.get({ userId: owner.userId, runId: started.run.runId })).resolves.toMatchObject({ runId: started.run.runId });
    await expect(queries.latest({ userId: owner.userId })).resolves.toMatchObject({ runId: started.run.runId });
  });
});
