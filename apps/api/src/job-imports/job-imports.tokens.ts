import type { JobContentStore, JobImportQueue, createJobImportCommands, createJobImportQueries } from "@job-copilot/domain/job-imports";
import type { JobPageFetcher } from "./job-page-fetcher.js";

export const JOB_CONTENT_STORE = Symbol("JOB_CONTENT_STORE");
export const JOB_IMPORT_QUEUE = Symbol("JOB_IMPORT_QUEUE");
export const JOB_IMPORT_COMMANDS = Symbol("JOB_IMPORT_COMMANDS");
export const JOB_IMPORT_QUERIES = Symbol("JOB_IMPORT_QUERIES");
export const JOB_PAGE_FETCHER = Symbol("JOB_PAGE_FETCHER");

export type JobImportCommands = ReturnType<typeof createJobImportCommands>;
export type JobImportQueries = ReturnType<typeof createJobImportQueries>;
export type { JobPageFetcher };

export type { JobContentStore, JobImportQueue };
