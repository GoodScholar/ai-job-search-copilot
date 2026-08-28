CREATE TABLE "job_target_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"priority" varchar(16) NOT NULL,
	"state" varchar(16) NOT NULL,
	"constraints" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_target_revisions_target_version_unique" UNIQUE("target_id","version"),
	CONSTRAINT "job_target_revisions_version_positive" CHECK ("job_target_revisions"."version" >= 1),
	CONSTRAINT "job_target_revisions_priority_check" CHECK ("job_target_revisions"."priority" in ('primary', 'secondary')),
	CONSTRAINT "job_target_revisions_state_check" CHECK ("job_target_revisions"."state" in ('active', 'inactive')),
	CONSTRAINT "job_target_revisions_constraints_object" CHECK (jsonb_typeof("job_target_revisions"."constraints") = 'object')
);
--> statement-breakpoint
CREATE TABLE "job_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"priority" varchar(16) NOT NULL,
	"state" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_targets_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_targets_version_positive" CHECK ("job_targets"."version" >= 1),
	CONSTRAINT "job_targets_priority_check" CHECK ("job_targets"."priority" in ('primary', 'secondary')),
	CONSTRAINT "job_targets_state_check" CHECK ("job_targets"."state" in ('active', 'inactive'))
);
--> statement-breakpoint
ALTER TABLE "job_target_revisions" ADD CONSTRAINT "job_target_revisions_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_target_revisions" ADD CONSTRAINT "job_target_revisions_target_id_job_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."job_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_target_revisions" ADD CONSTRAINT "job_target_revisions_owner_target_fk" FOREIGN KEY ("user_id","target_id") REFERENCES "public"."job_targets"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_targets" ADD CONSTRAINT "job_targets_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_targets_active_primary_per_user_unique" ON "job_targets" USING btree ("user_id") WHERE "job_targets"."priority" = 'primary' and "job_targets"."state" = 'active';
