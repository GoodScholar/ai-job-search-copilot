CREATE TABLE "job_discovery_schedule_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"run_id" uuid,
	"skip_reason" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_discovery_schedule_occurrences_schedule_time_unique" UNIQUE("schedule_id","scheduled_for"),
	CONSTRAINT "job_discovery_schedule_occurrences_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_discovery_schedule_occurrences_status_check" CHECK ("job_discovery_schedule_occurrences"."status" in ('pending', 'dispatched', 'skipped')),
	CONSTRAINT "job_discovery_schedule_occurrences_skip_reason_check" CHECK ("job_discovery_schedule_occurrences"."skip_reason" is null or "job_discovery_schedule_occurrences"."skip_reason" in ('TARGET_INACTIVE', 'NO_SUPPORTED_SOURCE', 'SOURCE_POLICY_REQUIRED')),
	CONSTRAINT "job_discovery_schedule_occurrences_outcome_check" CHECK (
    ("job_discovery_schedule_occurrences"."status" = 'pending' and "job_discovery_schedule_occurrences"."run_id" is null and "job_discovery_schedule_occurrences"."skip_reason" is null)
    or ("job_discovery_schedule_occurrences"."status" = 'dispatched' and "job_discovery_schedule_occurrences"."run_id" is not null and "job_discovery_schedule_occurrences"."skip_reason" is null)
    or ("job_discovery_schedule_occurrences"."status" = 'skipped' and "job_discovery_schedule_occurrences"."run_id" is null and "job_discovery_schedule_occurrences"."skip_reason" is not null)
  )
);
--> statement-breakpoint
CREATE TABLE "job_discovery_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" varchar(16) DEFAULT 'disabled' NOT NULL,
	"daily_time" varchar(5) NOT NULL,
	"time_zone" varchar(32) DEFAULT 'Asia/Shanghai' NOT NULL,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_discovery_schedules_user_target_unique" UNIQUE("user_id","target_id"),
	CONSTRAINT "job_discovery_schedules_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_discovery_schedules_user_schedule_target_unique" UNIQUE("user_id","id","target_id"),
	CONSTRAINT "job_discovery_schedules_version_positive" CHECK ("job_discovery_schedules"."version" >= 1),
	CONSTRAINT "job_discovery_schedules_state_check" CHECK ("job_discovery_schedules"."state" in ('enabled', 'disabled')),
	CONSTRAINT "job_discovery_schedules_daily_time_check" CHECK ("job_discovery_schedules"."daily_time" ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "job_discovery_schedules_time_zone_check" CHECK ("job_discovery_schedules"."time_zone" = 'Asia/Shanghai')
);
--> statement-breakpoint
ALTER TABLE "job_opportunities" ADD COLUMN "availability" varchar(16) DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_opportunities" ADD COLUMN "availability_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "job_source_posting_versions" ADD COLUMN "availability" varchar(16) DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_source_postings" ADD COLUMN "availability" varchar(16) DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_source_postings" ADD COLUMN "availability_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "job_discovery_schedule_occurrences" ADD CONSTRAINT "job_discovery_schedule_occurrences_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_discovery_schedule_occurrences" ADD CONSTRAINT "job_discovery_schedule_occurrences_owner_schedule_fk" FOREIGN KEY ("user_id","schedule_id","target_id") REFERENCES "public"."job_discovery_schedules"("user_id","id","target_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_discovery_schedule_occurrences" ADD CONSTRAINT "job_discovery_schedule_occurrences_owner_run_fk" FOREIGN KEY ("user_id","run_id") REFERENCES "public"."agent_runs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_discovery_schedules" ADD CONSTRAINT "job_discovery_schedules_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_discovery_schedules" ADD CONSTRAINT "job_discovery_schedules_target_id_job_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."job_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_discovery_schedules" ADD CONSTRAINT "job_discovery_schedules_owner_target_fk" FOREIGN KEY ("user_id","target_id") REFERENCES "public"."job_targets"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_discovery_schedule_occurrences_pending_idx" ON "job_discovery_schedule_occurrences" USING btree ("status","scheduled_for","id");--> statement-breakpoint
CREATE INDEX "job_discovery_schedules_due_idx" ON "job_discovery_schedules" USING btree ("state","next_run_at","id");--> statement-breakpoint
CREATE INDEX "job_opportunities_availability_idx" ON "job_opportunities" USING btree ("user_id","availability","availability_updated_at");--> statement-breakpoint
CREATE INDEX "job_source_postings_availability_idx" ON "job_source_postings" USING btree ("user_id","availability","availability_updated_at");--> statement-breakpoint
ALTER TABLE "job_opportunities" ADD CONSTRAINT "job_opportunities_availability_check" CHECK ("job_opportunities"."availability" in ('open', 'closed', 'expired'));--> statement-breakpoint
ALTER TABLE "job_source_posting_versions" ADD CONSTRAINT "job_source_posting_versions_availability_check" CHECK ("job_source_posting_versions"."availability" in ('open', 'closed', 'expired'));--> statement-breakpoint
ALTER TABLE "job_source_postings" ADD CONSTRAINT "job_source_postings_availability_check" CHECK ("job_source_postings"."availability" in ('open', 'closed', 'expired'));
