import { randomUUID } from "node:crypto";
import { Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { Client as MinioClient } from "minio";
import { createDatabase, type Database } from "@job-copilot/database";
import { createAuditTrail } from "@job-copilot/domain/audit-trail";
import { createCareerImportProcessor } from "@job-copilot/domain/career-imports";
import { CareerImportConsumer } from "./career-import-consumer.js";
import { FakeCareerDocumentParser } from "./fake-career-document-parser.js";
import { MinioCareerDocumentStore } from "./minio-career-document-store.js";

export const CAREER_IMPORT_CONSUMER = Symbol("CAREER_IMPORT_CONSUMER");
export const WORKER_DATABASE = Symbol("WORKER_DATABASE");

function required(name: "DATABASE_URL" | "REDIS_URL" | "MINIO_ENDPOINT" | "MINIO_ACCESS_KEY" | "MINIO_SECRET_KEY" | "MINIO_BUCKET", fallback: string): string {
  const value = process.env[name];
  if (value) return value;
  if (process.env.APP_ENV === "production") throw new Error(`${name} 必须配置`);
  return fallback;
}

function createMinioClient(): MinioClient {
  const endpoint = new URL(required("MINIO_ENDPOINT", `http://127.0.0.1:${process.env.MINIO_API_PORT ?? "59000"}`));
  return new MinioClient({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    useSSL: endpoint.protocol === "https:",
    accessKey: required("MINIO_ACCESS_KEY", "job_copilot"),
    secretKey: required("MINIO_SECRET_KEY", "local_only_job_copilot_secret"),
  });
}

@Injectable()
class WorkerDatabase {
  readonly db: Database = createDatabase(required("DATABASE_URL", "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:54320/job_copilot"));
  private closePromise: Promise<void> | undefined;

  close(): Promise<void> {
    this.closePromise ??= this.db.$client.end();
    return this.closePromise;
  }
}

@Module({
  providers: [
    { provide: WORKER_DATABASE, useClass: WorkerDatabase },
    {
      provide: CAREER_IMPORT_CONSUMER,
      inject: [WORKER_DATABASE],
      useFactory: (workerDatabase: WorkerDatabase): CareerImportConsumer => {
        const db = workerDatabase.db;
        const documentStore = new MinioCareerDocumentStore(createMinioClient(), required("MINIO_BUCKET", "career-documents"));
        const processor = createCareerImportProcessor({
          db,
          auditTrail: createAuditTrail({ db, clock: () => new Date() }),
          documentStore,
          parser: new FakeCareerDocumentParser(),
          id: randomUUID,
          clock: () => new Date(),
        });
        return new CareerImportConsumer({
          redisUrl: required("REDIS_URL", `redis://127.0.0.1:${process.env.REDIS_PORT ?? "63790"}`),
          processor,
        });
      },
    },
  ],
  exports: [CAREER_IMPORT_CONSUMER],
})
export class CareerImportModule implements OnModuleDestroy {
  constructor(
    @Inject(CAREER_IMPORT_CONSUMER) private readonly consumer: CareerImportConsumer,
    @Inject(WORKER_DATABASE) private readonly database: WorkerDatabase,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.consumer.close();
    await this.database.close();
  }
}
