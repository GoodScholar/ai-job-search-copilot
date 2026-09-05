import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import { createRunPreflightEvaluator, createRunPreflightQueries } from "@job-copilot/domain/run-preflight";
import { resolveJobDiscoveryExecutionMode } from "@job-copilot/domain/job-discovery-execution-mode";
import { GreenhouseSourceCapabilityAdapter } from "@job-copilot/domain/source-capabilities";
import { AuthModule } from "../auth/auth.module.js";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { ModelDiagnosticsModule } from "../model-diagnostics/model-diagnostics.module.js";
import { MODEL_DIAGNOSTIC_PROJECTION_READER, type ModelDiagnosticProjection } from "../model-diagnostics/model-diagnostics.tokens.js";
import { RunPreflightController } from "./run-preflight.controller.js";
import { RUN_PREFLIGHT_EVALUATOR, RUN_PREFLIGHT_QUERIES, type RunPreflightEvaluator } from "./run-preflight.tokens.js";

@Module({
  imports: [RuntimeConfigModule, AuthModule, ModelDiagnosticsModule],
  controllers: [RunPreflightController],
  providers: [
    { provide: RUN_PREFLIGHT_EVALUATOR, inject: [MODEL_DIAGNOSTIC_PROJECTION_READER], useFactory: (modelDiagnosticReader: ModelDiagnosticProjection): RunPreflightEvaluator => createRunPreflightEvaluator({ capabilityAdapter: new GreenhouseSourceCapabilityAdapter(), modelDiagnosticReader, discoveryExecutionMode: resolveJobDiscoveryExecutionMode(process.env), id: () => crypto.randomUUID(), clock: () => new Date() }) },
    { provide: RUN_PREFLIGHT_QUERIES, inject: [DATABASE, RUN_PREFLIGHT_EVALUATOR], useFactory: (db: Database, evaluator: RunPreflightEvaluator) => createRunPreflightQueries({ db, evaluator }) },
  ],
  exports: [RUN_PREFLIGHT_EVALUATOR, RUN_PREFLIGHT_QUERIES],
})
export class RunPreflightModule implements NestModule {
  configure(consumer: MiddlewareConsumer) { consumer.apply((_request: unknown, response: { setHeader(name: string, value: string): void }, next: () => void) => { response.setHeader("Cache-Control", "no-store"); next(); }).forRoutes(RunPreflightController); }
}
