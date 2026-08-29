import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  candidateFacts,
  careerDocuments,
  careerImports,
  createDatabase,
  jobAccounts,
  agentRuns,
  jobTargets,
  migrateDatabase,
  type Database,
} from "@job-copilot/database";
import { createWorkbenchHome } from "./workbench-home";

const activeUserId = "a3f3eb12-c92c-4582-b73c-8f2bf764b444";
const inactiveUserId = "af4ff7c6-4b16-46d3-afc2-e9d4a93e8a9e";
const secondActiveUserId = "922dee86-f382-4a2f-a7af-fbf744b67b2b";

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
    const getWorkbenchHome = createWorkbenchHome({ db: database });
    await expect(getWorkbenchHome({ userId: activeUserId })).resolves.toEqual({
      account: { userId: activeUserId },
      summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
    });
  });

  it("uses the domain account-not-found code for missing or inactive accounts", async () => {
    const getWorkbenchHome = createWorkbenchHome({ db: database });
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

    const getWorkbenchHome = createWorkbenchHome({ db: database });
    await expect(getWorkbenchHome({ userId: activeUserId })).resolves.toEqual({
      account: { userId: activeUserId },
      summary: { recommendations: 0, pendingFacts: 2, runningAgentRuns: 0, applications: 0 },
    });
    await expect(getWorkbenchHome({ userId: secondActiveUserId })).resolves.toEqual({
      account: { userId: secondActiveUserId },
      summary: { recommendations: 0, pendingFacts: 1, runningAgentRuns: 0, applications: 0 },
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
    await expect(createWorkbenchHome({ db: database })({ userId: activeUserId })).resolves.toMatchObject({ summary: { runningAgentRuns: 2 } });
  });
});
