import { describe, expect, it } from "vitest";
import { exhaustedAgentRunBudget, type AgentRunBudgetUsage } from "./effective-agent-run-budget";

const budget = { maxActiveDurationMs: 100, maxAttempts: 3, maxToolCalls: 2, maxResults: 10, maxModelCalls: 2, maxTokens: 100 };
const run = (input: Partial<Pick<AgentRunBudgetUsage, "workflowVersion" | "attemptCount" | "activeDurationMs" | "toolCallCount" | "modelCallCount" | "totalTokenCount">> = {}) => ({
  workflowVersion: "deep-match-v1",
  budgetSnapshot: budget,
  attemptCount: 3,
  activeDurationMs: 0,
  toolCallCount: 0,
  modelCallCount: 0,
  totalTokenCount: 0,
  ...input,
});

describe("effective agent run budget exhaustion", () => {
  it("将活动时长恰好到达有效上限视为耗尽", () => {
    expect(exhaustedAgentRunBudget(run({ activeDurationMs: 90 }), {}, 10)).toBe("active_duration");
  });

  it("允许第 maxAttempts 次领取但拒绝下一次", () => {
    expect(exhaustedAgentRunBudget(run({ attemptCount: 3 }), {}, 0)).toBeNull();
    expect(exhaustedAgentRunBudget(run({ attemptCount: 4 }), {}, 0)).toBe("attempts");
  });

  it("仅在预留后严格超过调用或 token 上限时耗尽", () => {
    expect(exhaustedAgentRunBudget(run({ workflowVersion: "job-discovery-workflow-v2", toolCallCount: 1 }), { toolCalls: 1 }, 0)).toBeNull();
    expect(exhaustedAgentRunBudget(run({ workflowVersion: "job-discovery-workflow-v2", toolCallCount: 2 }), { toolCalls: 1 }, 0)).toBe("tool_calls");
    expect(exhaustedAgentRunBudget(run({ totalTokenCount: 90 }), { inputTokens: 5, outputTokens: 5 }, 0)).toBeNull();
    expect(exhaustedAgentRunBudget(run({ totalTokenCount: 90 }), { budgetTokens: 11 }, 0)).toBe("tokens");
  });
});
