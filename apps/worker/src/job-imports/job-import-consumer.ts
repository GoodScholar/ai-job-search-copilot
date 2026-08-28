import { Worker } from "bullmq";
import type { OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { JOB_IMPORT_QUEUE, JobImportJobSchema } from "@job-copilot/contracts/job-imports";
import { JobImportRetryableError, type createJobImportProcessor } from "@job-copilot/domain/job-imports";

type JobImportProcessor = ReturnType<typeof createJobImportProcessor>;

export class JobImportConsumer implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly worker: Worker;
  private closePromise: Promise<void> | undefined;

  constructor(input: { redisUrl: string; processor: JobImportProcessor }) {
    this.redis = new Redis(input.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(JOB_IMPORT_QUEUE, async (job) => {
      const payload = JobImportJobSchema.parse(job.data);
      const attempts = job.opts.attempts ?? 1;
      try {
        return await input.processor.process({ ...payload, finalAttempt: job.attemptsMade + 1 >= attempts });
      } catch (error) {
        if (error instanceof JobImportRetryableError) throw new Error("job import temporarily unavailable");
        throw error;
      }
    }, { connection: this.redis, concurrency: 1 });
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private async closeResources(): Promise<void> {
    await this.worker.close();
    if (this.redis.status !== "end") await this.redis.quit();
  }
}
