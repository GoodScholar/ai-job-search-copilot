import { randomUUID } from "node:crypto";
import { createRunPreflightEvaluator } from "@job-copilot/domain/run-preflight";
import { createModelDiagnosticProjectionReader } from "@job-copilot/domain/model-diagnostics";
import { resolveJobDiscoveryExecutionMode } from "@job-copilot/domain/job-discovery-execution-mode";
import { createOpenAiModelDiagnosticAdapter, resolveJobNormalizerConfig } from "@job-copilot/model-access";
import { createFakeModelDiagnosticAdapter, TEST_MODEL_DIAGNOSTIC_FINGERPRINT_SEED } from "@job-copilot/model-access/testing";
import { GreenhouseTrustedSourceAdapter } from "./greenhouse-trusted-source-adapter.js";

/** 只读模型诊断投影；此装配从不主动运行外部诊断。 */
export function createWorkerRunPreflight(input: { environment?: NodeJS.ProcessEnv; executionMode: ReturnType<typeof resolveJobDiscoveryExecutionMode> }) {
  const environment = input.environment ?? process.env;
  const adapter = environment.APP_ENV === "test"
    ? createFakeModelDiagnosticAdapter({ kind: "success" }, TEST_MODEL_DIAGNOSTIC_FINGERPRINT_SEED)
    : createOpenAiModelDiagnosticAdapter({ apiKey: environment.OPENAI_API_KEY ?? "", endpoint: environment.OPENAI_ENDPOINT, organization: environment.OPENAI_ORGANIZATION, project: environment.OPENAI_PROJECT, lowCostModel: environment.OPENAI_LOW_COST_MODEL, highQualityModel: environment.OPENAI_HIGH_QUALITY_MODEL });
  return createRunPreflightEvaluator({ capabilityAdapter: new GreenhouseTrustedSourceAdapter(), modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: adapter.configurationFingerprint }), discoveryExecutionMode: input.executionMode, jobNormalizerMetadata: resolveJobNormalizerConfig(environment), id: randomUUID, clock: () => new Date() });
}
