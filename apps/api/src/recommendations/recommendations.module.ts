import { Module } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import { createDeepMatchQueries } from "@job-copilot/domain/deep-match-persistence";
import { createDeepMatchRunStarter } from "@job-copilot/domain/deep-match-agent-runs";
import type { AgentRunQueue } from "@job-copilot/domain/agent-runs";
import { AGENT_RUN_QUEUE_PORT } from "../agent-runs/agent-runs.tokens.js";
import { AuthModule } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { RecommendationsController } from "./recommendations.controller.js";
import { AgentRunsModule } from "../agent-runs/agent-runs.module.js";
import { RECOMMENDATION_QUERIES, RECOMMENDATION_RUN_STARTER } from "./recommendations.tokens.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule, AgentRunsModule], controllers: [RecommendationsController],
  providers: [
    { provide: RECOMMENDATION_QUERIES, inject: [DATABASE], useFactory: (db: Database) => createDeepMatchQueries({ db }) },
    { provide: RECOMMENDATION_RUN_STARTER, inject: [DATABASE, AGENT_RUN_QUEUE_PORT], useFactory: (db: Database, queue: AgentRunQueue) => createDeepMatchRunStarter({ db, queue, id: () => crypto.randomUUID(), clock: () => new Date() }) },
  ],
})
export class RecommendationsModule {}
