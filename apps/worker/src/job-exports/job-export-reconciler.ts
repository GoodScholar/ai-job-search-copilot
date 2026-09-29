import type { OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { JOB_EXPORT_JOB_NAME, JOB_EXPORT_QUEUE, type JobExportJob } from "@job-copilot/contracts/job-exports";
import type { createJobExportRecoveryQueries, JobExportQueue, JobExportStore } from "@job-copilot/domain/job-exports";

type RecoveryQueries = ReturnType<typeof createJobExportRecoveryQueries>;

export class BullmqJobExportQueue implements JobExportQueue {
  private readonly redis: Redis;
  private readonly queue: Queue;
  constructor(redisUrl: string) { this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 }); this.queue = new Queue(JOB_EXPORT_QUEUE, { connection: this.redis }); }
  async enqueue(job: JobExportJob): Promise<void> { await this.queue.add(JOB_EXPORT_JOB_NAME, job, { jobId: job.exportId, attempts: 3, backoff: { type: "fixed", delay: 1_000 }, removeOnComplete: true, removeOnFail: true }); }
  async close(): Promise<void> { await this.queue.close(); this.redis.disconnect(); }
}

export class JobExportReconciler implements OnModuleInit {
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning = false;
  private destroyed = false;
  private scanPromise: Promise<void> | undefined;
  constructor(private readonly input: { queries: RecoveryQueries; queue: JobExportQueue; store: JobExportStore }) {}
  async onModuleInit(): Promise<void> {
    await this.scan().catch(() => undefined);
    this.timer = setInterval(() => { void this.scan().catch(() => undefined); }, 5_000);
  }
  async close(): Promise<void> {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    await this.scanPromise?.catch(() => undefined);
  }
  private async scan(): Promise<void> {
    if (this.destroyed || this.scanning) return;
    this.scanning = true;
    const work = (async () => {
      await this.input.queries.expire();
      for (const job of await this.input.queries.listRecoverable()) {
        try { await this.input.queue.enqueue(job); } catch { /* 下一次扫描重新入队，清理仍继续。 */ }
      }
      for (const item of await this.input.queries.listCleanupPending()) {
        try { await this.input.store.delete({ objectKey: item.objectKey }); await this.input.queries.markObjectDeleted(item); } catch { /* 下次扫描仍会读取 object_deleted_at 为空的记录。 */ }
      }
    })();
    this.scanPromise = work;
    try { await work; } finally { this.scanning = false; if (this.scanPromise === work) this.scanPromise = undefined; }
  }
}
