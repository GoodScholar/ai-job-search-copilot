import { Worker } from "bullmq";
import Redis from "ioredis";
import { CAREER_IMPORT_QUEUE, CareerImportJobSchema } from "@job-copilot/contracts/career-import";
import type { createCareerImportProcessor } from "@job-copilot/domain/career-imports";

type CareerImportProcessor = ReturnType<typeof createCareerImportProcessor>;

export class CareerImportConsumer {
  private readonly redis: Redis;
  private readonly worker: Worker;

  constructor(input: { redisUrl: string; processor: CareerImportProcessor }) {
    this.redis = new Redis(input.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(CAREER_IMPORT_QUEUE, async (job) => {
      const payload = CareerImportJobSchema.parse(job.data);
      const attempts = job.opts.attempts ?? 1;
      return input.processor.process({ ...payload, finalAttempt: job.attemptsMade + 1 >= attempts });
    }, { connection: this.redis, concurrency: 1 });
  }

  async close(): Promise<void> {
    await this.worker.close();
    if (this.redis.status !== "end") await this.redis.quit();
  }
}
