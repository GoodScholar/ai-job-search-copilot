ALTER TABLE "agent_runs" ADD COLUMN "preflight_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_preflight_snapshot_object" CHECK ("preflight_snapshot" is null or jsonb_typeof("preflight_snapshot") = 'object');--> statement-breakpoint
ALTER TABLE "job_discovery_schedule_occurrences" DROP CONSTRAINT "job_discovery_schedule_occurrences_skip_reason_check";--> statement-breakpoint
ALTER TABLE "job_discovery_schedule_occurrences" ADD CONSTRAINT "job_discovery_schedule_occurrences_skip_reason_check" CHECK ("skip_reason" is null or "skip_reason" in ('TARGET_INACTIVE', 'NO_SUPPORTED_SOURCE', 'SOURCE_POLICY_REQUIRED', 'PROFILE_UNAVAILABLE', 'ACCOUNT_RUN_POLICY_WINDOW_CLOSED', 'RUN_PREFLIGHT_BLOCKED'));
