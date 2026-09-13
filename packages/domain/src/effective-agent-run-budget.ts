import {
  AGENT_RUN_BUDGET,
  DEEP_MATCH_AGENT_RUN_BUDGET,
  DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION,
  GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION,
  GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION,
  PUBLIC_JOB_DISCOVERY_BUDGET,
} from "@job-copilot/contracts/agent-runs";
import { LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION } from "@job-copilot/contracts/job-discovery";
import type { BudgetDimension } from "./agent-run-lifecycle";

export type AgentRunBudget = {
  maxActiveDurationMs: number;
  maxAttempts: number;
  maxToolCalls: number;
  maxResults: number;
  maxModelCalls: number;
  maxTokens: number;
};

export type AgentRunBudgetDimension = BudgetDimension;
export type AgentRunBudgetUsage = {
  workflowVersion: string;
  budgetSnapshot: AgentRunBudget;
  attemptCount: number;
  activeDurationMs: number;
  toolCallCount: number;
  modelCallCount: number;
  totalTokenCount: number;
};
export type AgentRunBudgetReserve = {
  toolCalls?: number;
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  budgetTokens?: number;
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

function amount(value: number | undefined) { return value ?? 0; }

/** 保持 checkpoint 与发布前检查使用同一组有效预算边界。 */
export function exhaustedAgentRunBudget(run: AgentRunBudgetUsage, reserve: AgentRunBudgetReserve, activeDurationMs = 0): AgentRunBudgetDimension | null {
  const budget = effectiveAgentRunBudget(run.workflowVersion, run.budgetSnapshot);
  // attempt 是领取时预增的；第 3 次已合法领取，预算只阻止第 4 次领取。
  if (run.attemptCount > budget.maxAttempts) return "attempts";
  if (run.activeDurationMs + activeDurationMs >= budget.maxActiveDurationMs) return "active_duration";
  if (run.toolCallCount + amount(reserve.toolCalls) > budget.maxToolCalls) return "tool_calls";
  if (run.modelCallCount + amount(reserve.modelCalls) > budget.maxModelCalls) return "model_calls";
  if (run.totalTokenCount + amount(reserve.budgetTokens ?? (amount(reserve.inputTokens) + amount(reserve.outputTokens))) > budget.maxTokens) return "tokens";
  return null;
}
