import { Module } from "@nestjs/common";
import { type Database } from "@job-copilot/database";
import { type AuditTrail } from "@job-copilot/domain/audit-trail";
import { createJobTargetCommands, createJobTargetQueries } from "@job-copilot/domain/job-targets";
import { AuthModule, AUDIT_TRAIL } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { JobTargetsController } from "./job-targets.controller.js";
import { JOB_TARGET_COMMANDS, JOB_TARGET_QUERIES } from "./job-targets.tokens.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule],
  controllers: [JobTargetsController],
  providers: [
    {
      provide: JOB_TARGET_COMMANDS,
      inject: [DATABASE, AUDIT_TRAIL],
      useFactory: (db: Database, auditTrail: AuditTrail) => createJobTargetCommands({
        db, auditTrail, id: () => crypto.randomUUID(), clock: () => new Date(),
      }),
    },
    {
      provide: JOB_TARGET_QUERIES,
      inject: [DATABASE],
      useFactory: (db: Database) => createJobTargetQueries({ db }),
    },
  ],
})
export class JobTargetsModule {}
