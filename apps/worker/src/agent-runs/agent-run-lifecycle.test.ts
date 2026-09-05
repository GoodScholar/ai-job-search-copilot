import { NestFactory } from "@nestjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const deferred = () => {
    let resolve!: () => void;
    return { promise: new Promise<void>((accept) => { resolve = accept; }), resolve };
  };
  const state = {
    events: [] as string[],
    closings: new Map<string, Promise<void>>(),
    failures: new Map<string, "sync" | "async">(),
    holdScheduler: false,
    schedulerStarted: deferred(),
    schedulerFinished: deferred(),
  };
  const database = { $client: { end: vi.fn(async () => { state.events.push("database-start"); }) } };

  const reset = (input: { holdScheduler?: boolean; failure?: { resource: string; kind: "sync" | "async" } } = {}) => {
    state.events.length = 0;
    state.closings.clear();
    state.failures.clear();
    if (input.failure) state.failures.set(input.failure.resource, input.failure.kind);
    state.holdScheduler = input.holdScheduler ?? false;
    state.schedulerStarted = deferred();
    state.schedulerFinished = deferred();
    database.$client.end.mockClear();
  };
  const close = (resource: string): Promise<void> => {
    const existing = state.closings.get(resource);
    if (existing) return existing;
    state.events.push(`${resource}-start`);
    if (state.failures.get(resource) === "sync") throw new Error(`${resource} close failed`);
    const closing = (async () => {
      if (resource === "scheduler" && state.holdScheduler) {
        state.schedulerStarted.resolve();
        await state.schedulerFinished.promise;
      }
      if (state.failures.get(resource) === "async") throw new Error(`${resource} close failed`);
      state.events.push(`${resource}-end`);
    })();
    state.closings.set(resource, closing);
    return closing;
  };

  class AgentRunScheduler {
    async onModuleInit(): Promise<void> {}
    close(): Promise<void> { return close("scheduler"); }
  }
  class AgentRunReconciler {
    async onModuleInit(): Promise<void> {}
    close(): Promise<void> { return close("reconciler"); }
  }
  class BullmqAgentRunQueue {
    close(): Promise<void> { return close("queue"); }
  }
  class AgentRunConsumer {
    close(): Promise<void> { return close("consumer"); }
  }

  return {
    AgentRunScheduler,
    AgentRunReconciler,
    BullmqAgentRunQueue,
    AgentRunConsumer,
    database,
    state,
    reset,
    createDatabase: vi.fn(() => database),
  };
});

vi.mock("@job-copilot/database", async (importOriginal) => ({
  ...await importOriginal<typeof import("@job-copilot/database")>(),
  createDatabase: fake.createDatabase,
}));
vi.mock("./agent-run-consumer.js", () => ({ AgentRunConsumer: fake.AgentRunConsumer }));
vi.mock("./agent-run-reconciler.js", () => ({
  AgentRunReconciler: fake.AgentRunReconciler,
  BullmqAgentRunQueue: fake.BullmqAgentRunQueue,
}));
vi.mock("./agent-run-scheduler.js", () => ({ AgentRunScheduler: fake.AgentRunScheduler }));

import { AgentRunModule } from "./agent-run.module.js";

function configureEnvironment() {
  Object.assign(process.env, {
    APP_ENV: "test",
    DATABASE_URL: "postgresql://lifecycle-test",
    REDIS_URL: "redis://lifecycle-test",
    MINIO_ENDPOINT: "http://127.0.0.1:9000",
    MINIO_ACCESS_KEY: "lifecycle-test",
    MINIO_SECRET_KEY: "lifecycle-test",
    MINIO_BUCKET: "lifecycle-test",
  });
}

beforeEach(() => fake.reset());

describe("AgentRunModule 生命周期", () => {
  it("完整串行关闭一次，并让重复 context close 复用每项关闭", async () => {
    configureEnvironment();
    const context = await NestFactory.createApplicationContext(AgentRunModule, { logger: false });

    await context.close();
    await context.close();

    expect(fake.state.events).toEqual([
      "scheduler-start", "scheduler-end",
      "reconciler-start", "reconciler-end",
      "consumer-start", "consumer-end",
      "queue-start", "queue-end",
      "database-start",
    ]);
    expect(fake.database.$client.end).toHaveBeenCalledTimes(1);
  });

  it("Scheduler 未 settle 时不关闭 PostgreSQL client", async () => {
    fake.reset({ holdScheduler: true });
    configureEnvironment();
    const context = await NestFactory.createApplicationContext(AgentRunModule, { logger: false });
    const closing = context.close();

    try {
      await vi.waitFor(() => expect(fake.state.events).toContain("scheduler-start"), { timeout: 100 });
      expect(fake.database.$client.end).not.toHaveBeenCalled();
    } finally {
      fake.state.schedulerFinished.resolve();
      await closing;
    }

    expect(fake.state.events.indexOf("database-start")).toBeGreaterThan(fake.state.events.indexOf("scheduler-end"));
  });

  it.each([
    ["scheduler", "sync"],
    ["reconciler", "async"],
    ["consumer", "sync"],
    ["queue", "async"],
  ] as const)("%s close %s 拒绝时仍关闭后续资源和数据库", async (resource, kind) => {
    fake.reset({ failure: { resource, kind } });
    configureEnvironment();
    const context = await NestFactory.createApplicationContext(AgentRunModule, { logger: false });

    await expect(context.close()).resolves.toBeUndefined();

    expect(fake.state.events).toContain(`${resource}-start`);
    expect(fake.state.events.at(-1)).toBe("database-start");
    expect(fake.database.$client.end).toHaveBeenCalledTimes(1);
  });

  it("后台 Provider 不再暴露 Nest 自动 destroy hook", async () => {
    const [scheduler, reconciler, consumer] = await Promise.all([
      vi.importActual<typeof import("./agent-run-scheduler.js")>("./agent-run-scheduler.js"),
      vi.importActual<typeof import("./agent-run-reconciler.js")>("./agent-run-reconciler.js"),
      vi.importActual<typeof import("./agent-run-consumer.js")>("./agent-run-consumer.js"),
    ]);

    expect(scheduler.AgentRunScheduler.prototype).not.toHaveProperty("onModuleDestroy");
    expect(reconciler.AgentRunReconciler.prototype).not.toHaveProperty("onModuleDestroy");
    expect(reconciler.BullmqAgentRunQueue.prototype).not.toHaveProperty("onModuleDestroy");
    expect(consumer.AgentRunConsumer.prototype).not.toHaveProperty("onModuleDestroy");
  });
});
