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
  jobAccounts,
  jobTargets,
  migrateDatabase,
  recommendationLists,
  type Database,
} from "@job-copilot/database";
import type { RunPreflightReport } from "@job-copilot/contracts/run-preflight";
import {
  createFirstRecommendationJourneyCommands,
  createFirstRecommendationJourneyReader,
  recordFirstRecommendationJourneyCompletion,
} from "./first-recommendation-journey";

const now = new Date("2026-09-06T01:00:00.000Z");
const ownerId = "9525a518-8b2c-4c76-98b6-1e2c4e5081bb";
const otherOwnerId = "3eac5e66-8eea-4bf1-9473-38ebed2aa1d9";

function report(input: { profile?: boolean; targetId?: string | null; capableSources?: number; status?: "blocked" | "ready" | "ready_with_warnings"; actions?: string[] } = {}): RunPreflightReport {
  const checkedAt = now.toISOString();
  const profile = input.profile ?? false;
  const targetId = input.targetId ?? null;
  const capableSources = input.capableSources ?? 0;
  const status = input.status ?? "blocked";
  const actions = input.actions ?? (profile ? [] : ["review_profile"]);
  return {
    version: "run-preflight-v1", workflow: "discovery", trigger: "manual", targetId, status, warningFingerprint: null, checkedAt,
    items: [
      { code: profile ? "PROFILE_EVIDENCE_READY" : "PROFILE_EVIDENCE_MISSING", severity: profile ? "informational" : "blocking", summary: "画像", impact: "请补全画像。", retryable: false, suggestedActions: profile ? [] : ["review_profile"], evidence: { kind: "profile", activeTrustedFactCount: profile ? 1 : 0, latestFactRevisionId: null, checkedAt } },
      { code: targetId ? "PRIMARY_JOB_TARGET_READY" : "PRIMARY_JOB_TARGET_MISSING", severity: targetId ? "informational" : "blocking", summary: "目标", impact: "请明确方向。", retryable: false, suggestedActions: targetId ? [] : ["review_job_targets"], evidence: { kind: "job_target", primaryTargetId: targetId, primaryTargetVersion: targetId ? 1 : null, requestedTargetId: targetId, requestedTargetVersion: targetId ? 1 : null, requestedTargetState: targetId ? "active" : "missing", checkedAt } },
      { code: targetId ? "REQUESTED_JOB_TARGET_READY" : "REQUESTED_JOB_TARGET_MISSING", severity: targetId ? "informational" : "blocking", summary: "请求目标", impact: "请明确方向。", retryable: false, suggestedActions: targetId ? [] : ["review_job_targets"], evidence: { kind: "job_target", primaryTargetId: targetId, primaryTargetVersion: targetId ? 1 : null, requestedTargetId: targetId, requestedTargetVersion: targetId ? 1 : null, requestedTargetState: targetId ? "active" : "missing", checkedAt } },
      { code: capableSources ? "SOURCE_CAPABILITY_READY" : "SOURCE_CAPABILITY_UNAVAILABLE", severity: capableSources ? "informational" : "blocking", summary: "来源", impact: "请接通来源。", retryable: false, suggestedActions: capableSources ? [] : ["review_job_sources"], evidence: { kind: "source_capability", enabledSourceCount: capableSources, capableSourceCount: capableSources, status: capableSources ? "ready" : "unavailable", checkedAt } },
      { code: "SOURCE_HEALTH_READY", severity: "informational", summary: "来源健康", impact: "来源可用。", retryable: false, suggestedActions: [], evidence: { kind: "source_health", checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 0, latestCheckedAt: null } },
      { code: "MODEL_DIAGNOSTIC_READY", severity: "informational", summary: "模型", impact: "模型可用。", retryable: false, suggestedActions: [], evidence: { kind: "model_diagnostic", status: "available", checkedAt } },
      { code: "ACCOUNT_RUN_POLICY_READY", severity: "informational", summary: "策略", impact: "策略可用。", retryable: false, suggestedActions: [], evidence: { kind: "account_run_policy", revisionNumber: 0, status: "ready", checkedAt } },
    ],
  } as RunPreflightReport;
}

