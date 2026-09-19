import { Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { Client as MinioClient } from "minio";
import { createDatabase, type Database } from "@job-copilot/database";
import { createJobExportProcessor, createJobExportRecoveryQueries, type JobExportStore } from "@job-copilot/domain/job-exports";
import { JobExportConsumer } from "./job-export-consumer.js";
import { BullmqJobExportQueue, JobExportReconciler } from "./job-export-reconciler.js";
import { MinioJobExportStore } from "./minio-job-export-store.js";

export const JOB_EXPORT_CONSUMER = Symbol("JOB_EXPORT_CONSUMER");
export const JOB_EXPORT_RECONCILER = Symbol("JOB_EXPORT_RECONCILER");
export const JOB_EXPORT_QUEUE = Symbol("JOB_EXPORT_QUEUE");
export const JOB_EXPORT_STORE = Symbol("JOB_EXPORT_STORE");
export const JOB_EXPORT_DATABASE = Symbol("JOB_EXPORT_DATABASE");

function required(name: "DATABASE_URL" | "REDIS_URL" | "MINIO_ENDPOINT" | "MINIO_ACCESS_KEY" | "MINIO_SECRET_KEY" | "MINIO_BUCKET", fallback: string): string {
  const value = process.env[name]; if (value) return value; if (process.env.APP_ENV === "production") throw new Error(`${name} 必须配置`); return fallback;
}
function minio(): MinioClient { const endpoint = new URL(required("MINIO_ENDPOINT", `http://127.0.0.1:${process.env.MINIO_API_PORT ?? "59000"}`)); return new MinioClient({ endPoint: endpoint.hostname, port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)), useSSL: endpoint.protocol === "https:", accessKey: required("MINIO_ACCESS_KEY", "job_copilot"), secretKey: required("MINIO_SECRET_KEY", "local_only_job_copilot_secret") }); }
@Injectable()
class WorkerDatabase { readonly db: Database = createDatabase(required("DATABASE_URL", "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:54320/job_copilot")); async close(): Promise<void> { await this.db.$client.end({ timeout: 5 }); } }

@Module({
  providers: [
    { provide: JOB_EXPORT_DATABASE, useClass: WorkerDatabase },
    { provide: JOB_EXPORT_STORE, useFactory: (): JobExportStore => new MinioJobExportStore(minio(), required("MINIO_BUCKET", "career-documents")) },
    { provide: JOB_EXPORT_QUEUE, useFactory: () => new BullmqJobExportQueue(required("REDIS_URL", `redis://127.0.0.1:${process.env.REDIS_PORT ?? "63790"}`)) },
    { provide: JOB_EXPORT_CONSUMER, inject: [JOB_EXPORT_DATABASE, JOB_EXPORT_STORE], useFactory: (database: WorkerDatabase, store: JobExportStore) => new JobExportConsumer({ redisUrl: required("REDIS_URL", `redis://127.0.0.1:${process.env.REDIS_PORT ?? "63790"}`), processor: createJobExportProcessor({ db: database.db, store, clock: () => new Date() }) }) },
    { provide: JOB_EXPORT_RECONCILER, inject: [JOB_EXPORT_DATABASE, JOB_EXPORT_STORE, JOB_EXPORT_QUEUE], useFactory: (database: WorkerDatabase, store: JobExportStore, queue: BullmqJobExportQueue) => new JobExportReconciler({ queries: createJobExportRecoveryQueries({ db: database.db, clock: () => new Date() }), queue, store }) },
  ], exports: [JOB_EXPORT_CONSUMER],
})
export class JobExportModule implements OnModuleDestroy {
  constructor(@Inject(JOB_EXPORT_RECONCILER) private readonly reconciler: JobExportReconciler, @Inject(JOB_EXPORT_CONSUMER) private readonly consumer: JobExportConsumer, @Inject(JOB_EXPORT_QUEUE) private readonly queue: BullmqJobExportQueue, @Inject(JOB_EXPORT_DATABASE) private readonly database: WorkerDatabase) {}
  async onModuleDestroy(): Promise<void> { try { await this.reconciler.close(); } finally { try { await this.consumer.close(); } finally { try { await this.queue.close(); } finally { await this.database.close(); } } } }
}
