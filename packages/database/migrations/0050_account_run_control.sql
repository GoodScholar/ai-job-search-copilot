CREATE TABLE "account_run_control_commands" (
	"user_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"action" varchar(8) NOT NULL,
	"expected_version" integer NOT NULL,
	"applied" boolean NOT NULL,
	"result_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_run_control_commands_pk" PRIMARY KEY("user_id","command_id"),
	CONSTRAINT "account_run_control_commands_action_check" CHECK ("account_run_control_commands"."action" in ('stop', 'release')),
	CONSTRAINT "account_run_control_commands_expected_version_nonnegative" CHECK ("account_run_control_commands"."expected_version" >= 0),
	CONSTRAINT "account_run_control_commands_snapshot_check" CHECK (jsonb_typeof("account_run_control_commands"."result_snapshot") = 'object' and octet_length("account_run_control_commands"."result_snapshot"::text) <= 2048 and "account_run_control_commands"."result_snapshot" ?& array['applied', 'state'] and ("account_run_control_commands"."result_snapshot" - array['applied', 'state']) = '{}'::jsonb and jsonb_typeof("account_run_control_commands"."result_snapshot" -> 'applied') = 'boolean' and jsonb_typeof("account_run_control_commands"."result_snapshot" -> 'state') = 'object' and ("account_run_control_commands"."result_snapshot" -> 'state') ?& array['stoppedAt', 'controlVersion', 'scheduleResumeAfter'] and (("account_run_control_commands"."result_snapshot" -> 'state') - array['stoppedAt', 'controlVersion', 'scheduleResumeAfter']) = '{}'::jsonb and jsonb_typeof("account_run_control_commands"."result_snapshot" -> 'state' -> 'controlVersion') = 'number' and ("account_run_control_commands"."result_snapshot" -> 'state' -> 'stoppedAt' = 'null'::jsonb or jsonb_typeof("account_run_control_commands"."result_snapshot" -> 'state' -> 'stoppedAt') = 'string') and ("account_run_control_commands"."result_snapshot" -> 'state' -> 'scheduleResumeAfter' = 'null'::jsonb or jsonb_typeof("account_run_control_commands"."result_snapshot" -> 'state' -> 'scheduleResumeAfter') = 'string'))
);
--> statement-breakpoint
ALTER TABLE "job_discovery_schedule_occurrences" DROP CONSTRAINT "job_discovery_schedule_occurrences_skip_reason_check";--> statement-breakpoint
ALTER TABLE "account_run_policies" ADD COLUMN "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_run_policies" ADD COLUMN "control_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_run_policies" ADD COLUMN "schedule_resume_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_run_control_commands" ADD CONSTRAINT "account_run_control_commands_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_run_policies" ADD CONSTRAINT "account_run_policies_control_version_nonnegative" CHECK ("account_run_policies"."control_version" >= 0);--> statement-breakpoint
ALTER TABLE "job_discovery_schedule_occurrences" ADD CONSTRAINT "job_discovery_schedule_occurrences_skip_reason_check" CHECK ("job_discovery_schedule_occurrences"."skip_reason" is null or "job_discovery_schedule_occurrences"."skip_reason" in ('TARGET_INACTIVE', 'NO_SUPPORTED_SOURCE', 'SOURCE_POLICY_REQUIRED', 'PROFILE_UNAVAILABLE', 'ACCOUNT_RUN_POLICY_WINDOW_CLOSED', 'RUN_PREFLIGHT_BLOCKED', 'ACCOUNT_RUN_STOPPED', 'ACCOUNT_RUN_SCHEDULE_SKIPPED'));
--> statement-breakpoint
CREATE FUNCTION reject_account_run_control_command_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ACCOUNT_RUN_CONTROL_COMMAND_IMMUTABLE'; END; $$;
--> statement-breakpoint
CREATE TRIGGER account_run_control_commands_immutable BEFORE UPDATE OR DELETE ON "account_run_control_commands" FOR EACH ROW EXECUTE FUNCTION reject_account_run_control_command_mutation();
