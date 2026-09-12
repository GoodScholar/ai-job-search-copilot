ALTER TABLE "agent_runs" ADD COLUMN "parent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "run_purpose" varchar(32);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "recommendation_context" jsonb;--> statement-breakpoint
UPDATE "agent_runs"
SET "run_purpose" = CASE
  WHEN "workflow_version" = 'deep-match-v1' AND "source_scope" ->> 'trigger' = 'manual' THEN 'opportunity_reevaluation'
  ELSE 'job_discovery'
END;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "run_purpose" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "run_purpose" SET DEFAULT 'job_discovery';--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_purpose_check" CHECK ("run_purpose" in ('job_discovery', 'opportunity_reevaluation', 'recommendation'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_owner_parent_target_fk" FOREIGN KEY ("user_id", "parent_run_id", "target_id") REFERENCES "agent_runs"("user_id", "id", "target_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_parent_not_self_check" CHECK ("parent_run_id" is null or "parent_run_id" <> "id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_recommendation_context_check" CHECK (
  ("run_purpose" <> 'recommendation' AND "recommendation_context" is null)
  OR ("run_purpose" = 'recommendation' AND "parent_run_id" is null
    AND "recommendation_context" IS NOT NULL
    AND jsonb_typeof("recommendation_context") = 'object'
    AND "recommendation_context" ?& array['version', 'profile', 'budgets', 'preflight', 'accountPolicyRevisionNumber']
    AND "recommendation_context" ->> 'version' = 'recommendation-context-v1'
    AND jsonb_typeof("recommendation_context" -> 'profile') = 'object'
    AND "recommendation_context" -> 'profile' ?& array['profileId', 'profileVersion']
    AND jsonb_typeof("recommendation_context" -> 'budgets') = 'object'
    AND "recommendation_context" -> 'budgets' ?& array['discovery', 'deepMatch']
    AND jsonb_typeof("recommendation_context" -> 'preflight') = 'object'
    AND octet_length("recommendation_context"::text) <= 32768)
  OR ("run_purpose" = 'recommendation' AND "parent_run_id" is not null AND "recommendation_context" is null)
);--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_recommendation_child_parent_unique" ON "agent_runs" ("parent_run_id") WHERE "run_purpose" = 'recommendation' AND "parent_run_id" is not null;--> statement-breakpoint

CREATE FUNCTION validate_recommendation_run_topology()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_purpose varchar(32);
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.run_purpose = 'recommendation' AND (
    NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.target_id IS DISTINCT FROM OLD.target_id
    OR NEW.run_purpose IS DISTINCT FROM OLD.run_purpose
    OR NEW.parent_run_id IS DISTINCT FROM OLD.parent_run_id
    OR NEW.workflow_version IS DISTINCT FROM OLD.workflow_version
    OR NEW.source_scope IS DISTINCT FROM OLD.source_scope
    OR NEW.recommendation_context IS DISTINCT FROM OLD.recommendation_context
  ) THEN
    RAISE EXCEPTION 'RECOMMENDATION_RUN_IDENTITY_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.run_purpose <> 'recommendation' THEN RETURN NEW; END IF;
  IF NEW.parent_run_id IS NULL THEN
    IF NEW.workflow_version <> 'layered-public-job-discovery-v1' THEN
      RAISE EXCEPTION 'RECOMMENDATION_ROOT_WORKFLOW_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.workflow_version <> 'deep-match-v1' OR NEW.source_scope ->> 'trigger' IS DISTINCT FROM 'automatic' THEN
    RAISE EXCEPTION 'RECOMMENDATION_CHILD_WORKFLOW_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  SELECT run_purpose INTO parent_purpose FROM agent_runs
  WHERE id = NEW.parent_run_id AND user_id = NEW.user_id AND target_id = NEW.target_id;
  IF parent_purpose IS DISTINCT FROM 'recommendation' THEN
    RAISE EXCEPTION 'RECOMMENDATION_PARENT_INVALID' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;$$;--> statement-breakpoint
CREATE TRIGGER agent_runs_recommendation_topology
BEFORE INSERT OR UPDATE OF "user_id", "target_id", "run_purpose", "parent_run_id", "workflow_version", "source_scope", "recommendation_context" ON "agent_runs"
FOR EACH ROW EXECUTE FUNCTION validate_recommendation_run_topology();--> statement-breakpoint

CREATE TABLE "recommendation_run_start_commands" (
  "user_id" uuid NOT NULL, "idempotency_key" uuid NOT NULL, "root_run_id" uuid NOT NULL,
  "command_fingerprint" varchar(64) NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recommendation_run_start_commands_user_key_pk" PRIMARY KEY ("user_id", "idempotency_key"),
  CONSTRAINT "recommendation_run_start_commands_fingerprint_check" CHECK ("command_fingerprint" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
ALTER TABLE "recommendation_run_start_commands" ADD CONSTRAINT "recommendation_run_start_commands_owner_root_fk" FOREIGN KEY ("user_id", "root_run_id") REFERENCES "agent_runs"("user_id", "id");--> statement-breakpoint

CREATE TABLE "recommendation_run_control_commands" (
  "user_id" uuid NOT NULL, "root_run_id" uuid NOT NULL, "command_id" uuid NOT NULL, "physical_run_id" uuid NOT NULL,
  "action" varchar(16) NOT NULL, "command_fingerprint" varchar(64) NOT NULL, "result_snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recommendation_run_control_commands_pk" PRIMARY KEY ("user_id", "root_run_id", "command_id"),
  CONSTRAINT "recommendation_run_control_commands_action_check" CHECK ("action" in ('pause', 'resume', 'cancel')),
  CONSTRAINT "recommendation_run_control_commands_fingerprint_check" CHECK ("command_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "recommendation_run_control_commands_snapshot_check" CHECK (
    jsonb_typeof("result_snapshot") = 'object'
    AND "result_snapshot" ?& array['runId', 'status', 'currentStep', 'controlState', 'version']
    AND ("result_snapshot" - array['runId', 'status', 'currentStep', 'controlState', 'version']) = '{}'::jsonb
    AND "result_snapshot" -> 'runId' = to_jsonb("physical_run_id"::text)
    AND "result_snapshot" ->> 'status' in ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')
    AND "result_snapshot" ->> 'currentStep' in ('queued', 'batch_search', 'fetch_details', 'persist_results', 'select_candidates', 'assess_matches', 'create_recommendations', 'completed', 'failed', 'cancelled')
    AND ("result_snapshot" ->> 'status' = 'cancelled') = ("result_snapshot" ->> 'currentStep' = 'cancelled')
    AND "result_snapshot" ->> 'controlState' in ('none', 'pause_requested', 'cancel_requested')
    AND jsonb_typeof("result_snapshot" -> 'version') = 'number'
  )
);--> statement-breakpoint
ALTER TABLE "recommendation_run_control_commands" ADD CONSTRAINT "recommendation_run_control_commands_owner_root_fk" FOREIGN KEY ("user_id", "root_run_id") REFERENCES "agent_runs"("user_id", "id");--> statement-breakpoint
ALTER TABLE "recommendation_run_control_commands" ADD CONSTRAINT "recommendation_run_control_commands_owner_physical_fk" FOREIGN KEY ("user_id", "physical_run_id") REFERENCES "agent_runs"("user_id", "id");--> statement-breakpoint

ALTER TABLE "agent_run_control_commands" DROP CONSTRAINT "agent_run_control_commands_result_snapshot_check";--> statement-breakpoint
ALTER TABLE "agent_run_control_commands" ADD CONSTRAINT "agent_run_control_commands_result_snapshot_check" CHECK (
  "result_snapshot" ?& array['runId', 'status', 'currentStep', 'controlState', 'version']
  and ("result_snapshot" - array['runId', 'status', 'currentStep', 'controlState', 'version']) = '{}'::jsonb
  and jsonb_typeof("result_snapshot" -> 'runId') = 'string'
  and "result_snapshot" -> 'runId' = to_jsonb("run_id"::text)
  and jsonb_typeof("result_snapshot" -> 'status') = 'string'
  and "result_snapshot" ->> 'status' in ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')
  and jsonb_typeof("result_snapshot" -> 'currentStep') = 'string'
  and "result_snapshot" ->> 'currentStep' in ('queued', 'batch_search', 'fetch_details', 'persist_results', 'select_candidates', 'assess_matches', 'create_recommendations', 'completed', 'failed', 'cancelled')
  and (("result_snapshot" ->> 'status' = 'cancelled') = ("result_snapshot" ->> 'currentStep' = 'cancelled'))
  and jsonb_typeof("result_snapshot" -> 'controlState') = 'string'
  and "result_snapshot" ->> 'controlState' in ('none', 'pause_requested', 'cancel_requested')
  and jsonb_typeof("result_snapshot" -> 'version') = 'number'
  and "result_snapshot" -> 'version' = to_jsonb("result_run_version")
);--> statement-breakpoint

ALTER TABLE "recommendation_lists" ADD CONSTRAINT "recommendation_lists_user_id_id_target_id_unique" UNIQUE ("user_id", "id", "target_id");--> statement-breakpoint
CREATE TABLE "recommendation_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "user_id" uuid NOT NULL, "target_id" uuid NOT NULL,
  "root_run_id" uuid NOT NULL, "producer_run_id" uuid NOT NULL, "kind" varchar(32) NOT NULL, "recommendation_list_id" uuid,
  "item_count" integer NOT NULL, "evidence" jsonb NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recommendation_results_user_id_id_unique" UNIQUE("user_id", "id"),
  CONSTRAINT "recommendation_results_owner_root_unique" UNIQUE("user_id", "root_run_id"),
  CONSTRAINT "recommendation_results_owner_producer_unique" UNIQUE("user_id", "producer_run_id"),
  CONSTRAINT "recommendation_results_kind_check" CHECK ("kind" in ('recommendation_list', 'no_recommendations')),
  CONSTRAINT "recommendation_results_evidence_object" CHECK (
    jsonb_typeof("evidence") = 'object'
    AND octet_length("evidence"::text) <= 32768
    AND "evidence" ?& array['discovery', 'sourceCoverage', 'coverageLosses', 'qualification', 'coarseRanking', 'deepMatching', 'suggestedActions']
    AND ("evidence" - array['discovery', 'sourceCoverage', 'coverageLosses', 'qualification', 'coarseRanking', 'deepMatching', 'suggestedActions']) = '{}'::jsonb
    AND jsonb_typeof("evidence" -> 'discovery') = 'object'
    AND jsonb_typeof("evidence" -> 'sourceCoverage') = 'object'
    AND jsonb_typeof("evidence" -> 'coverageLosses') = 'array'
    AND jsonb_typeof("evidence" -> 'qualification') = 'object'
    AND jsonb_typeof("evidence" -> 'coarseRanking') = 'object'
    AND jsonb_typeof("evidence" -> 'deepMatching') = 'object'
    AND jsonb_typeof("evidence" -> 'suggestedActions') = 'array'
  ),
  CONSTRAINT "recommendation_results_kind_shape_check" CHECK (("kind" = 'recommendation_list' and "id" = "recommendation_list_id" and "item_count" > 0) or ("kind" = 'no_recommendations' and "recommendation_list_id" is null and "item_count" = 0))
);--> statement-breakpoint
ALTER TABLE "recommendation_results" ADD CONSTRAINT "recommendation_results_owner_target_fk" FOREIGN KEY ("user_id", "target_id") REFERENCES "job_targets"("user_id", "id");--> statement-breakpoint
ALTER TABLE "recommendation_results" ADD CONSTRAINT "recommendation_results_owner_root_target_fk" FOREIGN KEY ("user_id", "root_run_id", "target_id") REFERENCES "agent_runs"("user_id", "id", "target_id");--> statement-breakpoint
ALTER TABLE "recommendation_results" ADD CONSTRAINT "recommendation_results_owner_producer_target_fk" FOREIGN KEY ("user_id", "producer_run_id", "target_id") REFERENCES "agent_runs"("user_id", "id", "target_id");--> statement-breakpoint
ALTER TABLE "recommendation_results" ADD CONSTRAINT "recommendation_results_owner_list_target_fk" FOREIGN KEY ("user_id", "recommendation_list_id", "target_id") REFERENCES "recommendation_lists"("user_id", "id", "target_id");--> statement-breakpoint

CREATE FUNCTION validate_recommendation_result()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agent_runs WHERE id = NEW.root_run_id AND user_id = NEW.user_id AND target_id = NEW.target_id AND run_purpose = 'recommendation' AND parent_run_id IS NULL) THEN
    RAISE EXCEPTION 'RECOMMENDATION_RESULT_ROOT_INVALID' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM agent_runs WHERE id = NEW.producer_run_id AND user_id = NEW.user_id AND target_id = NEW.target_id AND run_purpose = 'recommendation' AND parent_run_id = NEW.root_run_id) THEN
    RAISE EXCEPTION 'RECOMMENDATION_RESULT_PRODUCER_INVALID' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.kind = 'recommendation_list' THEN
    PERFORM 1 FROM recommendation_lists WHERE id = NEW.recommendation_list_id AND user_id = NEW.user_id AND target_id = NEW.target_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM recommendation_list_items WHERE user_id = NEW.user_id AND recommendation_list_id = NEW.recommendation_list_id) THEN
      RAISE EXCEPTION 'RECOMMENDATION_LIST_EMPTY' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;$$;--> statement-breakpoint
