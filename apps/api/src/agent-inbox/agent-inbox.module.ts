import { Module } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import { createAgentInbox } from "@job-copilot/domain/agent-runs";
import type { AuditTrail } from "@job-copilot/domain/audit-trail";
import { AuthModule, AUDIT_TRAIL } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { AgentRunsModule } from "../agent-runs/agent-runs.module.js";
import { AGENT_RUN_COMMANDS, RECOMMENDATION_RUN_COMMANDS, type AgentRunCommands, type RecommendationRunCommands } from "../agent-runs/agent-runs.tokens.js";
import { AgentInboxController } from "./agent-inbox.controller.js";
import { AGENT_INBOX } from "./agent-inbox.tokens.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule, AgentRunsModule],
  controllers: [AgentInboxController],
  providers: [{
    provide: AGENT_INBOX,
    inject: [DATABASE, AGENT_RUN_COMMANDS, RECOMMENDATION_RUN_COMMANDS, AUDIT_TRAIL],
    useFactory: (db: Database, commands: AgentRunCommands, recommendationCommands: RecommendationRunCommands, auditTrail: AuditTrail) => createAgentInbox({
      db, commands, recommendationCommands, auditTrail, id: () => crypto.randomUUID(), clock: () => new Date(),
    }),
  }],
})
export class AgentInboxModule {}
