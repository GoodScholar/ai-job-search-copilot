ALTER TABLE "job_discovery_leads" DROP CONSTRAINT "job_discovery_leads_outcome_check";--> statement-breakpoint
ALTER TABLE "job_discovery_leads" ADD COLUMN "verified_final_url" varchar(2048);--> statement-breakpoint
UPDATE "job_discovery_leads" AS lead
SET "verified_final_url" = CASE
  WHEN jsonb_typeof(posting."source_identity" -> 'observedFinalUrls') = 'object'
    THEN posting."source_identity" -> 'observedFinalUrls' ->> lead."normalized_url"
  WHEN jsonb_typeof(posting."source_identity" -> 'finalUrls') = 'array'
    AND jsonb_array_length(posting."source_identity" -> 'finalUrls') <= 1
    THEN posting."source_identity" ->> 'finalUrl'
  WHEN posting."source_identity" ? 'observedFinalUrls' THEN NULL
  WHEN posting."source_identity" ? 'finalUrls' THEN NULL
  ELSE posting."source_identity" ->> 'finalUrl'
END
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
      AND (
        "verified_final_url" IS NULL
        OR length("verified_final_url") NOT BETWEEN 1 AND 2048
        OR "verified_final_url" !~* '^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\:[1-9][0-9]{0,4})?(?:/[^?#]*)?(?:\?(?:(?:id|job|jobid|job_id|openingid|opening_id|positionid|position_id|requisitionid|requisition_id)=[A-Za-z0-9._~-]{1,128}(?:&(?:id|job|jobid|job_id|openingid|opening_id|positionid|position_id|requisitionid|requisition_id)=[A-Za-z0-9._~-]{1,128})*)?)?$'
        OR "verified_final_url" ~* '^https://(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::|/|\?|$)'
      )
  ) THEN RAISE EXCEPTION 'verified lead final fact missing'; END IF;
END $$;--> statement-breakpoint
ALTER TABLE "job_discovery_leads" ADD CONSTRAINT "job_discovery_leads_verified_final_url_length_check" CHECK ("job_discovery_leads"."verified_final_url" is null or length("job_discovery_leads"."verified_final_url") between 1 and 2048);--> statement-breakpoint
UPDATE "job_source_postings" AS posting
SET "source_identity" = rebuilt."identity"
FROM (
  SELECT posting_inner."user_id", posting_inner."id", jsonb_build_object(
    'taxonomyPolicy', 'public-job-source-taxonomy-v1',
    'canonicalUrl', posting_inner."source_identity" ->> 'canonicalUrl',
    'finalUrl', min(lead."verified_final_url"),
    'finalUrls', jsonb_agg(DISTINCT lead."verified_final_url" ORDER BY lead."verified_final_url")
  ) AS "identity"
  FROM "job_source_postings" AS posting_inner
  INNER JOIN "job_source_posting_versions" AS version_inner
    ON version_inner."user_id" = posting_inner."user_id" AND version_inner."source_posting_id" = posting_inner."id"
  INNER JOIN "job_discovery_attributions" AS attribution_inner
    ON attribution_inner."user_id" = version_inner."user_id" AND attribution_inner."source_posting_version_id" = version_inner."id"
  INNER JOIN "job_discovery_leads" AS lead
    ON lead."user_id" = attribution_inner."user_id" AND lead."id" = attribution_inner."lead_id" AND lead."state" = 'verified'
  GROUP BY posting_inner."user_id", posting_inner."id", posting_inner."source_identity" ->> 'canonicalUrl'
) AS rebuilt
WHERE posting."user_id" = rebuilt."user_id" AND posting."id" = rebuilt."id";--> statement-breakpoint
ALTER TABLE "job_discovery_leads" ADD CONSTRAINT "job_discovery_leads_outcome_check" CHECK (
    ("job_discovery_leads"."state" = 'pending' and "job_discovery_leads"."source_posting_version_id" is null and "job_discovery_leads"."verified_final_url" is null and "job_discovery_leads"."rejection_code" is null)
    or ("job_discovery_leads"."state" = 'verified' and "job_discovery_leads"."source_posting_version_id" is not null and "job_discovery_leads"."verified_final_url" is not null and "job_discovery_leads"."rejection_code" is null)
    or ("job_discovery_leads"."state" = 'rejected' and "job_discovery_leads"."source_posting_version_id" is null and "job_discovery_leads"."verified_final_url" is null and "job_discovery_leads"."rejection_code" is not null)
  );
