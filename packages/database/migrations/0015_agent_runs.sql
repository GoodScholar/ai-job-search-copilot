CREATE TABLE "agent_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"run_version" integer NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_events_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "agent_run_events_run_sequence_unique" UNIQUE("run_id","sequence"),
	CONSTRAINT "agent_run_events_sequence_positive" CHECK ("agent_run_events"."sequence" >= 1),
	CONSTRAINT "agent_run_events_run_version_positive" CHECK ("agent_run_events"."run_version" >= 1),
	CONSTRAINT "agent_run_events_event_type_check" CHECK ("agent_run_events"."event_type" in ('run.queued', 'run.started', 'step.started', 'step.completed', 'run.retry_scheduled', 'run.completed', 'run.failed')),
	CONSTRAINT "agent_run_events_data_object" CHECK (jsonb_typeof("agent_run_events"."data") = 'object')
);
--> statement-breakpoint
CREATE TABLE "agent_run_job_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"source_posting_version_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_job_results_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "agent_run_job_results_run_opportunity_source_unique" UNIQUE("run_id","opportunity_id","source_posting_version_id"),
	CONSTRAINT "agent_run_job_results_run_ordinal_unique" UNIQUE("run_id","ordinal"),
	CONSTRAINT "agent_run_job_results_ordinal_positive" CHECK ("agent_run_job_results"."ordinal" >= 1)
);
--> statement-breakpoint
CREATE TABLE "agent_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_key" varchar(32) NOT NULL,
	"ordinal" integer NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_code" varchar(64),
	CONSTRAINT "agent_run_steps_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "agent_run_steps_run_step_unique" UNIQUE("run_id","step_key"),
	CONSTRAINT "agent_run_steps_run_ordinal_unique" UNIQUE("run_id","ordinal"),
	CONSTRAINT "agent_run_steps_step_key_check" CHECK ("agent_run_steps"."step_key" in ('batch_search', 'fetch_details', 'persist_results')),
	CONSTRAINT "agent_run_steps_ordinal_check" CHECK ("agent_run_steps"."ordinal" between 1 and 3),
	CONSTRAINT "agent_run_steps_status_check" CHECK ("agent_run_steps"."status" in ('pending', 'running', 'completed', 'failed')),
	CONSTRAINT "agent_run_steps_attempt_count_nonnegative" CHECK ("agent_run_steps"."attempt_count" >= 0),
	CONSTRAINT "agent_run_steps_failure_code_check" CHECK ("agent_run_steps"."failure_code" is null or "agent_run_steps"."failure_code" in ('AGENT_RUN_ADAPTER_RETRYABLE', 'AGENT_RUN_ADAPTER_FAILED', 'AGENT_RUN_CONTENT_STORAGE_FAILED', 'AGENT_RUN_PERSIST_FAILED', 'AGENT_RUN_BUDGET_EXCEEDED')),
	CONSTRAINT "agent_run_steps_timestamp_state_check" CHECK (
    ("agent_run_steps"."status" = 'pending' and "agent_run_steps"."started_at" is null and "agent_run_steps"."completed_at" is null and "agent_run_steps"."failed_at" is null)
    or ("agent_run_steps"."status" = 'running' and "agent_run_steps"."started_at" is not null and "agent_run_steps"."completed_at" is null and "agent_run_steps"."failed_at" is null)
    or ("agent_run_steps"."status" = 'completed' and "agent_run_steps"."started_at" is not null and "agent_run_steps"."completed_at" is not null and "agent_run_steps"."failed_at" is null)
    or ("agent_run_steps"."status" = 'failed' and "agent_run_steps"."started_at" is not null and "agent_run_steps"."completed_at" is null and "agent_run_steps"."failed_at" is not null)
  )
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"target_version" integer NOT NULL,
	"target_snapshot" jsonb NOT NULL,
	"source_scope" jsonb NOT NULL,
	"budget_snapshot" jsonb NOT NULL,
	"workflow_version" varchar(64) NOT NULL,
	"adapter" varchar(64) NOT NULL,
	"adapter_version" varchar(64) NOT NULL,
	"output_schema_version" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"current_step" varchar(32) DEFAULT 'queued' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"failure_code" varchar(64),
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "agent_runs_user_idempotency_unique" UNIQUE("user_id","idempotency_key"),
	CONSTRAINT "agent_runs_target_version_positive" CHECK ("agent_runs"."target_version" >= 1),
	CONSTRAINT "agent_runs_target_snapshot_object" CHECK (jsonb_typeof("agent_runs"."target_snapshot") = 'object'),
	CONSTRAINT "agent_runs_source_scope_object" CHECK (jsonb_typeof("agent_runs"."source_scope") = 'object'),
	CONSTRAINT "agent_runs_budget_snapshot_object" CHECK (jsonb_typeof("agent_runs"."budget_snapshot") = 'object'),
	CONSTRAINT "agent_runs_status_check" CHECK ("agent_runs"."status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "agent_runs_current_step_check" CHECK ("agent_runs"."current_step" in ('queued', 'batch_search', 'fetch_details', 'persist_results', 'completed', 'failed')),
	CONSTRAINT "agent_runs_version_positive" CHECK ("agent_runs"."version" >= 1),
	CONSTRAINT "agent_runs_attempt_count_nonnegative" CHECK ("agent_runs"."attempt_count" >= 0),
	CONSTRAINT "agent_runs_failure_code_check" CHECK ("agent_runs"."failure_code" is null or "agent_runs"."failure_code" in ('AGENT_RUN_ADAPTER_RETRYABLE', 'AGENT_RUN_ADAPTER_FAILED', 'AGENT_RUN_CONTENT_STORAGE_FAILED', 'AGENT_RUN_PERSIST_FAILED', 'AGENT_RUN_BUDGET_EXCEEDED')),
	CONSTRAINT "agent_runs_claim_consistency_check" CHECK (("agent_runs"."claim_token" is null) = ("agent_runs"."claim_expires_at" is null)),
	CONSTRAINT "agent_runs_timestamp_state_check" CHECK (
    ("agent_runs"."status" = 'queued' and "agent_runs"."started_at" is null and "agent_runs"."completed_at" is null and "agent_runs"."failed_at" is null)
    or ("agent_runs"."status" = 'running' and "agent_runs"."started_at" is not null and "agent_runs"."completed_at" is null and "agent_runs"."failed_at" is null)
    or ("agent_runs"."status" = 'completed' and "agent_runs"."started_at" is not null and "agent_runs"."completed_at" is not null and "agent_runs"."failed_at" is null)
    or ("agent_runs"."status" = 'failed' and "agent_runs"."started_at" is not null and "agent_runs"."completed_at" is null and "agent_runs"."failed_at" is not null)
  )
);
--> statement-breakpoint
ALTER TABLE "job_opportunities" ALTER COLUMN "import_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_owner_run_fk" FOREIGN KEY ("user_id","run_id") REFERENCES "public"."agent_runs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_job_results" ADD CONSTRAINT "agent_run_job_results_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_job_results" ADD CONSTRAINT "agent_run_job_results_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_job_results" ADD CONSTRAINT "agent_run_job_results_opportunity_id_job_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."job_opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_job_results" ADD CONSTRAINT "agent_run_job_results_source_posting_version_id_job_source_posting_versions_id_fk" FOREIGN KEY ("source_posting_version_id") REFERENCES "public"."job_source_posting_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_job_results" ADD CONSTRAINT "agent_run_job_results_owner_run_fk" FOREIGN KEY ("user_id","run_id") REFERENCES "public"."agent_runs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_job_results" ADD CONSTRAINT "agent_run_job_results_owner_opportunity_fk" FOREIGN KEY ("user_id","opportunity_id") REFERENCES "public"."job_opportunities"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_job_results" ADD CONSTRAINT "agent_run_job_results_owner_posting_version_fk" FOREIGN KEY ("user_id","source_posting_version_id") REFERENCES "public"."job_source_posting_versions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_owner_run_fk" FOREIGN KEY ("user_id","run_id") REFERENCES "public"."agent_runs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_target_id_job_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."job_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_owner_target_fk" FOREIGN KEY ("user_id","target_id") REFERENCES "public"."job_targets"("user_id","id") ON DELETE no action ON UPDATE no action;