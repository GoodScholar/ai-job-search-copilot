import { Module } from "@nestjs/common";
import { createProfileReviewCommands, createTrustedProfileQueries } from "@job-copilot/domain/profile-review";
import type { AuditTrail } from "@job-copilot/domain/audit-trail";
import type { Database } from "@job-copilot/database";
import { AuthModule, AUDIT_TRAIL } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { ProfileReviewController } from "./profile-review.controller.js";
import { PROFILE_REVIEW_COMMANDS, TRUSTED_PROFILE_QUERIES } from "./profile-review.tokens.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule],
  controllers: [ProfileReviewController],
  providers: [
    {
      provide: PROFILE_REVIEW_COMMANDS,
      inject: [DATABASE, AUDIT_TRAIL],
      useFactory: (db: Database, auditTrail: AuditTrail) => createProfileReviewCommands({
        db, auditTrail, id: () => crypto.randomUUID(), clock: () => new Date(),
      }),
    },
    {
      provide: TRUSTED_PROFILE_QUERIES,
      inject: [DATABASE],
      useFactory: (db: Database) => createTrustedProfileQueries({ db }),
    },
  ],
})
export class ProfileReviewModule {}
