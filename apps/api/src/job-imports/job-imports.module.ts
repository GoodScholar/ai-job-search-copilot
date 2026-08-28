import { Module } from "@nestjs/common";
import { Client as MinioClient } from "minio";
import { type Database } from "@job-copilot/database";
import { createJobImportCommands, createJobImportQueries, type JobContentStore, type JobImportQueue } from "@job-copilot/domain/job-imports";
import { type AuditTrail } from "@job-copilot/domain/audit-trail";
import { AuthModule, AUDIT_TRAIL } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { BullmqJobImportQueue } from "./bullmq-job-import-queue.js";
import { JobImportsController } from "./job-imports.controller.js";
import { JOB_CONTENT_STORE, JOB_IMPORT_COMMANDS, JOB_IMPORT_QUEUE, JOB_IMPORT_QUERIES } from "./job-imports.tokens.js";
import { MinioJobContentStore } from "./minio-job-content-store.js";

function createMinioClient(): MinioClient {
  const endpoint = new URL(process.env.MINIO_ENDPOINT ?? `http://127.0.0.1:${process.env.MINIO_API_PORT ?? "59000"}`);
  return new MinioClient({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    useSSL: endpoint.protocol === "https:",
    accessKey: process.env.MINIO_ACCESS_KEY ?? "job_copilot",
    secretKey: process.env.MINIO_SECRET_KEY ?? "local_only_job_copilot_secret",
  });
}

@Module({
  imports: [RuntimeConfigModule, AuthModule],
  controllers: [JobImportsController],
  providers: [
    { provide: JOB_CONTENT_STORE, useFactory: (): JobContentStore => new MinioJobContentStore(createMinioClient()) },
    { provide: JOB_IMPORT_QUEUE, useFactory: (): JobImportQueue => new BullmqJobImportQueue() },
    {
      provide: JOB_IMPORT_COMMANDS,
      inject: [DATABASE, AUDIT_TRAIL, JOB_CONTENT_STORE, JOB_IMPORT_QUEUE],
      useFactory: (db: Database, auditTrail: AuditTrail, contentStore: JobContentStore, queue: JobImportQueue) => createJobImportCommands({
        db, auditTrail, contentStore, queue, id: () => crypto.randomUUID(), clock: () => new Date(),
      }),
    },
    {
      provide: JOB_IMPORT_QUERIES,
      inject: [DATABASE, JOB_CONTENT_STORE],
      useFactory: (db: Database, contentStore: JobContentStore) => createJobImportQueries({ db, contentStore }),
    },
  ],
})
export class JobImportsModule {}
