import type { createJobOpportunityArchiveCommands, createJobOpportunityArchiveQueries } from "@job-copilot/domain/job-opportunity-archives";

export const JOB_OPPORTUNITY_ARCHIVE_COMMANDS = Symbol("JOB_OPPORTUNITY_ARCHIVE_COMMANDS");
export const JOB_OPPORTUNITY_ARCHIVE_QUERIES = Symbol("JOB_OPPORTUNITY_ARCHIVE_QUERIES");
export type JobOpportunityArchiveCommands = ReturnType<typeof createJobOpportunityArchiveCommands>;
export type JobOpportunityArchiveQueries = ReturnType<typeof createJobOpportunityArchiveQueries>;
