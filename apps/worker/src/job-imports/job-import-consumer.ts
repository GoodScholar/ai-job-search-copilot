import { Worker } from "bullmq";
import type { OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { JOB_IMPORT_CLAIM_LEASE_MS, JOB_IMPORT_QUEUE, JobImportJobSchema } from "@job-copilot/contracts/job-imports";
import { JobImportRetryableError, type createJobImportProcessor } from "@job-copilot/domain/job-imports";

type JobImportProcessor = ReturnType<typeof createJobImportProcessor>;

export function jobImportAttemptContext(attemptsMade: number, attempts: number | undefined): { finalAttempt: boolean; attemptCount: number } {
  const attemptCount = attemptsMade + 1;
  return { finalAttempt: attemptCount >= (attempts ?? 1), attemptCount };
}

export class JobImportConsumer implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly worker: Worker;
  private closePromise: Promise<void> | undefined;

  constructor(input: { redisUrl: string; processor: JobImportProcessor }) {
    this.redis = new Redis(input.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(JOB_IMPORT_QUEUE, async (job) => {
      const payload = JobImportJobSchema.parse(job.data);
      const attempt = jobImportAttemptContext(job.attemptsMade, job.opts.attempts);
      try {
        return await input.processor.process({ ...payload, ...attempt });
      } catch (error) {
        if (error instanceof JobImportRetryableError) throw new Error("job import temporarily unavailable");
        throw error;
      }
    }, {
      connection: this.redis,
      concurrency: 1,
      lockDuration: JOB_IMPORT_CLAIM_LEASE_MS,
      stalledInterval: JOB_IMPORT_CLAIM_LEASE_MS,
    });
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
