import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_IMPORT_CLAIM_LEASE_MS, JOB_IMPORT_JOB_NAME, JOB_IMPORT_QUEUE } from "@job-copilot/contracts/job-imports";

const fake = vi.hoisted(() => {
  const queue = { add: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
  const redis = { status: "ready", quit: vi.fn().mockResolvedValue(undefined) };
  return {
    queue,
    redis,
    Queue: vi.fn(function Queue() { return queue; }),
    Redis: vi.fn(function Redis() { return redis; }),
  };
});

vi.mock("bullmq", () => ({ Queue: fake.Queue }));
vi.mock("ioredis", () => ({ default: fake.Redis }));

import { BullmqJobImportQueue } from "./bullmq-job-import-queue.js";

describe("BullmqJobImportQueue", () => {
  beforeEach(() => {
    fake.queue.add.mockClear();
  });

  it("使用在 claim lease 到期前不会耗尽的退避尝试", async () => {
    const producer = new BullmqJobImportQueue("redis://queue-test");
    const job = { version: 1 as const, importId: "5d06ee57-6338-4f13-b58d-a3b4e7c1a4a4", userId: "fddf17b9-25c4-4828-ac66-7a23df4a3f1b" };

    await producer.enqueue(job);

    expect(JOB_IMPORT_CLAIM_LEASE_MS).toBe(30_000);
    expect(fake.queue.add).toHaveBeenCalledWith(JOB_IMPORT_JOB_NAME, job, {
      jobId: job.importId,
      attempts: 6,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
    expect(1_000 + 2_000 + 4_000 + 8_000 + 16_000).toBeGreaterThanOrEqual(JOB_IMPORT_CLAIM_LEASE_MS);
  });
});
