import { Module } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { ModelDiagnosticAdapter } from "@job-copilot/contracts/model-diagnostics";
import type { Database } from "@job-copilot/database";
import { createModelDiagnostics } from "@job-copilot/domain/model-diagnostics";
import { createOpenAiModelDiagnosticAdapter } from "@job-copilot/model-access";
import { createFakeModelDiagnosticAdapter } from "@job-copilot/model-access/testing";
import { AuthModule } from "../auth/auth.module.js";
import { DATABASE, RUNTIME_CONFIG, RuntimeConfigModule } from "../config/runtime-config.module.js";
import { ModelDiagnosticsController } from "./model-diagnostics.controller.js";
import { MODEL_DIAGNOSTICS } from "./model-diagnostics.tokens.js";

function configurationMissingAdapter(config: { endpoint?: string; organization?: string; project?: string }): ModelDiagnosticAdapter {
  const configurationFingerprint = createHash("sha256").update(JSON.stringify({ version: "model-diagnostic-v1", ...config, missingApiKey: true })).digest("hex");
  return { configurationFingerprint, async diagnose() { return { status: "failed", reasonCode: "MODEL_DIAGNOSTIC_CONFIGURATION_MISSING", latencyBucket: "under_1s", checks: { authentication: "not_verified", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "not_verified" } }; } };
}

@Module({
  imports: [RuntimeConfigModule, AuthModule], controllers: [ModelDiagnosticsController],
  providers: [{
    provide: MODEL_DIAGNOSTICS, inject: [DATABASE, RUNTIME_CONFIG],
    useFactory: (db: Database, config: { APP_ENV: string; openAi: { apiKey?: string; endpoint?: string; organization?: string; project?: string } }) => createModelDiagnostics({
      db, clock: () => new Date(), adapter: config.APP_ENV === "test" ? createFakeModelDiagnosticAdapter({ kind: "success" }) : config.openAi.apiKey ? createOpenAiModelDiagnosticAdapter(config.openAi as { apiKey: string; endpoint?: string; organization?: string; project?: string }) : configurationMissingAdapter(config.openAi),
    }),
  }], exports: [MODEL_DIAGNOSTICS],
})
export class ModelDiagnosticsModule {}
