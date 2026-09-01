import { Module } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import { createJobTriageCommands, createJobTriageQueries } from "@job-copilot/domain/job-triage-persistence";
import { AuthModule, AUDIT_TRAIL } from "../auth/auth.module.js";
import type { AuditTrail } from "@job-copilot/domain/audit-trail";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { JobTriageController } from "./job-triage.controller.js";
import { JOB_TRIAGE_COMMANDS, JOB_TRIAGE_QUERIES } from "./job-triage.tokens.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule], controllers: [JobTriageController],
  providers: [
    { provide: JOB_TRIAGE_COMMANDS, inject: [DATABASE, AUDIT_TRAIL], useFactory: (db: Database, auditTrail: AuditTrail) => createJobTriageCommands({ db, auditTrail, id: () => crypto.randomUUID(), clock: () => new Date() }) },
    { provide: JOB_TRIAGE_QUERIES, inject: [DATABASE], useFactory: (db: Database) => createJobTriageQueries({ db }) },
  ],
})
export class JobTriageModule {}
