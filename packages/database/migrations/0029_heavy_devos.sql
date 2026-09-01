DROP INDEX IF EXISTS "job_triage_versions_owner_opportunity_created_idx";--> statement-breakpoint
ALTER TABLE "job_triage_versions" ADD COLUMN "sequence" integer;--> statement-breakpoint
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY user_id, opportunity_id ORDER BY created_at, id)::integer AS sequence
  FROM "job_triage_versions"
)
UPDATE "job_triage_versions" AS versions SET "sequence" = numbered.sequence FROM numbered WHERE versions.id = numbered.id;--> statement-breakpoint
ALTER TABLE "job_triage_versions" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "job_triage_versions_owner_opportunity_created_idx" ON "job_triage_versions" USING btree ("user_id","opportunity_id","sequence");--> statement-breakpoint
ALTER TABLE "job_triage_versions" ADD CONSTRAINT "job_triage_versions_owner_opportunity_sequence_unique" UNIQUE("user_id","opportunity_id","sequence");
