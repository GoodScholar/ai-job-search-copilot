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

it("pending add 与 pending disconnect 仍在 enqueue deadline 后拒绝", async () => {
  vi.useFakeTimers();
  const client = {
    add: vi.fn(() => new Promise<never>(() => {})),
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(() => new Promise<never>(() => {})),
  };
  const queue = new BullmqAgentRunQueue("redis://controlled-unavailable", {
    enqueueDeadlineMs: 50,
    cleanupDeadlineMs: 50,
    cooldownMs: 1_000,
    queueFactory: () => client,
  });
  const enqueue = queue.enqueue(job);
  let rejection: unknown;
  void enqueue.catch((error: unknown) => { rejection = error; });

  await vi.advanceTimersByTimeAsync(50);

  expect(rejection).toMatchObject({ code: "AGENT_RUN_QUEUE_TIMEOUT" });
  expect(client.disconnect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(50);
  expect(vi.getTimerCount()).toBe(0);
});

it("持续故障在共享 cooldown 内快速拒绝且不重复创建 client", async () => {
  vi.useFakeTimers();
  const clients = [0, 1].map(() => ({
    add: vi.fn().mockRejectedValue(new Error("redis unavailable")),
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }));
  const factory = vi.fn()
    .mockReturnValueOnce(clients[0])
    .mockReturnValueOnce(clients[1]);
  const queue = new BullmqAgentRunQueue("redis://controlled-unavailable", {
    enqueueDeadlineMs: 50,
    cleanupDeadlineMs: 50,
    cooldownMs: 1_000,
    queueFactory: factory,
  });

  await expect(queue.enqueue(job)).rejects.toThrow("redis unavailable");
  await expect(queue.enqueue({ ...job, runId: "80e774b4-aa27-44c4-a370-8b51587b29c2" }))
    .rejects.toMatchObject({ code: "AGENT_RUN_QUEUE_COOLDOWN" });
  expect(factory).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(1_000);
  await expect(queue.enqueue({ ...job, runId: "f3e30afc-e167-4746-afbf-67667a93d099" })).rejects.toThrow("redis unavailable");
  expect(factory).toHaveBeenCalledTimes(2);
});

it("旧 generation 一成一败不会断开 cooldown 后新建的健康 client", async () => {
  vi.useFakeTimers();
  const failed = promiseWithResolvers<unknown>();
  const stillSuccessful = promiseWithResolvers<unknown>();
  const oldClient = {
    add: vi.fn()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(stillSuccessful.promise),
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const healthyClient = {
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const factory = vi.fn().mockReturnValueOnce(oldClient).mockReturnValueOnce(healthyClient);
  const queue = new BullmqAgentRunQueue("redis://controlled-unavailable", {
    enqueueDeadlineMs: 500,
    cleanupDeadlineMs: 50,
    cooldownMs: 100,
    queueFactory: factory,
  });
  const first = queue.enqueue(job);
  const second = queue.enqueue({ ...job, runId: "80e774b4-aa27-44c4-a370-8b51587b29c2" });
  failed.reject(new Error("first failed"));
  await expect(first).rejects.toThrow("first failed");
  expect(oldClient.disconnect).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(100);
  await expect(queue.enqueue({ ...job, runId: "f3e30afc-e167-4746-afbf-67667a93d099" })).resolves.toBeUndefined();
  stillSuccessful.resolve(undefined);
  await expect(second).resolves.toBeUndefined();

  expect(oldClient.disconnect).toHaveBeenCalledTimes(1);
  expect(healthyClient.disconnect).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

function promiseWithResolvers<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
