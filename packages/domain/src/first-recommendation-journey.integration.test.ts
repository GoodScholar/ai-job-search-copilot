import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentRuns,
  careerDocuments,
  careerImports,
  createDatabase,
  firstRecommendationJourneyCompletions,
  firstRecommendationJourneyInteractions,
  companyWatchlists,
  companyWatchlistRevisions,
  jobAccounts,
  jobProfiles,
  profileFacts,
  profileFactRevisions,
  jobTargets,
  migrateDatabase,
  recommendationLists,
  type Database,
} from "@job-copilot/database";
import { RunPreflightReportSchema, type RunPreflightReport } from "@job-copilot/contracts/run-preflight";
import {
  createFirstRecommendationJourneyCommands,
  createFirstRecommendationJourneyReader,
  recordFirstRecommendationJourneyCompletion,
} from "./first-recommendation-journey";

const now = new Date("2026-09-06T01:00:00.000Z");
const ownerId = "9525a518-8b2c-4c76-98b6-1e2c4e5081bb";
const otherOwnerId = "3eac5e66-8eea-4bf1-9473-38ebed2aa1d9";

function report(input: { profile?: boolean; targetId?: string | null; capableSources?: number; status?: "blocked" | "ready" | "ready_with_warnings"; blockedBy?: "model" | "policy" } = {}): RunPreflightReport {
  const checkedAt = now.toISOString();
  const profile = input.profile ?? false;
  const targetId = input.targetId ?? null;
  const capableSources = input.capableSources ?? 0;
  const status = input.blockedBy ? "blocked" : input.status ?? "blocked";
  const partial = status === "ready_with_warnings";
  return RunPreflightReportSchema.parse({
    version: "run-preflight-v1", workflow: "discovery", trigger: "manual", targetId, status, warningFingerprint: partial ? "a".repeat(64) : null, checkedAt,
    items: [
      { code: profile ? "PROFILE_EVIDENCE_READY" : "PROFILE_EVIDENCE_MISSING", severity: profile ? "informational" : "blocking", summary: "画像", impact: "请补全画像。", retryable: false, suggestedActions: profile ? [] : ["review_profile"], evidence: { kind: "profile", activeTrustedFactCount: profile ? 1 : 0, latestFactRevisionId: null, checkedAt } },
      { code: targetId ? "PRIMARY_JOB_TARGET_READY" : "PRIMARY_JOB_TARGET_MISSING", severity: targetId ? "informational" : "blocking", summary: "目标", impact: "请明确方向。", retryable: false, suggestedActions: targetId ? [] : ["review_job_targets"], evidence: { kind: "job_target", primaryTargetId: targetId, primaryTargetVersion: targetId ? 1 : null, requestedTargetId: targetId, requestedTargetVersion: targetId ? 1 : null, requestedTargetState: targetId ? "active" : "missing", checkedAt } },
      { code: targetId ? "REQUESTED_JOB_TARGET_READY" : "REQUESTED_JOB_TARGET_MISSING", severity: targetId ? "informational" : "blocking", summary: "请求目标", impact: "请明确方向。", retryable: false, suggestedActions: targetId ? [] : ["review_job_targets"], evidence: { kind: "job_target", primaryTargetId: targetId, primaryTargetVersion: targetId ? 1 : null, requestedTargetId: targetId, requestedTargetVersion: targetId ? 1 : null, requestedTargetState: targetId ? "active" : "missing", checkedAt } },
      { code: capableSources ? partial ? "SOURCE_CAPABILITY_PARTIAL" : "SOURCE_CAPABILITY_READY" : "SOURCE_CAPABILITY_UNAVAILABLE", severity: capableSources ? partial ? "warning" : "informational" : "blocking", summary: "来源", impact: partial ? "部分来源能力不足，请检查来源设置。" : "请接通来源。", retryable: false, suggestedActions: capableSources ? partial ? ["review_source_capabilities"] : [] : ["review_source_capabilities"], evidence: { kind: "source_capability", enabledSourceCount: capableSources + (partial ? 1 : 0), capableSourceCount: capableSources, status: capableSources ? partial ? "partial" : "ready" : "unavailable", checkedAt } },
      { code: "SOURCE_HEALTH_READY", severity: "informational", summary: "来源健康", impact: "来源可用。", retryable: false, suggestedActions: [], evidence: { kind: "source_health", checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 0, latestCheckedAt: null } },
      { code: input.blockedBy === "model" ? "MODEL_DIAGNOSTIC_UNAVAILABLE" : "MODEL_DIAGNOSTIC_READY", severity: input.blockedBy === "model" ? "blocking" : "informational", summary: "模型", impact: "请先检查模型连接。", retryable: false, suggestedActions: input.blockedBy === "model" ? ["run_model_diagnostic"] : [], evidence: { kind: "model_diagnostic", status: input.blockedBy === "model" ? "failed" : "available", checkedAt } },
      { code: input.blockedBy === "policy" ? "ACCOUNT_RUN_POLICY_BLOCKED" : "ACCOUNT_RUN_POLICY_READY", severity: input.blockedBy === "policy" ? "blocking" : "informational", summary: "策略", impact: "请检查账户运行策略。", retryable: false, suggestedActions: input.blockedBy === "policy" ? ["review_account_run_policy"] : [], evidence: { kind: "account_run_policy", revisionNumber: 0, status: input.blockedBy === "policy" ? "blocked" : "ready", checkedAt } },
    ],
  });
}

