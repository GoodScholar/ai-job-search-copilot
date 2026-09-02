CREATE TABLE "recommendation_decision_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"decision_event_id" uuid NOT NULL,
	"proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendation_decision_responses_event_unique" UNIQUE("decision_event_id")
);
--> statement-breakpoint
ALTER TABLE "recommendation_decision_responses" ADD CONSTRAINT "recommendation_decision_responses_user_id_job_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."job_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_decision_responses" ADD CONSTRAINT "recommendation_decision_responses_decision_event_id_recommendation_decision_events_id_fk" FOREIGN KEY ("decision_event_id") REFERENCES "public"."recommendation_decision_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_decision_responses" ADD CONSTRAINT "recommendation_decision_responses_owner_event_fk" FOREIGN KEY ("user_id","decision_event_id") REFERENCES "public"."recommendation_decision_events"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER "recommendation_decision_responses_immutable" BEFORE UPDATE OR DELETE ON "recommendation_decision_responses" FOR EACH ROW EXECUTE FUNCTION "prevent_recommendation_feedback_mutation"();
