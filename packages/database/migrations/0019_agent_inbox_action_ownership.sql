ALTER TABLE "agent_inbox_item_actions" DROP CONSTRAINT "agent_inbox_item_actions_outcome_check";
--> statement-breakpoint
ALTER TABLE "agent_inbox_item_actions" ADD CONSTRAINT "agent_inbox_item_actions_outcome_check" CHECK ("agent_inbox_item_actions"."outcome" in ('pending', 'applied', 'no_change', 'failed'));
