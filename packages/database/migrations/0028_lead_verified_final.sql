ALTER TABLE "job_discovery_leads" DROP CONSTRAINT "job_discovery_leads_outcome_check";--> statement-breakpoint
ALTER TABLE "job_discovery_leads" ADD COLUMN "verified_final_url" varchar(2048);--> statement-breakpoint
UPDATE "job_discovery_leads" AS lead
SET "verified_final_url" = posting."source_identity" ->> 'finalUrl'
FROM "job_discovery_attributions" AS attribution
INNER JOIN "job_source_posting_versions" AS version
  ON version."user_id" = attribution."user_id" AND version."id" = attribution."source_posting_version_id"
INNER JOIN "job_source_postings" AS posting
  ON posting."user_id" = version."user_id" AND posting."id" = version."source_posting_id"
WHERE lead."state" = 'verified'
  AND attribution."user_id" = lead."user_id"
  AND attribution."lead_id" = lead."id"
  AND attribution."source_posting_version_id" = lead."source_posting_version_id";--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "job_discovery_leads"
    WHERE "state" = 'verified'
      AND ("verified_final_url" IS NULL OR length("verified_final_url") NOT BETWEEN 1 AND 2048)
  ) THEN RAISE EXCEPTION 'verified lead final fact missing'; END IF;
END $$;--> statement-breakpoint
ALTER TABLE "job_discovery_leads" ADD CONSTRAINT "job_discovery_leads_verified_final_url_length_check" CHECK ("job_discovery_leads"."verified_final_url" is null or length("job_discovery_leads"."verified_final_url") between 1 and 2048);--> statement-breakpoint
ALTER TABLE "job_discovery_leads" ADD CONSTRAINT "job_discovery_leads_outcome_check" CHECK (
    ("job_discovery_leads"."state" = 'pending' and "job_discovery_leads"."source_posting_version_id" is null and "job_discovery_leads"."verified_final_url" is null and "job_discovery_leads"."rejection_code" is null)
    or ("job_discovery_leads"."state" = 'verified' and "job_discovery_leads"."source_posting_version_id" is not null and "job_discovery_leads"."verified_final_url" is not null and "job_discovery_leads"."rejection_code" is null)
    or ("job_discovery_leads"."state" = 'rejected' and "job_discovery_leads"."source_posting_version_id" is null and "job_discovery_leads"."verified_final_url" is null and "job_discovery_leads"."rejection_code" is not null)
  );
