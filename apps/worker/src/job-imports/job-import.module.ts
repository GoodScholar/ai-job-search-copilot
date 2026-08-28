import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { Client as MinioClient } from "minio";
import { createDatabase, type Database } from "@job-copilot/database";
import { JOB_IMPORT_MAX_BYTES } from "@job-copilot/contracts/job-imports";
import { createAuditTrail } from "@job-copilot/domain/audit-trail";
import { createJobImportProcessor, type JobContentStore } from "@job-copilot/domain/job-imports";
import { FakeJobPostingNormalizer } from "./fake-job-posting-normalizer.js";
import { JobImportConsumer } from "./job-import-consumer.js";

export const JOB_IMPORT_CONSUMER = Symbol("JOB_IMPORT_CONSUMER");
export const WORKER_DATABASE = Symbol("WORKER_DATABASE");

const E2E_JOB_NORMALIZER_DELAY_MAX_MS = 5_000;

export function resolveE2eJobNormalizerDelayMs(environment: NodeJS.ProcessEnv = process.env): number {
  if (environment.APP_ENV !== "test") return 0;
  const configured = Number(environment.E2E_JOB_NORMALIZER_DELAY_MS ?? "0");
  if (!Number.isFinite(configured) || !Number.isInteger(configured) || configured < 0 || configured > E2E_JOB_NORMALIZER_DELAY_MAX_MS) return 0;
  return configured;
}

export function createConfiguredJobPostingNormalizer(environment: NodeJS.ProcessEnv = process.env): FakeJobPostingNormalizer {
  if (environment.APP_ENV === "production") throw new Error("生产 JobPostingNormalizer adapter 尚未配置");
  return new FakeJobPostingNormalizer({
    enableFailureFixture: environment.APP_ENV === "test",
    testDelayMs: resolveE2eJobNormalizerDelayMs(environment),
  });
}

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

class MinioJobContentStore implements JobContentStore {
  constructor(private readonly client: MinioClient, private readonly bucket: string) {}

  async put(input: { objectKey: string; bytes: Uint8Array; mediaType: "text/markdown"; importId: string }): Promise<void> {
    await this.client.putObject(this.bucket, input.objectKey, Readable.from([input.bytes]), input.bytes.byteLength, {
      "content-type": input.mediaType,
      "x-amz-meta-job-import-id": input.importId,
    });
  }

  async get({ objectKey }: { objectKey: string }): Promise<Uint8Array> {
    const stream = await this.client.getObject(this.bucket, objectKey);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = new Uint8Array(chunk);
      size += bytes.byteLength;
      if (size > JOB_IMPORT_MAX_BYTES) throw new Error("job import content exceeds configured size");
      chunks.push(bytes);
    }
    const value = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      value.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return value;
  }

  async delete({ objectKey }: { objectKey: string }): Promise<void> {
    await this.client.removeObject(this.bucket, objectKey);
  }
}

@Injectable()
class WorkerDatabase implements OnModuleDestroy {
  readonly db: Database = createDatabase(required("DATABASE_URL", "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:54320/job_copilot"));

  async onModuleDestroy(): Promise<void> {
    await this.db.$client.end();
  }
}

@Module({
  providers: [
    { provide: WORKER_DATABASE, useClass: WorkerDatabase },
    {
      provide: JOB_IMPORT_CONSUMER,
      inject: [WORKER_DATABASE],
      useFactory: (workerDatabase: WorkerDatabase): JobImportConsumer => {
        const db = workerDatabase.db;
        const contentStore = new MinioJobContentStore(createMinioClient(), required("MINIO_BUCKET", "career-documents"));
        const processor = createJobImportProcessor({
          db,
          auditTrail: createAuditTrail({ db, clock: () => new Date() }),
          contentStore,
          normalizer: createConfiguredJobPostingNormalizer(),
          id: randomUUID,
          clock: () => new Date(),
        });
        return new JobImportConsumer({
          redisUrl: required("REDIS_URL", `redis://127.0.0.1:${process.env.REDIS_PORT ?? "63790"}`),
          processor,
        });
      },
    },
  ],
  exports: [JOB_IMPORT_CONSUMER],
})
export class JobImportModule {}
