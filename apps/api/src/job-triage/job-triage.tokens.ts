import type { JobTriageCommands, JobTriageQueries } from "@job-copilot/domain/job-triage-persistence";

export const JOB_TRIAGE_COMMANDS = Symbol("JOB_TRIAGE_COMMANDS");
export const JOB_TRIAGE_QUERIES = Symbol("JOB_TRIAGE_QUERIES");

export type { JobTriageCommands, JobTriageQueries };
