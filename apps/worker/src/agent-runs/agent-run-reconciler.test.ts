import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentRunReconciler,
  agentRunQueueJobOptions,
} from "./agent-run-reconciler.js";

const first = {
  version: 1 as const,
  runId: "10000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000002",
};
const second = {
  version: 1 as const,
  runId: "30000000-0000-4000-8000-000000000003",
  userId: "40000000-0000-4000-8000-000000000004",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("AgentRunReconciler", () => {
  it("初始化立即扫描，之后每秒把领域判定的可恢复 run 重新入队", async () => {
    vi.useFakeTimers();
    const scans = [[first], [second]];
    const enqueued: unknown[] = [];
    const reconciler = new AgentRunReconciler({
      recoveryQueries: { listRecoverable: async () => scans.shift() ?? [] },
      queue: { enqueue: async (job) => { enqueued.push(job); } },
    });

    await reconciler.onModuleInit();
    expect(enqueued).toEqual([first]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(enqueued).toEqual([first, second]);

    reconciler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(enqueued).toEqual([first, second]);
  });

  it("前一次扫描未结束时跳过定时 tick，禁止重叠扫描", async () => {
    vi.useFakeTimers();
    const pending = deferred<typeof first[]>();
    let scans = 0;
    const reconciler = new AgentRunReconciler({
      recoveryQueries: {
        listRecoverable: async () => {
          scans += 1;
          return scans === 1 ? [] : pending.promise;
        },
      },
      queue: { enqueue: async () => undefined },
    });

    await reconciler.onModuleInit();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(scans).toBe(2);
    pending.resolve([]);
    await vi.runAllTicks();
    reconciler.onModuleDestroy();
  });

  it("一个 run 入队失败时仍继续补发同批其他可恢复 run", async () => {
    const enqueued: string[] = [];
    const reconciler = new AgentRunReconciler({
      recoveryQueries: { listRecoverable: async () => [first, second] },
      queue: {
        enqueue: async (job) => {
          enqueued.push(job.runId);
          if (job.runId === first.runId) throw new Error("redis temporarily unavailable");
        },
      },
    });

    await reconciler.onModuleInit();
    expect(enqueued).toEqual([first.runId, second.runId]);
    reconciler.onModuleDestroy();
  });

  it("队列任务固定 runId、三次尝试，并让 backoff 越过处理租约", () => {
    expect(agentRunQueueJobOptions(first.runId)).toEqual({
      jobId: first.runId,
      attempts: 3,
      backoff: { type: "fixed", delay: 31_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });
});
