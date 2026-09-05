import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentRunScheduler,
  type AgentRunScheduleFailure,
} from "./agent-run-scheduler.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

function reporter(failures: AgentRunScheduleFailure[]) {
  return { report: async (failure: AgentRunScheduleFailure) => { failures.push(failure); } };
}

afterEach(() => vi.useRealTimers());

describe("AgentRunScheduler", () => {
  it("模块初始化先扫描一次，再以固定周期扫描", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const scheduler = new AgentRunScheduler({
      schedules: {
        materializeDue: async () => { calls.push("materialize"); return []; },
        dispatchPending: async () => { calls.push("dispatch"); },
      },
      reporter: reporter([]),
    });

    await scheduler.onModuleInit();
    expect(calls).toEqual(["materialize", "dispatch"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(["materialize", "dispatch", "materialize", "dispatch"]);
    await scheduler.close();
  });

  it("上一次扫描未结束时跳过后续 tick，避免并发物化或派发", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    let materializations = 0;
    const scheduler = new AgentRunScheduler({
      schedules: {
        materializeDue: async () => {
          materializations += 1;
          return materializations === 1 ? [] : pending.promise.then(() => []);
        },
        dispatchPending: async () => undefined,
      },
      reporter: reporter([]),
      scanTimeoutMs: 10_000,
    });

    await scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(materializations).toBe(2);
    pending.resolve();
    await vi.runAllTicks();
    await scheduler.close();
  });

  it("物化查询超时报告稳定码，并保持单飞直到原查询结束", async () => {
    vi.useFakeTimers();
    const failures: AgentRunScheduleFailure[] = [];
    let materializations = 0;
    const scheduler = new AgentRunScheduler({
      schedules: {
        materializeDue: async () => {
          materializations += 1;
          return new Promise<never>(() => undefined);
        },
        dispatchPending: async () => undefined,
      },
      reporter: reporter(failures),
      scanTimeoutMs: 50,
    });

    const initializing = scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(50);
    await initializing;
    expect(failures).toEqual([{ failureCode: "JOB_DISCOVERY_SCHEDULE_MATERIALIZE_FAILED" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(materializations).toBe(1);
    const destroying = scheduler.close();
    await vi.advanceTimersByTimeAsync(50);
    await destroying;
  });

  it("派发查询超时只报告稳定码且不会杀死 Worker", async () => {
    vi.useFakeTimers();
    const failures: AgentRunScheduleFailure[] = [];
    const scheduler = new AgentRunScheduler({
      schedules: {
        materializeDue: async () => [],
        dispatchPending: async () => new Promise<void>(() => undefined),
      },
      reporter: reporter(failures),
      scanTimeoutMs: 50,
    });

    const initializing = scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(50);
    await initializing;
    expect(failures).toEqual([{ failureCode: "JOB_DISCOVERY_SCHEDULE_DISPATCH_FAILED" }]);
    const destroying = scheduler.close();
    await vi.advanceTimersByTimeAsync(50);
    await destroying;
  });

  it("销毁停止新扫描，且对未完成查询只作有界等待", async () => {
    vi.useFakeTimers();
    const pending = deferred<never>();
    let materializations = 0;
    const scheduler = new AgentRunScheduler({
      schedules: {
        materializeDue: async () => { materializations += 1; return pending.promise; },
        dispatchPending: async () => undefined,
      },
      reporter: reporter([]),
      scanTimeoutMs: 50,
    });

    const initializing = scheduler.onModuleInit();
    const destroying = scheduler.close();
    await vi.advanceTimersByTimeAsync(50);
    await destroying;
    await initializing;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(materializations).toBe(1);
  });

  it("有界关闭后仍消费迟到的 PostgreSQL 查询拒绝", async () => {
    vi.useFakeTimers();
    const pending = deferred<never>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    const scheduler = new AgentRunScheduler({
      schedules: {
        materializeDue: async () => pending.promise,
        dispatchPending: async () => undefined,
      },
      reporter: reporter([]),
      scanTimeoutMs: 50,
    });

    try {
      const initializing = scheduler.onModuleInit();
      await vi.advanceTimersByTimeAsync(50);
      await initializing;
      const closing = scheduler.close();
      await vi.advanceTimersByTimeAsync(50);
      await closing;

      pending.reject(new Error("write CONNECTION_ENDED"));
      await vi.runAllTicks();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
