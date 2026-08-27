import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAREER_IMPORT_JOB_NAME, CAREER_IMPORT_QUEUE } from "@job-copilot/contracts/career-import";

const fake = vi.hoisted(() => {
  const calls: string[] = [];
  const queue = {
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(async () => { calls.push("queue.close"); }),
  };
  const redis = {
    status: "ready",
    quit: vi.fn().mockImplementation(async () => { calls.push("redis.quit"); }),
  };
  return {
    calls,
    queue,
    redis,
    Queue: vi.fn(function Queue() { return queue; }),
    Redis: vi.fn(function Redis() { return redis; }),
  };
});

vi.mock("bullmq", () => ({ Queue: fake.Queue }));
vi.mock("ioredis", () => ({ default: fake.Redis }));

import { BullmqCareerImportQueue } from "./bullmq-career-import-queue.js";

describe("BullmqCareerImportQueue", () => {
  beforeEach(() => {
    fake.calls.length = 0;
    fake.queue.add.mockClear();
    fake.queue.close.mockClear();
    fake.redis.quit.mockClear();
    fake.Queue.mockClear();
    fake.Redis.mockClear();
    fake.redis.status = "ready";
  });

  it("uses the versioned queue contract and bounded producer options", async () => {
    const producer = new BullmqCareerImportQueue("redis://queue-test");
    const job = { version: 1 as const, importId: "5d06ee57-6338-4f13-b58d-a3b4e7c1a4a4", userId: "fddf17b9-25c4-4828-ac66-7a23df4a3f1b" };

    await producer.enqueue(job);

    expect(fake.Redis).toHaveBeenCalledWith("redis://queue-test", { maxRetriesPerRequest: null, lazyConnect: true });
    expect(fake.Queue).toHaveBeenCalledWith(CAREER_IMPORT_QUEUE, { connection: fake.redis });
    expect(fake.queue.add).toHaveBeenCalledWith(CAREER_IMPORT_JOB_NAME, job, {
      jobId: job.importId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it("rejects an invalid job payload and closes the queue before Redis", async () => {
    const producer = new BullmqCareerImportQueue("redis://queue-test");
    await expect(producer.enqueue({ version: 1, importId: "not-a-uuid", userId: "also-not-a-uuid" } as never)).rejects.toThrow();

    await producer.onModuleDestroy();

    expect(fake.calls).toEqual(["queue.close", "redis.quit"]);
    expect(fake.queue.add).not.toHaveBeenCalled();
  });
});
