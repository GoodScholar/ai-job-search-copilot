CREATE TABLE "deep_match_run_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "user_id" uuid NOT NULL, "run_id" uuid NOT NULL,
  "opportunity_id" uuid NOT NULL, "source_posting_version_id" uuid NOT NULL, "ordinal" integer NOT NULL,
  "candidate_snapshot" jsonb NOT NULL, "assessment" jsonb, "adapter_usage" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deep_match_run_candidates_run_opportunity_unique" UNIQUE("run_id","opportunity_id"),
  CONSTRAINT "deep_match_run_candidates_run_ordinal_unique" UNIQUE("run_id","ordinal"),
  CONSTRAINT "deep_match_run_candidates_ordinal_range" CHECK ("ordinal" between 1 and 10),
  CONSTRAINT "deep_match_run_candidates_snapshot_object" CHECK (jsonb_typeof("candidate_snapshot") = 'object')
);--> statement-breakpoint
ALTER TABLE "deep_match_run_candidates" ADD CONSTRAINT "deep_match_run_candidates_owner_run_fk" FOREIGN KEY ("user_id","run_id") REFERENCES "agent_runs"("user_id","id");--> statement-breakpoint
ALTER TABLE "deep_match_run_candidates" ADD CONSTRAINT "deep_match_run_candidates_owner_opportunity_fk" FOREIGN KEY ("user_id","opportunity_id") REFERENCES "job_opportunities"("user_id","id");--> statement-breakpoint
ALTER TABLE "deep_match_run_candidates" ADD CONSTRAINT "deep_match_run_candidates_owner_source_version_fk" FOREIGN KEY ("user_id","source_posting_version_id") REFERENCES "job_source_posting_versions"("user_id","id");
