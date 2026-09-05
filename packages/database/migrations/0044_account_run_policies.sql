CREATE TABLE "account_run_policy_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "revision_number" integer NOT NULL,
  "settings" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_run_policy_revisions_user_number_unique" UNIQUE("user_id", "revision_number"),
  CONSTRAINT "account_run_policy_revisions_user_id_id_unique" UNIQUE("user_id", "id"),
  CONSTRAINT "account_run_policy_revisions_number_positive" CHECK ("revision_number" >= 0),
  CONSTRAINT "account_run_policy_revisions_settings_object" CHECK (jsonb_typeof("settings") = 'object'),
  CONSTRAINT "account_run_policy_revisions_owner_fk" FOREIGN KEY ("user_id") REFERENCES "job_accounts"("id")
);--> statement-breakpoint
CREATE TABLE "account_run_policies" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "current_revision_number" integer NOT NULL,
  "version" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_run_policies_version_nonnegative" CHECK ("version" >= 0),
  CONSTRAINT "account_run_policies_revision_positive" CHECK ("current_revision_number" >= 0),
  CONSTRAINT "account_run_policies_owner_fk" FOREIGN KEY ("user_id") REFERENCES "job_accounts"("id"),
  CONSTRAINT "account_run_policies_owner_revision_fk" FOREIGN KEY ("user_id", "current_revision_number") REFERENCES "account_run_policy_revisions"("user_id", "revision_number")
);--> statement-breakpoint
CREATE INDEX "account_run_policy_revisions_owner_created_idx" ON "account_run_policy_revisions" ("user_id", "revision_number");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "account_policy_revision_number" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "account_policy_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_policy_revision_nonnegative" CHECK ("account_policy_revision_number" >= 0);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_policy_snapshot_object" CHECK (jsonb_typeof("account_policy_snapshot") = 'object');--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_policy_columns_paired" CHECK (("account_policy_revision_number" IS NULL) = ("account_policy_snapshot" IS NULL));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_policy_owner_revision_fk" FOREIGN KEY ("user_id", "account_policy_revision_number") REFERENCES "account_run_policy_revisions"("user_id", "revision_number");
