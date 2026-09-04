import { describe, expect, it } from "vitest";

import { processAgentRunJob } from "./agent-run-consumer.js";

const payload = {
  version: 1 as const,
  runId: "10000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000002",
};

describe("AgentRunConsumer", () => {
  it("BullMQ 本地 attempts 到上限仍把 retry 交给领域持久预算决定", async () => {
    const observed: unknown[] = [];
    const processor = {
      process: async (job: unknown) => {
        observed.push(job);
        return "retry" as const;
      },
    };

    await expect(processAgentRunJob({ data: payload, attemptsMade: 2, attempts: 3 }, processor))
      .rejects.toThrow("agent run temporarily unavailable");
    expect(observed).toEqual([payload]);
  });

  it.each(["completed", "paused", "cancelled", "budget_exhausted", "failed", "stale"] as const)("领域 %s 结果正常确认，不制造重复工作", async (outcome) => {
    const processor = { process: async () => outcome };

    await expect(processAgentRunJob({ data: payload, attemptsMade: 2, attempts: 3 }, processor))
      .resolves.toBe(outcome);
  });
});
