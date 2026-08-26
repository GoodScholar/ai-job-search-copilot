import { Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { ZodSerializerInterceptor, ZodValidationPipe } from "nestjs-zod";
import { AccountsController } from "./accounts/accounts.controller.js";
import { AuthModule } from "./auth/auth.module.js";
import { ApiProblemFilter } from "./common/api-problem.filter.js";
import { RequestIdHook } from "./common/request-id.hook.js";
import { RuntimeConfigModule } from "./config/runtime-config.module.js";
import { HealthModule } from "./health/health.module.js";
import { WorkbenchController } from "./workbench/workbench.controller.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule, HealthModule],
  controllers: [AccountsController, WorkbenchController],
  providers: [
    RequestIdHook,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
    { provide: APP_FILTER, useClass: ApiProblemFilter },
  ],
})
export class AppModule {}
