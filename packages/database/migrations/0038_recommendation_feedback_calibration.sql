ALTER TABLE "recommendation_list_items" ADD CONSTRAINT "recommendation_list_items_user_id_id_unique" UNIQUE("user_id", "id");--> statement-breakpoint

CREATE TABLE "recommendation_decision_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "user_id" uuid NOT NULL, "target_id" uuid NOT NULL,
  "recommendation_list_id" uuid NOT NULL, "recommendation_list_item_id" uuid NOT NULL, "match_version_id" uuid NOT NULL,
  "decision" varchar(16) NOT NULL, "reason" varchar(32), "note" text, "idempotency_key" uuid NOT NULL,
  "command_summary" varchar(64) NOT NULL, "expected_version" integer NOT NULL, "version" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recommendation_decision_events_user_key_unique" UNIQUE("user_id", "idempotency_key"),
  CONSTRAINT "recommendation_decision_events_user_id_id_unique" UNIQUE("user_id", "id"),
  CONSTRAINT "recommendation_decision_events_decision_check" CHECK ("decision" in ('saved', 'ignored')),
  CONSTRAINT "recommendation_decision_events_reason_check" CHECK ("reason" is null or "reason" in ('ROLE_DIRECTION', 'LOCATION', 'SALARY', 'COMPANY', 'INDUSTRY', 'SENIORITY', 'MISMATCH', 'EXPIRED', 'ALREADY_HANDLED')),
  CONSTRAINT "recommendation_decision_events_note_check" CHECK ("note" is null or length("note") between 1 and 500),
  CONSTRAINT "recommendation_decision_events_version_check" CHECK ("version" = "expected_version" + 1 and "expected_version" >= 0),
  CONSTRAINT "recommendation_decision_events_owner_target_fk" FOREIGN KEY ("user_id", "target_id") REFERENCES "job_targets"("user_id", "id"),
  CONSTRAINT "recommendation_decision_events_owner_list_fk" FOREIGN KEY ("user_id", "recommendation_list_id") REFERENCES "recommendation_lists"("user_id", "id"),
  CONSTRAINT "recommendation_decision_events_owner_item_fk" FOREIGN KEY ("user_id", "recommendation_list_item_id") REFERENCES "recommendation_list_items"("user_id", "id"),
  CONSTRAINT "recommendation_decision_events_owner_match_fk" FOREIGN KEY ("user_id", "match_version_id") REFERENCES "job_match_versions"("user_id", "id")
);--> statement-breakpoint
CREATE INDEX "recommendation_decision_events_current_idx" ON "recommendation_decision_events" ("user_id", "recommendation_list_item_id", "created_at", "id");--> statement-breakpoint

CREATE TABLE "calibration_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "user_id" uuid NOT NULL, "target_id" uuid NOT NULL,
  "reason" varchar(32) NOT NULL, "status" varchar(16) DEFAULT 'pending' NOT NULL, "version" integer DEFAULT 1 NOT NULL,
  "resolved_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "calibration_proposals_user_id_id_unique" UNIQUE("user_id", "id"),
  CONSTRAINT "calibration_proposals_status_check" CHECK ("status" in ('pending', 'approved', 'rejected')),
  CONSTRAINT "calibration_proposals_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "calibration_proposals_owner_target_fk" FOREIGN KEY ("user_id", "target_id") REFERENCES "job_targets"("user_id", "id")
);--> statement-breakpoint
CREATE INDEX "calibration_proposals_owner_target_status_idx" ON "calibration_proposals" ("user_id", "target_id", "status", "created_at");--> statement-breakpoint

