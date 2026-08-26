import { Module } from "@nestjs/common";
import { createWorkbenchHome } from "@job-copilot/domain/workbench-home";
import type { Database } from "@job-copilot/database";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { WorkbenchController } from "./workbench.controller.js";
import { WORKBENCH_HOME } from "./workbench.tokens.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule],
  controllers: [WorkbenchController],
  providers: [{
    provide: WORKBENCH_HOME,
    inject: [DATABASE],
    useFactory: (database: Database) => createWorkbenchHome({ db: database }),
  }],
})
export class WorkbenchModule {}
