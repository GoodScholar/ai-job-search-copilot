import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, jobAccounts, migrateDatabase, type Database } from "@job-copilot/database";
import { createWorkbenchHome } from "./workbench-home";

const activeUserId = "a3f3eb12-c92c-4582-b73c-8f2bf764b444";
const inactiveUserId = "af4ff7c6-4b16-46d3-afc2-e9d4a93e8a9e";

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
});