CREATE TABLE "calibration_proposal_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "user_id" uuid NOT NULL, "proposal_id" uuid NOT NULL,
  "revision_number" integer NOT NULL, "strategy" varchar(48) NOT NULL, "rule_config" jsonb NOT NULL, "impact_preview" jsonb NOT NULL,
  "idempotency_key" uuid NOT NULL, "command_summary" varchar(64) NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "calibration_proposal_revisions_proposal_number_unique" UNIQUE("proposal_id", "revision_number"),
  CONSTRAINT "calibration_proposal_revisions_user_key_unique" UNIQUE("user_id", "idempotency_key"),
  CONSTRAINT "calibration_proposal_revisions_user_id_id_unique" UNIQUE("user_id", "id"),
  CONSTRAINT "calibration_proposal_revisions_strategy_check" CHECK ("strategy" in ('require_related_evidence', 'raise_quality_bar', 'exclude_evidence_opportunities')),
  CONSTRAINT "calibration_proposal_revisions_config_object" CHECK (jsonb_typeof("rule_config") = 'object'),
  CONSTRAINT "calibration_proposal_revisions_preview_object" CHECK (jsonb_typeof("impact_preview") = 'object'),
  CONSTRAINT "calibration_proposal_revisions_owner_proposal_fk" FOREIGN KEY ("user_id", "proposal_id") REFERENCES "calibration_proposals"("user_id", "id")
);--> statement-breakpoint

CREATE TABLE "calibration_proposal_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "user_id" uuid NOT NULL, "proposal_id" uuid NOT NULL,
  "decision_event_id" uuid NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "calibration_proposal_evidence_decision_unique" UNIQUE("decision_event_id"),
  CONSTRAINT "calibration_proposal_evidence_owner_proposal_fk" FOREIGN KEY ("user_id", "proposal_id") REFERENCES "calibration_proposals"("user_id", "id"),
  CONSTRAINT "calibration_proposal_evidence_owner_decision_fk" FOREIGN KEY ("user_id", "decision_event_id") REFERENCES "recommendation_decision_events"("user_id", "id")
);--> statement-breakpoint

CREATE TABLE "recommendation_rule_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "user_id" uuid NOT NULL, "target_id" uuid NOT NULL,
  "proposal_id" uuid NOT NULL, "proposal_revision_id" uuid NOT NULL, "version" integer NOT NULL, "config" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recommendation_rule_versions_target_version_unique" UNIQUE("user_id", "target_id", "version"),
  CONSTRAINT "recommendation_rule_versions_user_id_id_unique" UNIQUE("user_id", "id"),
  CONSTRAINT "recommendation_rule_versions_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "recommendation_rule_versions_config_object" CHECK (jsonb_typeof("config") = 'object'),
  CONSTRAINT "recommendation_rule_versions_owner_target_fk" FOREIGN KEY ("user_id", "target_id") REFERENCES "job_targets"("user_id", "id"),
  CONSTRAINT "recommendation_rule_versions_owner_proposal_fk" FOREIGN KEY ("user_id", "proposal_id") REFERENCES "calibration_proposals"("user_id", "id"),
  CONSTRAINT "recommendation_rule_versions_owner_revision_fk" FOREIGN KEY ("user_id", "proposal_revision_id") REFERENCES "calibration_proposal_revisions"("user_id", "id")
);--> statement-breakpoint

CREATE FUNCTION "prevent_recommendation_feedback_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable recommendation feedback'; END; $$;--> statement-breakpoint
CREATE TRIGGER "recommendation_decision_events_immutable" BEFORE UPDATE OR DELETE ON "recommendation_decision_events" FOR EACH ROW EXECUTE FUNCTION "prevent_recommendation_feedback_mutation"();--> statement-breakpoint
CREATE TRIGGER "calibration_proposal_revisions_immutable" BEFORE UPDATE OR DELETE ON "calibration_proposal_revisions" FOR EACH ROW EXECUTE FUNCTION "prevent_recommendation_feedback_mutation"();--> statement-breakpoint
CREATE TRIGGER "recommendation_rule_versions_immutable" BEFORE UPDATE OR DELETE ON "recommendation_rule_versions" FOR EACH ROW EXECUTE FUNCTION "prevent_recommendation_feedback_mutation"();
