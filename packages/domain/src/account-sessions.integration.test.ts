import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database, migrateDatabase, sessions as sessionTable } from "@job-copilot/database";
import { createAccountSessions } from "./account-sessions";
import { createAuditTrail } from "./audit-trail";

const requestId = "18cd2fca-a70e-413a-8b83-9bea881370c4";
const nextRequestId = "6f361134-8fb3-4b75-a926-55412d9c40b9";
const now = new Date("2026-08-26T12:00:00.000Z");

describe("account sessions", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);

  afterAll(async () => {
    await database?.$client.end();
    await container?.stop();
  });

  it("reuses the account but creates independently revocable sessions", async () => {
    const tokens = ["first-session-token", "second-session-token"];
    const sessions = createAccountSessions({
      db: database,
      tokenSource: () => tokens.shift()!,
      sessionTtlMs: 60_000,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
    });

    const first = await sessions.startDevSession({ subject: "local-primary", now, requestId });
    const second = await sessions.startDevSession({
      subject: "local-primary",
      now,
      requestId: nextRequestId,
    });

    expect(second.account.userId).toBe(first.account.userId);
    expect(second.sessionToken).not.toBe(first.sessionToken);
    expect(await sessions.authenticateSession({
      sessionToken: first.sessionToken,
      now,
      requestId,
    })).toEqual({ userId: first.account.userId });

    await sessions.endSession({ sessionToken: first.sessionToken, now, requestId: nextRequestId });
    expect(await sessions.authenticateSession({
      sessionToken: first.sessionToken,
      now,
      requestId,
    })).toBeNull();
    expect(await sessions.authenticateSession({
      sessionToken: second.sessionToken,
      now,
      requestId: nextRequestId,
    })).toEqual({ userId: first.account.userId });

    const [storedSession] = await database.select().from(sessionTable)
      .where(eq(sessionTable.userId, first.account.userId));
    expect(storedSession?.tokenHash).not.toBe(first.sessionToken);
    expect(storedSession?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects an expired session", async () => {
    const sessions = createAccountSessions({
      db: database,
      tokenSource: () => "expired-session-token",
      sessionTtlMs: 60_000,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
    });
    const started = await sessions.startDevSession({
      subject: "expires-soon",
      now,
      requestId,
    });

    await expect(sessions.authenticateSession({
      sessionToken: started.sessionToken,
      now: new Date(now.getTime() + 60_001),
      requestId: nextRequestId,
    })).resolves.toBeNull();
  });
});
