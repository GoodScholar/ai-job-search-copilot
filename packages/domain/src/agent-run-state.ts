type Status = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
type ControlState = "none" | "pause_requested" | "cancel_requested";
type Action = "pause" | "resume" | "cancel";

export function reduceControl(state: { status: Status; controlState: ControlState }, action: Action) {
  if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") return action === "cancel" && state.status === "cancelled" ? { kind: "no_change" as const } : { kind: "conflict" as const, code: "AGENT_RUN_CONTROL_CONFLICT" as const };
  if (state.controlState === "cancel_requested") return action === "cancel" ? { kind: "no_change" as const } : { kind: "conflict" as const, code: "AGENT_RUN_CONTROL_CONFLICT" as const };
  if (action === "pause") return state.status === "queued" ? { kind: "transition" as const, status: "paused" as const, controlState: "none" as const, eventType: "run.paused" as const } : state.status === "paused" || state.controlState === "pause_requested" ? { kind: "no_change" as const } : { kind: "transition" as const, status: "running" as const, controlState: "pause_requested" as const, eventType: "run.pause_requested" as const };
  if (action === "resume") return state.status === "paused" ? { kind: "transition" as const, status: "queued" as const, controlState: "none" as const, eventType: "run.resumed" as const } : state.controlState === "pause_requested" ? { kind: "transition" as const, status: "running" as const, controlState: "none" as const, eventType: "run.resume_requested" as const } : { kind: "no_change" as const };
  return state.status === "running" ? { kind: "transition" as const, status: "running" as const, controlState: "cancel_requested" as const, eventType: "run.cancel_requested" as const } : { kind: "transition" as const, status: "cancelled" as const, controlState: "none" as const, eventType: "run.cancelled" as const };
}

export function decideRetry(input: {
  failure: { category: "source" | "model" | "model_auth" | "model_policy" | "model_invalid"; retryable: boolean };
  usage: { attempts: number; activeDurationMs: number; toolCalls?: number; modelCalls?: number; totalTokens?: number };
  budget: { maxAttempts: number; maxActiveDurationMs: number; maxToolCalls?: number; maxModelCalls?: number; maxTokens?: number };
  reserve?: { toolCalls?: number; sourceRequests?: number; modelCalls?: number; tokens?: number };
}) {
  if (input.failure.category === "model_auth") return { kind: "fail" as const, failureCode: "AGENT_RUN_MODEL_AUTH_FAILED" as const };
  if (input.failure.category === "model_policy") return { kind: "fail" as const, failureCode: "AGENT_RUN_MODEL_POLICY_REJECTED" as const };
  if (input.failure.category === "model_invalid") return { kind: "fail" as const, failureCode: "AGENT_RUN_MODEL_INVALID_RESPONSE" as const };
  if (!input.failure.retryable) return { kind: "fail" as const, failureCode: "AGENT_RUN_ADAPTER_FAILED" as const };
  if (input.usage.attempts >= input.budget.maxAttempts) return { kind: "budget_exhausted" as const, budgetDimension: "attempts" as const };
  if (input.usage.activeDurationMs >= input.budget.maxActiveDurationMs) return { kind: "budget_exhausted" as const, budgetDimension: "active_duration" as const };
  const toolCalls = input.usage.toolCalls ?? 0;
  const modelCalls = input.usage.modelCalls ?? 0;
  const totalTokens = input.usage.totalTokens ?? 0;
  if (toolCalls + (input.reserve?.toolCalls ?? 0) > (input.budget.maxToolCalls ?? Infinity)) return { kind: "budget_exhausted" as const, budgetDimension: "tool_calls" as const };
  if (modelCalls + (input.reserve?.modelCalls ?? 0) > (input.budget.maxModelCalls ?? Infinity)) return { kind: "budget_exhausted" as const, budgetDimension: "model_calls" as const };
  if (totalTokens + (input.reserve?.tokens ?? 0) > (input.budget.maxTokens ?? Infinity)) return { kind: "budget_exhausted" as const, budgetDimension: "tokens" as const };
  return { kind: "retry" as const };
}
