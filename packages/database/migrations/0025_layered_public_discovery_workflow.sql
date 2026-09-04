CREATE TABLE "job_discovery_diagnostics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"scope" varchar(16) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"query_id" uuid,
	"query_kind" varchar(32),
	"query_fingerprint" varchar(64),
	"lead_id" uuid,
	"code" varchar(64) NOT NULL,
	"retryable" boolean NOT NULL,
	"affected_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_discovery_diagnostics_owner_run_identity_unique" UNIQUE NULLS NOT DISTINCT("user_id","run_id","scope","provider","query_id","lead_id","code"),
	CONSTRAINT "job_discovery_diagnostics_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_discovery_diagnostics_scope_check" CHECK ("job_discovery_diagnostics"."scope" in ('provider', 'query', 'lead')),
	CONSTRAINT "job_discovery_diagnostics_provider_check" CHECK ("job_discovery_diagnostics"."provider" = 'anysearch'),
	CONSTRAINT "job_discovery_diagnostics_code_check" CHECK ("job_discovery_diagnostics"."code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "job_discovery_diagnostics_affected_count_check" CHECK ("job_discovery_diagnostics"."affected_count" between 0 and 10),
	CONSTRAINT "job_discovery_diagnostics_scope_pair_check" CHECK (
    ("job_discovery_diagnostics"."scope" = 'provider' and "job_discovery_diagnostics"."query_id" is null and "job_discovery_diagnostics"."query_kind" is null and "job_discovery_diagnostics"."query_fingerprint" is null and "job_discovery_diagnostics"."lead_id" is null)
    or ("job_discovery_diagnostics"."scope" = 'query' and "job_discovery_diagnostics"."query_id" is not null and "job_discovery_diagnostics"."query_kind" in ('general', 'site_constrained', 'target_company') and "job_discovery_diagnostics"."query_fingerprint" ~ '^[0-9a-f]{64}$' and "job_discovery_diagnostics"."lead_id" is null)
    or ("job_discovery_diagnostics"."scope" = 'lead' and "job_discovery_diagnostics"."query_id" is null and "job_discovery_diagnostics"."query_kind" is null and "job_discovery_diagnostics"."query_fingerprint" is null and "job_discovery_diagnostics"."lead_id" is not null)
  )
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "profile_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "watchlist_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "job_discovery_diagnostics" ADD CONSTRAINT "job_discovery_diagnostics_owner_run_fk" FOREIGN KEY ("user_id","run_id") REFERENCES "public"."agent_runs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_discovery_diagnostics" ADD CONSTRAINT "job_discovery_diagnostics_owner_lead_fk" FOREIGN KEY ("user_id","lead_id") REFERENCES "public"."job_discovery_leads"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_discovery_diagnostics_owner_run_idx" ON "job_discovery_diagnostics" USING btree ("user_id","run_id","created_at","id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_v4_snapshot_pair_check" CHECK ((
    "agent_runs"."workflow_version" = 'layered-public-job-discovery-v1'
    and jsonb_typeof("agent_runs"."profile_snapshot") = 'object'
    and jsonb_typeof("agent_runs"."watchlist_snapshot") = 'object'
    and "agent_runs"."profile_snapshot" ->> 'targetId' = "agent_runs"."target_snapshot" ->> 'targetId'
    and "agent_runs"."watchlist_snapshot" ->> 'targetId' = "agent_runs"."target_snapshot" ->> 'targetId'
  ) or (
    "agent_runs"."workflow_version" <> 'layered-public-job-discovery-v1'
    and "agent_runs"."profile_snapshot" is null
    and "agent_runs"."watchlist_snapshot" is null
  ));
