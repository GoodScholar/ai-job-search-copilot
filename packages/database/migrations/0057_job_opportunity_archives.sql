ALTER TABLE "job_opportunities" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_opportunities" ADD COLUMN "archive_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_opportunities" ADD CONSTRAINT "job_opportunities_archive_version_nonnegative" CHECK ("job_opportunities"."archive_version" >= 0);--> statement-breakpoint
CREATE INDEX "job_opportunities_archive_projection_idx" ON "job_opportunities" USING btree ("user_id", "archived_at", "updated_at", "id");--> statement-breakpoint
CREATE TABLE "job_opportunity_archive_commands" (
  "user_id" uuid NOT NULL,
  "opportunity_id" uuid NOT NULL,
  "command_id" uuid NOT NULL,
  "action" varchar(8) NOT NULL,
  "expected_version" integer NOT NULL,
  "applied" boolean NOT NULL,
  "result_snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_opportunity_archive_commands_pk" PRIMARY KEY("user_id", "command_id"),
  CONSTRAINT "job_opportunity_archive_commands_action_check" CHECK ("job_opportunity_archive_commands"."action" in ('archive', 'restore')),
  CONSTRAINT "job_opportunity_archive_commands_expected_version_nonnegative" CHECK ("job_opportunity_archive_commands"."expected_version" >= 0),
  CONSTRAINT "job_opportunity_archive_commands_result_snapshot_object" CHECK (jsonb_typeof("job_opportunity_archive_commands"."result_snapshot") = 'object' and octet_length("job_opportunity_archive_commands"."result_snapshot"::text) <= 1024)
);--> statement-breakpoint
ALTER TABLE "job_opportunity_archive_commands" ADD CONSTRAINT "job_opportunity_archive_commands_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_opportunity_archive_commands" ADD CONSTRAINT "job_opportunity_archive_commands_owner_opportunity_fk" FOREIGN KEY ("user_id", "opportunity_id") REFERENCES "public"."job_opportunities"("user_id", "id") ON DELETE no action ON UPDATE no action;
