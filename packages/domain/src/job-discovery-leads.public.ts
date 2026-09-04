import { createJobDiscoveryLeadRepository as createInternalRepository } from "./job-discovery-leads";

export { JobDiscoveryLeadError } from "./job-discovery-leads";

/** Package consumers retain the ordinary Lead API; claim authority stays on the v4 internal seam. */
export function createJobDiscoveryLeadRepository(input: Parameters<typeof createInternalRepository>[0]) {
  const repository = createInternalRepository(input);
  return {
    recordPending: repository.recordPending,
    getLead: repository.getLead,
    getAttribution: repository.getAttribution,
  };
}
