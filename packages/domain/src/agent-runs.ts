import { agentRuns, type Database } from "@job-copilot/database";
import { and, eq } from "drizzle-orm";
import type { AuditTrail } from "./audit-trail";
import { createAgentRunCheckpoint, type AgentRunCheckpoint } from "./agent-run-checkpoint";
import { createAgentRunProcessor as createDomainAgentRunProcessor, type AgentRunProcessorDependencies, type DiscoveryContentStore, type JobDiscoveryAdapter, type JobDiscoveryAdapterResolver } from "./agent-run-processor";
import { createDeepMatchRunProcessor } from "./deep-match-agent-runs";

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
export type {
  SourceHealthAdapterFailure,
  SourceHealthDetailResult,
  SourceHealthDiscoveryAdapter,
  SourceHealthDiscoveryAdapterResolver,
  SourceHealthListResult,
} from "./source-health-discovery-adapter";
export type {
  LayeredPublicJobDiscoveryWorkflow,
  LayeredPublicJobDiscoveryWorkflowResolver,
  LayeredPublicPhysicalOperation,
  LayeredPublicWorkflowDiagnostic,
  LayeredPublicWorkflowOutcome,
} from "./layered-public-job-discovery-workflow";
export { createLayeredPublicJobDiscoveryRuntime, type LayeredTrustedSourceAdapter } from "./layered-public-job-discovery-runtime";

type FacadeProcessorDependencies = Omit<AgentRunProcessorDependencies, "checkpoint"> & {
  checkpoint?: AgentRunCheckpoint;
};

export function createAgentRunProcessor(deps: FacadeProcessorDependencies) {
  const checkpoint = deps.checkpoint ?? createAgentRunCheckpoint({ db: deps.db as Database, auditTrail: deps.auditTrail as AuditTrail, id: deps.id, clock: deps.clock });
  const discovery = createDomainAgentRunProcessor({ ...deps, checkpoint });
  const matching = createDeepMatchRunProcessor({ db: deps.db as Database, id: deps.id, clock: deps.clock });
  return {
    async process(job: import("@job-copilot/contracts/agent-runs").AgentRunJob & { finalAttempt?: boolean }) {
      const [run] = await (deps.db as Database).select({ workflowVersion: agentRuns.workflowVersion }).from(agentRuns).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
      return run?.workflowVersion === "deep-match-v1" ? matching.process(job) : discovery.process(job);
    },
  };
}
