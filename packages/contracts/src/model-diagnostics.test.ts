import { describe, expect, it } from "vitest";
import {
  ModelDiagnosticChecksSchema,
  ModelDiagnosticLatencyBucketSchema,
  ModelDiagnosticProbeResultSchema,
  ModelDiagnosticPublicResponseSchema,
  ModelDiagnosticReasonCodeSchema,
  ModelDiagnosticStatusSchema,
} from "./model-diagnostics";

const checks = {
  authentication: "passed",
  modelAvailability: "passed",
  structuredOutput: "passed",
  timeout: "passed",
} as const;

describe("模型连接诊断契约", () => {
  it("只接受固定的总体状态、稳定原因和延迟区间", () => {
    expect(ModelDiagnosticStatusSchema.options).toEqual(["unverified", "checking", "available", "failed", "temporarily_unavailable"]);
    expect(ModelDiagnosticReasonCodeSchema.options).toEqual([
      "MODEL_DIAGNOSTIC_AVAILABLE",
      "MODEL_DIAGNOSTIC_CONFIGURATION_MISSING",
      "MODEL_DIAGNOSTIC_AUTHENTICATION_FAILED",
      "MODEL_DIAGNOSTIC_ACCESS_RESTRICTED",
      "MODEL_DIAGNOSTIC_LOW_COST_MODEL_UNAVAILABLE",
      "MODEL_DIAGNOSTIC_HIGH_QUALITY_MODEL_UNAVAILABLE",
      "MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED",
      "MODEL_DIAGNOSTIC_TIMEOUT",
      "MODEL_DIAGNOSTIC_RATE_LIMITED",
      "MODEL_DIAGNOSTIC_PROVIDER_UNAVAILABLE",
      "MODEL_DIAGNOSTIC_FAILED",
    ]);
    expect(ModelDiagnosticLatencyBucketSchema.options).toEqual(["under_1s", "1_to_5s", "5_to_10s", "10_to_20s", "timeout"]);
  });

  it("四项检查必须完整且严格，未执行不能伪装为通过", () => {
    expect(ModelDiagnosticChecksSchema.safeParse(checks).success).toBe(true);
    expect(ModelDiagnosticChecksSchema.safeParse({ ...checks, timeout: "not_verified" }).success).toBe(true);
    expect(ModelDiagnosticChecksSchema.safeParse({ authentication: "passed", modelAvailability: "passed", structuredOutput: "passed" }).success).toBe(false);
    expect(ModelDiagnosticChecksSchema.safeParse({ ...checks, timeout: "unknown" }).success).toBe(false);
    expect(ModelDiagnosticChecksSchema.safeParse({ ...checks, rawProviderOutput: "secret" }).success).toBe(false);
  });

  it("探针结果只包含完成诊断所需的稳定事实", () => {
    const result = {
      status: "available",
      checks,
      reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE",
      latencyBucket: "under_1s",
    } as const;
    expect(ModelDiagnosticProbeResultSchema.parse(result)).toEqual(result);
    expect(ModelDiagnosticProbeResultSchema.safeParse({ ...result, configurationFingerprint: "secret" }).success).toBe(false);
  });

  it("公开响应严格排除运行时秘密和供应商原始内容", () => {
    const response = {
      status: "available",
      checks,
      reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE",
      reasonSummary: "模型连接可用",
      impact: "可以启动需要模型的运行",
      suggestedActions: [],
      checkedAt: "2026-09-05T00:00:00.000Z",
      latencyBucket: "under_1s",
      retryAt: null,
    } as const;

    expect(ModelDiagnosticPublicResponseSchema.parse(response)).toEqual(response);
    for (const [field, value] of Object.entries({
      configurationFingerprint: "fingerprint",
      apiKey: "sk-secret",
      providerResponse: { output_text: "secret" },
      rawModelOutput: "secret",
    })) {
      expect(ModelDiagnosticPublicResponseSchema.safeParse({ ...response, [field]: value }).success).toBe(false);
    }
  });
});
