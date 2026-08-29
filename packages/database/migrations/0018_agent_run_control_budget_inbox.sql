CREATE TABLE "agent_inbox_item_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"action" varchar(16) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"related_run_id" uuid,
	"reason_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_inbox_item_actions_user_item_action_unique" UNIQUE("user_id","item_id","action_id"),
	CONSTRAINT "agent_inbox_item_actions_action_check" CHECK ("agent_inbox_item_actions"."action" in ('restart_run', 'resume_run', 'cancel_run', 'dismiss')),
	CONSTRAINT "agent_inbox_item_actions_outcome_check" CHECK ("agent_inbox_item_actions"."outcome" in ('applied', 'no_change', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "agent_inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"trigger_event_sequence" integer NOT NULL,
	"kind" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"reason_code" varchar(64) NOT NULL,
	"budget_dimension" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "agent_inbox_items_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "agent_inbox_items_run_event_kind_unique" UNIQUE("run_id","trigger_event_sequence","kind"),
	CONSTRAINT "agent_inbox_items_trigger_event_positive" CHECK ("agent_inbox_items"."trigger_event_sequence" >= 1),
	CONSTRAINT "agent_inbox_items_kind_check" CHECK ("agent_inbox_items"."kind" in ('run_failed', 'budget_exhausted', 'decision_required')),
	CONSTRAINT "agent_inbox_items_status_check" CHECK ("agent_inbox_items"."status" in ('open', 'resolved')),
	CONSTRAINT "agent_inbox_items_reason_check" CHECK ("agent_inbox_items"."reason_code" = 'AGENT_RUN_PAUSED' or "agent_inbox_items"."reason_code" in ('AGENT_RUN_ADAPTER_RETRYABLE', 'AGENT_RUN_ADAPTER_FAILED', 'AGENT_RUN_CONTENT_STORAGE_FAILED', 'AGENT_RUN_PERSIST_FAILED', 'AGENT_RUN_BUDGET_EXCEEDED', 'AGENT_RUN_MODEL_RETRYABLE', 'AGENT_RUN_MODEL_AUTH_FAILED', 'AGENT_RUN_MODEL_POLICY_REJECTED', 'AGENT_RUN_MODEL_INVALID_RESPONSE')),
	CONSTRAINT "agent_inbox_items_dimension_check" CHECK ("agent_inbox_items"."budget_dimension" is null or "agent_inbox_items"."budget_dimension" in ('active_duration', 'attempts', 'tool_calls', 'model_calls', 'tokens')),
	CONSTRAINT "agent_inbox_items_resolved_check" CHECK (("agent_inbox_items"."status" = 'open') = ("agent_inbox_items"."resolved_at" is null))
);
--> statement-breakpoint
CREATE TABLE "agent_run_control_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"action" varchar(16) NOT NULL,
	"applied" boolean NOT NULL,
	"result_run_version" integer NOT NULL,
	"result_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_control_commands_user_run_command_unique" UNIQUE("user_id","run_id","command_id"),
	CONSTRAINT "agent_run_control_commands_action_check" CHECK ("agent_run_control_commands"."action" in ('pause', 'resume', 'cancel')),
	CONSTRAINT "agent_run_control_commands_result_version_positive" CHECK ("agent_run_control_commands"."result_run_version" >= 1),
	CONSTRAINT "agent_run_control_commands_result_snapshot_object" CHECK (jsonb_typeof("agent_run_control_commands"."result_snapshot") = 'object'),
	CONSTRAINT "agent_run_control_commands_result_snapshot_check" CHECK (
    "agent_run_control_commands"."result_snapshot" ?& array['runId', 'status', 'currentStep', 'controlState', 'version']
    and ("agent_run_control_commands"."result_snapshot" - array['runId', 'status', 'currentStep', 'controlState', 'version']) = '{}'::jsonb
    and jsonb_typeof("agent_run_control_commands"."result_snapshot" -> 'runId') = 'string'
    and "agent_run_control_commands"."result_snapshot" -> 'runId' = to_jsonb("agent_run_control_commands"."run_id"::text)
    and jsonb_typeof("agent_run_control_commands"."result_snapshot" -> 'status') = 'string'
    and "agent_run_control_commands"."result_snapshot" ->> 'status' in ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')
    and jsonb_typeof("agent_run_control_commands"."result_snapshot" -> 'currentStep') = 'string'
    and "agent_run_control_commands"."result_snapshot" ->> 'currentStep' in ('queued', 'batch_search', 'fetch_details', 'persist_results', 'completed', 'failed', 'cancelled')
    and (("agent_run_control_commands"."result_snapshot" ->> 'status' = 'cancelled') = ("agent_run_control_commands"."result_snapshot" ->> 'currentStep' = 'cancelled'))
    and jsonb_typeof("agent_run_control_commands"."result_snapshot" -> 'controlState') = 'string'
    and "agent_run_control_commands"."result_snapshot" ->> 'controlState' in ('none', 'pause_requested', 'cancel_requested')
    and jsonb_typeof("agent_run_control_commands"."result_snapshot" -> 'version') = 'number'
    and "agent_run_control_commands"."result_snapshot" -> 'version' = to_jsonb("agent_run_control_commands"."result_run_version")
  )
);
--> statement-breakpoint
CREATE TABLE "agent_run_usage_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"usage_key" varchar(128) NOT NULL,
	"category" varchar(32) NOT NULL,
	"amount" integer NOT NULL,
	"step_key" varchar(32),
	"attempt_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_usage_entries_run_key_category_unique" UNIQUE("run_id","usage_key","category"),
	CONSTRAINT "agent_run_usage_entries_category_check" CHECK ("agent_run_usage_entries"."category" in ('active_duration', 'tool_call', 'source_request', 'model_call', 'input_tokens', 'output_tokens', 'result')),
	CONSTRAINT "agent_run_usage_entries_amount_positive" CHECK ("agent_run_usage_entries"."amount" >= 1),
	CONSTRAINT "agent_run_usage_entries_attempt_nonnegative" CHECK ("agent_run_usage_entries"."attempt_count" >= 0),
	CONSTRAINT "agent_run_usage_entries_step_check" CHECK ("agent_run_usage_entries"."step_key" is null or "agent_run_usage_entries"."step_key" in ('batch_search', 'fetch_details', 'persist_results'))
);
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_status_check";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_current_step_check";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_failure_code_check";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_timestamp_state_check";--> statement-breakpoint
ALTER TABLE "agent_run_events" DROP CONSTRAINT "agent_run_events_event_type_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "rule_version" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "tool_allowlist" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "control_state" varchar(24) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "active_slice_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "active_duration_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "tool_call_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "source_request_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model_call_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "input_token_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "output_token_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "total_token_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "result_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "usage_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "termination_kind" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "termination_budget_dimension" varchar(32);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "retry_of_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
UPDATE "agent_runs"
SET
  "budget_snapshot" = ("budget_snapshot" - 'maxDurationMs') || jsonb_build_object(
    'maxActiveDurationMs', coalesce(("budget_snapshot" ->> 'maxDurationMs')::integer, 60000)
  ),
  "rule_version" = 'fake-job-discovery-rules-v1',
  "tool_allowlist" = '["job_discovery.search_batch","job_discovery.get_detail"]'::jsonb,
  "model_snapshot" = null,
  "usage_complete" = false;
