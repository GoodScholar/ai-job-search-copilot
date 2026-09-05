import { NestFactory } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const schedulerStarted = (() => {
    let resolve!: () => void;
    return { promise: new Promise<void>((accept) => { resolve = accept; }), resolve };
  })();
  const schedulerFinished = (() => {
    let resolve!: () => void;
    return { promise: new Promise<void>((accept) => { resolve = accept; }), resolve };
  })();
  const events: string[] = [];
  const database = { $client: { end: vi.fn(async () => { events.push("database-start"); }) } };

  class AgentRunScheduler {
    async onModuleInit(): Promise<void> {}
    async onModuleDestroy(): Promise<void> {
      events.push("scheduler-start");
      schedulerStarted.resolve();
      await schedulerFinished.promise;
      events.push("scheduler-end");
    }
  }
  class AgentRunReconciler {
    async onModuleInit(): Promise<void> {}
    async onModuleDestroy(): Promise<void> { events.push("reconciler-end"); }
  }
  class BullmqAgentRunQueue {
    async onModuleDestroy(): Promise<void> { events.push("queue-end"); }
  }
  class AgentRunConsumer {
    async close(): Promise<void> { events.push("consumer-end"); }
    async onModuleDestroy(): Promise<void> { await this.close(); }
  }

  return {
    AgentRunScheduler,
    AgentRunReconciler,
    BullmqAgentRunQueue,
    AgentRunConsumer,
    database,
    events,
    schedulerStarted,
    schedulerFinished,
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

describe("AgentRunModule 生命周期", () => {
  it("等待 Scheduler settle 后才关闭 PostgreSQL client", async () => {
    Object.assign(process.env, {
      APP_ENV: "test",
      DATABASE_URL: "postgresql://lifecycle-test",
      REDIS_URL: "redis://lifecycle-test",
      MINIO_ENDPOINT: "http://127.0.0.1:9000",
      MINIO_ACCESS_KEY: "lifecycle-test",
      MINIO_SECRET_KEY: "lifecycle-test",
      MINIO_BUCKET: "lifecycle-test",
    });
    const context = await NestFactory.createApplicationContext(AgentRunModule, { logger: false });
    const closing = context.close();

    try {
      await fake.schedulerStarted.promise;
      expect(fake.database.$client.end).not.toHaveBeenCalled();
    } finally {
      fake.schedulerFinished.resolve();
      await closing;
    }

    expect(fake.events.indexOf("database-start")).toBeGreaterThan(fake.events.indexOf("scheduler-end"));
  });
});
