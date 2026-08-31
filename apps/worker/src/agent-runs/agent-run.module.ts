import { randomUUID } from "node:crypto";
import { Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { Client as MinioClient } from "minio";
import { createDatabase, type Database } from "@job-copilot/database";
import { createAuditTrail } from "@job-copilot/domain/audit-trail";
import { createAgentRunCommands, createAgentRunProcessor, createAgentRunRecoveryQueries, createLayeredPublicJobDiscoveryRuntime, type DiscoveryContentStore, type LayeredPublicJobDiscoveryWorkflowResolver } from "@job-copilot/domain/agent-runs";
import { resolveJobDiscoveryExecutionMode, validateJobDiscoveryRuntimeConfig } from "@job-copilot/domain/job-discovery-execution-mode";
import { createJobDiscoverySchedules } from "@job-copilot/domain/job-discovery-schedules";
import type { VerifiedJobEvidenceStore } from "@job-copilot/domain/verified-job-source-gate";
import { SecureJobPageFetcher } from "@job-copilot/source-access";

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
import { createJobDiscoveryAdapterResolver, createLayeredPublicJobDiscoveryWorkflowResolver, createSourceHealthDiscoveryAdapterResolver } from "./job-discovery-adapter-resolver.js";
import { AnySearchPublicJobAdapter, preflightAnySearchCandidate, type AnySearchCandidate, type AnySearchBeforeRequest } from "./anysearch-public-job-adapter.js";
import { GreenhouseTrustedSourceAdapter } from "./greenhouse-trusted-source-adapter.js";
import { MinioDiscoveryContentStore } from "./minio-discovery-content-store.js";
import { MinioVerifiedJobEvidenceStore } from "./minio-verified-job-evidence-store.js";

export const AGENT_RUN_CONSUMER = Symbol("AGENT_RUN_CONSUMER");
export const AGENT_RUN_RECONCILER = Symbol("AGENT_RUN_RECONCILER");
export const AGENT_RUN_QUEUE = Symbol("AGENT_RUN_QUEUE");
export const AGENT_RUN_DATABASE = Symbol("AGENT_RUN_DATABASE");
export const AGENT_RUN_RECOVERY_REPORTER = Symbol("AGENT_RUN_RECOVERY_REPORTER");
export const AGENT_RUN_SCHEDULER = Symbol("AGENT_RUN_SCHEDULER");
export const AGENT_RUN_SCHEDULE_REPORTER = Symbol("AGENT_RUN_SCHEDULE_REPORTER");
export const AGENT_RUN_EXECUTION_MODE = Symbol("AGENT_RUN_EXECUTION_MODE");

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

/** Worker v4 resolver 的配置入口；具体 workflow 只由生产端口组装，测试与未知环境 fail-closed。 */
export function createConfiguredLayeredPublicJobDiscoveryWorkflowResolver(input: {
  environment?: NodeJS.ProcessEnv;
  db: Database;
  auditTrail: ReturnType<typeof createAuditTrail>;
  contentStore: DiscoveryContentStore;
  evidenceStore: VerifiedJobEvidenceStore;
  id: () => string;
}): LayeredPublicJobDiscoveryWorkflowResolver {
  const environment = input.environment ?? process.env;
  validateJobDiscoveryRuntimeConfig(environment);
  if (environment.APP_ENV !== "production") {
    return createLayeredPublicJobDiscoveryWorkflowResolver({ createWorkflow: () => { throw new Error("AGENT_RUN_ADAPTER_UNSUPPORTED"); } });
  }
  return createLayeredPublicJobDiscoveryWorkflowResolver({
    createWorkflow: () => {
      const anySearch = new AnySearchPublicJobAdapter({ apiKey: environment.ANYSEARCH_API_KEY });
      const candidates = new Map<string, AnySearchCandidate>();
      return createLayeredPublicJobDiscoveryRuntime({
        db: input.db,
        id: input.id,
        auditTrail: input.auditTrail,
        contentStore: input.contentStore,
        evidenceStore: input.evidenceStore,
        trustedSourceAdapter: new GreenhouseTrustedSourceAdapter(),
        anySearch: {
          isConfigured: () => Boolean(environment.ANYSEARCH_API_KEY?.trim()),
          search: async ({ query, signal, beforeRequest: checkpoint }) => {
            const beforeRequest: AnySearchBeforeRequest = async (operation) => {
              if (operation.kind !== "search") return "blocked" as const;
              await checkpoint();
              return "proceed" as const;
            };
            const result = await anySearch.search({ ...query, signal }, beforeRequest);
            if (!result.ok && "error" in result) return { error: result.error };
            if (!("data" in result)) return { candidates: [] };
            const accepted = result.data.candidates.flatMap((outcome) => outcome.policy === "accepted" && outcome.candidate ? [outcome.candidate] : []);
            for (const candidate of accepted) candidates.set(`${candidate.queryId}:${candidate.candidateFingerprint}`, candidate);
            return { candidates: accepted.map((candidate) => ({ normalizedUrl: candidate.normalizedUrl, stableFingerprint: candidate.candidateFingerprint })) };
          },
          extract: async ({ candidate, signal, beforeRequest: checkpoint, authorizeRecoveredCandidate }) => {
            const issued = candidates.get(`${candidate.queryId}:${candidate.stableFingerprint}`) ?? Object.freeze({
              kind: "anysearch_public_job_candidate" as const, normalizedUrl: candidate.normalizedUrl, allowedSiteDomains: Object.freeze([...candidate.allowedSiteDomains]),
              queryId: candidate.queryId, candidateFingerprint: candidate.stableFingerprint,
            });
            // 恢复候选不复用进程内 Map；每次 extract 都拥有独立的 claim-bound 授权闭包。
            const adapter = candidates.has(`${candidate.queryId}:${candidate.stableFingerprint}`) ? anySearch : new AnySearchPublicJobAdapter({ apiKey: environment.ANYSEARCH_API_KEY, authorizeRecoveredCandidate });
            const beforeRequest: AnySearchBeforeRequest = async (operation) => {
              if (operation.kind !== "extract") return "blocked" as const;
              await checkpoint();
              return "proceed" as const;
            };
            const result = await adapter.extract({ candidate: issued, identity: candidate.leadId, signal }, beforeRequest);
            if (!result.ok && "error" in result) return { error: result.error };
            return "data" in result ? { normalizedUrl: result.data.normalizedUrl } : { error: { code: "ANYSEARCH_CANCELLED", retryable: false, httpStatus: null } };
          },
        },
        preflight: async ({ candidate }) => {
          const result = preflightAnySearchCandidate({ url: candidate.normalizedUrl, allowedSiteDomains: candidate.allowedSiteDomains });
          return result.ok ? { normalizedUrl: result.data.normalizedUrl } : null;
        },
        fetcher: {
          fetch: ({ candidate, signal }) => new SecureJobPageFetcher().fetch({ url: candidate.normalizedUrl, signal }),
        },
      });
    },
  });
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
    { provide: AGENT_RUN_EXECUTION_MODE, useFactory: () => createConfiguredJobDiscoveryExecutionMode() },
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
            sourceHealthAdapterResolver: createSourceHealthDiscoveryAdapterResolver(),
            layeredPublicWorkflowResolver: createConfiguredLayeredPublicJobDiscoveryWorkflowResolver({
              db,
              auditTrail: createAuditTrail({ db, clock: () => new Date() }),
              contentStore: new MinioDiscoveryContentStore(createMinioClient(), required("MINIO_BUCKET", "career-documents")),
              evidenceStore: new MinioVerifiedJobEvidenceStore(createMinioClient(), required("MINIO_BUCKET", "career-documents")),
              id: randomUUID,
            }),
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
      inject: [AGENT_RUN_DATABASE, AGENT_RUN_QUEUE, AGENT_RUN_SCHEDULE_REPORTER, AGENT_RUN_EXECUTION_MODE],
      useFactory: (
        database: AgentRunDatabase,
        queue: BullmqAgentRunQueue,
        reporter: AgentRunScheduleReporter,
        executionMode: ReturnType<typeof createConfiguredJobDiscoveryExecutionMode>,
      ) => {
        const db = database.db;
        const auditTrail = createAuditTrail({ db, clock: () => new Date() });
        const runs = createAgentRunCommands({
          db,
          queue,
          auditTrail,
          id: randomUUID,
          clock: () => new Date(),
          executionMode,
        });
        return new AgentRunScheduler({
          schedules: createJobDiscoverySchedules({ db, runs, auditTrail, id: randomUUID, clock: () => new Date(), executionMode }),
          reporter,
        });
      },
    },
  ],
  exports: [AGENT_RUN_CONSUMER, AGENT_RUN_SCHEDULER],
})
export class AgentRunModule {}
