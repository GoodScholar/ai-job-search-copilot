import { Queue } from "bullmq";
import Redis from "ioredis";
import { JOB_IMPORT_JOB_NAME, JOB_IMPORT_QUEUE, JobImportJobSchema, type JobImportJob } from "@job-copilot/contracts/job-imports";
import type { JobImportQueue } from "@job-copilot/domain/job-imports";

export class BullmqJobImportQueue implements JobImportQueue {
  private readonly redis: Redis;
  private readonly queue: Queue;

  constructor(redisUrl = process.env.REDIS_URL ?? `redis://127.0.0.1:${process.env.REDIS_PORT ?? "63790"}`) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    this.queue = new Queue(JOB_IMPORT_QUEUE, { connection: this.redis });
  }

  async enqueue(job: JobImportJob): Promise<void> {
    const value = JobImportJobSchema.parse(job);
    await this.queue.add(JOB_IMPORT_JOB_NAME, value, {
      jobId: value.importId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    if (this.redis.status !== "end") await this.redis.quit();
  }
}
