import {
  AGENT_RUN_BUDGET,
  DEEP_MATCH_AGENT_RUN_BUDGET,
  DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION,
  GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION,
  GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION,
  PUBLIC_JOB_DISCOVERY_BUDGET,
} from "@job-copilot/contracts/agent-runs";
import { LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION } from "@job-copilot/contracts/job-discovery";

export type AgentRunBudget = {
  maxActiveDurationMs: number;
  maxAttempts: number;
  maxToolCalls: number;
  maxResults: number;
  maxModelCalls: number;
  maxTokens: number;
};

function hardBudget(workflowVersion: string): AgentRunBudget {
  if (workflowVersion === DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION) return DEEP_MATCH_AGENT_RUN_BUDGET;
  if (workflowVersion === GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION
    || workflowVersion === GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION
    || workflowVersion === LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION) return PUBLIC_JOB_DISCOVERY_BUDGET;
  return AGENT_RUN_BUDGET;
}

/** 历史快照保持可读；运行时永远不得超过当前系统硬上限。 */
export function effectiveAgentRunBudget(workflowVersion: string, snapshot: AgentRunBudget): AgentRunBudget {
  const hard = hardBudget(workflowVersion);
  return {
    maxActiveDurationMs: Math.min(snapshot.maxActiveDurationMs, hard.maxActiveDurationMs),
    maxAttempts: Math.min(snapshot.maxAttempts, hard.maxAttempts),
    maxToolCalls: Math.min(snapshot.maxToolCalls, hard.maxToolCalls),
    maxResults: Math.min(snapshot.maxResults, hard.maxResults),
    maxModelCalls: Math.min(snapshot.maxModelCalls, hard.maxModelCalls),
    maxTokens: Math.min(snapshot.maxTokens, hard.maxTokens),
  };
}
