import { randomUUID } from "node:crypto";
import { Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { Client as MinioClient } from "minio";
import { createDatabase, type Database } from "@job-copilot/database";
import { createAuditTrail } from "@job-copilot/domain/audit-trail";
import { createAgentRunCommands, createAgentRunProcessor, createAgentRunRecoveryQueries } from "@job-copilot/domain/agent-runs";
import { resolveJobDiscoveryExecutionMode } from "@job-copilot/domain/job-discovery-execution-mode";
import { createJobDiscoverySchedules } from "@job-copilot/domain/job-discovery-schedules";

import { AgentRunConsumer } from "./agent-run-consumer.js";
import {
  AgentRunReconciler,
  BullmqAgentRunQueue,
  type AgentRunRecoveryFailure,
  type AgentRunRecoveryReporter,
} from "./agent-run-reconciler.js";
import {
  AgentRunScheduler,
  type AgentRunScheduleFailure,
  type AgentRunScheduleReporter,
} from "./agent-run-scheduler.js";
import { createJobDiscoveryAdapterResolver } from "./job-discovery-adapter-resolver.js";
import { MinioDiscoveryContentStore } from "./minio-discovery-content-store.js";

export const AGENT_RUN_CONSUMER = Symbol("AGENT_RUN_CONSUMER");
export const AGENT_RUN_RECONCILER = Symbol("AGENT_RUN_RECONCILER");
export const AGENT_RUN_QUEUE = Symbol("AGENT_RUN_QUEUE");
export const AGENT_RUN_DATABASE = Symbol("AGENT_RUN_DATABASE");
export const AGENT_RUN_RECOVERY_REPORTER = Symbol("AGENT_RUN_RECOVERY_REPORTER");
export const AGENT_RUN_SCHEDULER = Symbol("AGENT_RUN_SCHEDULER");
export const AGENT_RUN_SCHEDULE_REPORTER = Symbol("AGENT_RUN_SCHEDULE_REPORTER");

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

export function createConfiguredJobDiscoveryExecutionMode(environment: NodeJS.ProcessEnv = process.env) {
  return resolveJobDiscoveryExecutionMode(environment);
}

export function createConfiguredJobDiscoveryAdapterResolver(environment: NodeJS.ProcessEnv = process.env) {
  return createJobDiscoveryAdapterResolver(environment);
}

@Injectable()
class AgentRunDatabase implements OnModuleDestroy {
  readonly db: Database = createDatabase(required(
    "DATABASE_URL",
    "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:54320/job_copilot",
  ));

  async onModuleDestroy(): Promise<void> {
    await this.db.$client.end({ timeout: 5 });
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
      provide: AGENT_RUN_SCHEDULE_REPORTER,
      useValue: {
        report: (failure: AgentRunScheduleFailure) => console.error("Job discovery schedule failure", failure),
      } satisfies AgentRunScheduleReporter,
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
            adapterResolver: createConfiguredJobDiscoveryAdapterResolver(),
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
    {
      provide: AGENT_RUN_SCHEDULER,
      inject: [AGENT_RUN_DATABASE, AGENT_RUN_QUEUE, AGENT_RUN_SCHEDULE_REPORTER],
      useFactory: (
        database: AgentRunDatabase,
        queue: BullmqAgentRunQueue,
        reporter: AgentRunScheduleReporter,
      ) => {
        const db = database.db;
        const auditTrail = createAuditTrail({ db, clock: () => new Date() });
        const runs = createAgentRunCommands({
          db,
          queue,
          auditTrail,
          id: randomUUID,
          clock: () => new Date(),
          executionMode: createConfiguredJobDiscoveryExecutionMode(),
        });
        return new AgentRunScheduler({
          schedules: createJobDiscoverySchedules({ db, runs, auditTrail, id: randomUUID, clock: () => new Date() }),
          reporter,
        });
      },
    },
  ],
  exports: [AGENT_RUN_CONSUMER, AGENT_RUN_SCHEDULER],
})
export class AgentRunModule {}
