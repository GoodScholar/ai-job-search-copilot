import type { AuthenticatedAccount, StartedSession } from "@job-copilot/domain/account-sessions";

export const ACCOUNT_SESSIONS = Symbol("ACCOUNT_SESSIONS");

export type AccountSessions = {
  startDevSession(input: { subject: string; now: Date; requestId: string }): Promise<StartedSession>;
  authenticateSession(input: { sessionToken: string; now: Date; requestId: string }): Promise<AuthenticatedAccount | null>;
  endSession(input: { sessionToken: string; now: Date; requestId: string }): Promise<void>;
};
