import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentRunReconciler,
  agentRunQueueJobOptions,
  type AgentRunRecoveryFailure,
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

function memoryReporter(failures: AgentRunRecoveryFailure[]) {
  return { report: async (failure: AgentRunRecoveryFailure) => { failures.push(failure); } };
}

afterEach(() => vi.useRealTimers());

describe("AgentRunReconciler", () => {
  it("初始化立即扫描，之后每秒把领域判定的可恢复 run 重新入队", async () => {
    vi.useFakeTimers();
    const scans = [[first], [second]];
    const enqueued: unknown[] = [];
    const failures: AgentRunRecoveryFailure[] = [];
    const reconciler = new AgentRunReconciler({
      recoveryQueries: { listRecoverable: async () => scans.shift() ?? [] },
      queue: { enqueue: async (job) => { enqueued.push(job); } },
      reporter: memoryReporter(failures),
    });

    await reconciler.onModuleInit();
    expect(enqueued).toEqual([first]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(enqueued).toEqual([first, second]);

    reconciler.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(enqueued).toEqual([first, second]);
    expect(failures).toEqual([]);
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
      reporter: memoryReporter([]),
    });

    await reconciler.onModuleInit();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(scans).toBe(2);
    pending.resolve([]);
    await vi.runAllTicks();
    reconciler.close();
  });

  it("一个 run 入队失败时仍继续补发同批其他可恢复 run", async () => {
    const enqueued: string[] = [];
    const failures: AgentRunRecoveryFailure[] = [];
    const reconciler = new AgentRunReconciler({
      recoveryQueries: { listRecoverable: async () => [first, second] },
      queue: {
        enqueue: async (job) => {
          enqueued.push(job.runId);
          if (job.runId === first.runId) throw new Error("redis://secret:password@private-host raw failure");
        },
      },
      reporter: memoryReporter(failures),
    });

    await reconciler.onModuleInit();
    expect(enqueued).toEqual([first.runId, second.runId]);
    expect(failures).toEqual([{
      failureCode: "AGENT_RUN_RECOVERY_ENQUEUE_FAILED",
      runId: first.runId,
      userId: first.userId,
    }]);
    expect(JSON.stringify(failures)).not.toContain("secret");
    reconciler.close();
  });

  it("整体扫描失败只报告稳定故障码，并在下一轮继续扫描", async () => {
    vi.useFakeTimers();
    const failures: AgentRunRecoveryFailure[] = [];
    let scans = 0;
    const reconciler = new AgentRunReconciler({
      recoveryQueries: {
        listRecoverable: async () => {
          scans += 1;
          if (scans === 1) throw new Error("postgresql://private-user:private-password@database raw failure");
          return [];
        },
      },
      queue: { enqueue: async () => undefined },
      reporter: memoryReporter(failures),
    });

    await reconciler.onModuleInit();
    expect(failures).toEqual([{ failureCode: "AGENT_RUN_RECOVERY_SCAN_FAILED" }]);
    expect(JSON.stringify(failures)).not.toContain("private-password");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scans).toBe(2);
    reconciler.close();
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

  it("Redis 入队永不 settle 时在截止时间后报告故障并释放扫描锁", async () => {
    vi.useFakeTimers();
    const failures: AgentRunRecoveryFailure[] = [];
    const reconciler = new AgentRunReconciler({
      recoveryQueries: { listRecoverable: async () => [first] },
      queue: { enqueue: async () => new Promise<void>(() => undefined) },
      reporter: memoryReporter(failures),
    });

    const initializing = reconciler.onModuleInit();
    await vi.advanceTimersByTimeAsync(5_000);
    await initializing;
    expect(failures).toEqual([{ failureCode: "AGENT_RUN_RECOVERY_ENQUEUE_FAILED", runId: first.runId, userId: first.userId }]);
    await reconciler.close();
  });

  it("恢复查询永不 settle 时在 scan 总预算内结束启动", async () => {
    vi.useFakeTimers();
    const failures: AgentRunRecoveryFailure[] = [];
    const reconciler = new AgentRunReconciler({
      recoveryQueries: { listRecoverable: async () => new Promise<never>(() => undefined) },
      queue: { enqueue: async () => undefined },
      reporter: memoryReporter(failures),
      scanTimeoutMs: 50,
    });

    const initializing = reconciler.onModuleInit();
    await vi.advanceTimersByTimeAsync(50);
    await initializing;
    expect(failures).toEqual([{ failureCode: "AGENT_RUN_RECOVERY_SCAN_FAILED" }]);
    const closing = reconciler.close();
    await vi.advanceTimersByTimeAsync(50);
    await closing;
  });

  it("恢复查询超过 deadline 后保持单飞，并消费迟到的 PostgreSQL 拒绝", async () => {
    vi.useFakeTimers();
    const pending = deferred<typeof first[]>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    let scans = 0;
    const reconciler = new AgentRunReconciler({
      recoveryQueries: {
        listRecoverable: async () => {
          scans += 1;
          return scans === 1 ? pending.promise : [];
        },
      },
      queue: { enqueue: async () => undefined },
      reporter: memoryReporter([]),
      scanTimeoutMs: 50,
    });

    try {
      const initializing = reconciler.onModuleInit();
      await vi.advanceTimersByTimeAsync(50);
      await initializing;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(scans).toBe(1);

      pending.reject(new Error("write CONNECTION_ENDED"));
      await vi.runAllTicks();
      expect(unhandled).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(scans).toBe(2);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await reconciler.close();
    }
  });

  it("每轮总预算限制住大量挂起入队，并在下一轮从最旧 run 重新尝试", async () => {
    vi.useFakeTimers();
    const jobs = Array.from({ length: 100 }, (_, index) => ({ ...first, runId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
    const observed: string[] = [];
    let firstFails = true;
    const reconciler = new AgentRunReconciler({
      recoveryQueries: { listRecoverable: async () => jobs },
      queue: { enqueue: async (job) => {
        observed.push(job.runId);
        if (firstFails) return new Promise<void>(() => undefined);
      } },
      reporter: memoryReporter([]),
      scanTimeoutMs: 50,
    });

    const initializing = reconciler.onModuleInit();
    await vi.advanceTimersByTimeAsync(50);
    await initializing;
    expect(observed).toHaveLength(2);
    expect(observed[0]).toBe(jobs[0]!.runId);
    const beforeRetry = observed.length;
    firstFails = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observed[beforeRetry]).toBe(jobs[0]!.runId);
    await reconciler.close();
  });
});
