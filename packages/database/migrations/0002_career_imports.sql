CREATE TABLE "candidate_fact_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"candidate_fact_id" uuid NOT NULL,
	"career_document_id" uuid NOT NULL,
	"locator_type" varchar(32) DEFAULT 'markdown_lines' NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"excerpt" text NOT NULL,
	"excerpt_sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_fact_evidence_fact_unique" UNIQUE("candidate_fact_id"),
	CONSTRAINT "candidate_fact_evidence_locator_type_check" CHECK ("candidate_fact_evidence"."locator_type" = 'markdown_lines'),
	CONSTRAINT "candidate_fact_evidence_start_line_check" CHECK ("candidate_fact_evidence"."start_line" >= 1),
	CONSTRAINT "candidate_fact_evidence_end_line_check" CHECK ("candidate_fact_evidence"."end_line" >= "candidate_fact_evidence"."start_line"),
	CONSTRAINT "candidate_fact_evidence_excerpt_sha256_format" CHECK ("candidate_fact_evidence"."excerpt_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "candidate_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"career_import_id" uuid NOT NULL,
	"career_document_id" uuid NOT NULL,
	"fact_key" varchar(64) NOT NULL,
	"fact_type" varchar(32) NOT NULL,
	"fact_value" jsonb NOT NULL,
	"confidence_basis_points" integer NOT NULL,
	"confirmation_status" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_facts_import_fact_key_unique" UNIQUE("career_import_id","fact_key"),
	CONSTRAINT "candidate_facts_fact_key_format" CHECK ("candidate_facts"."fact_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "candidate_facts_fact_type_check" CHECK ("candidate_facts"."fact_type" in ('experience', 'education', 'skill', 'project', 'language', 'achievement', 'certification')),
	CONSTRAINT "candidate_facts_confidence_basis_points_range" CHECK ("candidate_facts"."confidence_basis_points" between 0 and 10000),
	CONSTRAINT "candidate_facts_confirmation_status_check" CHECK ("candidate_facts"."confirmation_status" = 'pending')
);
--> statement-breakpoint
CREATE TABLE "career_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"object_key" varchar(512) NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"media_type" varchar(32) NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "career_documents_user_checksum_unique" UNIQUE("user_id","checksum_sha256"),
	CONSTRAINT "career_documents_checksum_sha256_format" CHECK ("career_documents"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "career_documents_media_type_check" CHECK ("career_documents"."media_type" = 'text/markdown'),
	CONSTRAINT "career_documents_byte_size_range" CHECK ("career_documents"."byte_size" between 0 and 524288)
);
--> statement-breakpoint
CREATE TABLE "career_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"career_document_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"parser_adapter" varchar(32) DEFAULT 'fake' NOT NULL,
	"parser_version" varchar(64) DEFAULT 'fake-career-parser-v1' NOT NULL,
	"prompt_version" varchar(64) DEFAULT 'career-import-prompt-v1' NOT NULL,
	"output_schema_version" varchar(64) DEFAULT 'career-facts-v1' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"failure_code" varchar(64),
	"originating_request_id" uuid NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "career_imports_document_versions_unique" UNIQUE("career_document_id","parser_version","prompt_version","output_schema_version"),
	CONSTRAINT "career_imports_status_check" CHECK ("career_imports"."status" in ('queued', 'processing', 'completed', 'failed')),
	CONSTRAINT "career_imports_parser_adapter_check" CHECK ("career_imports"."parser_adapter" = 'fake'),
	CONSTRAINT "career_imports_parser_version_check" CHECK ("career_imports"."parser_version" = 'fake-career-parser-v1'),
	CONSTRAINT "career_imports_prompt_version_check" CHECK ("career_imports"."prompt_version" = 'career-import-prompt-v1'),
	CONSTRAINT "career_imports_output_schema_version_check" CHECK ("career_imports"."output_schema_version" = 'career-facts-v1'),
	CONSTRAINT "career_imports_attempt_count_check" CHECK ("career_imports"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "candidate_fact_evidence" ADD CONSTRAINT "candidate_fact_evidence_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_fact_evidence" ADD CONSTRAINT "candidate_fact_evidence_candidate_fact_id_candidate_facts_id_fk" FOREIGN KEY ("candidate_fact_id") REFERENCES "public"."candidate_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_fact_evidence" ADD CONSTRAINT "candidate_fact_evidence_career_document_id_career_documents_id_fk" FOREIGN KEY ("career_document_id") REFERENCES "public"."career_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_facts" ADD CONSTRAINT "candidate_facts_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_facts" ADD CONSTRAINT "candidate_facts_career_import_id_career_imports_id_fk" FOREIGN KEY ("career_import_id") REFERENCES "public"."career_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_facts" ADD CONSTRAINT "candidate_facts_career_document_id_career_documents_id_fk" FOREIGN KEY ("career_document_id") REFERENCES "public"."career_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_documents" ADD CONSTRAINT "career_documents_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_imports" ADD CONSTRAINT "career_imports_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_imports" ADD CONSTRAINT "career_imports_career_document_id_career_documents_id_fk" FOREIGN KEY ("career_document_id") REFERENCES "public"."career_documents"("id") ON DELETE no action ON UPDATE no action;
