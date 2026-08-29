import { afterEach, expect, it, vi } from "vitest";
import { BullmqAgentRunQueue } from "./bullmq-agent-run-queue.js";

const job = {
  version: 1 as const,
  runId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08",
  userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3",
};

afterEach(() => {
  vi.useRealTimers();
});

it("API producer 超时后断开故障连接，且不会留下可复用的悬挂 client", async () => {
  vi.useFakeTimers();
  const client = {
    add: vi.fn(() => new Promise<never>(() => {})),
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const queue = new BullmqAgentRunQueue("redis://controlled-unavailable", {
    enqueueDeadlineMs: 50,
    queueFactory: () => client,
  });
  const enqueue = queue.enqueue(job);
  const rejection = expect(enqueue).rejects.toMatchObject({ code: "AGENT_RUN_QUEUE_TIMEOUT" });

  await vi.advanceTimersByTimeAsync(50);

  await rejection;
  expect(client.disconnect).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  await queue.onModuleDestroy();
  expect(client.close).not.toHaveBeenCalled();
});
