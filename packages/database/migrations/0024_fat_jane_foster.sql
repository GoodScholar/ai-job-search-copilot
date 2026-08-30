CREATE TABLE "job_discovery_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"source_posting_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_discovery_attributions_lead_unique" UNIQUE("lead_id"),
	CONSTRAINT "job_discovery_attributions_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_discovery_attributions_provider_check" CHECK ("job_discovery_attributions"."provider" = 'anysearch')
);
--> statement-breakpoint
CREATE TABLE "job_discovery_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"query_id" uuid NOT NULL,
	"query_kind" varchar(32) NOT NULL,
	"query_fingerprint" varchar(64) NOT NULL,
	"normalized_url" varchar(2048) NOT NULL,
	"stable_fingerprint" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"source_posting_version_id" uuid,
	"rejection_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_discovery_leads_owner_run_provider_identity_unique" UNIQUE("user_id","run_id","provider","stable_fingerprint"),
	CONSTRAINT "job_discovery_leads_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_discovery_leads_attr_ref_unique" UNIQUE("user_id","id","run_id","provider","query_id","source_posting_version_id"),
	CONSTRAINT "job_discovery_leads_provider_check" CHECK ("job_discovery_leads"."provider" = 'anysearch'),
	CONSTRAINT "job_discovery_leads_query_kind_check" CHECK ("job_discovery_leads"."query_kind" in ('general', 'site_constrained', 'target_company')),
	CONSTRAINT "job_discovery_leads_query_fingerprint_format" CHECK ("job_discovery_leads"."query_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "job_discovery_leads_stable_fingerprint_format" CHECK ("job_discovery_leads"."stable_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "job_discovery_leads_url_length_check" CHECK (length("job_discovery_leads"."normalized_url") between 1 and 2048),
	CONSTRAINT "job_discovery_leads_ttl_check" CHECK ("job_discovery_leads"."expires_at" = "job_discovery_leads"."created_at" + interval '30 days'),
	CONSTRAINT "job_discovery_leads_state_check" CHECK ("job_discovery_leads"."state" in ('pending', 'verified', 'rejected')),
	CONSTRAINT "job_discovery_leads_rejection_code_check" CHECK ("job_discovery_leads"."rejection_code" is null or "job_discovery_leads"."rejection_code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "job_discovery_leads_outcome_check" CHECK (
    ("job_discovery_leads"."state" = 'pending' and "job_discovery_leads"."source_posting_version_id" is null and "job_discovery_leads"."rejection_code" is null)
    or ("job_discovery_leads"."state" = 'verified' and "job_discovery_leads"."source_posting_version_id" is not null and "job_discovery_leads"."rejection_code" is null)
    or ("job_discovery_leads"."state" = 'rejected' and "job_discovery_leads"."source_posting_version_id" is null and "job_discovery_leads"."rejection_code" is not null)
  )
);
--> statement-breakpoint
ALTER TABLE "job_discovery_attributions" ADD CONSTRAINT "job_discovery_attributions_lead_ref_fk" FOREIGN KEY ("user_id","lead_id","run_id","provider","query_id","source_posting_version_id") REFERENCES "public"."job_discovery_leads"("user_id","id","run_id","provider","query_id","source_posting_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_discovery_attributions" ADD CONSTRAINT "job_discovery_attributions_owner_version_fk" FOREIGN KEY ("user_id","source_posting_version_id") REFERENCES "public"."job_source_posting_versions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_discovery_leads" ADD CONSTRAINT "job_discovery_leads_owner_run_target_fk" FOREIGN KEY ("user_id","run_id","target_id") REFERENCES "public"."agent_runs"("user_id","id","target_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_discovery_leads" ADD CONSTRAINT "job_discovery_leads_owner_version_fk" FOREIGN KEY ("user_id","source_posting_version_id") REFERENCES "public"."job_source_posting_versions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_discovery_attributions_owner_run_idx" ON "job_discovery_attributions" USING btree ("user_id","run_id","created_at","id");--> statement-breakpoint
CREATE INDEX "job_discovery_leads_owner_run_state_idx" ON "job_discovery_leads" USING btree ("user_id","run_id","state","created_at","id");