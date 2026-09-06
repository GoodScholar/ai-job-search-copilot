CREATE TABLE "first_recommendation_journey_completions" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "result_kind" varchar(32) NOT NULL,
  "result_id" uuid NOT NULL,
  "completed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "first_recommendation_journey_completions_result_kind_check" CHECK ("result_kind" in ('recommendation_list', 'no_recommendations'))
);
--> statement-breakpoint
CREATE TABLE "first_recommendation_journey_interactions" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "dismissed_at" timestamp with time zone,
  "last_visited_step" varchar(32),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "first_recommendation_journey_interactions_version_nonnegative" CHECK ("version" >= 0),
  CONSTRAINT "first_recommendation_journey_interactions_last_visited_step_check" CHECK ("last_visited_step" is null or "last_visited_step" in ('career_materials', 'profile_evidence', 'primary_target', 'job_sources', 'run_readiness', 'first_result'))
);
--> statement-breakpoint
ALTER TABLE "first_recommendation_journey_completions" ADD CONSTRAINT "first_recommendation_journey_completions_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "first_recommendation_journey_interactions" ADD CONSTRAINT "first_recommendation_journey_interactions_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "first_recommendation_journey_completions" ("user_id", "result_kind", "result_id", "completed_at")
SELECT DISTINCT ON (lists.user_id)
  lists.user_id, 'recommendation_list', lists.id, lists.created_at
FROM "recommendation_lists" AS lists
WHERE EXISTS (
  SELECT 1
  FROM "recommendation_list_items" AS items
  WHERE items.user_id = lists.user_id
    AND items.recommendation_list_id = lists.id
)
ORDER BY lists.user_id, lists.created_at, lists.sequence, lists.id;--> statement-breakpoint
CREATE FUNCTION reject_first_recommendation_journey_completion_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'FIRST_RECOMMENDATION_JOURNEY_COMPLETION_IMMUTABLE';
END;
$$;--> statement-breakpoint
CREATE TRIGGER first_recommendation_journey_completions_immutable
BEFORE UPDATE OR DELETE ON "first_recommendation_journey_completions"
FOR EACH ROW
EXECUTE FUNCTION reject_first_recommendation_journey_completion_mutation();
--> statement-breakpoint
CREATE FUNCTION validate_first_recommendation_journey_completion_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.result_kind = 'recommendation_list' AND NOT EXISTS (
    SELECT 1 FROM recommendation_lists AS lists
    WHERE lists.user_id = NEW.user_id AND lists.id = NEW.result_id
  ) THEN
    RAISE EXCEPTION 'FIRST_RECOMMENDATION_JOURNEY_COMPLETION_RESULT_NOT_OWNED'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER first_recommendation_journey_completions_result_owned
BEFORE INSERT ON "first_recommendation_journey_completions"
FOR EACH ROW
EXECUTE FUNCTION validate_first_recommendation_journey_completion_result();
