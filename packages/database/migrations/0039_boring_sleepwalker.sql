DROP INDEX IF EXISTS "recommendation_decision_events_current_idx";--> statement-breakpoint
CREATE INDEX "recommendation_decision_events_current_idx" ON "recommendation_decision_events" USING btree ("user_id","recommendation_list_item_id","version");--> statement-breakpoint
ALTER TABLE "recommendation_decision_events" ADD CONSTRAINT "recommendation_decision_events_user_item_version_unique" UNIQUE("user_id","recommendation_list_item_id","version");
