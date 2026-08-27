CREATE TABLE "candidate_fact_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"candidate_fact_id" uuid NOT NULL,
	"decision" varchar(16) NOT NULL,
	"profile_fact_revision_id" uuid,
	"profile_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_fact_decisions_candidate_fact_unique" UNIQUE("candidate_fact_id"),
	CONSTRAINT "candidate_fact_decisions_type_check" CHECK ("candidate_fact_decisions"."decision" in ('confirmed', 'corrected', 'rejected')),
	CONSTRAINT "candidate_fact_decisions_version_nonnegative" CHECK ("candidate_fact_decisions"."profile_version" >= 0),
	CONSTRAINT "candidate_fact_decisions_revision_check" CHECK (("candidate_fact_decisions"."decision" = 'rejected') = ("candidate_fact_decisions"."profile_fact_revision_id" is null))
);
--> statement-breakpoint
CREATE TABLE "job_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_profiles_user_unique" UNIQUE("user_id"),
	CONSTRAINT "job_profiles_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_profiles_version_nonnegative" CHECK ("job_profiles"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "profile_fact_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_fact_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"fact_type" varchar(32) NOT NULL,
	"fact_value" jsonb NOT NULL,
	"state" varchar(16) DEFAULT 'active' NOT NULL,
	"source" varchar(32) NOT NULL,
	"candidate_fact_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_fact_revisions_fact_revision_unique" UNIQUE("profile_fact_id","revision_number"),
	CONSTRAINT "profile_fact_revisions_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "profile_fact_revisions_number_positive" CHECK ("profile_fact_revisions"."revision_number" >= 1),
	CONSTRAINT "profile_fact_revisions_fact_type_check" CHECK ("profile_fact_revisions"."fact_type" in ('experience', 'education', 'skill', 'project', 'language', 'achievement', 'certification', 'work_eligibility')),
	CONSTRAINT "profile_fact_revisions_state_check" CHECK ("profile_fact_revisions"."state" in ('active', 'removed')),
	CONSTRAINT "profile_fact_revisions_source_check" CHECK ("profile_fact_revisions"."source" in ('candidate_fact', 'user_confirmed')),
	CONSTRAINT "profile_fact_revisions_candidate_source_check" CHECK ("profile_fact_revisions"."source" != 'candidate_fact' or "profile_fact_revisions"."candidate_fact_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "profile_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"fact_type" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_facts_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "profile_facts_fact_type_check" CHECK ("profile_facts"."fact_type" in ('experience', 'education', 'skill', 'project', 'language', 'achievement', 'certification', 'work_eligibility'))
);
--> statement-breakpoint
ALTER TABLE "candidate_facts" ADD CONSTRAINT "candidate_facts_user_id_id_unique" UNIQUE("user_id","id");--> statement-breakpoint
ALTER TABLE "candidate_fact_decisions" ADD CONSTRAINT "candidate_fact_decisions_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_fact_decisions" ADD CONSTRAINT "candidate_fact_decisions_profile_id_job_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."job_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_fact_decisions" ADD CONSTRAINT "candidate_fact_decisions_candidate_fact_id_candidate_facts_id_fk" FOREIGN KEY ("candidate_fact_id") REFERENCES "public"."candidate_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_fact_decisions" ADD CONSTRAINT "candidate_fact_decisions_profile_fact_revision_id_profile_fact_revisions_id_fk" FOREIGN KEY ("profile_fact_revision_id") REFERENCES "public"."profile_fact_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_fact_decisions" ADD CONSTRAINT "candidate_fact_decisions_owner_profile_fk" FOREIGN KEY ("user_id","profile_id") REFERENCES "public"."job_profiles"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_fact_decisions" ADD CONSTRAINT "candidate_fact_decisions_owner_candidate_fk" FOREIGN KEY ("user_id","candidate_fact_id") REFERENCES "public"."candidate_facts"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_fact_decisions" ADD CONSTRAINT "candidate_fact_decisions_owner_revision_fk" FOREIGN KEY ("user_id","profile_fact_revision_id") REFERENCES "public"."profile_fact_revisions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_profiles" ADD CONSTRAINT "job_profiles_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_fact_revisions" ADD CONSTRAINT "profile_fact_revisions_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_fact_revisions" ADD CONSTRAINT "profile_fact_revisions_profile_fact_id_profile_facts_id_fk" FOREIGN KEY ("profile_fact_id") REFERENCES "public"."profile_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_fact_revisions" ADD CONSTRAINT "profile_fact_revisions_candidate_fact_id_candidate_facts_id_fk" FOREIGN KEY ("candidate_fact_id") REFERENCES "public"."candidate_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_fact_revisions" ADD CONSTRAINT "profile_fact_revisions_owner_fact_fk" FOREIGN KEY ("user_id","profile_fact_id") REFERENCES "public"."profile_facts"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_fact_revisions" ADD CONSTRAINT "profile_fact_revisions_owner_candidate_fk" FOREIGN KEY ("user_id","candidate_fact_id") REFERENCES "public"."candidate_facts"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_profile_id_job_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."job_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_owner_profile_fk" FOREIGN KEY ("user_id","profile_id") REFERENCES "public"."job_profiles"("user_id","id") ON DELETE no action ON UPDATE no action;
