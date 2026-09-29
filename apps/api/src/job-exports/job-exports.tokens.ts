import type { createJobExportCommands, createJobExportQueries, JobExportQueue, JobExportStore } from "@job-copilot/domain/job-exports";

export const JOB_EXPORT_COMMANDS = Symbol("JOB_EXPORT_COMMANDS");
export const JOB_EXPORT_QUERIES = Symbol("JOB_EXPORT_QUERIES");
export const JOB_EXPORT_QUEUE = Symbol("JOB_EXPORT_QUEUE");
export const JOB_EXPORT_STORE = Symbol("JOB_EXPORT_STORE");
export type JobExportCommands = ReturnType<typeof createJobExportCommands>;
export type JobExportQueries = ReturnType<typeof createJobExportQueries>;
export type { JobExportQueue, JobExportStore };
