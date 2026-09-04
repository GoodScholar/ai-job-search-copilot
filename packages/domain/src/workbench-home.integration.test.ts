import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  candidateFacts,
  careerDocuments,
  careerImports,
  createDatabase,
  jobAccounts,
  agentRuns,
  agentInboxItems,
  calibrationProposals,
  companyWatchlistRevisions,
  companyWatchlists,
  jobSourceHealthChecks,
  jobTargets,
  recommendationLists,
  migrateDatabase,
  type Database,
} from "@job-copilot/database";
import { createWorkbenchHome } from "./workbench-home";

const activeUserId = "a3f3eb12-c92c-4582-b73c-8f2bf764b444";
const inactiveUserId = "af4ff7c6-4b16-46d3-afc2-e9d4a93e8a9e";
const secondActiveUserId = "922dee86-f382-4a2f-a7af-fbf744b67b2b";
const clock = () => new Date("2026-09-04T16:30:00.000Z");

describe("workbench home", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
    await database.insert(jobAccounts).values([
      { id: activeUserId, status: "active" },
      { id: inactiveUserId, status: "inactive" },
      { id: secondActiveUserId, status: "active" },
    ]);
  }, 60_000);

  afterAll(async () => {
    await database?.$client.end();
    await container?.stop();
  });

  it("returns the real empty workbench only for an active account", async () => {
    const getWorkbenchHome = createWorkbenchHome({ db: database, clock });
    await expect(getWorkbenchHome({ userId: activeUserId })).resolves.toEqual({
      account: { userId: activeUserId },
      summary: { todayRecommendations: 0, pendingFacts: 0, activeAgentRuns: 0, failedAgentRuns: 0, sourceFailures: 0, pendingDecisions: 0, applications: 0, applicationsAvailable: false },
    });
  });

  it("uses the domain account-not-found code for missing or inactive accounts", async () => {
    const getWorkbenchHome = createWorkbenchHome({ db: database, clock });
    await expect(getWorkbenchHome({
      userId: "65c0528e-4046-49d5-a056-8b7d3888192a",
    })).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    await expect(getWorkbenchHome({ userId: inactiveUserId }))
      .rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("counts only the current account's real pending candidate facts", async () => {
    const firstDocumentId = "4767e2ee-38c7-4842-a1a3-8b2d027c5a59";
    const firstImportId = "e5013f89-9e9c-4ce4-bec2-5a0f9b38c170";
    const secondDocumentId = "4ee1c7c6-2c94-4b31-b5ae-8ad0f4bf1115";
    const secondImportId = "2daa2804-c7fa-43f8-9232-8b4543c488d0";
    await database.insert(careerDocuments).values([
      { id: firstDocumentId, userId: activeUserId, checksumSha256: "1".repeat(64), objectKey: "accounts/one/source.md", originalFilename: "one.md", mediaType: "text/markdown", byteSize: 1 },
      { id: secondDocumentId, userId: secondActiveUserId, checksumSha256: "2".repeat(64), objectKey: "accounts/two/source.md", originalFilename: "two.md", mediaType: "text/markdown", byteSize: 1 },
    ]);
    await database.insert(careerImports).values([
      { id: firstImportId, userId: activeUserId, careerDocumentId: firstDocumentId, originatingRequestId: "9f6d7593-6e4c-4a38-b841-142eff124e0b" },
      { id: secondImportId, userId: secondActiveUserId, careerDocumentId: secondDocumentId, originatingRequestId: "3bdbdc50-07fd-4c2d-b232-ebd9c9c63a44" },
    ]);
    await database.insert(candidateFacts).values([
      { id: "ab0565ea-5936-45c6-9d61-07f9ce10ca84", userId: activeUserId, careerImportId: firstImportId, careerDocumentId: firstDocumentId, factKey: "3".repeat(64), factType: "skill", factValue: { name: "TypeScript" }, confidenceBasisPoints: 10_000 },
      { id: "f1b7e4fc-1b4f-4c64-85a2-4fc4bc5f4473", userId: activeUserId, careerImportId: firstImportId, careerDocumentId: firstDocumentId, factKey: "4".repeat(64), factType: "skill", factValue: { name: "PostgreSQL" }, confidenceBasisPoints: 10_000 },
      { id: "56cb9b03-96ca-40f2-b66f-e2cc6ad7645a", userId: secondActiveUserId, careerImportId: secondImportId, careerDocumentId: secondDocumentId, factKey: "5".repeat(64), factType: "skill", factValue: { name: "Rust" }, confidenceBasisPoints: 10_000 },
    ]);

    const getWorkbenchHome = createWorkbenchHome({ db: database, clock });
    await expect(getWorkbenchHome({ userId: activeUserId })).resolves.toEqual({
      account: { userId: activeUserId },
      summary: { todayRecommendations: 0, pendingFacts: 2, activeAgentRuns: 0, failedAgentRuns: 0, sourceFailures: 0, pendingDecisions: 0, applications: 0, applicationsAvailable: false },
    });
    await expect(getWorkbenchHome({ userId: secondActiveUserId })).resolves.toEqual({
      account: { userId: secondActiveUserId },
      summary: { todayRecommendations: 0, pendingFacts: 1, activeAgentRuns: 0, failedAgentRuns: 0, sourceFailures: 0, pendingDecisions: 0, applications: 0, applicationsAvailable: false },
    });
  });

  it("只统计当前账户排队、运行或暂停中的 agent run", async () => {
    const activeTargetId = crypto.randomUUID();
    const otherTargetId = crypto.randomUUID();
    await database.insert(jobTargets).values([
      { id: activeTargetId, userId: activeUserId, version: 1, priority: "primary", state: "active", activeSlot: null },
      { id: otherTargetId, userId: secondActiveUserId, version: 1, priority: "primary", state: "active", activeSlot: null },
    ]);
    await database.insert(agentRuns).values([
      { id: crypto.randomUUID(), userId: activeUserId, targetId: activeTargetId, idempotencyKey: crypto.randomUUID(), targetVersion: 1, targetSnapshot: {}, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "v", ruleVersion: "v", adapter: "a", adapterVersion: "v", outputSchemaVersion: "v", toolAllowlist: [], status: "queued", currentStep: "queued" },
      { id: crypto.randomUUID(), userId: activeUserId, targetId: activeTargetId, idempotencyKey: crypto.randomUUID(), targetVersion: 1, targetSnapshot: {}, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "v", ruleVersion: "v", adapter: "a", adapterVersion: "v", outputSchemaVersion: "v", toolAllowlist: [], status: "paused", currentStep: "queued" },
      { id: crypto.randomUUID(), userId: secondActiveUserId, targetId: otherTargetId, idempotencyKey: crypto.randomUUID(), targetVersion: 1, targetSnapshot: {}, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "v", ruleVersion: "v", adapter: "a", adapterVersion: "v", outputSchemaVersion: "v", toolAllowlist: [], status: "queued", currentStep: "queued" },
    ]);
    await expect(createWorkbenchHome({ db: database, clock })({ userId: activeUserId })).resolves.toMatchObject({ summary: { activeAgentRuns: 2 } });
  });

  it("以 Asia/Shanghai 当日、每目标最新序列、最新启用来源和未解决 Inbox 聚合账户工作台", async () => {
    const userId = crypto.randomUUID();
    const otherUserId = crypto.randomUUID();
    const primaryTargetId = crypto.randomUUID();
    const secondaryTargetId = crypto.randomUUID();
    const otherTargetId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const importId = crypto.randomUUID();
    const factId = crypto.randomUUID();
    const now = new Date("2026-09-04T16:30:00.000Z");
    const earlier = new Date("2026-09-04T01:00:00.000Z");
    const healthRunId = crypto.randomUUID();
    const latestHealthRunId = crypto.randomUUID();
    const todayFirstListId = crypto.randomUUID();
    const todayLatestListId = crypto.randomUUID();
    const todaySecondTargetListId = crypto.randomUUID();
    const yesterdayListId = crypto.randomUUID();
    const enabledRecoveredItemId = crypto.randomUUID();
    const enabledRateLimitedItemId = crypto.randomUUID();
    const enabledParserItemId = crypto.randomUUID();
    const disabledItemId = crypto.randomUUID();
    const enabledZeroResultItemId = crypto.randomUUID();

    await database.insert(jobAccounts).values([{ id: userId, status: "active" }, { id: otherUserId, status: "active" }]);
    await database.insert(jobTargets).values([
      { id: primaryTargetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null },
      { id: secondaryTargetId, userId, version: 1, priority: "secondary", state: "active", activeSlot: 1 },
      { id: otherTargetId, userId: otherUserId, version: 1, priority: "primary", state: "active", activeSlot: null },
    ]);
    await database.insert(careerDocuments).values({ id: documentId, userId, checksumSha256: "6".repeat(64), objectKey: "accounts/control/source.md", originalFilename: "source.md", mediaType: "text/markdown", byteSize: 1 });
    await database.insert(careerImports).values({ id: importId, userId, careerDocumentId: documentId, originatingRequestId: crypto.randomUUID() });
    await database.insert(candidateFacts).values({ id: factId, userId, careerImportId: importId, careerDocumentId: documentId, factKey: "7".repeat(64), factType: "skill", factValue: { name: "TypeScript" }, confidenceBasisPoints: 10_000 });
    await database.insert(recommendationLists).values([
      { id: todayFirstListId, userId, targetId: primaryTargetId, localDate: "2026-09-05", sequence: 1, createdAt: earlier },
      { id: todayLatestListId, userId, targetId: primaryTargetId, localDate: "2026-09-05", sequence: 2, createdAt: now },
      { id: todaySecondTargetListId, userId, targetId: secondaryTargetId, localDate: "2026-09-05", sequence: 1, createdAt: now },
      { id: yesterdayListId, userId, targetId: primaryTargetId, localDate: "2026-09-04", sequence: 1, createdAt: now },
      { id: crypto.randomUUID(), userId: otherUserId, targetId: otherTargetId, localDate: "2026-09-05", sequence: 1, createdAt: now },
    ]);

    const run = (id: string, status: "queued" | "running" | "paused" | "completed" | "failed") => ({
      id, userId, targetId: primaryTargetId, idempotencyKey: crypto.randomUUID(), targetVersion: 1, targetSnapshot: {}, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "v", ruleVersion: "v", adapter: "a", adapterVersion: "v", outputSchemaVersion: "v", toolAllowlist: [], status,
      currentStep: status === "completed" ? "completed" : status === "failed" ? "failed" : "queued",
      ...(status === "running" || status === "completed" || status === "failed" ? { startedAt: earlier } : {}),
      ...(status === "completed" ? { completedAt: now } : {}),
      ...(status === "failed" ? { failedAt: now } : {}),
    });
    await database.insert(agentRuns).values([
      run(crypto.randomUUID(), "queued"), run(crypto.randomUUID(), "running"), run(crypto.randomUUID(), "paused"), run(crypto.randomUUID(), "failed"), run(healthRunId, "completed"), run(latestHealthRunId, "completed"),
      { ...run(crypto.randomUUID(), "failed"), userId: otherUserId, targetId: otherTargetId },
    ]);

    const watchlistId = crypto.randomUUID();
    const item = (itemId: string, boardToken: string, state: "enabled" | "disabled", position: number) => ({ itemId, canonicalCompanyName: boardToken, careersUrl: `https://boards.greenhouse.io/${boardToken}`, allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null, state, position });
    await database.insert(companyWatchlists).values({ id: watchlistId, userId, targetId: primaryTargetId, version: 1, createdAt: earlier, updatedAt: now });
    await database.insert(companyWatchlistRevisions).values({ id: crypto.randomUUID(), userId, watchlistId, targetId: primaryTargetId, version: 1, items: [
      item(enabledRecoveredItemId, "recovered", "enabled", 1), item(enabledRateLimitedItemId, "limited", "enabled", 2), item(enabledParserItemId, "parser", "enabled", 3), item(disabledItemId, "disabled", "disabled", 4), item(enabledZeroResultItemId, "empty", "enabled", 5),
    ], createdAt: now });
    const health = (runId: string, watchlistItemId: string, boardToken: string, status: "healthy" | "zero_valid_results" | "parser_degraded" | "rate_limited" | "hard_failed", checkedAt: Date) => ({
      id: crypto.randomUUID(), userId, runId, targetId: primaryTargetId, watchlistItemId, sourceId: `greenhouse:${boardToken}`, status,
      reasonCodes: status === "parser_degraded" ? ["SOURCE_DETAIL_FIELDS_MISSING"] : status === "rate_limited" ? ["SOURCE_RATE_LIMITED"] : status === "hard_failed" ? ["SOURCE_SERVER_ERROR"] : [],
      impactScope: status === "healthy" || status === "zero_valid_results" ? "none" : "entire_source", impactAffectedCount: null,
      observedPostingCount: status === "healthy" ? 1 : 0, selectedDetailCount: status === "healthy" ? 1 : 0, validDetailCount: status === "healthy" ? 1 : 0, requestAttemptCount: 1, checkedAt,
    });
    await database.insert(jobSourceHealthChecks).values([
      health(healthRunId, enabledRecoveredItemId, "recovered", "hard_failed", earlier), health(latestHealthRunId, enabledRecoveredItemId, "recovered", "healthy", now), health(latestHealthRunId, enabledRateLimitedItemId, "limited", "rate_limited", now), health(latestHealthRunId, enabledParserItemId, "parser", "parser_degraded", now), health(latestHealthRunId, disabledItemId, "disabled", "hard_failed", now), health(latestHealthRunId, enabledZeroResultItemId, "empty", "zero_valid_results", now),
    ]);

    const pendingProposalId = crypto.randomUUID();
    const resolvedProposalId = crypto.randomUUID();
    await database.insert(calibrationProposals).values([
      { id: pendingProposalId, userId, targetId: primaryTargetId, reason: "SALARY", status: "pending", version: 1, createdAt: now, updatedAt: now },
      { id: resolvedProposalId, userId, targetId: primaryTargetId, reason: "LOCATION", status: "rejected", version: 2, resolvedAt: now, createdAt: earlier, updatedAt: now },
    ]);
    await database.insert(agentInboxItems).values([
      { id: crypto.randomUUID(), userId, candidateFactId: factId, kind: "candidate_fact", status: "unread", reasonCode: "CANDIDATE_FACT_PENDING", createdAt: now },
      { id: crypto.randomUUID(), userId, recommendationListId: todayLatestListId, kind: "recommendation_list", status: "read", reasonCode: "RECOMMENDATION_LIST_PUBLISHED", createdAt: earlier, readAt: now },
      { id: crypto.randomUUID(), userId, calibrationProposalId: resolvedProposalId, kind: "calibration_proposal", status: "resolved", reasonCode: "CALIBRATION_PROPOSAL_CREATED", createdAt: earlier, resolvedAt: now },
    ]);

    await expect(createWorkbenchHome({ db: database, clock: () => now })({ userId })).resolves.toEqual({
      account: { userId },
      summary: { todayRecommendations: 2, pendingFacts: 1, activeAgentRuns: 3, failedAgentRuns: 1, sourceFailures: 2, pendingDecisions: 2, applications: 0, applicationsAvailable: false },
    });
  });
});
