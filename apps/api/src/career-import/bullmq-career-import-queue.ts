import { Queue } from "bullmq";
import Redis from "ioredis";
import { CAREER_IMPORT_JOB_NAME, CAREER_IMPORT_QUEUE, CareerImportJobSchema, type CareerImportJob } from "@job-copilot/contracts/career-import";
import type { CareerImportQueue } from "@job-copilot/domain/career-imports";

export class BullmqCareerImportQueue implements CareerImportQueue {
  private readonly redis: Redis;
  private readonly queue: Queue;

  constructor(redisUrl = process.env.REDIS_URL ?? `redis://127.0.0.1:${process.env.REDIS_PORT ?? "63790"}`) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(CAREER_IMPORT_QUEUE, { connection: this.redis });
  }

  async enqueue(job: CareerImportJob): Promise<void> {
    const value = CareerImportJobSchema.parse(job);
    await this.queue.add(CAREER_IMPORT_JOB_NAME, value, {
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
