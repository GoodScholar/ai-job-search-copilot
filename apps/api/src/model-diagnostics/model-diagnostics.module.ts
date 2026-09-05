import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import { createModelDiagnosticProjectionReader, createModelDiagnostics } from "@job-copilot/domain/model-diagnostics";
import { createOpenAiModelDiagnosticAdapter } from "@job-copilot/model-access";
import { createFakeModelDiagnosticAdapter, TEST_MODEL_DIAGNOSTIC_FINGERPRINT_SEED, type ModelDiagnosticFakeScenario } from "@job-copilot/model-access/testing";
import { AuthModule } from "../auth/auth.module.js";
import { DATABASE, RUNTIME_CONFIG, RuntimeConfigModule } from "../config/runtime-config.module.js";
import type { RuntimeConfig } from "@job-copilot/domain/runtime-config";
import { ModelDiagnosticsController } from "./model-diagnostics.controller.js";
import { MODEL_DIAGNOSTIC_ADAPTER, MODEL_DIAGNOSTIC_PROJECTION_READER, MODEL_DIAGNOSTICS, type ModelDiagnosticsAdapter } from "./model-diagnostics.tokens.js";

const testScenarios = ["success", "authentication_failed", "provider_unavailable"] as const;
function testScenario(appEnv: string): ModelDiagnosticFakeScenario {
  const configured = process.env.E2E_MODEL_DIAGNOSTIC_SCENARIO;
  if (configured !== undefined && appEnv !== "test") throw new Error("MODEL_DIAGNOSTIC_TEST_SCENARIO_DISABLED");
  if (configured === undefined) return { kind: "success" };
  if (!(testScenarios as readonly string[]).includes(configured)) throw new Error("MODEL_DIAGNOSTIC_TEST_SCENARIO_INVALID");
  return { kind: configured as (typeof testScenarios)[number] };
}
@Module({
  imports: [RuntimeConfigModule, AuthModule], controllers: [ModelDiagnosticsController],
  providers: [
    { provide: MODEL_DIAGNOSTIC_ADAPTER, inject: [RUNTIME_CONFIG], useFactory: (config: RuntimeConfig): ModelDiagnosticsAdapter => config.APP_ENV === "test" ? createFakeModelDiagnosticAdapter(testScenario(config.APP_ENV), TEST_MODEL_DIAGNOSTIC_FINGERPRINT_SEED) : createOpenAiModelDiagnosticAdapter({ ...config.openAi, apiKey: config.openAi.apiKey ?? "" }) },
    { provide: MODEL_DIAGNOSTIC_PROJECTION_READER, inject: [MODEL_DIAGNOSTIC_ADAPTER], useFactory: (adapter: ModelDiagnosticsAdapter) => createModelDiagnosticProjectionReader({ configurationFingerprint: adapter.configurationFingerprint }) },
    { provide: MODEL_DIAGNOSTICS, inject: [DATABASE, MODEL_DIAGNOSTIC_ADAPTER], useFactory: (db: Database, adapter: ModelDiagnosticsAdapter) => createModelDiagnostics({ db, clock: () => new Date(), adapter }) },
  ], exports: [MODEL_DIAGNOSTICS, MODEL_DIAGNOSTIC_PROJECTION_READER],
})
export class ModelDiagnosticsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) { consumer.apply((_request: unknown, response: { setHeader(name: string, value: string): void }, next: () => void) => { response.setHeader("Cache-Control", "no-store"); next(); }).forRoutes(ModelDiagnosticsController); }
}
