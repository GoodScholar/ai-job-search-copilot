import { Module } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import type { AgentRunStarter } from "@job-copilot/domain/agent-runs";
import type { AuditTrail } from "@job-copilot/domain/audit-trail";
import { createJobDiscoverySchedules } from "@job-copilot/domain/job-discovery-schedules";
import { AgentRunsModule } from "../agent-runs/agent-runs.module.js";
import { AGENT_RUN_COMMANDS, type AgentRunCommands } from "../agent-runs/agent-runs.tokens.js";
import { AuthModule, AUDIT_TRAIL } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { JobDiscoverySchedulesController } from "./job-discovery-schedules.controller.js";
import { JOB_DISCOVERY_SCHEDULES } from "./job-discovery-schedules.tokens.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule, AgentRunsModule],
  controllers: [JobDiscoverySchedulesController],
  providers: [{
    provide: JOB_DISCOVERY_SCHEDULES,
    inject: [DATABASE, AGENT_RUN_COMMANDS, AUDIT_TRAIL],
    useFactory: (db: Database, runs: AgentRunCommands, auditTrail: AuditTrail) => createJobDiscoverySchedules({ db, runs: runs as AgentRunStarter, auditTrail, id: () => crypto.randomUUID(), clock: () => new Date() }),
  }],
})
export class JobDiscoverySchedulesModule {}
