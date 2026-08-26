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

  it("rejects metadata outside the event-specific allowlist instead of storing it", async () => {
    const auditTrail = createAuditTrail({ db: database, clock: () => now });

    await expect(auditTrail.append({
      userId,
      eventType: "auth.session_started",
      outcome: "success",
      requestId,
      reasonCode: "AUTH_SESSION_STARTED",
      resourceType: "session",
      metadata: { sessionToken: "must-not-be-stored" } as never,
    })).rejects.toThrow(/字段白名单/);
  });

  it("accepts only the metadata shape assigned to each approved event", async () => {
    const auditTrail = createAuditTrail({ db: database, clock: () => now });

    await auditTrail.append({
      userId,
      actorUserId: userId,
      eventType: "auth.session_started",
      outcome: "success",
      reasonCode: "AUTH_SESSION_STARTED",
      requestId,
      resourceType: "session",
      metadata: { provider: "dev" },
    });

    await auditTrail.append({
      userId,
      actorUserId: userId,
      eventType: "auth.session_ended",
      outcome: "success",
      reasonCode: "AUTH_SESSION_ENDED",
      requestId: "2d5d9ef3-0b02-4514-9f1a-7cda8e3f1736",
      resourceType: "session",
      metadata: {},
    });
    await auditTrail.append({
      userId,
      actorUserId: userId,
      eventType: "auth.session_rejected",
      outcome: "denied",
      reasonCode: "AUTH_SESSION_REVOKED",
      requestId: "54b36840-180d-4344-87c1-f414f79ef70b",
      resourceType: "session",
      metadata: {},
    });
    await auditTrail.append({
      userId,
      actorUserId: userId,
      eventType: "account.access_rejected",
      outcome: "denied",
      reasonCode: "ACCOUNT_NOT_FOUND",
      requestId: "b9bbd306-e072-4e86-9019-6c49d3d0f751",
      resourceType: "account",
      resourceId: "b016711c-9834-43d6-a3cb-859880710b61",
      metadata: {},
    });

    await expect(auditTrail.append({
      userId,
      eventType: "auth.session_ended",
      outcome: "success",
      requestId: "949434d5-96a8-43e8-8e94-644248583da3",
      reasonCode: "AUTH_SESSION_ENDED",
      resourceType: "session",
      metadata: { provider: "dev" } as never,
    })).rejects.toThrow(/字段白名单/);

    await expect(auditTrail.query({ userId })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({
      userId,
      actorUserId: userId,
      eventType: "auth.session_started",
      outcome: "success",
      reasonCode: "AUTH_SESSION_STARTED",
      requestId,
      metadata: { provider: "dev" },
      occurredAt: now,
    })]));
  });
});
