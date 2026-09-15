import { Module } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import type { AuditTrail } from "@job-copilot/domain/audit-trail";
import { createJobDiscoverySchedules } from "@job-copilot/domain/job-discovery-schedules";
import { createConfiguredJobDiscoveryExecutionMode } from "../agent-runs/agent-runs.module.js";
import { AgentRunsModule } from "../agent-runs/agent-runs.module.js";
import { RECOMMENDATION_RUN_COMMANDS, type RecommendationRunCommands } from "../agent-runs/agent-runs.tokens.js";
import { AuthModule, AUDIT_TRAIL } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { RunPreflightModule } from "../run-preflight/run-preflight.module.js";
import { RUN_PREFLIGHT_EVALUATOR, type RunPreflightEvaluator } from "../run-preflight/run-preflight.tokens.js";
import { JobDiscoverySchedulesController } from "./job-discovery-schedules.controller.js";
import { JOB_DISCOVERY_SCHEDULES } from "./job-discovery-schedules.tokens.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule, AgentRunsModule, RunPreflightModule],
  controllers: [JobDiscoverySchedulesController],
  providers: [{
    provide: JOB_DISCOVERY_SCHEDULES,
    inject: [DATABASE, RECOMMENDATION_RUN_COMMANDS, AUDIT_TRAIL, RUN_PREFLIGHT_EVALUATOR],
    useFactory: (db: Database, recommendations: RecommendationRunCommands, auditTrail: AuditTrail, runPreflight: RunPreflightEvaluator) => createJobDiscoverySchedules({ db, recommendations, runPreflight, auditTrail, id: () => crypto.randomUUID(), clock: () => new Date(), executionMode: createConfiguredJobDiscoveryExecutionMode() }),
  }],
})
export class JobDiscoverySchedulesModule {}
