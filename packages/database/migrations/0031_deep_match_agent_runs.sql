ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_current_step_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_current_step_check" CHECK ("current_step" in ('queued', 'batch_search', 'fetch_details', 'persist_results', 'select_candidates', 'assess_matches', 'create_recommendations', 'completed', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_fake_model_usage_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_fake_model_usage_check" CHECK (("workflow_version" = 'deep-match-v1' and jsonb_typeof("model_snapshot") = 'object') or ("workflow_version" <> 'deep-match-v1' and "model_snapshot" is null and "model_call_count" = 0 and "input_token_count" = 0 and "output_token_count" = 0 and "total_token_count" = 0));--> statement-breakpoint
ALTER TABLE "agent_run_steps" DROP CONSTRAINT "agent_run_steps_step_key_check";--> statement-breakpoint
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_step_key_check" CHECK ("step_key" in ('batch_search', 'fetch_details', 'persist_results', 'select_candidates', 'assess_matches', 'create_recommendations'));
