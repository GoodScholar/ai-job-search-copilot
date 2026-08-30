import { NestFactory } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

const fake = vi.hoisted(() => {
  const worker = { close: vi.fn<() => Promise<void>>() };
  const redis = {
    status: "ready",
    quit: vi.fn<() => Promise<void>>(),
    disconnect: vi.fn(),
  };
  const database = { $client: { end: vi.fn<() => Promise<void>>() } };
  return {
    worker,
    redis,
    database,
    Worker: vi.fn(function Worker() { return worker; }),
    Redis: vi.fn(function Redis() { return redis; }),
    createDatabase: vi.fn(() => database),
  };
});

vi.mock("bullmq", () => ({ Worker: fake.Worker }));
vi.mock("ioredis", () => ({ default: fake.Redis }));
vi.mock("@job-copilot/database", async (importOriginal) => ({
  ...await importOriginal<typeof import("@job-copilot/database")>(),
  createDatabase: fake.createDatabase,
}));

import { CareerImportConsumer } from "./career-import-consumer.js";
import { CareerImportModule } from "./career-import.module.js";

beforeEach(() => {
  fake.worker.close.mockReset();
  fake.redis.quit.mockReset();
  fake.redis.disconnect.mockReset();
  fake.database.$client.end.mockReset();
  fake.Worker.mockClear();
  fake.Redis.mockClear();
  fake.createDatabase.mockClear();
  fake.redis.status = "ready";
  fake.worker.close.mockResolvedValue(undefined);
  fake.redis.quit.mockImplementation(async () => { fake.redis.status = "end"; });
  fake.database.$client.end.mockResolvedValue(undefined);
  Object.assign(process.env, {
    APP_ENV: "test",
    DATABASE_URL: "postgresql://lifecycle-test",
    REDIS_URL: "redis://lifecycle-test",
    MINIO_ENDPOINT: "http://127.0.0.1:9000",
    MINIO_ACCESS_KEY: "lifecycle-test",
    MINIO_SECRET_KEY: "lifecycle-test",
    MINIO_BUCKET: "lifecycle-test",
  });
});

afterEach(() => vi.useRealTimers());

describe("CareerImport lifecycle", () => {
  it("真实 CareerImportModule factory wiring 会在 consumer settle 后才开始 database close", async () => {
    const events: string[] = [];
    const consumerClose = deferred<void>();
    const consumerStarted = deferred<void>();
    fake.worker.close.mockImplementation(async () => {
      events.push("consumer-start");
      consumerStarted.resolve();
      await consumerClose.promise;
      events.push("consumer-end");
    });
    fake.database.$client.end.mockImplementation(async () => { events.push("database-start"); });
    const context = await NestFactory.createApplicationContext(CareerImportModule, { logger: false });
    const closing = context.close();

    try {
      await consumerStarted.promise;
      expect(events).toEqual(["consumer-start"]);
    } finally {
      consumerClose.resolve();
      await closing;
    }

    expect(events).toEqual(["consumer-start", "consumer-end", "database-start"]);
  });

  it("worker close 超时后仍关闭 Redis，且重复 close 不启动第二轮", async () => {
    vi.useFakeTimers();
    fake.worker.close.mockReturnValue(new Promise<void>(() => undefined));
    const consumer = new CareerImportConsumer({ redisUrl: "redis://lifecycle-test", processor: { process: async () => "completed" } as never });
    const closing = consumer.close();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(fake.redis.quit).toHaveBeenCalledTimes(1);
    await expect(closing).resolves.toBeUndefined();
    await consumer.close();
    expect(fake.worker.close).toHaveBeenCalledTimes(1);
    expect(fake.redis.quit).toHaveBeenCalledTimes(1);
  });

  it("worker 或 Redis close 拒绝后仍 disconnect，且重复 close 不重试", async () => {
    fake.worker.close.mockRejectedValue(new Error("worker unavailable"));
    fake.redis.quit.mockRejectedValue(new Error("redis unavailable"));
    const consumer = new CareerImportConsumer({ redisUrl: "redis://lifecycle-test", processor: { process: async () => "completed" } as never });

    await expect(consumer.close()).resolves.toBeUndefined();
    await consumer.close();

    expect(fake.worker.close).toHaveBeenCalledTimes(1);
    expect(fake.redis.quit).toHaveBeenCalledTimes(1);
    expect(fake.redis.disconnect).toHaveBeenCalledTimes(1);
  });
});
