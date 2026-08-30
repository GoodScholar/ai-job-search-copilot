CREATE TABLE "job_discovery_run_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_posting_version_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_discovery_run_results_owner_run_ordinal_unique" UNIQUE("user_id","run_id","ordinal"),
	CONSTRAINT "job_discovery_run_results_owner_run_version_unique" UNIQUE("user_id","run_id","source_posting_version_id"),
	CONSTRAINT "job_discovery_run_results_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_discovery_run_results_ordinal_check" CHECK ("job_discovery_run_results"."ordinal" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "job_discovery_source_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"code" varchar(64) NOT NULL,
	"affected_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_discovery_source_issues_owner_run_identity_unique" UNIQUE("user_id","run_id","provider","code"),
	CONSTRAINT "job_discovery_source_issues_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_discovery_source_issues_provider_check" CHECK ("job_discovery_source_issues"."provider" in ('anysearch', 'greenhouse')),
	CONSTRAINT "job_discovery_source_issues_code_check" CHECK ("job_discovery_source_issues"."code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "job_discovery_source_issues_affected_count_check" CHECK ("job_discovery_source_issues"."affected_count" between 0 and 10)
);
--> statement-breakpoint
ALTER TABLE "job_discovery_run_results" ADD CONSTRAINT "job_discovery_run_results_owner_run_fk" FOREIGN KEY ("user_id","run_id") REFERENCES "public"."agent_runs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_discovery_run_results" ADD CONSTRAINT "job_discovery_run_results_owner_version_fk" FOREIGN KEY ("user_id","source_posting_version_id") REFERENCES "public"."job_source_posting_versions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_discovery_source_issues" ADD CONSTRAINT "job_discovery_source_issues_owner_run_fk" FOREIGN KEY ("user_id","run_id") REFERENCES "public"."agent_runs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_discovery_source_issues_owner_run_idx" ON "job_discovery_source_issues" USING btree ("user_id","run_id","provider","code");