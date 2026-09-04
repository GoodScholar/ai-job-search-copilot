ALTER TABLE "agent_inbox_items" DROP CONSTRAINT "agent_inbox_items_status_check";--> statement-breakpoint
ALTER TABLE "agent_inbox_items" DROP CONSTRAINT "agent_inbox_items_resolved_check";--> statement-breakpoint
ALTER TABLE "agent_inbox_items" DROP CONSTRAINT "agent_inbox_items_kind_check";--> statement-breakpoint
ALTER TABLE "agent_inbox_items" DROP CONSTRAINT "agent_inbox_items_reason_check";--> statement-breakpoint
ALTER TABLE "agent_inbox_items" DROP CONSTRAINT IF EXISTS "agent_inbox_items_kind_reason_pair_check";--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ALTER COLUMN "trigger_event_sequence" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD COLUMN "candidate_fact_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD COLUMN "watchlist_item_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD COLUMN "source_health_check_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD COLUMN "recommendation_list_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD COLUMN "calibration_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ALTER COLUMN "status" SET DEFAULT 'unread';--> statement-breakpoint
UPDATE "agent_inbox_items" SET "status" = 'unread' WHERE "status" = 'open';--> statement-breakpoint
WITH source_items AS (
  SELECT "id", "user_id", "run_id", row_number() OVER (PARTITION BY "user_id", "run_id" ORDER BY "created_at", "id") AS ordinal
  FROM "agent_inbox_items"
  WHERE "kind" = 'source_attention'
), source_checks AS (
  SELECT "id", "user_id", "run_id", "watchlist_item_id", row_number() OVER (PARTITION BY "user_id", "run_id" ORDER BY "checked_at", "id") AS ordinal
  FROM "job_source_health_checks"
  WHERE "status" in ('parser_degraded', 'rate_limited', 'hard_failed')
)
UPDATE "agent_inbox_items" AS item
SET "watchlist_item_id" = source_checks."watchlist_item_id", "source_health_check_id" = source_checks."id"
FROM source_items
JOIN source_checks ON source_checks."user_id" = source_items."user_id" AND source_checks."run_id" = source_items."run_id" AND source_checks.ordinal = 1
WHERE item."id" = source_items."id" AND source_items.ordinal = 1;--> statement-breakpoint
WITH source_items AS (
  SELECT "id", "user_id", "run_id", row_number() OVER (PARTITION BY "user_id", "run_id" ORDER BY "created_at", "id") AS ordinal
  FROM "agent_inbox_items"
  WHERE "kind" = 'source_attention'
), source_checks AS (
  SELECT "id", "user_id", "run_id", "watchlist_item_id", row_number() OVER (PARTITION BY "user_id", "run_id" ORDER BY "checked_at", "id") AS ordinal
  FROM "job_source_health_checks"
  WHERE "status" in ('parser_degraded', 'rate_limited', 'hard_failed')
)
INSERT INTO "agent_inbox_items" ("id", "user_id", "run_id", "trigger_event_sequence", "watchlist_item_id", "source_health_check_id", "kind", "status", "reason_code", "budget_dimension", "created_at", "read_at", "resolved_at")
SELECT gen_random_uuid(), item."user_id", item."run_id", null, source_checks."watchlist_item_id", source_checks."id", item."kind", item."status", item."reason_code", item."budget_dimension", item."created_at", item."read_at", item."resolved_at"
FROM "agent_inbox_items" AS item
JOIN source_items ON source_items."id" = item."id" AND source_items.ordinal = 1
JOIN source_checks ON source_checks."user_id" = source_items."user_id" AND source_checks."run_id" = source_items."run_id" AND source_checks.ordinal > 1;--> statement-breakpoint
UPDATE "agent_inbox_items"
SET "kind" = 'discovery_attention', "reason_code" = 'DISCOVERY_ATTENTION'
WHERE "kind" = 'source_attention' AND "source_health_check_id" IS NULL;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_kind_check" CHECK ("agent_inbox_items"."kind" in ('run_failed', 'budget_exhausted', 'decision_required', 'source_attention', 'discovery_attention', 'candidate_fact', 'recommendation_list', 'calibration_proposal'));--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_status_check" CHECK ("agent_inbox_items"."status" in ('unread', 'read', 'resolved'));--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_reason_check" CHECK ("agent_inbox_items"."reason_code" in ('AGENT_RUN_PAUSED', 'SOURCE_HEALTH_ATTENTION', 'DISCOVERY_ATTENTION', 'CANDIDATE_FACT_PENDING', 'RECOMMENDATION_LIST_PUBLISHED', 'CALIBRATION_PROPOSAL_CREATED', 'AGENT_RUN_ADAPTER_RETRYABLE', 'AGENT_RUN_ADAPTER_FAILED', 'AGENT_RUN_CONTENT_STORAGE_FAILED', 'AGENT_RUN_PERSIST_FAILED', 'AGENT_RUN_BUDGET_EXCEEDED', 'AGENT_RUN_MODEL_RETRYABLE', 'AGENT_RUN_MODEL_AUTH_FAILED', 'AGENT_RUN_MODEL_POLICY_REJECTED', 'AGENT_RUN_MODEL_INVALID_RESPONSE'));--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_kind_reason_pair_check" CHECK (("agent_inbox_items"."kind" = 'source_attention') = ("agent_inbox_items"."reason_code" = 'SOURCE_HEALTH_ATTENTION') and ("agent_inbox_items"."kind" = 'discovery_attention') = ("agent_inbox_items"."reason_code" = 'DISCOVERY_ATTENTION') and ("agent_inbox_items"."kind" = 'candidate_fact') = ("agent_inbox_items"."reason_code" = 'CANDIDATE_FACT_PENDING') and ("agent_inbox_items"."kind" = 'recommendation_list') = ("agent_inbox_items"."reason_code" = 'RECOMMENDATION_LIST_PUBLISHED') and ("agent_inbox_items"."kind" = 'calibration_proposal') = ("agent_inbox_items"."reason_code" = 'CALIBRATION_PROPOSAL_CREATED'));--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_lifecycle_check" CHECK (("status" = 'unread' and "read_at" is null and "resolved_at" is null) or ("status" = 'read' and "read_at" is not null and "resolved_at" is null and "read_at" >= "created_at") or ("status" = 'resolved' and "resolved_at" is not null and "resolved_at" >= "created_at" and ("read_at" is null or ("read_at" >= "created_at" and "resolved_at" >= "read_at"))));--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_reference_combination_check" CHECK (("kind" in ('run_failed', 'budget_exhausted', 'decision_required', 'discovery_attention') and "run_id" is not null and "trigger_event_sequence" is not null and "candidate_fact_id" is null and "watchlist_item_id" is null and "source_health_check_id" is null and "recommendation_list_id" is null and "calibration_proposal_id" is null) or ("kind" = 'source_attention' and "run_id" is not null and "watchlist_item_id" is not null and "source_health_check_id" is not null and "candidate_fact_id" is null and "recommendation_list_id" is null and "calibration_proposal_id" is null) or ("kind" = 'candidate_fact' and "run_id" is null and "trigger_event_sequence" is null and "candidate_fact_id" is not null and "watchlist_item_id" is null and "source_health_check_id" is null and "recommendation_list_id" is null and "calibration_proposal_id" is null) or ("kind" = 'recommendation_list' and "run_id" is null and "trigger_event_sequence" is null and "candidate_fact_id" is null and "watchlist_item_id" is null and "source_health_check_id" is null and "recommendation_list_id" is not null and "calibration_proposal_id" is null) or ("kind" = 'calibration_proposal' and "run_id" is null and "trigger_event_sequence" is null and "candidate_fact_id" is null and "watchlist_item_id" is null and "source_health_check_id" is null and "recommendation_list_id" is null and "calibration_proposal_id" is not null));--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_candidate_fact_id_candidate_facts_id_fk" FOREIGN KEY ("candidate_fact_id") REFERENCES "public"."candidate_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.recommendation_lists') IS NOT NULL THEN
    ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_recommendation_list_id_recommendation_lists_id_fk" FOREIGN KEY ("recommendation_list_id") REFERENCES "public"."recommendation_lists"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calibration_proposals') IS NOT NULL THEN
    ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_calibration_proposal_id_calibration_proposals_id_fk" FOREIGN KEY ("calibration_proposal_id") REFERENCES "public"."calibration_proposals"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_owner_candidate_fact_fk" FOREIGN KEY ("user_id", "candidate_fact_id") REFERENCES "public"."candidate_facts"("user_id", "id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.recommendation_lists') IS NOT NULL THEN
    ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_owner_recommendation_list_fk" FOREIGN KEY ("user_id", "recommendation_list_id") REFERENCES "public"."recommendation_lists"("user_id", "id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calibration_proposals') IS NOT NULL THEN
    ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_owner_calibration_proposal_fk" FOREIGN KEY ("user_id", "calibration_proposal_id") REFERENCES "public"."calibration_proposals"("user_id", "id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "job_source_health_checks" ADD CONSTRAINT "job_source_health_checks_user_run_watchlist_id_unique" UNIQUE ("user_id", "run_id", "watchlist_item_id", "id");--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_owner_source_health_check_fk" FOREIGN KEY ("user_id", "run_id", "watchlist_item_id", "source_health_check_id") REFERENCES "public"."job_source_health_checks"("user_id", "run_id", "watchlist_item_id", "id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbox_items_candidate_fact_unique_idx" ON "agent_inbox_items" USING btree ("candidate_fact_id") WHERE "candidate_fact_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbox_items_recommendation_list_unique_idx" ON "agent_inbox_items" USING btree ("recommendation_list_id") WHERE "recommendation_list_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbox_items_calibration_proposal_unique_idx" ON "agent_inbox_items" USING btree ("calibration_proposal_id") WHERE "calibration_proposal_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbox_items_source_run_source_health_check_unique_idx" ON "agent_inbox_items" USING btree ("run_id", "source_health_check_id") WHERE "kind" = 'source_attention';--> statement-breakpoint
ALTER TABLE "agent_inbox_item_actions" DROP CONSTRAINT "agent_inbox_item_actions_action_check";--> statement-breakpoint
ALTER TABLE "agent_inbox_item_actions" ADD CONSTRAINT "agent_inbox_item_actions_action_check" CHECK ("agent_inbox_item_actions"."action" in ('restart_run', 'resume_run', 'cancel_run', 'mark_read', 'dismiss'));