--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "rule_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "tool_allowlist" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_inbox_item_actions" ADD CONSTRAINT "agent_inbox_item_actions_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox_item_actions" ADD CONSTRAINT "agent_inbox_item_actions_item_id_agent_inbox_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."agent_inbox_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox_item_actions" ADD CONSTRAINT "agent_inbox_item_actions_owner_item_fk" FOREIGN KEY ("user_id","item_id") REFERENCES "public"."agent_inbox_items"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox_item_actions" ADD CONSTRAINT "agent_inbox_item_actions_owner_related_run_fk" FOREIGN KEY ("user_id","related_run_id") REFERENCES "public"."agent_runs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_owner_run_fk" FOREIGN KEY ("user_id","run_id") REFERENCES "public"."agent_runs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_control_commands" ADD CONSTRAINT "agent_run_control_commands_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_control_commands" ADD CONSTRAINT "agent_run_control_commands_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_control_commands" ADD CONSTRAINT "agent_run_control_commands_owner_run_fk" FOREIGN KEY ("user_id","run_id") REFERENCES "public"."agent_runs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_usage_entries" ADD CONSTRAINT "agent_run_usage_entries_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_usage_entries" ADD CONSTRAINT "agent_run_usage_entries_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_usage_entries" ADD CONSTRAINT "agent_run_usage_entries_owner_run_fk" FOREIGN KEY ("user_id","run_id") REFERENCES "public"."agent_runs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_inbox_items_open_lookup_idx" ON "agent_inbox_items" USING btree ("user_id","status","created_at");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_owner_retry_fk" FOREIGN KEY ("user_id","retry_of_run_id") REFERENCES "public"."agent_runs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_control_state_check" CHECK ("agent_runs"."control_state" in ('none', 'pause_requested', 'cancel_requested'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_execution_claim_check" CHECK (("agent_runs"."claim_token" is null and "agent_runs"."active_slice_started_at" is null) or "agent_runs"."status" = 'running');--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_aggregate_nonnegative" CHECK ("agent_runs"."active_duration_ms" >= 0 and "agent_runs"."tool_call_count" >= 0 and "agent_runs"."source_request_count" >= 0 and "agent_runs"."model_call_count" >= 0 and "agent_runs"."input_token_count" >= 0 and "agent_runs"."output_token_count" >= 0 and "agent_runs"."total_token_count" >= 0 and "agent_runs"."result_count" >= 0);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_total_tokens_check" CHECK ("agent_runs"."total_token_count" = "agent_runs"."input_token_count" + "agent_runs"."output_token_count");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_fake_model_usage_check" CHECK ("agent_runs"."model_snapshot" is null and "agent_runs"."model_call_count" = 0 and "agent_runs"."input_token_count" = 0 and "agent_runs"."output_token_count" = 0 and "agent_runs"."total_token_count" = 0);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_termination_kind_check" CHECK ("agent_runs"."termination_kind" is null or "agent_runs"."termination_kind" in ('completed', 'cancelled_by_user', 'source_failed', 'content_storage_failed', 'persistence_failed', 'budget_exhausted'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_termination_budget_dimension_check" CHECK (("agent_runs"."termination_kind" = 'budget_exhausted' and "agent_runs"."termination_budget_dimension" in ('active_duration', 'attempts', 'tool_calls', 'model_calls', 'tokens')) or ("agent_runs"."termination_kind" is distinct from 'budget_exhausted' and "agent_runs"."termination_budget_dimension" is null));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_cancelled_step_check" CHECK (("agent_runs"."status" = 'cancelled') = ("agent_runs"."current_step" = 'cancelled'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_termination_mapping_check" CHECK (coalesce((
    ("agent_runs"."status" in ('queued', 'running', 'paused') and "agent_runs"."termination_kind" is null and "agent_runs"."termination_budget_dimension" is null)
    or ("agent_runs"."status" = 'completed' and ((not "agent_runs"."usage_complete" and "agent_runs"."termination_kind" is null) or ("agent_runs"."termination_kind" = 'completed' and "agent_runs"."failure_code" is null and "agent_runs"."termination_budget_dimension" is null)))
    or ("agent_runs"."status" = 'cancelled' and ((not "agent_runs"."usage_complete" and "agent_runs"."termination_kind" is null) or ("agent_runs"."termination_kind" = 'cancelled_by_user' and "agent_runs"."failure_code" is null and "agent_runs"."termination_budget_dimension" is null)))
    or ("agent_runs"."status" = 'failed' and (
      (not "agent_runs"."usage_complete" and "agent_runs"."termination_kind" is null)
      or ("agent_runs"."termination_kind" = 'source_failed' and "agent_runs"."failure_code" in ('AGENT_RUN_ADAPTER_RETRYABLE', 'AGENT_RUN_ADAPTER_FAILED', 'AGENT_RUN_MODEL_RETRYABLE', 'AGENT_RUN_MODEL_AUTH_FAILED', 'AGENT_RUN_MODEL_POLICY_REJECTED', 'AGENT_RUN_MODEL_INVALID_RESPONSE') and "agent_runs"."termination_budget_dimension" is null)
      or ("agent_runs"."termination_kind" = 'content_storage_failed' and "agent_runs"."failure_code" = 'AGENT_RUN_CONTENT_STORAGE_FAILED' and "agent_runs"."termination_budget_dimension" is null)
      or ("agent_runs"."termination_kind" = 'persistence_failed' and "agent_runs"."failure_code" = 'AGENT_RUN_PERSIST_FAILED' and "agent_runs"."termination_budget_dimension" is null)
      or ("agent_runs"."termination_kind" = 'budget_exhausted' and "agent_runs"."failure_code" = 'AGENT_RUN_BUDGET_EXCEEDED' and "agent_runs"."termination_budget_dimension" is not null)
    ))
  ), false));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_status_check" CHECK ("agent_runs"."status" in ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_current_step_check" CHECK ("agent_runs"."current_step" in ('queued', 'batch_search', 'fetch_details', 'persist_results', 'completed', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_failure_code_check" CHECK ("agent_runs"."failure_code" is null or "agent_runs"."failure_code" in ('AGENT_RUN_ADAPTER_RETRYABLE', 'AGENT_RUN_ADAPTER_FAILED', 'AGENT_RUN_CONTENT_STORAGE_FAILED', 'AGENT_RUN_PERSIST_FAILED', 'AGENT_RUN_BUDGET_EXCEEDED', 'AGENT_RUN_MODEL_RETRYABLE', 'AGENT_RUN_MODEL_AUTH_FAILED', 'AGENT_RUN_MODEL_POLICY_REJECTED', 'AGENT_RUN_MODEL_INVALID_RESPONSE'));--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_event_type_check" CHECK ("agent_run_events"."event_type" in ('run.queued', 'run.started', 'step.started', 'step.completed', 'run.retry_scheduled', 'run.completed', 'run.failed', 'run.pause_requested', 'run.paused', 'run.resume_requested', 'run.resumed', 'run.cancel_requested', 'run.cancelled', 'run.budget_updated'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_timestamp_state_check" CHECK (
    ("agent_runs"."status" in ('queued', 'paused') and "agent_runs"."completed_at" is null and "agent_runs"."failed_at" is null and "agent_runs"."cancelled_at" is null)
    or ("agent_runs"."status" = 'running' and "agent_runs"."started_at" is not null and "agent_runs"."completed_at" is null and "agent_runs"."failed_at" is null and "agent_runs"."cancelled_at" is null)
    or ("agent_runs"."status" = 'completed' and "agent_runs"."started_at" is not null and "agent_runs"."completed_at" is not null and "agent_runs"."failed_at" is null and "agent_runs"."cancelled_at" is null)
    or ("agent_runs"."status" = 'failed' and "agent_runs"."started_at" is not null and "agent_runs"."completed_at" is null and "agent_runs"."failed_at" is not null and "agent_runs"."cancelled_at" is null)
    or ("agent_runs"."status" = 'cancelled' and "agent_runs"."completed_at" is null and "agent_runs"."failed_at" is null and "agent_runs"."cancelled_at" is not null)
  );
