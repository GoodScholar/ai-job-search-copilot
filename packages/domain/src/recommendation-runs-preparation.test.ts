import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import {
  companyWatchlistRevisions, companyWatchlists, createDatabase, jobAccounts, jobProfiles, jobTargets, jobTargetRevisions,
  migrateDatabase, modelDiagnosticResults, profileFactRevisions, profileFacts, type Database,
} from "@job-copilot/database";
import { systemAccountRunPolicy } from "@job-copilot/contracts/account-run-policies";
import { createAccountRunPolicies } from "./account-run-policies";
import { createAuditTrail } from "./audit-trail";
import { createAccountRunControl } from "./account-run-control";
import { createModelDiagnosticProjectionReader, createRunPreflightEvaluator } from "./run-preflight";
import { createRecommendationRunPreparationQueries, prepareRecommendationRunInTransaction } from "./recommendation-runs-preparation";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import type { SourceCapabilityAdapter } from "./source-capabilities";

const now = new Date("2026-09-13T12:00:00.000Z");
const constraints = {
  roleFamily: "AI 应用工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [],
  dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
};

const capabilityAdapter: SourceCapabilityAdapter = {
  adapter: "greenhouse", adapterVersion: "test-v1",
  declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test-v1", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring"] }),
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

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

describe("推荐运行准备", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);
  afterAll(async () => { await database?.$client.end(); await container?.stop(); });

  async function account() {
    const userId = randomUUID(); const targetId = randomUUID(); const profileId = randomUUID(); const factId = randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 2, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: randomUUID(), userId, targetId, version: 2, priority: "primary", state: "active", constraints, createdAt: now });
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 3, createdAt: now, updatedAt: now });
    await database.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
    await database.insert(profileFactRevisions).values({ id: randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "TypeScript" }, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 3, createdAt: now });
    const watchlistId = randomUUID(); const itemId = randomUUID();
    await database.insert(companyWatchlists).values({ id: watchlistId, userId, targetId, version: 1, createdAt: now, updatedAt: now });
    await database.insert(companyWatchlistRevisions).values({ id: randomUUID(), userId, watchlistId, targetId, version: 1, createdAt: now, items: [{ itemId, canonicalCompanyName: "Example", careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: "must-not-project", state: "enabled", position: 1 }] });
    const fingerprint = randomUUID();
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: now });
    return { userId, targetId, fingerprint };
  }

  function evaluator(mode: "fake" | "greenhouse" | "layered_public", fingerprint: string) {
    return createRunPreflightEvaluator({ capabilityAdapter, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }), discoveryExecutionMode: mode, id: randomUUID, clock: () => now });
  }

  it.each(["fake", "greenhouse", "layered_public"] as const)("%s 模式从冻结实际计划生成安全准备摘要与私有启动上下文", async (mode) => {
    const owner = await account();
    const runPreflight = evaluator(mode, owner.fingerprint);
    const queries = createRecommendationRunPreparationQueries({ db: database, runPreflight, executionMode: mode, id: randomUUID, clock: () => now });
    const preparation = await queries.prepare({ userId: owner.userId });
    const internal = await database.transaction((transaction) => prepareRecommendationRunInTransaction(transaction, { userId: owner.userId, executionMode: mode }, { runPreflight, id: randomUUID, clock: () => now }));

    expect(preparation).toMatchObject({ target: { targetId: owner.targetId, targetVersion: 2, roleFamily: "AI 应用工程师" }, preflight: { workflow: "recommendation", targetId: owner.targetId }, budgets: internal.recommendationContext!.budgets });
    expect(preparation.sourceScope).toEqual(mode === "layered_public"
      ? { trustedSourceCount: (internal.startSpec!.executionSpec.sourceScope as { trustedSources: unknown[] }).trustedSources.length, publicQueryCount: (internal.startSpec!.executionSpec.sourceScope as { publicDiscovery: { queries: unknown[] } }).publicDiscovery.queries.length }
      : { trustedSourceCount: (internal.startSpec!.executionSpec.sourceScope as { sources: unknown[] }).sources.length, publicQueryCount: 0 });
    expect(JSON.stringify(preparation)).not.toMatch(/profileId|profileVersion|must-not-project/);
    expect(internal.startSpec).toMatchObject({ targetId: owner.targetId, targetVersion: 2 });
    expect(internal.recommendationContext).toMatchObject({ version: "recommendation-context-v1", profile: { profileVersion: 3 }, preflight: preparation.preflight });
  });

  it.each(["fake", "greenhouse", "layered_public"] as const)("%s 模式在账户停止后将 recommendation 预检阻塞为唯一策略项", async (mode) => {
    const owner = await account();
    await createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now })
      .control({ userId: owner.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 0, action: "stop" } });
    const preparation = await createRecommendationRunPreparationQueries({ db: database, runPreflight: evaluator(mode, owner.fingerprint), executionMode: mode, id: randomUUID, clock: () => now }).prepare({ userId: owner.userId });

    expect(preparation.preflight.status).toBe("blocked");
    expect(preparation.preflight.items.filter((item) => item.code === "ACCOUNT_RUN_POLICY_BLOCKED")).toEqual([
      expect.objectContaining({ summary: "账户已停止全部运行", suggestedActions: ["review_account_run_policy"] }),
    ]);
    expect(preparation.preflight.items).toHaveLength(7);
  });

  it("缺少活动主目标时只返回阻塞的公开摘要，不构造私有启动输入", async () => {
    const userId = randomUUID(); const fingerprint = randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: now });
    const runPreflight = evaluator("fake", fingerprint);
    const result = await database.transaction((transaction) => prepareRecommendationRunInTransaction(transaction, { userId, executionMode: "fake" }, { runPreflight, id: randomUUID, clock: () => now }));

    expect(result).toMatchObject({ preparation: { target: null, preflight: { workflow: "recommendation", targetId: null, status: "blocked" }, sourceScope: { trustedSourceCount: 0, publicQueryCount: 0 } }, startSpec: null, recommendationContext: null });
    expect(result.preparation.preflight.items.map((item) => item.code)).toContain("PRIMARY_JOB_TARGET_MISSING");
  });

  it("没有可执行 Greenhouse 来源时仍返回阻塞摘要，且不泄漏可启动私有结果", async () => {
    const owner = await account();
    const [watchlist] = await database.select({ id: companyWatchlists.id }).from(companyWatchlists).where(and(eq(companyWatchlists.userId, owner.userId), eq(companyWatchlists.targetId, owner.targetId)));
    await database.update(companyWatchlists).set({ version: 2, updatedAt: now }).where(eq(companyWatchlists.id, watchlist!.id));
    await database.insert(companyWatchlistRevisions).values({ id: randomUUID(), userId: owner.userId, watchlistId: watchlist!.id, targetId: owner.targetId, version: 2, items: [], createdAt: now });

    await expect(createRecommendationRunPreparationQueries({ db: database, runPreflight: evaluator("greenhouse", owner.fingerprint), executionMode: "greenhouse", id: randomUUID, clock: () => now }).prepare({ userId: owner.userId })).resolves.toMatchObject({
      preflight: { status: "blocked" }, sourceScope: { trustedSourceCount: 0, publicQueryCount: 0 },
    });
    const internal = await database.transaction((transaction) => prepareRecommendationRunInTransaction(transaction, { userId: owner.userId, executionMode: "greenhouse" }, { runPreflight: evaluator("greenhouse", owner.fingerprint), id: randomUUID, clock: () => now }));
    expect(internal).toMatchObject({ startSpec: null, recommendationContext: null });
  });

  it("模型诊断阻塞时保留安全的来源摘要，但不返回可启动私有结果", async () => {
    const owner = await account();
    await database.update(modelDiagnosticResults).set({ status: "failed", reasonCode: "MODEL_DIAGNOSTIC_FAILED" }).where(eq(modelDiagnosticResults.configurationFingerprint, owner.fingerprint));
    const internal = await database.transaction((transaction) => prepareRecommendationRunInTransaction(transaction, { userId: owner.userId, executionMode: "greenhouse" }, { runPreflight: evaluator("greenhouse", owner.fingerprint), id: randomUUID, clock: () => now }));

    expect(internal.preparation).toMatchObject({ preflight: { status: "blocked" }, sourceScope: { trustedSourceCount: 1, publicQueryCount: 0 } });
    expect(internal).toMatchObject({ startSpec: null, recommendationContext: null });
  });

  it("有效主目标缺少画像时保留安全来源摘要并阻塞私有启动结果", async () => {
    const owner = await account();
    await database.delete(profileFactRevisions).where(eq(profileFactRevisions.userId, owner.userId));
    await database.delete(profileFacts).where(eq(profileFacts.userId, owner.userId));
    await database.delete(jobProfiles).where(eq(jobProfiles.userId, owner.userId));
    const internal = await database.transaction((transaction) => prepareRecommendationRunInTransaction(transaction, { userId: owner.userId, executionMode: "greenhouse" }, { runPreflight: evaluator("greenhouse", owner.fingerprint), id: randomUUID, clock: () => now }));

    expect(internal.preparation).toMatchObject({ target: { targetId: owner.targetId }, preflight: { status: "blocked" }, sourceScope: { trustedSourceCount: 1, publicQueryCount: 0 } });
    expect(internal.preparation.preflight.items.map((item) => item.code)).toContain("PROFILE_EVIDENCE_MISSING");
    expect(internal).toMatchObject({ startSpec: null, recommendationContext: null });
  });

  it("layered public 缺少画像时返回阻塞摘要而不构造私有启动结果", async () => {
    const owner = await account();
    await database.delete(profileFactRevisions).where(eq(profileFactRevisions.userId, owner.userId));
    await database.delete(profileFacts).where(eq(profileFacts.userId, owner.userId));
    await database.delete(jobProfiles).where(eq(jobProfiles.userId, owner.userId));

    const internal = await database.transaction((transaction) => prepareRecommendationRunInTransaction(transaction, { userId: owner.userId, executionMode: "layered_public" }, { runPreflight: evaluator("layered_public", owner.fingerprint), id: randomUUID, clock: () => now }));

    expect(internal.preparation).toMatchObject({ target: { targetId: owner.targetId }, preflight: { status: "blocked" } });
    expect(internal.preparation.preflight.items.map((item) => item.code)).toContain("PROFILE_EVIDENCE_MISSING");
    expect(internal).toMatchObject({ startSpec: null, recommendationContext: null });
  });

  it("layered public 的可信与公开分支均不可用时返回阻塞摘要而不抛错", async () => {
    const owner = await account();
    const [watchlist] = await database.select({ id: companyWatchlists.id }).from(companyWatchlists).where(and(eq(companyWatchlists.userId, owner.userId), eq(companyWatchlists.targetId, owner.targetId)));
    await database.update(companyWatchlists).set({ version: 2, updatedAt: now }).where(eq(companyWatchlists.id, watchlist!.id));
    await database.insert(companyWatchlistRevisions).values({ id: randomUUID(), userId: owner.userId, watchlistId: watchlist!.id, targetId: owner.targetId, version: 2, items: [], createdAt: now });
    const settings = structuredClone(systemAccountRunPolicy().effective);
    settings.discovery.enabledProviders = [];
    settings.discovery.publicQueryLimit = 0;
    await createAccountRunPolicies({ db: database, id: randomUUID, clock: () => now }).save({ userId: owner.userId, command: { expectedVersion: 0, settings } });

    const internal = await database.transaction((transaction) => prepareRecommendationRunInTransaction(transaction, { userId: owner.userId, executionMode: "layered_public" }, { runPreflight: evaluator("layered_public", owner.fingerprint), id: randomUUID, clock: () => now }));

    expect(internal.preparation).toMatchObject({ target: { targetId: owner.targetId }, preflight: { status: "blocked" }, sourceScope: { trustedSourceCount: 0, publicQueryCount: 0 } });
    expect(internal.preparation.preflight.items.map((item) => item.code)).toContain("SOURCE_CAPABILITY_UNAVAILABLE");
    expect(internal).toMatchObject({ startSpec: null, recommendationContext: null });
  });

  it("recommendation 忽略非主目标请求，始终绑定当前活动主目标", async () => {
    const owner = await account(); const secondaryTargetId = randomUUID();
    await database.insert(jobTargets).values({ id: secondaryTargetId, userId: owner.userId, version: 1, priority: "secondary", state: "active", activeSlot: 1, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: randomUUID(), userId: owner.userId, targetId: secondaryTargetId, version: 1, priority: "secondary", state: "active", constraints: { ...constraints, roleFamily: "不应使用" }, createdAt: now });
    const evaluation = await evaluator("greenhouse", owner.fingerprint).evaluate(database, { userId: owner.userId, targetId: secondaryTargetId, workflow: "recommendation", trigger: "manual" });

    expect(evaluation.report).toMatchObject({ targetId: owner.targetId });
    expect(evaluation.report.items.find((item) => item.code === "REQUESTED_JOB_TARGET_READY")?.evidence).toMatchObject({ requestedTargetId: owner.targetId });
  });

  it("layered public 在仅 AnySearch 查询可规划时将来源降级为 warning，而不是 blocking", async () => {
    const owner = await account();
    const [watchlist] = await database.select({ id: companyWatchlists.id }).from(companyWatchlists).where(and(eq(companyWatchlists.userId, owner.userId), eq(companyWatchlists.targetId, owner.targetId)));
    await database.update(companyWatchlists).set({ version: 2, updatedAt: now }).where(eq(companyWatchlists.id, watchlist!.id));
    await database.insert(companyWatchlistRevisions).values({ id: randomUUID(), userId: owner.userId, watchlistId: watchlist!.id, targetId: owner.targetId, version: 2, items: [{ itemId: randomUUID(), canonicalCompanyName: "Public only", careersUrl: "https://careers.example.com/jobs", allowedDomains: ["example.com"], sourceNote: null, state: "enabled", position: 1 }], createdAt: now });
    const settings = structuredClone(systemAccountRunPolicy().effective);
    settings.discovery.enabledProviders = ["anysearch"];
    settings.discovery.publicQueryLimit = 1;
    await createAccountRunPolicies({ db: database, id: randomUUID, clock: () => now }).save({ userId: owner.userId, command: { expectedVersion: 0, settings } });

    const preparation = await createRecommendationRunPreparationQueries({ db: database, runPreflight: evaluator("layered_public", owner.fingerprint), executionMode: "layered_public", id: randomUUID, clock: () => now }).prepare({ userId: owner.userId });
    expect(preparation.preflight.status).toBe("ready_with_warnings");
    expect(preparation.preflight.items.find((item) => item.code === "SOURCE_CAPABILITY_PARTIAL")).toMatchObject({ severity: "warning" });
    expect(preparation.sourceScope).toEqual({ trustedSourceCount: 0, publicQueryCount: 1 });
  });

  it("公开 prepare 在账户锁中冻结 evaluator 后的主目标快照", async () => {
    const owner = await account();
    const evaluationFinished = deferred(); const releasePreparation = deferred();
    const base = evaluator("greenhouse", owner.fingerprint);
    const delayed = { evaluate: async (...args: Parameters<typeof base.evaluate>) => {
      const result = await base.evaluate(...args);
      evaluationFinished.resolve();
      await releasePreparation.promise;
      return result;
    } };
    const queries = createRecommendationRunPreparationQueries({ db: database, runPreflight: delayed, executionMode: "greenhouse", id: randomUUID, clock: () => now });
    const preparing = queries.prepare({ userId: owner.userId });
    await evaluationFinished.promise;
    const competingDatabase = createDatabase(container.getConnectionUri());
    const observerDatabase = createDatabase(container.getConnectionUri());
    const reachedAccountLock = deferred();
    const deactivate = competingDatabase.transaction(async (transaction) => {
      reachedAccountLock.resolve();
      await acquireAccountAdvisoryLock(transaction, owner.userId);
      await transaction.update(jobTargets).set({ state: "inactive" }).where(eq(jobTargets.id, owner.targetId));
    });
    try {
      await reachedAccountLock.promise;
      await waitUntilAConnectionIsWaitingForAccountAdvisoryLock(observerDatabase);
      releasePreparation.resolve();
      const preparation = await preparing;
      await deactivate;

      expect(preparation).toMatchObject({ target: { targetId: owner.targetId }, preflight: { targetId: owner.targetId } });
      expect(preparation.preflight.status).not.toBe("blocked");
    } finally {
      releasePreparation.resolve();
      await Promise.allSettled([preparing, deactivate]);
      await competingDatabase.$client.end();
      await observerDatabase.$client.end();
    }
  });

  it.each([
    ["fake", "fake"],
    ["greenhouse", "publicDiscovery"],
    ["layered_public", "publicDiscovery"],
  ] as const)("recommendation 同时要求 %s 发现预算和 deep-match 预算可用", async (mode, discoveryBudget) => {
    const owner = await account();
    const settings = structuredClone(systemAccountRunPolicy().effective);
    settings.budgets[discoveryBudget].maxResults = 0;
    await createAccountRunPolicies({ db: database, id: randomUUID, clock: () => now }).save({ userId: owner.userId, command: { expectedVersion: 0, settings } });

    const discoveryBlocked = await evaluator(mode, owner.fingerprint).evaluate(database, { userId: owner.userId, workflow: "recommendation" as never, trigger: "manual" });
    expect(discoveryBlocked.report.status).toBe("blocked");
    expect(discoveryBlocked.report.items.filter((item) => item.code === "ACCOUNT_RUN_POLICY_BLOCKED")).toHaveLength(1);

    settings.budgets[discoveryBudget].maxResults = 1;
    settings.budgets.deepMatch.maxModelCalls = 0;
    await createAccountRunPolicies({ db: database, id: randomUUID, clock: () => now }).save({ userId: owner.userId, command: { expectedVersion: 1, settings } });
    const deepMatchBlocked = await evaluator(mode, owner.fingerprint).evaluate(database, { userId: owner.userId, workflow: "recommendation" as never, trigger: "manual" });

    expect(deepMatchBlocked.report.status).toBe("blocked");
    expect(deepMatchBlocked.report.items.filter((item) => item.code === "ACCOUNT_RUN_POLICY_BLOCKED")).toHaveLength(1);
  });
});
