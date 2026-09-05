import { z } from "zod";

const nonnegativeInteger = z.int().nonnegative();
const nullableUuid = z.uuid().nullable();
const safeChineseCopy = (maxLength: number) => z.string().trim().min(1).max(maxLength).regex(/\p{Script=Han}/u, "必须包含中文安全文案");

export const RunPreflightWorkflowSchema = z.enum(["discovery", "deep_match"]);
export const RunPreflightTriggerSchema = z.enum(["manual", "schedule", "automatic"]);
export const RunPreflightSeveritySchema = z.enum(["blocking", "warning", "informational"]);
export const RunPreflightStatusSchema = z.enum(["blocked", "ready_with_warnings", "ready"]);
export const RunPreflightSuggestedActionSchema = z.enum([
  "review_profile",
  "review_job_targets",
  "review_source_capabilities",
  "review_source_health",
  "run_model_diagnostic",
  "review_account_run_policy",
]);
export const RunPreflightCheckCodeSchema = z.enum([
  "PROFILE_EVIDENCE_MISSING",
  "PROFILE_EVIDENCE_READY",
  "PRIMARY_JOB_TARGET_MISSING",
  "PRIMARY_JOB_TARGET_READY",
  "REQUESTED_JOB_TARGET_MISSING",
  "REQUESTED_JOB_TARGET_INACTIVE",
  "REQUESTED_JOB_TARGET_READY",
  "SOURCE_CAPABILITY_UNAVAILABLE",
  "SOURCE_CAPABILITY_PARTIAL",
  "SOURCE_CAPABILITY_READY",
  "SOURCE_CAPABILITY_NOT_REQUIRED",
  "SOURCE_HEALTH_UNCHECKED",
  "SOURCE_HEALTH_DEGRADED",
  "SOURCE_HEALTH_READY",
  "SOURCE_HEALTH_NOT_REQUIRED",
  "MODEL_DIAGNOSTIC_UNAVAILABLE",
  "MODEL_DIAGNOSTIC_READY",
  "ACCOUNT_RUN_POLICY_BLOCKED",
  "ACCOUNT_RUN_POLICY_READY",
]);
export const RunPreflightWarningFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const RunPreflightEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("profile"),
    activeTrustedFactCount: nonnegativeInteger,
    latestFactRevisionId: nullableUuid,
    checkedAt: z.iso.datetime(),
  }).strict(),
  z.object({
    kind: z.literal("job_target"),
    primaryTargetId: nullableUuid,
    primaryTargetVersion: nonnegativeInteger.nullable(),
    requestedTargetId: nullableUuid,
    requestedTargetVersion: nonnegativeInteger.nullable(),
    requestedTargetState: z.enum(["missing", "inactive", "active"]),
    checkedAt: z.iso.datetime(),
  }).strict(),
  z.object({
    kind: z.literal("source_capability"),
    enabledSourceCount: nonnegativeInteger,
    capableSourceCount: nonnegativeInteger,
    status: z.enum(["unavailable", "partial", "ready", "not_required"]),
    checkedAt: z.iso.datetime(),
  }).strict(),
  z.object({
    kind: z.literal("source_health"),
    checkedSourceCount: nonnegativeInteger,
    healthySourceCount: nonnegativeInteger,
    degradedSourceCount: nonnegativeInteger,
    uncheckedSourceCount: nonnegativeInteger,
    latestCheckedAt: z.iso.datetime().nullable(),
  }).strict(),
  z.object({
    kind: z.literal("model_diagnostic"),
    status: z.enum(["unverified", "checking", "failed", "temporarily_unavailable", "available"]),
    checkedAt: z.iso.datetime().nullable(),
  }).strict(),
  z.object({
    kind: z.literal("account_run_policy"),
    revisionNumber: nonnegativeInteger,
    status: z.enum(["blocked", "ready"]),
    checkedAt: z.iso.datetime(),
  }).strict(),
]);

export const RunPreflightItemSchema = z.object({
  code: RunPreflightCheckCodeSchema,
  severity: RunPreflightSeveritySchema,
  summary: safeChineseCopy(200),
  evidence: RunPreflightEvidenceSchema,
  impact: safeChineseCopy(500),
  retryable: z.boolean(),
  suggestedActions: z.array(RunPreflightSuggestedActionSchema).max(2).refine(
    (actions) => new Set(actions).size === actions.length,
    { message: "建议动作不可重复" },
  ),
}).strict();

export const RunPreflightReportSchema = z.object({
  version: z.literal("run-preflight-v1"),
  workflow: RunPreflightWorkflowSchema,
  trigger: RunPreflightTriggerSchema,
  targetId: z.uuid().nullable(),
  status: RunPreflightStatusSchema,
  items: z.array(RunPreflightItemSchema).max(7),
  warningFingerprint: RunPreflightWarningFingerprintSchema.nullable(),
  checkedAt: z.iso.datetime(),
}).strict().superRefine((report, context) => {
  const hasBlocking = report.items.some((item) => item.severity === "blocking");
  const hasWarning = report.items.some((item) => item.severity === "warning");
  const expectedStatus = hasBlocking ? "blocked" : hasWarning ? "ready_with_warnings" : "ready";
  if (report.status !== expectedStatus) {
    context.addIssue({ code: "custom", path: ["status"], message: "聚合状态必须与检查项严重级一致" });
  }
  if ((report.warningFingerprint !== null) !== hasWarning) {
    context.addIssue({ code: "custom", path: ["warningFingerprint"], message: "警告 fingerprint 必须且只能在存在警告时提供" });
  }
});

export const RunPreflightSnapshotSchema = RunPreflightReportSchema;
export const RunPreflightProblemSchema = z.object({
  code: z.enum(["RUN_PREFLIGHT_BLOCKED", "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED"]),
  message: safeChineseCopy(500),
  preflight: RunPreflightReportSchema,
}).strict();

export type RunPreflightWorkflow = z.infer<typeof RunPreflightWorkflowSchema>;
export type RunPreflightTrigger = z.infer<typeof RunPreflightTriggerSchema>;
export type RunPreflightSeverity = z.infer<typeof RunPreflightSeveritySchema>;
export type RunPreflightStatus = z.infer<typeof RunPreflightStatusSchema>;
export type RunPreflightSuggestedAction = z.infer<typeof RunPreflightSuggestedActionSchema>;
export type RunPreflightCheckCode = z.infer<typeof RunPreflightCheckCodeSchema>;
export type RunPreflightEvidence = z.infer<typeof RunPreflightEvidenceSchema>;
export type RunPreflightItem = z.infer<typeof RunPreflightItemSchema>;
export type RunPreflightReport = z.infer<typeof RunPreflightReportSchema>;
export type RunPreflightSnapshot = z.infer<typeof RunPreflightSnapshotSchema>;
export type RunPreflightProblem = z.infer<typeof RunPreflightProblemSchema>;
