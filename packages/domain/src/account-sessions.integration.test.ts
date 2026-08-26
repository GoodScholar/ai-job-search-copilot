import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditEvents,
  createDatabase,
  type Database,
  jobAccounts,
  migrateDatabase,
  sessions as sessionTable,
} from "@job-copilot/database";
import { createAccountSessions } from "./account-sessions";
import { createAuditTrail } from "./audit-trail";

const requestId = "18cd2fca-a70e-413a-8b83-9bea881370c4";
const nextRequestId = "6f361134-8fb3-4b75-a926-55412d9c40b9";
const revokedRequestId = "9d4f3d5e-d0e1-45c6-862f-17ce576d2f38";
const expiredRequestId = "1b73a8be-123d-4aec-9e92-c8ba18e20e41";
const unknownRequestId = "7cba4dd4-b316-4439-8b50-aa84696aa6b8";
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

  it("audits revoked, expired, and unknown session authentication without secrets", async () => {
    const tokens = ["rejected-revoked-session-token", "rejected-expired-session-token"];
    const sessions = createAccountSessions({
      db: database,
      tokenSource: () => tokens.shift()!,
      sessionTtlMs: 60_000,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
    });
    const revoked = await sessions.startDevSession({
      subject: "rejected-revoked",
      now,
      requestId,
    });
    await sessions.endSession({ sessionToken: revoked.sessionToken, now, requestId: nextRequestId });
    expect(await sessions.authenticateSession({
      sessionToken: revoked.sessionToken,
      now,
      requestId: revokedRequestId,
    })).toBeNull();

    const expired = await sessions.startDevSession({
      subject: "rejected-expired",
      now,
      requestId,
    });
    expect(await sessions.authenticateSession({
      sessionToken: expired.sessionToken,
      now: new Date(now.getTime() + 60_001),
      requestId: expiredRequestId,
    })).toBeNull();

    expect(await sessions.authenticateSession({
      sessionToken: "unknown-session-token",
      now,
      requestId: unknownRequestId,
    })).toBeNull();

    const rejectionEvents = await database.select({
      userId: auditEvents.userId,
      actorUserId: auditEvents.actorUserId,
      eventType: auditEvents.eventType,
      requestId: auditEvents.requestId,
      reasonCode: auditEvents.reasonCode,
      metadata: auditEvents.metadata,
    }).from(auditEvents).where(eq(auditEvents.eventType, "auth.session_rejected"));

    expect(rejectionEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userId: revoked.account.userId,
        actorUserId: revoked.account.userId,
        requestId: revokedRequestId,
        reasonCode: "AUTH_SESSION_REVOKED",
        metadata: {},
      }),
      expect.objectContaining({
        userId: expired.account.userId,
        actorUserId: expired.account.userId,
        requestId: expiredRequestId,
        reasonCode: "AUTH_SESSION_EXPIRED",
        metadata: {},
      }),
      expect.objectContaining({
        userId: null,
        actorUserId: null,
        requestId: unknownRequestId,
        reasonCode: "AUTH_SESSION_NOT_FOUND",
        metadata: {},
      }),
    ]));
  });

  it("rejects invalid request ids before changing session or audit state", async () => {
    const tokens = ["request-id-existing-session-token", "request-id-must-not-create-token"];
    const sessions = createAccountSessions({
      db: database,
      tokenSource: () => tokens.shift()!,
      sessionTtlMs: 60_000,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
    });
    const started = await sessions.startDevSession({
      subject: "request-id-validation",
      now,
      requestId,
    });
    const [accountsBefore, sessionsBefore, auditsBefore] = await Promise.all([
      database.select().from(jobAccounts),
      database.select().from(sessionTable),
      database.select().from(auditEvents),
    ]);

    await expect(sessions.startDevSession({
      subject: "must-not-create-account",
      now,
      requestId: "not-a-uuid",
    })).rejects.toThrow(/requestId/);
    await expect(sessions.authenticateSession({
      sessionToken: started.sessionToken,
      now,
      requestId: "not-a-uuid",
    })).rejects.toThrow(/requestId/);
    await expect(sessions.endSession({
      sessionToken: started.sessionToken,
      now,
      requestId: "not-a-uuid",
    })).rejects.toThrow(/requestId/);

    await expect(Promise.all([
      database.select().from(jobAccounts),
      database.select().from(sessionTable),
      database.select().from(auditEvents),
    ])).resolves.toEqual([accountsBefore, sessionsBefore, auditsBefore]);
  });
});
