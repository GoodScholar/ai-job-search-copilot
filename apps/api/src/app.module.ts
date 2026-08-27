import { Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { ZodSerializerInterceptor, ZodValidationPipe } from "nestjs-zod";
import { AccountsController } from "./accounts/accounts.controller.js";
import { AuthModule } from "./auth/auth.module.js";
import { ApiProblemFilter } from "./common/api-problem.filter.js";
import { RequestIdHook } from "./common/request-id.hook.js";
import { RuntimeConfigModule } from "./config/runtime-config.module.js";
import { HealthModule } from "./health/health.module.js";
import { CareerImportModule } from "./career-import/career-import.module.js";
import { WorkbenchModule } from "./workbench/workbench.module.js";
import { ProfileReviewModule } from "./profile-review/profile-review.module.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule, HealthModule, WorkbenchModule, CareerImportModule, ProfileReviewModule],
  controllers: [AccountsController],
  providers: [
    RequestIdHook,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
    { provide: APP_FILTER, useClass: ApiProblemFilter },
  ],
})
export class AppModule {}
