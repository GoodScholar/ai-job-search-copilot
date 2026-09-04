import { Worker } from "bullmq";
import Redis from "ioredis";
import { CAREER_IMPORT_QUEUE, CareerImportJobSchema } from "@job-copilot/contracts/career-import";
import type { createCareerImportProcessor } from "@job-copilot/domain/career-imports";
import { closeWithinDeadline } from "../close-within-deadline.js";

type CareerImportProcessor = ReturnType<typeof createCareerImportProcessor>;
export class CareerImportConsumer {
  private readonly redis: Redis;
  private readonly worker: Worker;
  private closePromise: Promise<void> | undefined;

  constructor(input: { redisUrl: string; processor: CareerImportProcessor }) {
    this.redis = new Redis(input.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(CAREER_IMPORT_QUEUE, async (job) => {
      const payload = CareerImportJobSchema.parse(job.data);
      const attempts = job.opts.attempts ?? 1;
      return input.processor.process({ ...payload, finalAttempt: job.attemptsMade + 1 >= attempts });
    }, { connection: this.redis, concurrency: 1 });
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    try {
      await closeWithinDeadline(this.worker.close(), "career import close deadline");
    } catch {
      // Redis fallback below releases the remaining live connection.
    }
    try {
      if (this.redis.status !== "end") await closeWithinDeadline(this.redis.quit(), "career import close deadline");
    } catch {
      // Disconnect below is the non-blocking final fallback.
    } finally {
      if (this.redis.status !== "end") this.redis.disconnect();
    }
  }
}