CREATE TRIGGER recommendation_results_validate_insert BEFORE INSERT ON "recommendation_results" FOR EACH ROW EXECUTE FUNCTION validate_recommendation_result();--> statement-breakpoint

CREATE FUNCTION protect_published_recommendation_list_items()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.recommendation_list_id IS DISTINCT FROM OLD.recommendation_list_id THEN
    PERFORM 1 FROM recommendation_lists WHERE id = OLD.recommendation_list_id AND user_id = OLD.user_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM recommendation_results WHERE kind = 'recommendation_list' AND recommendation_list_id = OLD.recommendation_list_id)
      AND NOT EXISTS (SELECT 1 FROM recommendation_list_items WHERE recommendation_list_id = OLD.recommendation_list_id AND id <> OLD.id) THEN
      RAISE EXCEPTION 'PUBLISHED_RECOMMENDATION_LIST_MUST_NOT_BE_EMPTY' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;$$;--> statement-breakpoint
CREATE TRIGGER recommendation_list_items_preserve_published_nonempty
BEFORE DELETE OR UPDATE OF "recommendation_list_id" ON "recommendation_list_items"
FOR EACH ROW EXECUTE FUNCTION protect_published_recommendation_list_items();--> statement-breakpoint

CREATE FUNCTION reject_recommendation_fact_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'RECOMMENDATION_FACT_IMMUTABLE'; END;$$;--> statement-breakpoint
CREATE TRIGGER recommendation_run_start_commands_immutable BEFORE UPDATE OR DELETE ON "recommendation_run_start_commands" FOR EACH ROW EXECUTE FUNCTION reject_recommendation_fact_mutation();--> statement-breakpoint
CREATE TRIGGER recommendation_run_control_commands_immutable BEFORE UPDATE OR DELETE ON "recommendation_run_control_commands" FOR EACH ROW EXECUTE FUNCTION reject_recommendation_fact_mutation();--> statement-breakpoint
CREATE TRIGGER recommendation_results_immutable BEFORE UPDATE OR DELETE ON "recommendation_results" FOR EACH ROW EXECUTE FUNCTION reject_recommendation_fact_mutation();--> statement-breakpoint

