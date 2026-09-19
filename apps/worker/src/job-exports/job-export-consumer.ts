import { Worker } from "bullmq";
import Redis from "ioredis";
import { JOB_EXPORT_QUEUE, JobExportJobSchema } from "@job-copilot/contracts/job-exports";
import type { createJobExportProcessor } from "@job-copilot/domain/job-exports";
import { closeWithinDeadline } from "../close-within-deadline.js";

type JobExportProcessor = ReturnType<typeof createJobExportProcessor>;

export class JobExportConsumer {
  private readonly redis: Redis;
  private readonly worker: Worker;
  private closePromise: Promise<void> | undefined;

  constructor(input: { redisUrl: string; processor: JobExportProcessor }) {
    this.redis = new Redis(input.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(JOB_EXPORT_QUEUE, async (job) => {
      const payload = JobExportJobSchema.parse(job.data);
      const attempts = job.opts.attempts ?? 1;
      return input.processor.process({ ...payload, finalAttempt: job.attemptsMade + 1 >= attempts });
    }, { connection: this.redis, concurrency: 1 });
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    try { await closeWithinDeadline(this.worker.close(), "job export close deadline"); } catch { /* Redis fallback below. */ }
    try { if (this.redis.status !== "end") await closeWithinDeadline(this.redis.quit(), "job export redis close deadline"); } catch { /* disconnect below. */ }
    finally { if (this.redis.status !== "end") this.redis.disconnect(); }
  }
}
