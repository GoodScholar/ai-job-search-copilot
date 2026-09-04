import { Module } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import type { AuditTrail } from "@job-copilot/domain/audit-trail";
import { createCompanyWatchlistCommands, createCompanyWatchlistQueries } from "@job-copilot/domain/company-watchlists";
import { createSourceHealthQueries } from "@job-copilot/domain/source-health";
import { AuthModule, AUDIT_TRAIL } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { CompanyWatchlistsController } from "./company-watchlists.controller.js";
import { SourceHealthController } from "./source-health.controller.js";
import { COMPANY_WATCHLIST_COMMANDS, COMPANY_WATCHLIST_QUERIES, SOURCE_HEALTH_QUERIES } from "./company-watchlists.tokens.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule],
  controllers: [CompanyWatchlistsController, SourceHealthController],
  providers: [
    {
      provide: COMPANY_WATCHLIST_COMMANDS,
      inject: [DATABASE, AUDIT_TRAIL],
      useFactory: (db: Database, auditTrail: AuditTrail) => createCompanyWatchlistCommands({
        db, auditTrail, id: () => crypto.randomUUID(), clock: () => new Date(),
      }),
    },
    {
      provide: COMPANY_WATCHLIST_QUERIES,
      inject: [DATABASE],
      useFactory: (db: Database) => createCompanyWatchlistQueries({ db }),
    },
    { provide: SOURCE_HEALTH_QUERIES, inject: [DATABASE], useFactory: (db: Database) => createSourceHealthQueries({ db }) },
  ],
})
export class CompanyWatchlistsModule {}