describe("first recommendation journey", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let currentReport = report();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = createDatabase(container.getConnectionUri());
    await migrateDatabase(db);
    await db.insert(jobAccounts).values([{ id: ownerId, status: "active" }, { id: otherOwnerId, status: "active" }]);
  }, 60_000);

  afterAll(async () => { await db?.$client.end(); await container?.stop(); });

  const reader = () => createFirstRecommendationJourneyReader({
    db,
    runPreflight: { evaluate: async () => ({ report: currentReport, policy: { revisionNumber: 0, snapshot: {} as never } }) },
  });

  it("从权威事实推导步骤，且已访问的未完成步骤优先成为当前步骤", async () => {
    const initial = await reader().get({ userId: ownerId });
    expect(initial).toMatchObject({ status: "active", currentStepId: "career_materials" });
    expect(initial.steps.map((step) => [step.id, step.status, step.action.href])).toEqual([
      ["career_materials", "needs_action", "/profile"], ["profile_evidence", "needs_action", "/profile"], ["primary_target", "needs_action", "/profile/targets"],
      ["job_sources", "needs_action", "/profile/targets"], ["run_readiness", "needs_action", "/profile"], ["first_result", "waiting", "/home"],
    ]);

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
    expect(progressed).toMatchObject({ currentStepId: "first_result" });
    expect(progressed.steps).toMatchObject(expect.arrayContaining([
      expect.objectContaining({ id: "career_materials", status: "completed" }),
      expect.objectContaining({ id: "profile_evidence", status: "completed" }),
      expect.objectContaining({ id: "primary_target", status: "completed" }),
      expect.objectContaining({ id: "job_sources", status: "completed", action: expect.objectContaining({ href: `/profile/targets/${targetId}/watchlist` }) }),
      expect.objectContaining({ id: "run_readiness", status: "completed" }),
    ]));
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
    await db.insert(jobTargets).values({ id: targetId, userId: otherOwnerId, version: 1, priority: "primary", state: "active", activeSlot: null });
    await db.insert(recommendationLists).values({ id: listId, userId: otherOwnerId, targetId, localDate: "2026-09-06", sequence: 1, createdAt: now });
    await db.insert(agentRuns).values({ id: crypto.randomUUID(), userId: otherOwnerId, targetId, idempotencyKey: crypto.randomUUID(), targetVersion: 1, targetSnapshot: {}, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "v", ruleVersion: "v", adapter: "a", adapterVersion: "v", outputSchemaVersion: "v", toolAllowlist: [], status: "failed", currentStep: "failed", startedAt: now, failedAt: now });
    await expect(reader().get({ userId: otherOwnerId })).resolves.toMatchObject({ status: "dismissed", steps: expect.arrayContaining([expect.objectContaining({ id: "first_result", status: "waiting" })]) });

    await recordFirstRecommendationJourneyCompletion(db, { userId: otherOwnerId, result: { kind: "recommendation_list", resultId: listId }, completedAt: now });
    await recordFirstRecommendationJourneyCompletion(db, { userId: otherOwnerId, result: { kind: "recommendation_list", resultId: crypto.randomUUID() }, completedAt: new Date(now.getTime() + 1) });
    await expect(db.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, otherOwnerId)))
      .resolves.toEqual([expect.objectContaining({ resultId: listId, completedAt: now })]);
    await expect(reader().get({ userId: otherOwnerId })).resolves.toEqual({ status: "completed", steps: [], currentStepId: null, completedAt: now.toISOString() });
    await expect(db.select().from(firstRecommendationJourneyInteractions).where(and(eq(firstRecommendationJourneyInteractions.userId, otherOwnerId), eq(firstRecommendationJourneyInteractions.version, 2)))).resolves.toHaveLength(1);
  });
});
