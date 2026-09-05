import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import type { Database } from "@job-copilot/database";
import { createModelDiagnostics } from "@job-copilot/domain/model-diagnostics";
import { createOpenAiModelDiagnosticAdapter } from "@job-copilot/model-access";
import { createFakeModelDiagnosticAdapter, type ModelDiagnosticFakeScenario } from "@job-copilot/model-access/testing";
import { AuthModule } from "../auth/auth.module.js";
import { DATABASE, RUNTIME_CONFIG, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { ModelDiagnosticsController } from "./model-diagnostics.controller.js";
import { MODEL_DIAGNOSTICS } from "./model-diagnostics.tokens.js";

type OpenAiConfig = { apiKey?: string; endpoint?: string; organization?: string; project?: string; lowCostModel: string; highQualityModel: string };
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
  providers: [{
    provide: MODEL_DIAGNOSTICS, inject: [DATABASE, RUNTIME_CONFIG],
    useFactory: (db: Database, config: { APP_ENV: string; openAi: OpenAiConfig }) => createModelDiagnostics({
      db, clock: () => new Date(), adapter: config.APP_ENV === "test" ? createFakeModelDiagnosticAdapter(testScenario(config.APP_ENV)) : createOpenAiModelDiagnosticAdapter({ ...config.openAi, apiKey: config.openAi.apiKey ?? "" }),
    }),
  }], exports: [MODEL_DIAGNOSTICS],
})
export class ModelDiagnosticsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) { consumer.apply((_request: unknown, response: { setHeader(name: string, value: string): void }, next: () => void) => { response.setHeader("Cache-Control", "no-store"); next(); }).forRoutes(ModelDiagnosticsController); }
}
