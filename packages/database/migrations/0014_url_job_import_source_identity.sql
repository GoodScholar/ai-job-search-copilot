ALTER TABLE "job_imports" ADD COLUMN "source_identifier" varchar(64);--> statement-breakpoint
UPDATE "job_imports" SET "source_identifier" = "content_sha256" WHERE "source_identifier" IS NULL;--> statement-breakpoint
ALTER TABLE "job_imports" ALTER COLUMN "source_identifier" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "job_imports" ADD CONSTRAINT "job_imports_source_identifier_format" CHECK ("job_imports"."source_identifier" ~ '^[0-9a-f]{64}$');
