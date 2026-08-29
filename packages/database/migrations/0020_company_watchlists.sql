CREATE TABLE "company_watchlist_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"watchlist_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_watchlist_revisions_watchlist_version_unique" UNIQUE("watchlist_id","version"),
	CONSTRAINT "company_watchlist_revisions_version_positive" CHECK ("company_watchlist_revisions"."version" >= 1),
	CONSTRAINT "company_watchlist_revisions_items_array" CHECK (jsonb_typeof("company_watchlist_revisions"."items") = 'array')
);
--> statement-breakpoint
CREATE TABLE "company_watchlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_watchlists_user_target_unique" UNIQUE("user_id","target_id"),
	CONSTRAINT "company_watchlists_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "company_watchlists_user_watchlist_target_unique" UNIQUE("user_id","id","target_id"),
	CONSTRAINT "company_watchlists_version_positive" CHECK ("company_watchlists"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "company_watchlist_revisions" ADD CONSTRAINT "company_watchlist_revisions_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_watchlist_revisions" ADD CONSTRAINT "company_watchlist_revisions_watchlist_target_fk" FOREIGN KEY ("user_id","watchlist_id","target_id") REFERENCES "public"."company_watchlists"("user_id","id","target_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_watchlist_revisions" ADD CONSTRAINT "company_watchlist_revisions_owner_target_fk" FOREIGN KEY ("user_id","target_id") REFERENCES "public"."job_targets"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_watchlists" ADD CONSTRAINT "company_watchlists_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_watchlists" ADD CONSTRAINT "company_watchlists_target_id_job_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."job_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_watchlists" ADD CONSTRAINT "company_watchlists_owner_target_fk" FOREIGN KEY ("user_id","target_id") REFERENCES "public"."job_targets"("user_id","id") ON DELETE no action ON UPDATE no action;
