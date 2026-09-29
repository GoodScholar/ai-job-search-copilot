import { Queue } from "bullmq";
import type { OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { JOB_EXPORT_JOB_NAME, JOB_EXPORT_QUEUE, type JobExportJob } from "@job-copilot/contracts/job-exports";
import type { JobExportQueue } from "@job-copilot/domain/job-exports";

export class BullmqJobExportQueue implements JobExportQueue, OnModuleDestroy {
  private readonly redis: Redis;
  private readonly queue: Queue;

  constructor(redisUrl = process.env.REDIS_URL ?? `redis://127.0.0.1:${process.env.REDIS_PORT ?? "63790"}`) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    this.queue = new Queue(JOB_EXPORT_QUEUE, { connection: this.redis });
  }

  async enqueue(job: JobExportJob): Promise<void> {
    await this.queue.add(JOB_EXPORT_JOB_NAME, job, { jobId: job.exportId, attempts: 3, backoff: { type: "fixed", delay: 1_000 }, removeOnComplete: true, removeOnFail: true });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    if (this.redis.status !== "end") this.redis.disconnect();
  }
}
