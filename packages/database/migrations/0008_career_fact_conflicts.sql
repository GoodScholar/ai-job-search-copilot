CREATE TABLE "career_fact_conflicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "user_id" uuid NOT NULL,
  "existing_candidate_fact_id" uuid NOT NULL, "incoming_candidate_fact_id" uuid NOT NULL,
  "kind" varchar(32) NOT NULL, "status" varchar(16) DEFAULT 'pending' NOT NULL, "resolution" varchar(32), "profile_version" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "resolved_at" timestamp with time zone,
  CONSTRAINT "career_fact_conflicts_pair_unique" UNIQUE("existing_candidate_fact_id","incoming_candidate_fact_id"),
  CONSTRAINT "career_fact_conflicts_kind_check" CHECK ("kind" in ('date','role','organization','metric')),
  CONSTRAINT "career_fact_conflicts_status_check" CHECK ("status" in ('pending','resolved')),
  CONSTRAINT "career_fact_conflicts_resolution_check" CHECK ("resolution" is null or "resolution" in ('use_existing','use_incoming','keep_both')),
  CONSTRAINT "career_fact_conflicts_profile_version_positive" CHECK ("profile_version" is null or "profile_version" >= 1),
  CONSTRAINT "career_fact_conflicts_distinct_pair_check" CHECK ("existing_candidate_fact_id" <> "incoming_candidate_fact_id"),
  CONSTRAINT "career_fact_conflicts_resolution_state_check" CHECK (("status" = 'pending' and "resolution" is null and "resolved_at" is null and "profile_version" is null) or ("status" = 'resolved' and "resolution" is not null and "resolved_at" is not null and "profile_version" is not null))
);--> statement-breakpoint
ALTER TABLE "career_fact_conflicts" ADD CONSTRAINT "career_fact_conflicts_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "job_accounts"("id");--> statement-breakpoint
ALTER TABLE "career_fact_conflicts" ADD CONSTRAINT "career_fact_conflicts_existing_owner_fk" FOREIGN KEY ("user_id","existing_candidate_fact_id") REFERENCES "candidate_facts"("user_id","id");--> statement-breakpoint
ALTER TABLE "career_fact_conflicts" ADD CONSTRAINT "career_fact_conflicts_incoming_owner_fk" FOREIGN KEY ("user_id","incoming_candidate_fact_id") REFERENCES "candidate_facts"("user_id","id");
CREATE INDEX "career_fact_conflicts_incoming_pending_idx" ON "career_fact_conflicts" ("user_id", "incoming_candidate_fact_id", "status");
