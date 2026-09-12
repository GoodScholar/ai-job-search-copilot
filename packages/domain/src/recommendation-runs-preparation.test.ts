import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
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
