ALTER TABLE "agent_run_usage_entries" DROP CONSTRAINT "agent_run_usage_entries_step_check";--> statement-breakpoint
ALTER TABLE "agent_run_usage_entries" ADD CONSTRAINT "agent_run_usage_entries_step_check" CHECK ("step_key" is null or "step_key" in ('batch_search', 'fetch_details', 'persist_results', 'select_candidates', 'assess_matches', 'create_recommendations'));
