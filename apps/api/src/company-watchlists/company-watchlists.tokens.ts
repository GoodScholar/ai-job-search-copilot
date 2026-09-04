import type { CompanyWatchlistCommands, CompanyWatchlistQueries } from "@job-copilot/domain/company-watchlists";
import type { SourceCapabilityProjectionQueries } from "@job-copilot/domain/source-capability-projections";

export const COMPANY_WATCHLIST_COMMANDS = Symbol("COMPANY_WATCHLIST_COMMANDS");
export const COMPANY_WATCHLIST_QUERIES = Symbol("COMPANY_WATCHLIST_QUERIES");
export const SOURCE_HEALTH_QUERIES = Symbol("SOURCE_HEALTH_QUERIES");
export const SOURCE_CAPABILITY_PROJECTION_QUERIES = Symbol("SOURCE_CAPABILITY_PROJECTION_QUERIES");

export type { CompanyWatchlistCommands, CompanyWatchlistQueries };
export type { SourceCapabilityProjectionQueries };
