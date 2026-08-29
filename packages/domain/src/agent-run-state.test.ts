import { describe, expect, it } from "vitest";
import { decideRetry, reduceControl } from "./agent-run-state";

describe("agent run control state", () => {
  it("只允许已定义的暂停、恢复和取消转换", () => {
    const cases = [
      [{ status: "queued", controlState: "none" }, "pause", { kind: "transition", status: "paused", controlState: "none", eventType: "run.paused" }],
      [{ status: "running", controlState: "none" }, "pause", { kind: "transition", status: "running", controlState: "pause_requested", eventType: "run.pause_requested" }],
      [{ status: "running", controlState: "pause_requested" }, "resume", { kind: "transition", status: "running", controlState: "none", eventType: "run.resume_requested" }],
      [{ status: "paused", controlState: "none" }, "resume", { kind: "transition", status: "queued", controlState: "none", eventType: "run.resumed" }],
      [{ status: "running", controlState: "pause_requested" }, "cancel", { kind: "transition", status: "running", controlState: "cancel_requested", eventType: "run.cancel_requested" }],
      [{ status: "queued", controlState: "none" }, "cancel", { kind: "transition", status: "cancelled", controlState: "none", eventType: "run.cancelled" }],
      [{ status: "paused", controlState: "none" }, "cancel", { kind: "transition", status: "cancelled", controlState: "none", eventType: "run.cancelled" }],
    ] as const;

    for (const [state, action, expected] of cases) expect(reduceControl(state, action)).toEqual(expected);
  });

  it("将重复命令归为无变化，并拒绝终态或已接受取消后的冲突命令", () => {
    const cases = [
      [{ status: "paused", controlState: "none" }, "pause", { kind: "no_change" }],
      [{ status: "running", controlState: "pause_requested" }, "pause", { kind: "no_change" }],
      [{ status: "running", controlState: "none" }, "resume", { kind: "no_change" }],
      [{ status: "cancelled", controlState: "none" }, "cancel", { kind: "no_change" }],
      [{ status: "cancelled", controlState: "none" }, "resume", { kind: "conflict", code: "AGENT_RUN_CONTROL_CONFLICT" }],
      [{ status: "completed", controlState: "none" }, "cancel", { kind: "conflict", code: "AGENT_RUN_CONTROL_CONFLICT" }],
      [{ status: "failed", controlState: "none" }, "pause", { kind: "conflict", code: "AGENT_RUN_CONTROL_CONFLICT" }],
      [{ status: "running", controlState: "cancel_requested" }, "resume", { kind: "conflict", code: "AGENT_RUN_CONTROL_CONFLICT" }],
    ] as const;

    for (const [state, action, expected] of cases) expect(reduceControl(state, action)).toEqual(expected);
  });
});

describe("agent run retry policy", () => {
  const budget = { maxAttempts: 3, maxActiveDurationMs: 60_000, maxToolCalls: 10, maxModelCalls: 0 };

  it("只为适配器明确标记为暂时的来源故障保留有限重试", () => {
    const cases = [
      [{ category: "source", retryable: true }, { attempts: 1, activeDurationMs: 1_000, toolCalls: 1, modelCalls: 0 }, { kind: "retry" }],
      [{ category: "source", retryable: true }, { attempts: 3, activeDurationMs: 1_000, toolCalls: 1, modelCalls: 0 }, { kind: "budget_exhausted", budgetDimension: "attempts" }],
      [{ category: "source", retryable: true }, { attempts: 1, activeDurationMs: 60_000, toolCalls: 1, modelCalls: 0 }, { kind: "budget_exhausted", budgetDimension: "active_duration" }],
      [{ category: "source", retryable: true }, { attempts: 1, activeDurationMs: 1_000, toolCalls: 10, modelCalls: 0 }, { kind: "budget_exhausted", budgetDimension: "tool_calls" }],
      [{ category: "source", retryable: false }, { attempts: 1, activeDurationMs: 1_000, toolCalls: 1, modelCalls: 0 }, { kind: "fail", failureCode: "AGENT_RUN_ADAPTER_FAILED" }],
    ] as const;

    for (const [failure, usage, expected] of cases) expect(decideRetry({ failure, usage, budget, reserve: { toolCalls: 1 } })).toEqual(expected);
  });

  it("将模型认证、策略和无效响应直接终止，即使错误来源误标为可重试", () => {
    const usage = { attempts: 1, activeDurationMs: 1_000, toolCalls: 1, modelCalls: 0 };
    expect(decideRetry({ failure: { category: "model_auth", retryable: true }, usage, budget })).toEqual({ kind: "fail", failureCode: "AGENT_RUN_MODEL_AUTH_FAILED" });
    expect(decideRetry({ failure: { category: "model_policy", retryable: true }, usage, budget })).toEqual({ kind: "fail", failureCode: "AGENT_RUN_MODEL_POLICY_REJECTED" });
    expect(decideRetry({ failure: { category: "model_invalid", retryable: true }, usage, budget })).toEqual({ kind: "fail", failureCode: "AGENT_RUN_MODEL_INVALID_RESPONSE" });
  });

  it("在模型预算为零时于调用前拒绝模型预占", () => {
    expect(decideRetry({
      failure: { category: "source", retryable: true },
      usage: { attempts: 1, activeDurationMs: 1_000, toolCalls: 1, modelCalls: 0 },
      budget,
      reserve: { modelCalls: 1 },
    })).toEqual({ kind: "budget_exhausted", budgetDimension: "model_calls" });
  });

  it("只在模型调用预算仍有余量时为明确暂时的模型故障重试", () => {
    const usage = { attempts: 1, activeDurationMs: 1_000, toolCalls: 1, modelCalls: 0 };
    expect(decideRetry({
      failure: { category: "model", retryable: true }, usage,
      budget: { ...budget, maxModelCalls: 2 }, reserve: { modelCalls: 1 },
    })).toEqual({ kind: "retry" });
    expect(decideRetry({
      failure: { category: "model", retryable: true }, usage, budget, reserve: { modelCalls: 1 },
    })).toEqual({ kind: "budget_exhausted", budgetDimension: "model_calls" });
  });
});
