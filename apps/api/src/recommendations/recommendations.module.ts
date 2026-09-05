import { Module } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import { createRecommendationQueries } from "@job-copilot/domain/recommendation-queries";
import { createDeepMatchRunStarter } from "@job-copilot/domain/deep-match-agent-runs";
import { createRecommendationFeedbackCommands, createRecommendationFeedbackQueries } from "@job-copilot/domain/recommendation-feedback";
import type { AgentRunQueue } from "@job-copilot/domain/agent-runs";
import { AGENT_RUN_QUEUE_PORT } from "../agent-runs/agent-runs.tokens.js";
import { AuthModule } from "../auth/auth.module.js";
import { AUDIT_TRAIL } from "../auth/auth.module.js";
import type { AuditTrail } from "@job-copilot/domain/audit-trail";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { RecommendationsController } from "./recommendations.controller.js";
import { AgentRunsModule } from "../agent-runs/agent-runs.module.js";
import { RECOMMENDATION_FEEDBACK_COMMANDS, RECOMMENDATION_FEEDBACK_QUERIES, RECOMMENDATION_QUERIES, RECOMMENDATION_RUN_STARTER } from "./recommendations.tokens.js";
import { RunPreflightModule } from "../run-preflight/run-preflight.module.js";
import { RUN_PREFLIGHT_EVALUATOR, type RunPreflightEvaluator } from "../run-preflight/run-preflight.tokens.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule, AgentRunsModule, RunPreflightModule], controllers: [RecommendationsController],
  providers: [
    { provide: RECOMMENDATION_QUERIES, inject: [DATABASE], useFactory: (db: Database) => createRecommendationQueries({ db }) },
    { provide: RECOMMENDATION_RUN_STARTER, inject: [DATABASE, AGENT_RUN_QUEUE_PORT, RUN_PREFLIGHT_EVALUATOR], useFactory: (db: Database, queue: AgentRunQueue, runPreflight: RunPreflightEvaluator) => createDeepMatchRunStarter({ db, queue, runPreflight, id: () => crypto.randomUUID(), clock: () => new Date() }) },
    { provide: RECOMMENDATION_FEEDBACK_COMMANDS, inject: [DATABASE, AUDIT_TRAIL], useFactory: (db: Database, auditTrail: AuditTrail) => createRecommendationFeedbackCommands({ db, auditTrail, id: () => crypto.randomUUID(), clock: () => new Date() }) },
    { provide: RECOMMENDATION_FEEDBACK_QUERIES, inject: [DATABASE], useFactory: (db: Database) => createRecommendationFeedbackQueries({ db }) },
  ],
})
export class RecommendationsModule {}
