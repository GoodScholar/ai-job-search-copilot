import { Module } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import type { AgentRunQueue } from "@job-copilot/domain/agent-runs";
import { createAgentRunCommands, createAgentRunQueries, createRecommendationRunCommands } from "@job-copilot/domain/agent-runs";
import { resolveJobDiscoveryExecutionMode } from "@job-copilot/domain/job-discovery-execution-mode";
import type { AuditTrail } from "@job-copilot/domain/audit-trail";
import { AuthModule, AUDIT_TRAIL } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { AgentRunsController } from "./agent-runs.controller.js";
import { AGENT_RUN_COMMANDS, AGENT_RUN_QUERIES, AGENT_RUN_QUEUE_PORT, RECOMMENDATION_RUN_COMMANDS } from "./agent-runs.tokens.js";
import { BullmqAgentRunQueue } from "./bullmq-agent-run-queue.js";
import { RunPreflightModule } from "../run-preflight/run-preflight.module.js";
import { RUN_PREFLIGHT_EVALUATOR, type RunPreflightEvaluator } from "../run-preflight/run-preflight.tokens.js";

export function createConfiguredJobDiscoveryExecutionMode(environment: NodeJS.ProcessEnv = process.env) {
  return resolveJobDiscoveryExecutionMode(environment);
}

@Module({
  imports: [RuntimeConfigModule, AuthModule, RunPreflightModule],
  controllers: [AgentRunsController],
  providers: [
    { provide: AGENT_RUN_QUEUE_PORT, useFactory: (): AgentRunQueue => new BullmqAgentRunQueue() },
    {
      provide: AGENT_RUN_COMMANDS,
      inject: [DATABASE, AGENT_RUN_QUEUE_PORT, AUDIT_TRAIL, RUN_PREFLIGHT_EVALUATOR],
      useFactory: (db: Database, queue: AgentRunQueue, auditTrail: AuditTrail, runPreflight: RunPreflightEvaluator) => createAgentRunCommands({
        db, queue, auditTrail, runPreflight, id: () => crypto.randomUUID(), clock: () => new Date(), executionMode: createConfiguredJobDiscoveryExecutionMode(),
      }),
    },
    {
      provide: AGENT_RUN_QUERIES,
      inject: [DATABASE],
      useFactory: (db: Database) => createAgentRunQueries({ db }),
    },
    {
      provide: RECOMMENDATION_RUN_COMMANDS,
      inject: [DATABASE, AGENT_RUN_QUEUE_PORT, AUDIT_TRAIL, RUN_PREFLIGHT_EVALUATOR],
      useFactory: (db: Database, queue: AgentRunQueue, auditTrail: AuditTrail, runPreflight: RunPreflightEvaluator) => createRecommendationRunCommands({
        db, queue, auditTrail, runPreflight, id: () => crypto.randomUUID(), clock: () => new Date(), executionMode: createConfiguredJobDiscoveryExecutionMode(),
      }),
    },
  ],
  exports: [AGENT_RUN_QUEUE_PORT, AGENT_RUN_COMMANDS, AGENT_RUN_QUERIES, RECOMMENDATION_RUN_COMMANDS],
})
export class AgentRunsModule {}
