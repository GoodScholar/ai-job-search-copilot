import { Module } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import { createAccountRunPolicies } from "@job-copilot/domain/account-run-policies";
import { AuthModule } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { AccountRunPoliciesController } from "./account-run-policies.controller.js";
import { ACCOUNT_RUN_POLICIES } from "./account-run-policies.tokens.js";
@Module({ imports: [RuntimeConfigModule, AuthModule], controllers: [AccountRunPoliciesController], providers: [{ provide: ACCOUNT_RUN_POLICIES, inject: [DATABASE], useFactory: (db: Database) => createAccountRunPolicies({ db, id: () => crypto.randomUUID(), clock: () => new Date() }) }] })
export class AccountRunPoliciesModule {}
