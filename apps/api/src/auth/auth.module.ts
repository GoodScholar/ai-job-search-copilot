import { Module } from "@nestjs/common";
import { createAccountSessions, createSessionToken } from "@job-copilot/domain/account-sessions";
import { createAuditTrail, type AuditTrail } from "@job-copilot/domain/audit-trail";
import type { Database } from "@job-copilot/database";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { AuthController } from "./auth.controller.js";
import { ACCOUNT_SESSIONS, type AccountSessions } from "./auth.tokens.js";
import { SessionGuard } from "./session.guard.js";

export const AUDIT_TRAIL = Symbol("AUDIT_TRAIL");

@Module({
  imports: [RuntimeConfigModule],
  controllers: [AuthController],
  providers: [
    {
      provide: AUDIT_TRAIL,
      inject: [DATABASE],
      useFactory: (database: Database): AuditTrail => createAuditTrail({
        db: database,
        clock: () => new Date(),
      }),
    },
    {
      provide: ACCOUNT_SESSIONS,
      inject: [DATABASE, AUDIT_TRAIL],
      useFactory: (database: Database, auditTrail: AuditTrail): AccountSessions => createAccountSessions({
        db: database,
        tokenSource: createSessionToken,
        sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
        auditTrail,
      }),
    },
    SessionGuard,
  ],
  exports: [ACCOUNT_SESSIONS, AUDIT_TRAIL, SessionGuard],
})
export class AuthModule {}
