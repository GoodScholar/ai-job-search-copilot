CREATE TABLE journey_metric_enrollments (
  user_id uuid PRIMARY KEY REFERENCES job_accounts(id),
  journey_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  configuration varchar(16) NOT NULL CHECK (configuration IN ('valid', 'invalid'))
);
--> statement-breakpoint
CREATE TABLE journey_metric_events (
  event_key varchar(64) PRIMARY KEY CHECK (event_key ~ '^[a-f0-9]{64}$'),
  journey_id uuid NOT NULL REFERENCES journey_metric_enrollments(journey_id),
  event jsonb NOT NULL,
  CONSTRAINT journey_metric_event_whitelist CHECK ((
    jsonb_typeof(event) = 'object'
    AND event ?& array['version', 'journeyId', 'eventKey', 'type', 'stage', 'occurredAt', 'elapsedMs', 'terminalStatus', 'reasonCode', 'configuration']
    AND (event - array['version', 'journeyId', 'eventKey', 'type', 'stage', 'occurredAt', 'elapsedMs', 'terminalStatus', 'reasonCode', 'configuration']) = '{}'::jsonb
    AND event->>'version' = 'first-recommendation-metrics-v1'
    AND event->>'journeyId' = journey_id::text
    AND event->>'eventKey' = event_key
    AND event->>'type' IN ('started', 'stage_reached', 'blocked', 'terminated', 'completed')
    AND event->>'stage' IN ('career_materials', 'profile_evidence', 'primary_target', 'job_sources', 'run_readiness', 'first_result')
    AND event->>'configuration' IN ('valid', 'invalid')
    AND jsonb_typeof(event->'elapsedMs') = 'number' AND (event->>'elapsedMs')::numeric >= 0
    AND jsonb_typeof(event->'occurredAt') = 'string'
    AND event->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    AND (event->'terminalStatus' = 'null'::jsonb OR event->>'terminalStatus' IN ('recommendation_list', 'no_recommendations', 'failed', 'cancelled'))
    AND (event->'reasonCode' = 'null'::jsonb OR event->>'reasonCode' IN ('CAREER_MATERIALS_MISSING', 'CAREER_IMPORT_FAILED', 'PROFILE_EVIDENCE_MISSING', 'PRIMARY_JOB_TARGET_MISSING', 'REQUESTED_JOB_TARGET_MISSING', 'REQUESTED_JOB_TARGET_INACTIVE', 'SOURCE_CAPABILITY_UNAVAILABLE', 'MODEL_DIAGNOSTIC_UNAVAILABLE', 'ACCOUNT_RUN_POLICY_BLOCKED', 'RUN_BUDGET_EXCEEDED', 'MODEL_AUTH_FAILED', 'MODEL_POLICY_REJECTED', 'RUN_CANCELLED', 'UNKNOWN_BLOCKER'))
  ) IS TRUE)
);
--> statement-breakpoint
CREATE INDEX journey_metric_events_journey_idx ON journey_metric_events(journey_id);
--> statement-breakpoint
CREATE UNIQUE INDEX journey_metric_completion_once ON journey_metric_events(journey_id) WHERE event->>'type' = 'completed';
