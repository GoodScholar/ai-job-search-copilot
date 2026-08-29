import { describe, expect, it } from "vitest";

import { agentRunAttemptContext, processAgentRunJob } from "./agent-run-consumer.js";

const payload = {
  version: 1 as const,
  runId: "10000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000002",
};

describe("AgentRunConsumer", () => {
  it("把 BullMQ 尝试次数映射为领域 finalAttempt", () => {
    expect(agentRunAttemptContext(0, 3)).toEqual({ finalAttempt: false });
    expect(agentRunAttemptContext(1, 3)).toEqual({ finalAttempt: false });
    expect(agentRunAttemptContext(2, 3)).toEqual({ finalAttempt: true });
    expect(agentRunAttemptContext(0, undefined)).toEqual({ finalAttempt: true });
  });

  it("仅在领域要求 retry 时让 BullMQ 重试", async () => {
    const observed: unknown[] = [];
    const processor = {
      process: async (job: unknown) => {
        observed.push(job);
        return "retry" as const;
      },
    };

    await expect(processAgentRunJob({ data: payload, attemptsMade: 0, attempts: 3 }, processor))
      .rejects.toThrow("agent run temporarily unavailable");
    expect(observed).toEqual([{ ...payload, finalAttempt: false }]);
  });

  it.each(["completed", "failed", "stale"] as const)("领域 %s 结果正常确认，不制造重复工作", async (outcome) => {
    const processor = { process: async () => outcome };

    await expect(processAgentRunJob({ data: payload, attemptsMade: 2, attempts: 3 }, processor))
      .resolves.toBe(outcome);
  });
});
