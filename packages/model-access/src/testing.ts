import type { ModelDiagnosticAdapter, ModelDiagnosticProbeResult } from "@job-copilot/contracts/model-diagnostics";
import { createInternalOpenAiModelDiagnosticAdapter, type ModelDiagnosticTestOptions, type ModelDiagnosticTestTransport, type OpenAiModelDiagnosticConfig } from "./internal.js";

export type { ModelDiagnosticTestTransport } from "./internal.js";

export type ModelDiagnosticFakeScenario = { kind:
  | "success"
  | "authentication_failed"
  | "access_restricted"
  | "low_cost_model_unavailable"
  | "high_quality_model_unavailable"
  | "strict_output_unsupported"
  | "incomplete"
  | "refusal"
  | "queued"
  | "in_progress"
  | "malformed_output"
  | "missing_output"
  | "timeout"
  | "rate_limited"
  | "provider_unavailable"
  | "generic_failure"
  | "generic_redirect";
};

export function createOpenAiModelDiagnosticAdapterForTest(config: OpenAiModelDiagnosticConfig, transport: ModelDiagnosticTestTransport, options?: ModelDiagnosticTestOptions): ModelDiagnosticAdapter {
  return createInternalOpenAiModelDiagnosticAdapter(config, transport, options);
}

export function createFakeModelDiagnosticAdapter(scenario: ModelDiagnosticFakeScenario, fingerprintSeed?: string): ModelDiagnosticAdapter {
  return {
    configurationFingerprint: `fake-model-diagnostic-${scenario.kind}${fingerprintSeed ? `-${fingerprintSeed}` : ""}`,
    async diagnose() {
      return fakeResult(scenario.kind);
    },
  };
}

function fakeResult(kind: ModelDiagnosticFakeScenario["kind"]): ModelDiagnosticProbeResult {
  const checks = (authentication: "passed" | "failed" | "not_verified", modelAvailability: "passed" | "failed" | "not_verified", structuredOutput: "passed" | "failed" | "not_verified", timeout: "passed" | "failed" | "not_verified") => ({ authentication, modelAvailability, structuredOutput, timeout });
  switch (kind) {
    case "success": return { status: "available", checks: checks("passed", "passed", "passed", "passed"), reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s" };
    case "authentication_failed": return { status: "failed", checks: checks("failed", "not_verified", "not_verified", "not_verified"), reasonCode: "MODEL_DIAGNOSTIC_AUTHENTICATION_FAILED", latencyBucket: "under_1s" };
    case "access_restricted": return { status: "failed", checks: checks("passed", "not_verified", "not_verified", "passed"), reasonCode: "MODEL_DIAGNOSTIC_ACCESS_RESTRICTED", latencyBucket: "under_1s" };
    case "low_cost_model_unavailable": return { status: "failed", checks: checks("passed", "failed", "not_verified", "passed"), reasonCode: "MODEL_DIAGNOSTIC_LOW_COST_MODEL_UNAVAILABLE", latencyBucket: "under_1s" };
    case "high_quality_model_unavailable": return { status: "failed", checks: checks("passed", "failed", "not_verified", "passed"), reasonCode: "MODEL_DIAGNOSTIC_HIGH_QUALITY_MODEL_UNAVAILABLE", latencyBucket: "under_1s" };
    case "strict_output_unsupported":
    case "incomplete":
    case "refusal":
    case "queued": return { status: "failed", checks: checks("passed", "passed", "failed", "passed"), reasonCode: "MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED", latencyBucket: "under_1s" };
    case "in_progress":
    case "malformed_output":
    case "missing_output": return { status: "failed", checks: checks("passed", "passed", "failed", "passed"), reasonCode: "MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED", latencyBucket: "under_1s" };
    case "timeout": return { status: "temporarily_unavailable", checks: checks("not_verified", "not_verified", "not_verified", "failed"), reasonCode: "MODEL_DIAGNOSTIC_TIMEOUT", latencyBucket: "timeout" };
    case "rate_limited": return { status: "temporarily_unavailable", checks: checks("not_verified", "not_verified", "not_verified", "passed"), reasonCode: "MODEL_DIAGNOSTIC_RATE_LIMITED", latencyBucket: "under_1s" };
    case "provider_unavailable": return { status: "temporarily_unavailable", checks: checks("not_verified", "not_verified", "not_verified", "passed"), reasonCode: "MODEL_DIAGNOSTIC_PROVIDER_UNAVAILABLE", latencyBucket: "under_1s" };
    case "generic_failure":
    case "generic_redirect": return { status: "failed", checks: checks("not_verified", "not_verified", "not_verified", "passed"), reasonCode: "MODEL_DIAGNOSTIC_FAILED", latencyBucket: "under_1s" };
  }
}
