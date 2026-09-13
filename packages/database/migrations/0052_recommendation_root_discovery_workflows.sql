CREATE OR REPLACE FUNCTION validate_recommendation_run_topology()
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
    IF NEW.workflow_version NOT IN ('job-discovery-workflow-v1', 'job-discovery-workflow-v3', 'layered-public-job-discovery-v1') THEN
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
END;$$;
