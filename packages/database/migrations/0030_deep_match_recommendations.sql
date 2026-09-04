CREATE TABLE "job_match_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "user_id" uuid NOT NULL, "opportunity_id" uuid NOT NULL, "source_posting_version_id" uuid NOT NULL, "triage_version_id" uuid NOT NULL, "profile_id" uuid NOT NULL, "profile_version" integer NOT NULL, "target_id" uuid NOT NULL, "target_version" integer NOT NULL, "rule_version" varchar(64) NOT NULL, "prompt_version" varchar(64) NOT NULL, "adapter" varchar(64) NOT NULL, "adapter_version" varchar(64) NOT NULL, "model" varchar(128) NOT NULL, "output_schema_version" varchar(64) NOT NULL, "overall_score" integer NOT NULL, "display_band" varchar(32) NOT NULL, "assessment" jsonb NOT NULL, "sequence" integer NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_match_versions_user_id_id_unique" UNIQUE("user_id","id"), CONSTRAINT "job_match_versions_owner_opportunity_sequence_unique" UNIQUE("user_id","opportunity_id","sequence"), CONSTRAINT "job_match_versions_versions_positive" CHECK ("profile_version" >= 1 and "target_version" >= 1 and "sequence" >= 1), CONSTRAINT "job_match_versions_score_range" CHECK ("overall_score" between 0 and 100), CONSTRAINT "job_match_versions_display_band_check" CHECK ("display_band" in ('highly_matched', 'worth_trying', 'consider_carefully')), CONSTRAINT "job_match_versions_assessment_object" CHECK (jsonb_typeof("assessment") = 'object')
);
--> statement-breakpoint
ALTER TABLE "job_match_versions" ADD CONSTRAINT "job_match_versions_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "job_accounts"("id");--> statement-breakpoint
ALTER TABLE "job_match_versions" ADD CONSTRAINT "job_match_versions_owner_opportunity_fk" FOREIGN KEY ("user_id","opportunity_id") REFERENCES "job_opportunities"("user_id","id");--> statement-breakpoint
ALTER TABLE "job_match_versions" ADD CONSTRAINT "job_match_versions_owner_source_version_fk" FOREIGN KEY ("user_id","source_posting_version_id") REFERENCES "job_source_posting_versions"("user_id","id");--> statement-breakpoint
-- Historical migration integration tests deliberately stop before the triage
-- feature. Keep that legacy path replayable while enforcing the relationship
-- whenever the current triage table is present.
DO $$ BEGIN
  IF to_regclass('public.job_triage_versions') IS NOT NULL THEN
    ALTER TABLE "job_match_versions" ADD CONSTRAINT "job_match_versions_owner_triage_fk" FOREIGN KEY ("user_id","triage_version_id") REFERENCES "job_triage_versions"("user_id","id");
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "job_match_versions" ADD CONSTRAINT "job_match_versions_owner_profile_fk" FOREIGN KEY ("user_id","profile_id") REFERENCES "job_profiles"("user_id","id");--> statement-breakpoint
ALTER TABLE "job_match_versions" ADD CONSTRAINT "job_match_versions_owner_target_fk" FOREIGN KEY ("user_id","target_id") REFERENCES "job_targets"("user_id","id");--> statement-breakpoint
CREATE INDEX "job_match_versions_owner_target_created_idx" ON "job_match_versions" ("user_id","target_id","created_at","id");--> statement-breakpoint
CREATE TABLE "recommendation_lists" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "user_id" uuid NOT NULL, "target_id" uuid NOT NULL, "local_date" varchar(10) NOT NULL, "sequence" integer NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recommendation_lists_user_id_id_unique" UNIQUE("user_id","id"), CONSTRAINT "recommendation_lists_target_date_sequence_unique" UNIQUE("user_id","target_id","local_date","sequence"), CONSTRAINT "recommendation_lists_sequence_positive" CHECK ("sequence" >= 1), CONSTRAINT "recommendation_lists_local_date_format" CHECK ("local_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
ALTER TABLE "recommendation_lists" ADD CONSTRAINT "recommendation_lists_owner_target_fk" FOREIGN KEY ("user_id","target_id") REFERENCES "job_targets"("user_id","id");--> statement-breakpoint
CREATE TABLE "recommendation_list_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "user_id" uuid NOT NULL, "recommendation_list_id" uuid NOT NULL, "match_version_id" uuid NOT NULL, "ordinal" integer NOT NULL, "highlighted" boolean DEFAULT false NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recommendation_list_items_list_match_unique" UNIQUE("recommendation_list_id","match_version_id"), CONSTRAINT "recommendation_list_items_list_ordinal_unique" UNIQUE("recommendation_list_id","ordinal"), CONSTRAINT "recommendation_list_items_ordinal_range" CHECK ("ordinal" between 1 and 10)
);
--> statement-breakpoint
ALTER TABLE "recommendation_list_items" ADD CONSTRAINT "recommendation_list_items_owner_list_fk" FOREIGN KEY ("user_id","recommendation_list_id") REFERENCES "recommendation_lists"("user_id","id");--> statement-breakpoint
ALTER TABLE "recommendation_list_items" ADD CONSTRAINT "recommendation_list_items_owner_match_fk" FOREIGN KEY ("user_id","match_version_id") REFERENCES "job_match_versions"("user_id","id");--> statement-breakpoint
CREATE TABLE "recommendation_exclusions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "user_id" uuid NOT NULL, "target_id" uuid NOT NULL, "opportunity_id" uuid NOT NULL, "recommendation_list_id" uuid, "reason_code" varchar(64) NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recommendation_exclusions_reason_code_check" CHECK ("reason_code" in ('TRIAGE_NOT_PASS', 'DEADLINE_EXPIRED', 'SCORE_BELOW_THRESHOLD', 'CANDIDATE_LIMIT', 'MATCH_QUALITY_INSUFFICIENT'))
);
--> statement-breakpoint
ALTER TABLE "recommendation_exclusions" ADD CONSTRAINT "recommendation_exclusions_owner_target_fk" FOREIGN KEY ("user_id","target_id") REFERENCES "job_targets"("user_id","id");--> statement-breakpoint
ALTER TABLE "recommendation_exclusions" ADD CONSTRAINT "recommendation_exclusions_owner_opportunity_fk" FOREIGN KEY ("user_id","opportunity_id") REFERENCES "job_opportunities"("user_id","id");--> statement-breakpoint
CREATE INDEX "recommendation_exclusions_owner_target_opportunity_idx" ON "recommendation_exclusions" ("user_id","target_id","opportunity_id","created_at");
