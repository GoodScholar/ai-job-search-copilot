ALTER TABLE "job_imports" DROP CONSTRAINT "job_imports_user_content_unique";--> statement-breakpoint
ALTER TABLE "job_imports" DROP CONSTRAINT "job_imports_input_type_check";--> statement-breakpoint
ALTER TABLE "job_imports" ADD COLUMN "requested_url" varchar(2048);--> statement-breakpoint
ALTER TABLE "job_imports" ADD COLUMN "final_url" varchar(2048);--> statement-breakpoint
ALTER TABLE "job_imports" ADD COLUMN "canonical_url" varchar(2048);--> statement-breakpoint
ALTER TABLE "job_imports" ADD COLUMN "page_classification" varchar(32);--> statement-breakpoint
ALTER TABLE "job_imports" ADD COLUMN "source_kind" varchar(32);--> statement-breakpoint
ALTER TABLE "job_source_postings" ADD COLUMN "is_official" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "job_imports_user_non_url_content_unique" ON "job_imports" USING btree ("user_id","content_sha256") WHERE "job_imports"."input_type" <> 'url';--> statement-breakpoint
CREATE UNIQUE INDEX "job_imports_user_url_content_unique" ON "job_imports" USING btree ("user_id","canonical_url","content_sha256") WHERE "job_imports"."input_type" = 'url';--> statement-breakpoint
ALTER TABLE "job_imports" ADD CONSTRAINT "job_imports_url_provenance_check" CHECK (("job_imports"."input_type" = 'url') = ("job_imports"."requested_url" is not null and "job_imports"."final_url" is not null and "job_imports"."canonical_url" is not null and "job_imports"."page_classification" = 'job' and "job_imports"."source_kind" in ('official', 'aggregator')));--> statement-breakpoint
ALTER TABLE "job_imports" ADD CONSTRAINT "job_imports_input_type_check" CHECK ("job_imports"."input_type" in ('pasted_text', 'markdown_upload', 'url'));