import type { CompanyWatchlistCommands, CompanyWatchlistQueries } from "@job-copilot/domain/company-watchlists";

export const COMPANY_WATCHLIST_COMMANDS = Symbol("COMPANY_WATCHLIST_COMMANDS");
export const COMPANY_WATCHLIST_QUERIES = Symbol("COMPANY_WATCHLIST_QUERIES");

export type { CompanyWatchlistCommands, CompanyWatchlistQueries };
