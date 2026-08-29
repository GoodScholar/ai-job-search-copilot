import { Module } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import type { AgentRunQueue } from "@job-copilot/domain/agent-runs";
import { createAgentRunCommands, createAgentRunQueries } from "@job-copilot/domain/agent-runs";
import type { AuditTrail } from "@job-copilot/domain/audit-trail";
import { AuthModule, AUDIT_TRAIL } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { AgentRunsController } from "./agent-runs.controller.js";
import { AGENT_RUN_COMMANDS, AGENT_RUN_QUERIES, AGENT_RUN_QUEUE_PORT } from "./agent-runs.tokens.js";
import { BullmqAgentRunQueue } from "./bullmq-agent-run-queue.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule],
  controllers: [AgentRunsController],
  providers: [
    { provide: AGENT_RUN_QUEUE_PORT, useFactory: (): AgentRunQueue => new BullmqAgentRunQueue() },
    {
      provide: AGENT_RUN_COMMANDS,
      inject: [DATABASE, AGENT_RUN_QUEUE_PORT, AUDIT_TRAIL],
      useFactory: (db: Database, queue: AgentRunQueue, auditTrail: AuditTrail) => createAgentRunCommands({
        db, queue, auditTrail, id: () => crypto.randomUUID(), clock: () => new Date(),
      }),
    },
    {
      provide: AGENT_RUN_QUERIES,
      inject: [DATABASE],
      useFactory: (db: Database) => createAgentRunQueries({ db }),
    },
  ],
  exports: [AGENT_RUN_QUEUE_PORT, AGENT_RUN_COMMANDS, AGENT_RUN_QUERIES],
})
export class AgentRunsModule {}
