import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import { createRecommendationRunPreparationQueries } from "@job-copilot/domain/recommendation-runs-preparation";
import { createRecommendationRunQueries } from "@job-copilot/domain/recommendation-runs";
import { resolveJobDiscoveryExecutionMode } from "@job-copilot/domain/job-discovery-execution-mode";
import { AgentRunsModule } from "../agent-runs/agent-runs.module.js";
import { RECOMMENDATION_RUN_QUERIES } from "../agent-runs/agent-runs.tokens.js";
import { AuthModule } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { RunPreflightModule } from "../run-preflight/run-preflight.module.js";
import { RUN_PREFLIGHT_EVALUATOR, type RunPreflightEvaluator } from "../run-preflight/run-preflight.tokens.js";
import { RecommendationRunsController } from "./recommendation-runs.controller.js";
import { RECOMMENDATION_RUN_PREPARATION_QUERIES } from "./recommendation-runs.tokens.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule, AgentRunsModule, RunPreflightModule], controllers: [RecommendationRunsController],
  providers: [
    { provide: RECOMMENDATION_RUN_QUERIES, inject: [DATABASE], useFactory: (db: Database) => createRecommendationRunQueries({ db }) },
    { provide: RECOMMENDATION_RUN_PREPARATION_QUERIES, inject: [DATABASE, RUN_PREFLIGHT_EVALUATOR], useFactory: (db: Database, runPreflight: RunPreflightEvaluator) => createRecommendationRunPreparationQueries({ db, runPreflight, executionMode: resolveJobDiscoveryExecutionMode(process.env), id: () => crypto.randomUUID(), clock: () => new Date() }) },
  ],
})
export class RecommendationRunsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) { consumer.apply((_request: unknown, response: { setHeader(name: string, value: string): void }, next: () => void) => { response.setHeader("Cache-Control", "no-store"); next(); }).forRoutes(RecommendationRunsController); }
}
