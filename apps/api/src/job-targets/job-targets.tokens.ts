import type { JobTargetCommands, JobTargetQueries } from "@job-copilot/domain/job-targets";

export const JOB_TARGET_COMMANDS = Symbol("JOB_TARGET_COMMANDS");
export const JOB_TARGET_QUERIES = Symbol("JOB_TARGET_QUERIES");

export type { JobTargetCommands, JobTargetQueries };
