import { Module } from "@nestjs/common";
import { Client as MinioClient } from "minio";
import { createCareerImportCommands, createCareerImportQueries } from "@job-copilot/domain/career-imports";
import { type Database } from "@job-copilot/database";
import { AuthModule, AUDIT_TRAIL } from "../auth/auth.module.js";
import type { AuditTrail } from "@job-copilot/domain/audit-trail";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { BullmqCareerImportQueue } from "./bullmq-career-import-queue.js";
import { CareerImportController } from "./career-import.controller.js";
import { CAREER_DOCUMENT_STORE, CAREER_IMPORT_COMMANDS, CAREER_IMPORT_QUEUE, CAREER_IMPORT_QUERIES, type CareerDocumentStore, type CareerImportQueue } from "./career-import.tokens.js";
import { MinioCareerDocumentStore } from "./minio-career-document-store.js";

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
  controllers: [CareerImportController],
  providers: [
    { provide: CAREER_DOCUMENT_STORE, useFactory: (): CareerDocumentStore => new MinioCareerDocumentStore(createMinioClient()) },
    { provide: CAREER_IMPORT_QUEUE, useFactory: (): CareerImportQueue => new BullmqCareerImportQueue() },
    {
      provide: CAREER_IMPORT_COMMANDS,
      inject: [DATABASE, AUDIT_TRAIL, CAREER_DOCUMENT_STORE, CAREER_IMPORT_QUEUE],
      useFactory: (db: Database, auditTrail: AuditTrail, documentStore: CareerDocumentStore, queue: CareerImportQueue) => createCareerImportCommands({
        db, auditTrail, documentStore, queue, id: () => crypto.randomUUID(), clock: () => new Date(),
      }),
    },
    {
      provide: CAREER_IMPORT_QUERIES,
      inject: [DATABASE],
      useFactory: (db: Database) => createCareerImportQueries({ db }),
    },
  ],
})
export class CareerImportModule {}
