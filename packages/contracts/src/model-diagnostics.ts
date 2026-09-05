import { z } from "zod";

export const ModelDiagnosticStatusSchema = z.enum([
  "unverified",
  "checking",
  "available",
  "failed",
  "temporarily_unavailable",
]);

export const ModelDiagnosticReasonCodeSchema = z.enum([
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

export const ModelDiagnosticLatencyBucketSchema = z.enum([
  "under_1s",
  "1_to_5s",
  "5_to_10s",
  "10_to_20s",
  "timeout",
]);

export const ModelDiagnosticCheckStatusSchema = z.enum(["passed", "failed", "not_verified"]);

export const ModelDiagnosticChecksSchema = z.object({
  authentication: ModelDiagnosticCheckStatusSchema,
  modelAvailability: ModelDiagnosticCheckStatusSchema,
  structuredOutput: ModelDiagnosticCheckStatusSchema,
  timeout: ModelDiagnosticCheckStatusSchema,
}).strict();

export const ModelDiagnosticProbeResultSchema = z.object({
  status: z.enum(["available", "failed", "temporarily_unavailable"]),
  checks: ModelDiagnosticChecksSchema,
  reasonCode: ModelDiagnosticReasonCodeSchema,
  latencyBucket: ModelDiagnosticLatencyBucketSchema,
}).strict();

/** API 只投影脱敏后的稳定诊断事实，运行配置和供应商响应永不跨越此边界。 */
export const ModelDiagnosticPublicResponseSchema = z.object({
  status: ModelDiagnosticStatusSchema,
  checks: ModelDiagnosticChecksSchema,
  reasonCode: ModelDiagnosticReasonCodeSchema,
  reasonSummary: z.string().trim().min(1).max(200),
  impact: z.string().trim().min(1).max(200),
  suggestedActions: z.array(z.string().trim().min(1).max(120)).max(3),
  checkedAt: z.iso.datetime().nullable(),
  latencyBucket: ModelDiagnosticLatencyBucketSchema.nullable(),
  retryAt: z.iso.datetime().nullable(),
}).strict();

export type ModelDiagnosticStatus = z.infer<typeof ModelDiagnosticStatusSchema>;
export type ModelDiagnosticReasonCode = z.infer<typeof ModelDiagnosticReasonCodeSchema>;
export type ModelDiagnosticLatencyBucket = z.infer<typeof ModelDiagnosticLatencyBucketSchema>;
export type ModelDiagnosticCheckStatus = z.infer<typeof ModelDiagnosticCheckStatusSchema>;
export type ModelDiagnosticChecks = z.infer<typeof ModelDiagnosticChecksSchema>;
export type ModelDiagnosticProbeResult = z.infer<typeof ModelDiagnosticProbeResultSchema>;
export type ModelDiagnosticPublicResponse = z.infer<typeof ModelDiagnosticPublicResponseSchema>;

export interface ModelDiagnosticAdapter {
  readonly configurationFingerprint: string;
  diagnose(input: { signal: AbortSignal }): Promise<ModelDiagnosticProbeResult>;
}
