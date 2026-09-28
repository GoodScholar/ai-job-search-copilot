import { z } from "zod";

export const JourneyMetricStageSchema = z.enum([
  "career_materials", "profile_evidence", "primary_target", "job_sources", "run_readiness", "first_result",
]);
export const JourneyMetricReasonSchema = z.enum([
  "CAREER_MATERIALS_MISSING", "CAREER_IMPORT_FAILED", "PROFILE_EVIDENCE_MISSING", "PRIMARY_JOB_TARGET_MISSING",
  "REQUESTED_JOB_TARGET_MISSING", "REQUESTED_JOB_TARGET_INACTIVE", "SOURCE_CAPABILITY_UNAVAILABLE",
  "MODEL_DIAGNOSTIC_UNAVAILABLE", "ACCOUNT_RUN_POLICY_BLOCKED", "RUN_BUDGET_EXCEEDED",
  "MODEL_AUTH_FAILED", "MODEL_POLICY_REJECTED", "RUN_CANCELLED", "UNKNOWN_BLOCKER",
]);
export const JourneyMetricEventSchema = z.object({
  version: z.literal("first-recommendation-metrics-v1"),
  journeyId: z.uuid(),
  eventKey: z.string().regex(/^[a-f0-9]{64}$/u),
  type: z.enum(["started", "stage_reached", "blocked", "terminated", "completed"]),
  stage: JourneyMetricStageSchema,
  occurredAt: z.iso.datetime(),
  elapsedMs: z.int().nonnegative(),
  terminalStatus: z.enum(["recommendation_list", "no_recommendations", "failed", "cancelled"]).nullable(),
  reasonCode: JourneyMetricReasonSchema.nullable(),
  configuration: z.enum(["valid", "invalid"]),
}).strict();

export type JourneyMetricEvent = z.infer<typeof JourneyMetricEventSchema>;
export type JourneyMetricStage = z.infer<typeof JourneyMetricStageSchema>;
export type JourneyMetricReason = z.infer<typeof JourneyMetricReasonSchema>;
