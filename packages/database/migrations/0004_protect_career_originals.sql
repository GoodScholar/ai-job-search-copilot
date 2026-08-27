CREATE TABLE "protected_career_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"processing_document_id" uuid NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"object_key" varchar(512) NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"media_type" varchar(32) NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "protected_career_documents_derivation_unique" UNIQUE("user_id","processing_document_id","checksum_sha256"),
	CONSTRAINT "protected_career_documents_checksum_format" CHECK ("protected_career_documents"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "protected_career_documents_media_type_check" CHECK ("protected_career_documents"."media_type" = 'text/markdown'),
	CONSTRAINT "protected_career_documents_byte_size_range" CHECK ("protected_career_documents"."byte_size" between 0 and 524288)
);
--> statement-breakpoint
ALTER TABLE "career_documents" ADD COLUMN "privacy_scan_version" varchar(64);--> statement-breakpoint
ALTER TABLE "protected_career_documents" ADD CONSTRAINT "protected_career_documents_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protected_career_documents" ADD CONSTRAINT "protected_career_documents_processing_document_id_career_documents_id_fk" FOREIGN KEY ("processing_document_id") REFERENCES "public"."career_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protected_career_documents" ADD CONSTRAINT "protected_career_documents_owner_processing_fk" FOREIGN KEY ("user_id","processing_document_id") REFERENCES "public"."career_documents"("user_id","id") ON DELETE no action ON UPDATE no action;