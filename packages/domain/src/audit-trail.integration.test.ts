import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, jobAccounts, migrateDatabase, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";

const userId = "8cf9ef56-08fd-4465-b4c7-4c713d0d80a5";
const requestId = "adfbd5ec-4b3a-4b63-af71-f1635205704c";
const now = new Date("2026-08-26T12:00:00.000Z");

describe("audit trail", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
    await database.insert(jobAccounts).values({ id: userId });
  }, 60_000);

  afterAll(async () => {
    await database?.$client.end();
    await container?.stop();
  });

  it("rejects sensitive metadata instead of storing it", async () => {
    const auditTrail = createAuditTrail({ db: database, clock: () => now });

    await expect(auditTrail.append({
      userId,
      eventType: "auth.session_started",
      outcome: "success",
      requestId,
      metadata: { sessionToken: "must-not-be-stored" },
    })).rejects.toThrow(/敏感审计字段/);
  });

  it("stores and returns a redacted audit event", async () => {
    const auditTrail = createAuditTrail({ db: database, clock: () => now });

    await auditTrail.append({
      userId,
      actorUserId: userId,
      eventType: "auth.session_started",
      outcome: "success",
      reasonCode: "AUTH_SESSION_STARTED",
      requestId,
      resourceType: "session",
      metadata: { provider: "dev", attempts: 1, trusted: true },
    });

    await expect(auditTrail.query({ userId })).resolves.toEqual([expect.objectContaining({
      userId,
      actorUserId: userId,
      eventType: "auth.session_started",
      outcome: "success",
      reasonCode: "AUTH_SESSION_STARTED",
      requestId,
      metadata: { provider: "dev", attempts: 1, trusted: true },
      occurredAt: now,
    })]);
  });
});
