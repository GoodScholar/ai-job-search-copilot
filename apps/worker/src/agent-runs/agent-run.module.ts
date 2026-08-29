import { randomUUID } from "node:crypto";
import { Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { Client as MinioClient } from "minio";
import { createDatabase, type Database } from "@job-copilot/database";
import { createAuditTrail } from "@job-copilot/domain/audit-trail";
import { createAgentRunProcessor, createAgentRunRecoveryQueries } from "@job-copilot/domain/agent-runs";

import { AgentRunConsumer } from "./agent-run-consumer.js";
import {
  AgentRunReconciler,
  BullmqAgentRunQueue,
  type AgentRunRecoveryFailure,
  type AgentRunRecoveryReporter,
} from "./agent-run-reconciler.js";
import { FakeJobDiscoveryAdapter } from "./fake-job-discovery-adapter.js";
import { MinioDiscoveryContentStore } from "./minio-discovery-content-store.js";

export const AGENT_RUN_CONSUMER = Symbol("AGENT_RUN_CONSUMER");
export const AGENT_RUN_RECONCILER = Symbol("AGENT_RUN_RECONCILER");
export const AGENT_RUN_QUEUE = Symbol("AGENT_RUN_QUEUE");
export const AGENT_RUN_DATABASE = Symbol("AGENT_RUN_DATABASE");
export const AGENT_RUN_RECOVERY_REPORTER = Symbol("AGENT_RUN_RECOVERY_REPORTER");

function required(
  name: "DATABASE_URL" | "REDIS_URL" | "MINIO_ENDPOINT" | "MINIO_ACCESS_KEY" | "MINIO_SECRET_KEY" | "MINIO_BUCKET",
  fallback: string,
): string {
  const value = process.env[name];
  if (value) return value;
  if (process.env.APP_ENV === "production") throw new Error(`${name} 必须配置`);
  return fallback;
}

function redisUrl(): string {
  return required("REDIS_URL", `redis://127.0.0.1:${process.env.REDIS_PORT ?? "63790"}`);
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

export function createConfiguredJobDiscoveryAdapter(environment: NodeJS.ProcessEnv = process.env): FakeJobDiscoveryAdapter {
  if (environment.APP_ENV !== "local" && environment.APP_ENV !== "test") {
    throw new Error("JobDiscoveryAdapter 环境未获允许");
  }
  return new FakeJobDiscoveryAdapter();
}

@Injectable()
class AgentRunDatabase implements OnModuleDestroy {
  readonly db: Database = createDatabase(required(
    "DATABASE_URL",
    "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:54320/job_copilot",
  ));

  async onModuleDestroy(): Promise<void> {
    await this.db.$client.end();
  }
}

@Module({
  providers: [
    { provide: AGENT_RUN_DATABASE, useClass: AgentRunDatabase },
    {
      provide: AGENT_RUN_QUEUE,
      useFactory: () => new BullmqAgentRunQueue(redisUrl()),
    },
    {
      provide: AGENT_RUN_RECOVERY_REPORTER,
      useValue: {
        report: (failure: AgentRunRecoveryFailure) => console.error("Agent run recovery failure", failure),
      } satisfies AgentRunRecoveryReporter,
    },
    {
      provide: AGENT_RUN_CONSUMER,
      inject: [AGENT_RUN_DATABASE],
      useFactory: (database: AgentRunDatabase) => {
        const db = database.db;
        return new AgentRunConsumer({
          redisUrl: redisUrl(),
          processor: createAgentRunProcessor({
            db,
            adapter: createConfiguredJobDiscoveryAdapter(),
            contentStore: new MinioDiscoveryContentStore(createMinioClient(), required("MINIO_BUCKET", "career-documents")),
            auditTrail: createAuditTrail({ db, clock: () => new Date() }),
            id: randomUUID,
            clock: () => new Date(),
          }),
        });
      },
    },
    {
      provide: AGENT_RUN_RECONCILER,
      inject: [AGENT_RUN_DATABASE, AGENT_RUN_QUEUE, AGENT_RUN_RECOVERY_REPORTER],
      useFactory: (
        database: AgentRunDatabase,
        queue: BullmqAgentRunQueue,
        reporter: AgentRunRecoveryReporter,
      ) => new AgentRunReconciler({
        recoveryQueries: createAgentRunRecoveryQueries({ db: database.db, clock: () => new Date() }),
        queue,
        reporter,
      }),
    },
  ],
  exports: [AGENT_RUN_CONSUMER],
})
export class AgentRunModule {}