describe("first recommendation journey", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let currentReport = report();
  const evaluations: Array<{ workflow: string; trigger: string }> = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = createDatabase(container.getConnectionUri());
    await migrateDatabase(db);
    await db.insert(jobAccounts).values([{ id: ownerId, status: "active" }, { id: otherOwnerId, status: "active" }]);
  }, 60_000);

  afterAll(async () => { await db?.$client.end(); await container?.stop(); });

  const reader = () => createFirstRecommendationJourneyReader({
    db,
    runPreflight: { evaluate: async (_db, input) => { evaluations.push({ workflow: input.workflow, trigger: input.trigger }); return { report: currentReport, policy: { revisionNumber: 0, snapshot: {} as never } }; } },
  });

  it("从权威事实推导步骤，且已访问的未完成步骤优先成为当前步骤", async () => {
    const initial = await reader().get({ userId: ownerId });
    expect(initial).toMatchObject({ status: "active", interactionVersion: 0, currentStepId: "career_materials" });
    expect(initial.steps.map((step) => [step.id, step.status, step.action.href])).toEqual([
      ["career_materials", "needs_action", "/profile"], ["profile_evidence", "needs_action", "/profile"], ["primary_target", "needs_action", "/profile/targets"],
      ["job_sources", "needs_action", "/profile/targets"], ["run_readiness", "needs_action", "/profile"], ["first_result", "waiting", "/home"],
    ]);
    expect(evaluations).toContainEqual({ workflow: "discovery", trigger: "manual" });

    const documentId = crypto.randomUUID();
    const importId = crypto.randomUUID();
    await db.insert(careerDocuments).values({ id: documentId, userId: ownerId, checksumSha256: "a".repeat(64), objectKey: "accounts/owner/resume.md", originalFilename: "resume.md", mediaType: "text/markdown", byteSize: 1 });
    await db.insert(careerImports).values({ id: importId, userId: ownerId, careerDocumentId: documentId, originatingRequestId: crypto.randomUUID(), status: "queued" });
    await expect(reader().get({ userId: ownerId })).resolves.toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ id: "career_materials", status: "in_progress" })]) });
    await db.update(careerImports).set({ status: "completed", completedAt: now }).where(eq(careerImports.id, importId));

    const targetId = crypto.randomUUID();
    await db.insert(jobTargets).values({ id: targetId, userId: ownerId, version: 1, priority: "primary", state: "active", activeSlot: null });
    currentReport = report({ profile: true, targetId, capableSources: 1, status: "ready_with_warnings" });
    const commands = createFirstRecommendationJourneyCommands({ db, clock: () => now });
    await commands.updateInteraction({ userId: ownerId, command: { action: "visit_step", stepId: "first_result", expectedVersion: 0 } });
    const progressed = await reader().get({ userId: ownerId });
    expect(progressed).toMatchObject({ interactionVersion: 1, currentStepId: "first_result" });
    expect(progressed.steps).toMatchObject(expect.arrayContaining([
      expect.objectContaining({ id: "career_materials", status: "completed" }),
      expect.objectContaining({ id: "profile_evidence", status: "completed" }),
      expect.objectContaining({ id: "primary_target", status: "completed" }),
      expect.objectContaining({ id: "job_sources", status: "completed", action: expect.objectContaining({ href: `/profile/targets/${targetId}/watchlist` }) }),
      expect.objectContaining({ id: "run_readiness", status: "completed" }),
      expect.objectContaining({ id: "first_result", status: "needs_action" }),
    ]));
    expect(progressed.steps.find((value) => value.id === "run_readiness")).toMatchObject({ impact: "部分来源能力不足，请检查来源设置。" });
    await commands.updateInteraction({ userId: ownerId, command: { action: "visit_step", stepId: "job_sources", expectedVersion: 1 } });
    await expect(reader().get({ userId: ownerId })).resolves.toMatchObject({ currentStepId: "first_result" });
  });

  it("活动运行优先显示确定性的运行锚点，未满足前置条件则等待", async () => {
    const targetId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await db.insert(jobAccounts).values({ id: userId, status: "active" });
    await db.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null });
    currentReport = report({ profile: true, targetId, capableSources: 1, status: "ready" });
    const runIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await db.insert(agentRuns).values(runIds.map((id, index) => ({ id, userId, targetId, idempotencyKey: crypto.randomUUID(), targetVersion: 1, targetSnapshot: {}, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "v", ruleVersion: "v", adapter: "a", adapterVersion: "v", outputSchemaVersion: "v", toolAllowlist: [], status: (["queued", "running", "paused"] as const)[index]!, currentStep: "queued", queuedAt: new Date(now.getTime() + index), ...(index === 1 ? { startedAt: new Date(now.getTime() + index) } : {}) })));
    const journey = await reader().get({ userId });
    expect(journey.steps.find((value) => value.id === "first_result")).toMatchObject({ status: "in_progress", action: { href: `/home?runId=${runIds[0]}#agent-run` } });
  });

  it("processing 导入进行中，失败导入不构成完成", async () => {
    const userId = crypto.randomUUID(); const documentId = crypto.randomUUID(); const importId = crypto.randomUUID();
    await db.insert(jobAccounts).values({ id: userId, status: "active" });
    await db.insert(careerDocuments).values({ id: documentId, userId, checksumSha256: "b".repeat(64), objectKey: `accounts/${userId}/resume.md`, originalFilename: "resume.md", mediaType: "text/markdown", byteSize: 1 });
    await db.insert(careerImports).values({ id: importId, userId, careerDocumentId: documentId, originatingRequestId: crypto.randomUUID(), status: "processing", processingStartedAt: now });
    currentReport = report();
    await expect(reader().get({ userId })).resolves.toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ id: "career_materials", status: "in_progress" })]) });
    await db.update(careerImports).set({ status: "failed", failedAt: now }).where(eq(careerImports.id, importId));
    await expect(reader().get({ userId })).resolves.toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ id: "career_materials", status: "needs_action" })]) });
  });

  it("画像、目标、来源和阻塞动作分别投影到对应步骤", async () => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID();
    await db.insert(jobAccounts).values({ id: userId, status: "active" });
    currentReport = report();
    let journey = await reader().get({ userId });
    expect(journey.steps.find((value) => value.id === "profile_evidence")?.status).toBe("needs_action");
    currentReport = report({ profile: true }); journey = await reader().get({ userId });
    expect(journey.steps.find((value) => value.id === "profile_evidence")?.status).toBe("completed");
    expect(journey.steps.find((value) => value.id === "primary_target")?.status).toBe("needs_action");
    currentReport = report({ profile: true, targetId }); journey = await reader().get({ userId });
    expect(journey.steps.find((value) => value.id === "primary_target")?.status).toBe("completed");
    expect(journey.steps.find((value) => value.id === "job_sources")?.status).toBe("needs_action");
    currentReport = report({ profile: true, targetId, capableSources: 1, status: "ready" }); journey = await reader().get({ userId });
    expect(journey.steps.find((value) => value.id === "job_sources")?.status).toBe("completed");
    for (const [blockedBy, href] of [["model", "/profile/model-connection"], ["policy", "/profile/run-policy"]] as const) {
      currentReport = report({ profile: true, targetId, capableSources: 1, blockedBy });
      journey = await reader().get({ userId });
      expect(journey.steps.find((value) => value.id === "run_readiness")).toMatchObject({ status: "needs_action", action: { href } });
    }
  });

  it("其他账户的导入、活动运行和完成事实不会影响当前账户", async () => {
    const userId = crypto.randomUUID(); const otherId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const documentId = crypto.randomUUID();
    await db.insert(jobAccounts).values([{ id: userId, status: "active" }, { id: otherId, status: "active" }]);
    await db.insert(jobTargets).values({ id: targetId, userId: otherId, version: 1, priority: "primary", state: "active", activeSlot: null });
    await db.insert(careerDocuments).values({ id: documentId, userId: otherId, checksumSha256: "c".repeat(64), objectKey: `accounts/${otherId}/resume.md`, originalFilename: "resume.md", mediaType: "text/markdown", byteSize: 1 });
    await db.insert(careerImports).values({ id: crypto.randomUUID(), userId: otherId, careerDocumentId: documentId, originatingRequestId: crypto.randomUUID(), status: "completed", completedAt: now });
    await db.insert(agentRuns).values({ id: crypto.randomUUID(), userId: otherId, targetId, idempotencyKey: crypto.randomUUID(), targetVersion: 1, targetSnapshot: {}, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "v", ruleVersion: "v", adapter: "a", adapterVersion: "v", outputSchemaVersion: "v", toolAllowlist: [], status: "queued", currentStep: "queued" });
    await recordFirstRecommendationJourneyCompletion(db, { userId: otherId, result: { kind: "no_recommendations", resultId: crypto.randomUUID() }, completedAt: now });
    currentReport = report();
    await expect(reader().get({ userId })).resolves.toMatchObject({ status: "active", steps: expect.arrayContaining([expect.objectContaining({ id: "career_materials", status: "needs_action" }), expect.objectContaining({ id: "first_result", status: "waiting" })]) });
  });

  it("完成后真实画像、目标和来源退化不会重新打开旅程", async () => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const profileId = crypto.randomUUID(); const factId = crypto.randomUUID(); const watchlistId = crypto.randomUUID(); const listId = crypto.randomUUID();
    await db.insert(jobAccounts).values({ id: userId, status: "active" });
    await db.insert(jobProfiles).values({ id: profileId, userId, version: 1 });
    await db.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill" });
    await db.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "TypeScript" }, state: "active", source: "user_confirmed", profileVersion: 1 });
    await db.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null });
    await db.insert(companyWatchlists).values({ id: watchlistId, userId, targetId, version: 1 });
    await db.insert(companyWatchlistRevisions).values({ id: crypto.randomUUID(), userId, watchlistId, targetId, version: 1, items: [{ itemId: crypto.randomUUID(), canonicalCompanyName: "示例公司", careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null, state: "enabled", position: 1 }] });
    await db.insert(recommendationLists).values({ id: listId, userId, targetId, localDate: "2026-09-06", sequence: 1, createdAt: now });
    currentReport = report({ profile: true, targetId, capableSources: 1, status: "ready" });
    await expect(reader().get({ userId })).resolves.toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ id: "profile_evidence", status: "completed" }), expect.objectContaining({ id: "primary_target", status: "completed" }), expect.objectContaining({ id: "job_sources", status: "completed" })]) });
    await recordFirstRecommendationJourneyCompletion(db, { userId, result: { kind: "recommendation_list", resultId: listId }, completedAt: now });
    await db.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId: factId, revisionNumber: 2, factType: "skill", factValue: { name: "TypeScript" }, state: "removed", source: "user_confirmed", profileVersion: 2 });
    await db.update(jobTargets).set({ state: "inactive" }).where(eq(jobTargets.id, targetId));
    await db.insert(companyWatchlistRevisions).values({ id: crypto.randomUUID(), userId, watchlistId, targetId, version: 2, items: [{ itemId: crypto.randomUUID(), canonicalCompanyName: "示例公司", careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null, state: "disabled", position: 1 }] });
    await db.update(companyWatchlists).set({ version: 2 }).where(eq(companyWatchlists.id, watchlistId));
    const sentinel = new Error("完成读取不得调用动态 preflight");
    const completedReader = createFirstRecommendationJourneyReader({ db, runPreflight: { evaluate: async () => { throw sentinel; } } });
    await expect(completedReader.get({ userId })).resolves.toEqual({ status: "completed", steps: [], currentStepId: null, completedAt: now.toISOString() });
  });

  it("交互以账户、未完成状态与乐观版本保护，并跨读取恢复", async () => {
    const commands = createFirstRecommendationJourneyCommands({ db, clock: () => now });
    await expect(commands.updateInteraction({ userId: otherOwnerId, command: { action: "visit_step", stepId: "job_sources", expectedVersion: 0 } }))
      .resolves.toEqual({ version: 1, dismissedAt: null, lastVisitedStep: "job_sources" });
    await expect(commands.updateInteraction({ userId: otherOwnerId, command: { action: "dismiss", expectedVersion: 1 } }))
      .resolves.toMatchObject({ version: 2, dismissedAt: now.toISOString(), lastVisitedStep: "job_sources" });
    await expect(reader().get({ userId: otherOwnerId })).resolves.toMatchObject({ status: "dismissed" });
    await expect(commands.updateInteraction({ userId: otherOwnerId, command: { action: "dismiss", expectedVersion: 1 } }))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(commands.updateInteraction({ userId: crypto.randomUUID(), command: { action: "dismiss", expectedVersion: 0 } }))
      .rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("只接受内部完成记录器的可信事实，并永久优先于动态条件", async () => {
    const targetId = crypto.randomUUID();
    const listId = crypto.randomUUID();
    const secondListId = crypto.randomUUID();
    await db.insert(jobTargets).values({ id: targetId, userId: otherOwnerId, version: 1, priority: "primary", state: "active", activeSlot: null });
    await db.insert(recommendationLists).values([{ id: listId, userId: otherOwnerId, targetId, localDate: "2026-09-06", sequence: 1, createdAt: now }, { id: secondListId, userId: otherOwnerId, targetId, localDate: "2026-09-06", sequence: 2, createdAt: now }]);
    await db.insert(agentRuns).values({ id: crypto.randomUUID(), userId: otherOwnerId, targetId, idempotencyKey: crypto.randomUUID(), targetVersion: 1, targetSnapshot: {}, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "v", ruleVersion: "v", adapter: "a", adapterVersion: "v", outputSchemaVersion: "v", toolAllowlist: [], status: "failed", currentStep: "failed", startedAt: now, failedAt: now });
    await expect(reader().get({ userId: otherOwnerId })).resolves.toMatchObject({ status: "dismissed", steps: expect.arrayContaining([expect.objectContaining({ id: "first_result", status: "waiting" })]) });

    await Promise.all([
      recordFirstRecommendationJourneyCompletion(db, { userId: otherOwnerId, result: { kind: "recommendation_list", resultId: listId }, completedAt: now }),
      recordFirstRecommendationJourneyCompletion(db, { userId: otherOwnerId, result: { kind: "recommendation_list", resultId: secondListId }, completedAt: new Date(now.getTime() + 1) }),
    ]);
    const [completion] = await db.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, otherOwnerId));
    expect(completion).toEqual(expect.objectContaining({ resultId: expect.stringMatching(new RegExp(`^(${listId}|${secondListId})$`)) }));
    await expect(reader().get({ userId: otherOwnerId })).resolves.toEqual({ status: "completed", steps: [], currentStepId: null, completedAt: completion!.completedAt.toISOString() });
    await expect(createFirstRecommendationJourneyCommands({ db, clock: () => now }).updateInteraction({ userId: otherOwnerId, command: { action: "dismiss", expectedVersion: 2 } })).rejects.toMatchObject({ code: "JOURNEY_COMPLETED" });
    await expect(db.select().from(firstRecommendationJourneyInteractions).where(and(eq(firstRecommendationJourneyInteractions.userId, otherOwnerId), eq(firstRecommendationJourneyInteractions.version, 2)))).resolves.toHaveLength(1);
    const sentinel = new Error("不可变数据库错误");
    await expect(recordFirstRecommendationJourneyCompletion({ insert: () => { throw sentinel; } } as never, { userId: otherOwnerId, result: { kind: "no_recommendations", resultId: crypto.randomUUID() }, completedAt: now })).rejects.toBe(sentinel);
  });
});
