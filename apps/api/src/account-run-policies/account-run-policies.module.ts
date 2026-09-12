import { MiddlewareConsumer, Module, NestModule, RequestMethod } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import { createAccountRunPolicies } from "@job-copilot/domain/account-run-policies";
import { createAccountRunControl } from "@job-copilot/domain/account-run-control";
import type { AuditTrail } from "@job-copilot/domain/audit-trail";
import { AuthModule, AUDIT_TRAIL } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { AccountRunPoliciesController } from "./account-run-policies.controller.js";
import { ACCOUNT_RUN_CONTROL, ACCOUNT_RUN_POLICIES } from "./account-run-policies.tokens.js";
@Module({ imports: [RuntimeConfigModule, AuthModule], controllers: [AccountRunPoliciesController], providers: [
  { provide: ACCOUNT_RUN_POLICIES, inject: [DATABASE], useFactory: (db: Database) => createAccountRunPolicies({ db, id: () => crypto.randomUUID(), clock: () => new Date() }) },
  { provide: ACCOUNT_RUN_CONTROL, inject: [DATABASE, AUDIT_TRAIL], useFactory: (db: Database, auditTrail: AuditTrail) => createAccountRunControl({ db, auditTrail, id: () => crypto.randomUUID(), clock: () => new Date() }) },
] })
export class AccountRunPoliciesModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_request: unknown, response: { setHeader(name: string, value: string): void }, next: () => void) => {
        response.setHeader("Cache-Control", "no-store");
        next();
      })
      .forRoutes(
        { path: "v1/account/run-policy/control", method: RequestMethod.ALL },
        { path: "v1/account/run-policy/controls", method: RequestMethod.ALL },
      );
  }
}
