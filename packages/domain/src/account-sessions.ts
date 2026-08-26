import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { externalIdentities, jobAccounts, sessions, type Database } from "@job-copilot/database";
import { z } from "zod";
import type { AuditTrail } from "./audit-trail";

export type StartedSession = {
  account: { userId: string };
  sessionToken: string;
  expiresAt: Date;
};

export type AuthenticatedAccount = { userId: string };

const RequestIdSchema = z.uuid();

function hashSessionToken(sessionToken: string): string {
  return createHash("sha256").update(sessionToken).digest("hex");
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

function validateRequestId(requestId: string): void {
  if (!RequestIdSchema.safeParse(requestId).success) {
    throw new Error("requestId 必须是 UUID");
  }
}

export function createAccountSessions(input: {
  db: Database;
  tokenSource: () => string;
  sessionTtlMs: number;
  auditTrail: AuditTrail;
}): {
  startDevSession(input: { subject: string; now: Date; requestId: string }): Promise<StartedSession>;
  authenticateSession(input: {
    sessionToken: string;
    now: Date;
    requestId: string;
  }): Promise<AuthenticatedAccount | null>;
  endSession(input: { sessionToken: string; now: Date; requestId: string }): Promise<void>;
} {
  return {
    async startDevSession({ subject, now, requestId }): Promise<StartedSession> {
      validateRequestId(requestId);
      const sessionToken = input.tokenSource();
      const expiresAt = new Date(now.getTime() + input.sessionTtlMs);
      const tokenHash = hashSessionToken(sessionToken);

      const account = await input.db.transaction(async (transaction) => {
        const createdUserId = randomUUID();
        await transaction.insert(jobAccounts).values({ id: createdUserId, status: "active" });
        const [identity] = await transaction.insert(externalIdentities)
          .values({ provider: "dev", subject, userId: createdUserId })
          .onConflictDoUpdate({
            target: [externalIdentities.provider, externalIdentities.subject],
            set: { subject },
          })
          .returning({ userId: externalIdentities.userId });
        if (!identity) {
          throw new Error("无法创建外部身份");
        }
        if (identity.userId !== createdUserId) {
          await transaction.delete(jobAccounts).where(eq(jobAccounts.id, createdUserId));
        }

        await transaction.insert(sessions).values({ userId: identity.userId, tokenHash, expiresAt });
        await input.auditTrail.bind(transaction).append({
          userId: identity.userId,
          actorUserId: identity.userId,
          eventType: "auth.session_started",
          occurredAt: now,
          requestId,
          outcome: "success",
          reasonCode: "AUTH_SESSION_STARTED",
          resourceType: "session",
          metadata: { provider: "dev" },
        });
        return { userId: identity.userId };
      });

      return { account, sessionToken, expiresAt };
    },

    async authenticateSession({ sessionToken, now, requestId }): Promise<AuthenticatedAccount | null> {
      validateRequestId(requestId);
      const tokenHash = hashSessionToken(sessionToken);
      const [session] = await input.db.select({
        userId: sessions.userId,
        revokedAt: sessions.revokedAt,
        expiresAt: sessions.expiresAt,
        accountStatus: jobAccounts.status,
      })
        .from(sessions)
        .innerJoin(jobAccounts, eq(jobAccounts.id, sessions.userId))
        .where(eq(sessions.tokenHash, tokenHash));

      if (!session) {
        await input.auditTrail.append({
          eventType: "auth.session_rejected",
          occurredAt: now,
          requestId,
          outcome: "denied",
          reasonCode: "AUTH_SESSION_NOT_FOUND",
          resourceType: "session",
          metadata: {},
        });
        return null;
      }
      if (session.revokedAt) {
        await input.auditTrail.append({
          userId: session.userId,
          actorUserId: session.userId,
          eventType: "auth.session_rejected",
          occurredAt: now,
          requestId,
          outcome: "denied",
          reasonCode: "AUTH_SESSION_REVOKED",
          resourceType: "session",
          metadata: {},
        });
        return null;
      }
      if (session.expiresAt <= now) {
        await input.auditTrail.append({
          userId: session.userId,
          actorUserId: session.userId,
          eventType: "auth.session_rejected",
          occurredAt: now,
          requestId,
          outcome: "denied",
          reasonCode: "AUTH_SESSION_EXPIRED",
          resourceType: "session",
          metadata: {},
        });
        return null;
      }
      if (session.accountStatus !== "active") {
        await input.auditTrail.append({
          userId: session.userId,
          actorUserId: session.userId,
          eventType: "auth.session_rejected",
          occurredAt: now,
          requestId,
          outcome: "denied",
          reasonCode: "AUTH_ACCOUNT_INACTIVE",
          resourceType: "session",
          metadata: {},
        });
        return null;
      }

      return { userId: session.userId };
    },

    async endSession({ sessionToken, now, requestId }): Promise<void> {
      validateRequestId(requestId);
      const tokenHash = hashSessionToken(sessionToken);
      const [revokedSession] = await input.db.update(sessions).set({ revokedAt: now })
        .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
        .returning({ userId: sessions.userId });

      if (!revokedSession) {
        return;
      }

      await input.auditTrail.append({
        userId: revokedSession.userId,
        actorUserId: revokedSession.userId,
        eventType: "auth.session_ended",
        occurredAt: now,
        requestId,
        outcome: "success",
        reasonCode: "AUTH_SESSION_ENDED",
        resourceType: "session",
        metadata: {},
      });
    },
  };
}
