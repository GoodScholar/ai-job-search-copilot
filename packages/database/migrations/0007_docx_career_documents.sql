ALTER TABLE "career_documents" ADD COLUMN "source_format" varchar(16) DEFAULT 'markdown' NOT NULL;--> statement-breakpoint
ALTER TABLE "career_documents" DROP CONSTRAINT "career_documents_user_checksum_unique";--> statement-breakpoint
ALTER TABLE "career_documents" ADD CONSTRAINT "career_documents_user_checksum_source_format_unique" UNIQUE("user_id","checksum_sha256","source_format");--> statement-breakpoint
ALTER TABLE "career_documents" DROP CONSTRAINT "career_documents_media_type_check";--> statement-breakpoint
ALTER TABLE "career_documents" ADD CONSTRAINT "career_documents_media_type_check" CHECK ("career_documents"."media_type" in ('text/markdown', 'text/plain'));--> statement-breakpoint
ALTER TABLE "career_documents" ADD CONSTRAINT "career_documents_source_format_check" CHECK ("career_documents"."source_format" in ('markdown', 'docx'));--> statement-breakpoint
ALTER TABLE "protected_career_documents" DROP CONSTRAINT "protected_career_documents_media_type_check";--> statement-breakpoint
ALTER TABLE "protected_career_documents" ADD CONSTRAINT "protected_career_documents_media_type_check" CHECK ("protected_career_documents"."media_type" in ('text/markdown', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));--> statement-breakpoint
ALTER TABLE "candidate_fact_evidence" DROP CONSTRAINT "candidate_fact_evidence_locator_type_check";--> statement-breakpoint
ALTER TABLE "candidate_fact_evidence" ADD CONSTRAINT "candidate_fact_evidence_locator_type_check" CHECK ("candidate_fact_evidence"."locator_type" in ('markdown_lines', 'docx_paragraphs'));
