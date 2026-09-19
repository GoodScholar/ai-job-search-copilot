import { Module } from "@nestjs/common";
import { type Database } from "@job-copilot/database";
import { createJobOpportunityArchiveCommands, createJobOpportunityArchiveQueries } from "@job-copilot/domain/job-opportunity-archives";
import { type AuditTrail } from "@job-copilot/domain/audit-trail";
import { AuthModule, AUDIT_TRAIL } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { JobOpportunityArchivesController } from "./job-opportunity-archives.controller.js";
import { JOB_OPPORTUNITY_ARCHIVE_COMMANDS, JOB_OPPORTUNITY_ARCHIVE_QUERIES } from "./job-opportunity-archives.tokens.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule],
  controllers: [JobOpportunityArchivesController],
  providers: [
    { provide: JOB_OPPORTUNITY_ARCHIVE_COMMANDS, inject: [DATABASE, AUDIT_TRAIL], useFactory: (db: Database, auditTrail: AuditTrail) => createJobOpportunityArchiveCommands({ db, auditTrail, clock: () => new Date() }) },
    { provide: JOB_OPPORTUNITY_ARCHIVE_QUERIES, inject: [DATABASE], useFactory: (db: Database) => createJobOpportunityArchiveQueries({ db }) },
  ],
})
export class JobOpportunityArchivesModule {}
