CREATE TABLE "job_triage_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"source_posting_version_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"target_id" uuid NOT NULL,
	"target_version" integer NOT NULL,
	"qualification_rule_version" varchar(64) NOT NULL,
	"coarse_rule_version" varchar(64) NOT NULL,
	"overall_verdict" varchar(16) NOT NULL,
	"gate_results" jsonb NOT NULL,
	"pending_items" jsonb NOT NULL,
	"deadline_status" varchar(16) NOT NULL,
	"confidence_basis_points" integer NOT NULL,
	"dimension_scores" jsonb,
	"overall_score" integer,
	"threshold" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_triage_versions_input_rule_unique" UNIQUE("user_id","opportunity_id","source_posting_version_id","profile_id","profile_version","target_id","target_version","qualification_rule_version","coarse_rule_version"),
	CONSTRAINT "job_triage_versions_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_triage_versions_profile_version_positive" CHECK ("job_triage_versions"."profile_version" >= 1),
	CONSTRAINT "job_triage_versions_target_version_positive" CHECK ("job_triage_versions"."target_version" >= 1),
	CONSTRAINT "job_triage_versions_rule_versions_nonempty" CHECK (length("job_triage_versions"."qualification_rule_version") between 1 and 64 and length("job_triage_versions"."coarse_rule_version") between 1 and 64),
	CONSTRAINT "job_triage_versions_verdict_check" CHECK ("job_triage_versions"."overall_verdict" in ('pass', 'fail', 'unknown')),
	CONSTRAINT "job_triage_versions_gate_results_object" CHECK (jsonb_typeof("job_triage_versions"."gate_results") = 'object'),
	CONSTRAINT "job_triage_versions_pending_items_array" CHECK (jsonb_typeof("job_triage_versions"."pending_items") = 'array'),
	CONSTRAINT "job_triage_versions_deadline_status_check" CHECK ("job_triage_versions"."deadline_status" in ('expired', 'closing_soon', 'valid', 'missing', 'invalid')),
	CONSTRAINT "job_triage_versions_confidence_range" CHECK ("job_triage_versions"."confidence_basis_points" between 0 and 10000),
	CONSTRAINT "job_triage_versions_dimension_scores_object" CHECK ("job_triage_versions"."dimension_scores" is null or jsonb_typeof("job_triage_versions"."dimension_scores") = 'object'),
	CONSTRAINT "job_triage_versions_score_range" CHECK (("job_triage_versions"."overall_score" is null or "job_triage_versions"."overall_score" between 0 and 100) and ("job_triage_versions"."threshold" is null or "job_triage_versions"."threshold" between 0 and 100)),
	CONSTRAINT "job_triage_versions_score_verdict_check" CHECK (
    (("job_triage_versions"."overall_verdict" = 'pass' and "job_triage_versions"."deadline_status" <> 'expired') = ("job_triage_versions"."dimension_scores" is not null and "job_triage_versions"."overall_score" is not null and "job_triage_versions"."threshold" is not null))
  )
);
--> statement-breakpoint
ALTER TABLE "job_triage_versions" ADD CONSTRAINT "job_triage_versions_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triage_versions" ADD CONSTRAINT "job_triage_versions_opportunity_id_job_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."job_opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triage_versions" ADD CONSTRAINT "job_triage_versions_source_posting_version_id_job_source_posting_versions_id_fk" FOREIGN KEY ("source_posting_version_id") REFERENCES "public"."job_source_posting_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triage_versions" ADD CONSTRAINT "job_triage_versions_profile_id_job_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."job_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triage_versions" ADD CONSTRAINT "job_triage_versions_target_id_job_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."job_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triage_versions" ADD CONSTRAINT "job_triage_versions_owner_opportunity_fk" FOREIGN KEY ("user_id","opportunity_id") REFERENCES "public"."job_opportunities"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triage_versions" ADD CONSTRAINT "job_triage_versions_owner_source_version_fk" FOREIGN KEY ("user_id","source_posting_version_id") REFERENCES "public"."job_source_posting_versions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triage_versions" ADD CONSTRAINT "job_triage_versions_owner_profile_fk" FOREIGN KEY ("user_id","profile_id") REFERENCES "public"."job_profiles"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triage_versions" ADD CONSTRAINT "job_triage_versions_owner_target_fk" FOREIGN KEY ("user_id","target_id") REFERENCES "public"."job_targets"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_triage_versions_owner_opportunity_created_idx" ON "job_triage_versions" USING btree ("user_id","opportunity_id","created_at","id");