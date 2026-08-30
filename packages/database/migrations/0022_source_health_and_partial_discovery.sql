ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_id_target_id_unique" UNIQUE("user_id","id","target_id");--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_termination_kind_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_termination_kind_check" CHECK ("agent_runs"."termination_kind" is null or "agent_runs"."termination_kind" in ('completed', 'completed_with_source_issues', 'cancelled_by_user', 'source_failed', 'content_storage_failed', 'persistence_failed', 'budget_exhausted'));--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_termination_mapping_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_termination_mapping_check" CHECK (coalesce((
  ("agent_runs"."status" in ('queued', 'running', 'paused') and "agent_runs"."termination_kind" is null and "agent_runs"."termination_budget_dimension" is null)
  or ("agent_runs"."status" = 'completed' and ((not "agent_runs"."usage_complete" and "agent_runs"."termination_kind" is null) or ("agent_runs"."termination_kind" in ('completed', 'completed_with_source_issues') and "agent_runs"."failure_code" is null and "agent_runs"."termination_budget_dimension" is null)))
  or ("agent_runs"."status" = 'cancelled' and ((not "agent_runs"."usage_complete" and "agent_runs"."termination_kind" is null) or ("agent_runs"."termination_kind" = 'cancelled_by_user' and "agent_runs"."failure_code" is null and "agent_runs"."termination_budget_dimension" is null)))
  or ("agent_runs"."status" = 'failed' and (
    (not "agent_runs"."usage_complete" and "agent_runs"."termination_kind" is null)
    or ("agent_runs"."termination_kind" = 'source_failed' and "agent_runs"."failure_code" in ('AGENT_RUN_ADAPTER_RETRYABLE', 'AGENT_RUN_ADAPTER_FAILED', 'AGENT_RUN_MODEL_RETRYABLE', 'AGENT_RUN_MODEL_AUTH_FAILED', 'AGENT_RUN_MODEL_POLICY_REJECTED', 'AGENT_RUN_MODEL_INVALID_RESPONSE') and "agent_runs"."termination_budget_dimension" is null)
    or ("agent_runs"."termination_kind" = 'content_storage_failed' and "agent_runs"."failure_code" = 'AGENT_RUN_CONTENT_STORAGE_FAILED' and "agent_runs"."termination_budget_dimension" is null)
    or ("agent_runs"."termination_kind" = 'persistence_failed' and "agent_runs"."failure_code" = 'AGENT_RUN_PERSIST_FAILED' and "agent_runs"."termination_budget_dimension" is null)
    or ("agent_runs"."termination_kind" = 'budget_exhausted' and "agent_runs"."failure_code" = 'AGENT_RUN_BUDGET_EXCEEDED' and "agent_runs"."termination_budget_dimension" is not null)
  ))
), false));--> statement-breakpoint
CREATE TABLE "job_source_health_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"watchlist_item_id" uuid NOT NULL,
	"source_id" varchar(2048) NOT NULL,
	"status" varchar(32) NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"impact_scope" varchar(32) NOT NULL,
	"impact_affected_count" integer,
	"observed_posting_count" integer NOT NULL,
	"selected_detail_count" integer NOT NULL,
	"valid_detail_count" integer NOT NULL,
	"request_attempt_count" integer NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_source_health_checks_run_source_unique" UNIQUE("run_id","source_id"),
	CONSTRAINT "job_source_health_checks_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_source_health_checks_status_check" CHECK ("job_source_health_checks"."status" in ('healthy', 'zero_valid_results', 'parser_degraded', 'rate_limited', 'hard_failed')),
	CONSTRAINT "job_source_health_checks_reason_codes_array_check" CHECK (jsonb_typeof("job_source_health_checks"."reason_codes") = 'array'),
	CONSTRAINT "job_source_health_checks_reason_codes_safe_check" CHECK ("job_source_health_checks"."reason_codes" <@ '["SOURCE_LIST_SCHEMA_INVALID", "SOURCE_DETAIL_FIELDS_MISSING", "SOURCE_DETAIL_URL_INVALID", "SOURCE_DETAIL_IDENTITY_INVALID", "SOURCE_RATE_LIMITED", "SOURCE_AUTH_FAILED", "SOURCE_TIMEOUT", "SOURCE_UNREACHABLE", "SOURCE_SERVER_ERROR", "SOURCE_POLICY_REJECTED"]'::jsonb),
	CONSTRAINT "job_source_health_checks_source_id_check" CHECK ("job_source_health_checks"."source_id" ~ '^greenhouse:[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "job_source_health_checks_impact_scope_check" CHECK (("job_source_health_checks"."impact_scope" = 'none' and "job_source_health_checks"."impact_affected_count" is null) or ("job_source_health_checks"."impact_scope" = 'job_details' and "job_source_health_checks"."impact_affected_count" >= 1) or ("job_source_health_checks"."impact_scope" = 'entire_source' and ("job_source_health_checks"."impact_affected_count" is null or "job_source_health_checks"."impact_affected_count" >= 0))),
	CONSTRAINT "job_source_health_checks_counts_nonnegative" CHECK ("job_source_health_checks"."observed_posting_count" >= 0 and "job_source_health_checks"."selected_detail_count" >= 0 and "job_source_health_checks"."valid_detail_count" >= 0 and "job_source_health_checks"."request_attempt_count" >= 1 and "job_source_health_checks"."valid_detail_count" <= "job_source_health_checks"."selected_detail_count" and "job_source_health_checks"."selected_detail_count" <= "job_source_health_checks"."observed_posting_count"),
	CONSTRAINT "job_source_health_checks_status_evidence_check" CHECK (
	  ("job_source_health_checks"."status" = 'healthy' and "job_source_health_checks"."valid_detail_count" >= 1 and "job_source_health_checks"."reason_codes" = '[]'::jsonb and "job_source_health_checks"."impact_scope" = 'none' and "job_source_health_checks"."impact_affected_count" is null)
	  or ("job_source_health_checks"."status" = 'zero_valid_results' and "job_source_health_checks"."valid_detail_count" = 0 and "job_source_health_checks"."reason_codes" = '[]'::jsonb and "job_source_health_checks"."impact_scope" = 'none' and "job_source_health_checks"."impact_affected_count" is null)
	  or ("job_source_health_checks"."status" = 'parser_degraded' and "job_source_health_checks"."reason_codes" <> '[]'::jsonb and "job_source_health_checks"."reason_codes" <@ '["SOURCE_LIST_SCHEMA_INVALID", "SOURCE_DETAIL_FIELDS_MISSING", "SOURCE_DETAIL_URL_INVALID", "SOURCE_DETAIL_IDENTITY_INVALID"]'::jsonb and "job_source_health_checks"."impact_scope" in ('job_details', 'entire_source'))
	  or ("job_source_health_checks"."status" = 'rate_limited' and "job_source_health_checks"."reason_codes" = '["SOURCE_RATE_LIMITED"]'::jsonb and "job_source_health_checks"."impact_scope" = 'entire_source')
	  or ("job_source_health_checks"."status" = 'hard_failed' and "job_source_health_checks"."reason_codes" <> '[]'::jsonb and "job_source_health_checks"."reason_codes" <@ '["SOURCE_AUTH_FAILED", "SOURCE_TIMEOUT", "SOURCE_UNREACHABLE", "SOURCE_SERVER_ERROR", "SOURCE_POLICY_REJECTED"]'::jsonb and "job_source_health_checks"."impact_scope" = 'entire_source')
	)
);
--> statement-breakpoint
ALTER TABLE "job_source_health_checks" ADD CONSTRAINT "job_source_health_checks_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_source_health_checks" ADD CONSTRAINT "job_source_health_checks_owner_run_target_fk" FOREIGN KEY ("user_id","run_id","target_id") REFERENCES "public"."agent_runs"("user_id","id","target_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_source_health_checks_latest_lookup_idx" ON "job_source_health_checks" USING btree ("user_id","target_id","watchlist_item_id","source_id","checked_at","id");--> statement-breakpoint
CREATE FUNCTION "prevent_job_source_health_check_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'job source health checks are immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "job_source_health_checks_immutable" BEFORE UPDATE OR DELETE ON "job_source_health_checks"
FOR EACH ROW EXECUTE FUNCTION "prevent_job_source_health_check_mutation"();
