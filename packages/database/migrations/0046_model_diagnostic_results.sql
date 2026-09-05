CREATE TABLE "model_diagnostic_results" (
  "configuration_fingerprint" varchar(128) NOT NULL,
  "status" varchar(32) NOT NULL,
  "checks" jsonb NOT NULL,
  "reason_code" varchar(80) NOT NULL,
  "checked_at" timestamp with time zone NOT NULL,
  "latency_bucket" varchar(16) NOT NULL,
  CONSTRAINT "model_diagnostic_results_pk" PRIMARY KEY("configuration_fingerprint", "checked_at"),
  CONSTRAINT "model_diagnostic_results_status_check" CHECK ("status" in ('available', 'failed', 'temporarily_unavailable')),
  CONSTRAINT "model_diagnostic_results_reason_code_check" CHECK ("reason_code" in ('MODEL_DIAGNOSTIC_AVAILABLE', 'MODEL_DIAGNOSTIC_CONFIGURATION_MISSING', 'MODEL_DIAGNOSTIC_AUTHENTICATION_FAILED', 'MODEL_DIAGNOSTIC_ACCESS_RESTRICTED', 'MODEL_DIAGNOSTIC_LOW_COST_MODEL_UNAVAILABLE', 'MODEL_DIAGNOSTIC_HIGH_QUALITY_MODEL_UNAVAILABLE', 'MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED', 'MODEL_DIAGNOSTIC_TIMEOUT', 'MODEL_DIAGNOSTIC_RATE_LIMITED', 'MODEL_DIAGNOSTIC_PROVIDER_UNAVAILABLE', 'MODEL_DIAGNOSTIC_FAILED')),
  CONSTRAINT "model_diagnostic_results_latency_bucket_check" CHECK ("latency_bucket" in ('under_1s', '1_to_5s', '5_to_10s', '10_to_20s', 'timeout')),
  CONSTRAINT "model_diagnostic_results_checks_check" CHECK (
    jsonb_typeof("checks") = 'object'
    AND "checks" ?& array['authentication', 'modelAvailability', 'structuredOutput', 'timeout']
    AND "checks" = jsonb_build_object(
      'authentication', "checks" -> 'authentication',
      'modelAvailability', "checks" -> 'modelAvailability',
      'structuredOutput', "checks" -> 'structuredOutput',
      'timeout', "checks" -> 'timeout'
    )
    AND "checks" ->> 'authentication' in ('passed', 'failed', 'not_verified')
    AND "checks" ->> 'modelAvailability' in ('passed', 'failed', 'not_verified')
    AND "checks" ->> 'structuredOutput' in ('passed', 'failed', 'not_verified')
    AND "checks" ->> 'timeout' in ('passed', 'failed', 'not_verified')
  )
);--> statement-breakpoint
CREATE INDEX "model_diagnostic_results_fingerprint_checked_at_idx" ON "model_diagnostic_results" ("configuration_fingerprint", "checked_at" DESC);
