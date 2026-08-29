import type { Database } from "@job-copilot/database";
import type { AuditTrail } from "./audit-trail";
import { createAgentRunCheckpoint, type AgentRunCheckpoint } from "./agent-run-checkpoint";
import { createAgentRunProcessor as createDomainAgentRunProcessor, type AgentRunProcessorDependencies, type DiscoveryContentStore, type JobDiscoveryAdapter, type JobDiscoveryAdapterResolver } from "./agent-run-processor";

/** Agent run public facade. Execution stays in `agent-run-processor`. */
export {
  canonicalJsonBytes,
  canonicalJsonSha256,
  createAgentRunRecoveryQueries,
  discoverySourceIdentifier,
  type AgentRunProcessorDependencies,
  type DiscoveryContentStore,
  type JobDiscoveryAdapter,
  type JobDiscoveryAdapterResolver,
  type PublicDiscoveryBatchSearchInput,
} from "./agent-run-processor";
export { AgentRunControlError, AgentRunError, createAgentRunCommands, type AgentRunQueue, type AgentRunStarter } from "./agent-run-control";
export { createAgentRunCheckpoint, type AgentRunCheckpoint, type AgentRunCheckpointDecision } from "./agent-run-checkpoint";
export { createAgentRunQueries } from "./agent-run-queries";
export { AgentInboxActionError, AgentInboxError, createAgentInbox } from "./agent-inbox";

type FacadeProcessorDependencies = Omit<AgentRunProcessorDependencies, "checkpoint"> & {
  checkpoint?: AgentRunCheckpoint;
};

export function createAgentRunProcessor(deps: FacadeProcessorDependencies) {
  const checkpoint = deps.checkpoint ?? createAgentRunCheckpoint({ db: deps.db as Database, auditTrail: deps.auditTrail as AuditTrail, id: deps.id, clock: deps.clock });
  return createDomainAgentRunProcessor({ ...deps, checkpoint });
}
