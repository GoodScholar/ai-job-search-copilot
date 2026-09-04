import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentRunScheduler,
  type AgentRunScheduleFailure,
} from "./agent-run-scheduler.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
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
    await scheduler.onModuleDestroy();
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
    await scheduler.onModuleDestroy();
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
    const destroying = scheduler.onModuleDestroy();
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
    const destroying = scheduler.onModuleDestroy();
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
    const destroying = scheduler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(50);
    await destroying;
    await initializing;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(materializations).toBe(1);
  });
});
