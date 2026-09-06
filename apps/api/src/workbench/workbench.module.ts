import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { createWorkbenchHome } from "@job-copilot/domain/workbench-home";
import { createFirstRecommendationJourneyCommands, createFirstRecommendationJourneyReader } from "@job-copilot/domain/first-recommendation-journey";
import type { Database } from "@job-copilot/database";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { RunPreflightModule } from "../run-preflight/run-preflight.module.js";
import { RUN_PREFLIGHT_EVALUATOR, type RunPreflightEvaluator } from "../run-preflight/run-preflight.tokens.js";
import { WorkbenchController } from "./workbench.controller.js";
import { FIRST_RECOMMENDATION_JOURNEY_COMMANDS, WORKBENCH_HOME } from "./workbench.tokens.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule, RunPreflightModule],
  controllers: [WorkbenchController],
  providers: [
    {
      provide: WORKBENCH_HOME,
      inject: [DATABASE, RUN_PREFLIGHT_EVALUATOR],
      useFactory: (database: Database, runPreflight: RunPreflightEvaluator) => createWorkbenchHome({
        db: database,
        clock: () => new Date(),
        firstRecommendationJourney: createFirstRecommendationJourneyReader({ db: database, runPreflight }),
      }),
    },
    {
      provide: FIRST_RECOMMENDATION_JOURNEY_COMMANDS,
      inject: [DATABASE],
      useFactory: (database: Database) => createFirstRecommendationJourneyCommands({ db: database, clock: () => new Date() }),
    },
  ],
})
export class WorkbenchModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply((_request: unknown, response: { setHeader(name: string, value: string): void }, next: () => void) => {
      response.setHeader("Cache-Control", "no-store");
      next();
    }).forRoutes(WorkbenchController);
  }
}