ALTER TABLE "agent_inbox_items" DROP CONSTRAINT IF EXISTS "agent_inbox_items_kind_check";--> statement-breakpoint
ALTER TABLE "agent_inbox_items" DROP CONSTRAINT IF EXISTS "agent_inbox_items_reason_check";--> statement-breakpoint
ALTER TABLE "agent_inbox_items" DROP CONSTRAINT IF EXISTS "agent_inbox_items_kind_reason_pair_check";--> statement-breakpoint
ALTER TABLE "agent_inbox_items" DROP CONSTRAINT IF EXISTS "agent_inbox_items_reference_combination_check";--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD COLUMN "recommendation_result_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_owner_recommendation_result_fk" FOREIGN KEY ("user_id", "recommendation_result_id") REFERENCES "recommendation_results"("user_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbox_items_recommendation_result_unique_idx" ON "agent_inbox_items" ("recommendation_result_id") WHERE "recommendation_result_id" is not null;--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_kind_check" CHECK ("kind" in ('run_failed', 'budget_exhausted', 'decision_required', 'source_attention', 'discovery_attention', 'candidate_fact', 'recommendation_list', 'recommendation_result', 'calibration_proposal'));--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_reason_check" CHECK ("reason_code" in ('AGENT_RUN_PAUSED', 'SOURCE_HEALTH_ATTENTION', 'DISCOVERY_ATTENTION', 'CANDIDATE_FACT_PENDING', 'RECOMMENDATION_LIST_PUBLISHED', 'NO_RECOMMENDATIONS_PUBLISHED', 'CALIBRATION_PROPOSAL_CREATED', 'AGENT_RUN_ADAPTER_RETRYABLE', 'AGENT_RUN_ADAPTER_FAILED', 'AGENT_RUN_CONTENT_STORAGE_FAILED', 'AGENT_RUN_PERSIST_FAILED', 'AGENT_RUN_BUDGET_EXCEEDED', 'AGENT_RUN_MODEL_RETRYABLE', 'AGENT_RUN_MODEL_AUTH_FAILED', 'AGENT_RUN_MODEL_POLICY_REJECTED', 'AGENT_RUN_MODEL_INVALID_RESPONSE'));--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_kind_reason_pair_check" CHECK (("kind" = 'source_attention') = ("reason_code" = 'SOURCE_HEALTH_ATTENTION') and ("kind" = 'discovery_attention') = ("reason_code" = 'DISCOVERY_ATTENTION') and ("kind" = 'candidate_fact') = ("reason_code" = 'CANDIDATE_FACT_PENDING') and ("kind" = 'recommendation_list') = ("reason_code" = 'RECOMMENDATION_LIST_PUBLISHED') and ("kind" = 'recommendation_result') = ("reason_code" = 'NO_RECOMMENDATIONS_PUBLISHED') and ("kind" = 'calibration_proposal') = ("reason_code" = 'CALIBRATION_PROPOSAL_CREATED'));--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_reference_combination_check" CHECK (
  ("kind" in ('run_failed', 'budget_exhausted', 'decision_required', 'discovery_attention') and "run_id" is not null and "trigger_event_sequence" is not null and "candidate_fact_id" is null and "watchlist_item_id" is null and "source_health_check_id" is null and "recommendation_list_id" is null and "recommendation_result_id" is null and "calibration_proposal_id" is null)
  or ("kind" = 'source_attention' and "run_id" is not null and "watchlist_item_id" is not null and "source_health_check_id" is not null and "candidate_fact_id" is null and "recommendation_list_id" is null and "recommendation_result_id" is null and "calibration_proposal_id" is null)
  or ("kind" = 'candidate_fact' and "run_id" is null and "trigger_event_sequence" is null and "candidate_fact_id" is not null and "watchlist_item_id" is null and "source_health_check_id" is null and "recommendation_list_id" is null and "recommendation_result_id" is null and "calibration_proposal_id" is null)
  or ("kind" = 'recommendation_list' and "run_id" is null and "trigger_event_sequence" is null and "candidate_fact_id" is null and "watchlist_item_id" is null and "source_health_check_id" is null and "recommendation_list_id" is not null and "recommendation_result_id" is null and "calibration_proposal_id" is null)
  or ("kind" = 'recommendation_result' and "run_id" is null and "trigger_event_sequence" is null and "candidate_fact_id" is null and "watchlist_item_id" is null and "source_health_check_id" is null and "recommendation_list_id" is null and "recommendation_result_id" is not null and "calibration_proposal_id" is null)
  or ("kind" = 'calibration_proposal' and "run_id" is null and "trigger_event_sequence" is null and "candidate_fact_id" is null and "watchlist_item_id" is null and "source_health_check_id" is null and "recommendation_list_id" is null and "recommendation_result_id" is null and "calibration_proposal_id" is not null)
);
