ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_id_target_id_unique" UNIQUE("user_id","id","target_id");--> statement-breakpoint
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
	CONSTRAINT "job_source_health_checks_impact_scope_check" CHECK ("job_source_health_checks"."impact_scope" in ('none', 'entire_source', 'job_details') and ("job_source_health_checks"."impact_affected_count" is not null or "job_source_health_checks"."impact_scope" = 'entire_source')),
	CONSTRAINT "job_source_health_checks_counts_nonnegative" CHECK ("job_source_health_checks"."observed_posting_count" >= 0 and "job_source_health_checks"."selected_detail_count" >= 0 and "job_source_health_checks"."valid_detail_count" >= 0 and "job_source_health_checks"."request_attempt_count" >= 0 and ("job_source_health_checks"."impact_affected_count" is null or "job_source_health_checks"."impact_affected_count" >= 0))
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
