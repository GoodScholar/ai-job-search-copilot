import type { JobContentStore, JobImportQueue, createJobImportCommands, createJobImportQueries } from "@job-copilot/domain/job-imports";

export const JOB_CONTENT_STORE = Symbol("JOB_CONTENT_STORE");
export const JOB_IMPORT_QUEUE = Symbol("JOB_IMPORT_QUEUE");
export const JOB_IMPORT_COMMANDS = Symbol("JOB_IMPORT_COMMANDS");
export const JOB_IMPORT_QUERIES = Symbol("JOB_IMPORT_QUERIES");

export type JobImportCommands = ReturnType<typeof createJobImportCommands>;
export type JobImportQueries = ReturnType<typeof createJobImportQueries>;

export type { JobContentStore, JobImportQueue };
