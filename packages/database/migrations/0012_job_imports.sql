CREATE TABLE "job_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"input_type" varchar(32) NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"original_filename" varchar(255),
	"status" varchar(16) DEFAULT 'imported' NOT NULL,
	"failure_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_imports_user_content_unique" UNIQUE("user_id","content_sha256"),
	CONSTRAINT "job_imports_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_imports_input_type_check" CHECK ("job_imports"."input_type" in ('pasted_text', 'markdown_upload')),
	CONSTRAINT "job_imports_status_check" CHECK ("job_imports"."status" in ('imported', 'normalizing', 'completed', 'failed')),
	CONSTRAINT "job_imports_content_sha256_format" CHECK ("job_imports"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "job_imports_filename_input_type_check" CHECK (("job_imports"."input_type" = 'markdown_upload') = ("job_imports"."original_filename" is not null))
);
--> statement-breakpoint
CREATE TABLE "job_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"source_posting_version_id" uuid NOT NULL,
	"dedup_key" varchar(64) NOT NULL,
	"company" text,
	"title" text,
	"location" text,
	"posted_at" timestamp with time zone,
	"deadline" timestamp with time zone,
	"description" text,
	"normalized_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_opportunities_user_dedup_unique" UNIQUE("user_id","dedup_key"),
	CONSTRAINT "job_opportunities_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_opportunities_dedup_key_format" CHECK ("job_opportunities"."dedup_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "job_opportunities_normalized_data_object" CHECK (jsonb_typeof("job_opportunities"."normalized_data") = 'object')
);
--> statement-breakpoint
CREATE TABLE "job_opportunity_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"source_posting_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_opportunity_sources_opportunity_version_unique" UNIQUE("opportunity_id","source_posting_version_id"),
	CONSTRAINT "job_opportunity_sources_user_id_id_unique" UNIQUE("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "job_source_posting_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_posting_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"raw_object_reference" jsonb NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_source_posting_versions_posting_version_unique" UNIQUE("source_posting_id","version"),
	CONSTRAINT "job_source_posting_versions_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_source_posting_versions_version_positive" CHECK ("job_source_posting_versions"."version" >= 1),
	CONSTRAINT "job_source_posting_versions_content_sha256_format" CHECK ("job_source_posting_versions"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "job_source_posting_versions_raw_object_reference_object" CHECK (jsonb_typeof("job_source_posting_versions"."raw_object_reference") = 'object')
);
--> statement-breakpoint
CREATE TABLE "job_source_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_type" varchar(32) NOT NULL,
	"source_identifier" varchar(512) NOT NULL,
	"source_identity" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_source_postings_user_identity_unique" UNIQUE("user_id","source_type","source_identifier"),
	CONSTRAINT "job_source_postings_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "job_source_postings_source_identity_object" CHECK (jsonb_typeof("job_source_postings"."source_identity") = 'object')
);
--> statement-breakpoint
ALTER TABLE "job_imports" ADD CONSTRAINT "job_imports_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_opportunities" ADD CONSTRAINT "job_opportunities_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_opportunities" ADD CONSTRAINT "job_opportunities_import_id_job_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."job_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_opportunities" ADD CONSTRAINT "job_opportunities_source_posting_version_id_job_source_posting_versions_id_fk" FOREIGN KEY ("source_posting_version_id") REFERENCES "public"."job_source_posting_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_opportunities" ADD CONSTRAINT "job_opportunities_owner_import_fk" FOREIGN KEY ("user_id","import_id") REFERENCES "public"."job_imports"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_opportunities" ADD CONSTRAINT "job_opportunities_owner_posting_version_fk" FOREIGN KEY ("user_id","source_posting_version_id") REFERENCES "public"."job_source_posting_versions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_opportunity_sources" ADD CONSTRAINT "job_opportunity_sources_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_opportunity_sources" ADD CONSTRAINT "job_opportunity_sources_opportunity_id_job_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."job_opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_opportunity_sources" ADD CONSTRAINT "job_opportunity_sources_source_posting_version_id_job_source_posting_versions_id_fk" FOREIGN KEY ("source_posting_version_id") REFERENCES "public"."job_source_posting_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_opportunity_sources" ADD CONSTRAINT "job_opportunity_sources_owner_opportunity_fk" FOREIGN KEY ("user_id","opportunity_id") REFERENCES "public"."job_opportunities"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_opportunity_sources" ADD CONSTRAINT "job_opportunity_sources_owner_posting_version_fk" FOREIGN KEY ("user_id","source_posting_version_id") REFERENCES "public"."job_source_posting_versions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_source_posting_versions" ADD CONSTRAINT "job_source_posting_versions_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_source_posting_versions" ADD CONSTRAINT "job_source_posting_versions_source_posting_id_job_source_postings_id_fk" FOREIGN KEY ("source_posting_id") REFERENCES "public"."job_source_postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_source_posting_versions" ADD CONSTRAINT "job_source_posting_versions_owner_posting_fk" FOREIGN KEY ("user_id","source_posting_id") REFERENCES "public"."job_source_postings"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_source_postings" ADD CONSTRAINT "job_source_postings_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;
