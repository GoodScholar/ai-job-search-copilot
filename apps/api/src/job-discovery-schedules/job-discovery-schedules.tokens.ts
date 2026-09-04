import type { createJobDiscoverySchedules } from "@job-copilot/domain/job-discovery-schedules";

export const JOB_DISCOVERY_SCHEDULES = Symbol("JOB_DISCOVERY_SCHEDULES");
export type JobDiscoverySchedules = ReturnType<typeof createJobDiscoverySchedules>;
