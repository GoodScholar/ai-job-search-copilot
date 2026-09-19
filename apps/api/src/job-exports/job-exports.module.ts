import { Module } from "@nestjs/common";
import { Client as MinioClient } from "minio";
import type { Database } from "@job-copilot/database";
import { createJobExportCommands, createJobExportQueries, type JobExportQueue, type JobExportStore } from "@job-copilot/domain/job-exports";
import { AuthModule } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { BullmqJobExportQueue } from "./bullmq-job-export-queue.js";
import { JobExportsController } from "./job-exports.controller.js";
import { JOB_EXPORT_COMMANDS, JOB_EXPORT_QUERIES, JOB_EXPORT_QUEUE, JOB_EXPORT_STORE } from "./job-exports.tokens.js";
import { MinioJobExportStore } from "./minio-job-export-store.js";

function minioClient(): MinioClient {
  const endpoint = new URL(process.env.MINIO_ENDPOINT ?? `http://127.0.0.1:${process.env.MINIO_API_PORT ?? "59000"}`);
  return new MinioClient({ endPoint: endpoint.hostname, port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)), useSSL: endpoint.protocol === "https:", accessKey: process.env.MINIO_ACCESS_KEY ?? "job_copilot", secretKey: process.env.MINIO_SECRET_KEY ?? "local_only_job_copilot_secret" });
}

@Module({
  imports: [RuntimeConfigModule, AuthModule], controllers: [JobExportsController],
  providers: [
    { provide: JOB_EXPORT_QUEUE, useFactory: (): JobExportQueue => new BullmqJobExportQueue() },
    { provide: JOB_EXPORT_STORE, useFactory: (): JobExportStore => new MinioJobExportStore(minioClient()) },
    { provide: JOB_EXPORT_COMMANDS, inject: [DATABASE, JOB_EXPORT_QUEUE], useFactory: (db: Database, queue: JobExportQueue) => createJobExportCommands({ db, queue, id: () => crypto.randomUUID(), clock: () => new Date() }) },
    { provide: JOB_EXPORT_QUERIES, inject: [DATABASE], useFactory: (db: Database) => createJobExportQueries({ db, clock: () => new Date() }) },
  ],
})
export class JobExportsModule {}
