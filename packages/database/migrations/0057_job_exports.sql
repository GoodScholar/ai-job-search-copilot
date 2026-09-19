CREATE TABLE "job_exports" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "job_accounts"("id"),
  "command_id" uuid NOT NULL,
  "filter" varchar(16) NOT NULL,
  "field_version" integer NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'generating',
  "row_count" integer NOT NULL,
  "object_key" varchar(512) NOT NULL,
  "queue_published_at" timestamp with time zone,
  "object_deleted_at" timestamp with time zone,
  "failure_code" varchar(64),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "job_exports_user_command_unique" UNIQUE("user_id", "command_id"),
  CONSTRAINT "job_exports_user_id_id_unique" UNIQUE("user_id", "id"),
  CONSTRAINT "job_exports_filter_check" CHECK ("filter" in ('active', 'archived', 'all')),
  CONSTRAINT "job_exports_field_version_check" CHECK ("field_version" = 1),
  CONSTRAINT "job_exports_status_check" CHECK ("status" in ('generating', 'ready', 'failed', 'expired')),
  CONSTRAINT "job_exports_row_count_nonnegative" CHECK ("row_count" >= 0),
  CONSTRAINT "job_exports_failure_code_check" CHECK ("failure_code" is null or "failure_code" = 'JOB_EXPORT_GENERATION_FAILED')
);
CREATE INDEX "job_exports_owner_created_idx" ON "job_exports" ("user_id", "created_at", "id");
CREATE INDEX "job_exports_recovery_idx" ON "job_exports" ("status", "queue_published_at", "created_at");
CREATE INDEX "job_exports_expiry_idx" ON "job_exports" ("status", "expires_at", "object_deleted_at");

CREATE TABLE "job_export_rows" (
  "export_id" uuid NOT NULL REFERENCES "job_exports"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "job_accounts"("id"),
  "ordinal" integer NOT NULL,
  "opportunity_id" uuid NOT NULL,
  "source_posting_version_id" uuid NOT NULL,
  "title" text,
  "company" text,
  "location" text,
  "source_url" text,
  "availability" varchar(16) NOT NULL,
  "archived_at" timestamp with time zone,
  "recommendation_decision" varchar(16),
  "application_status" varchar(32),
  "posted_at" timestamp with time zone,
  "deadline" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "job_export_rows_pk" PRIMARY KEY("export_id", "ordinal"),
  CONSTRAINT "job_export_rows_owner_export_fk" FOREIGN KEY ("user_id", "export_id") REFERENCES "job_exports"("user_id", "id"),
  CONSTRAINT "job_export_rows_ordinal_positive" CHECK ("ordinal" >= 1),
  CONSTRAINT "job_export_rows_availability_check" CHECK ("availability" in ('open', 'closed', 'expired')),
  CONSTRAINT "job_export_rows_decision_check" CHECK ("recommendation_decision" is null or "recommendation_decision" in ('pending', 'saved', 'ignored')),
  CONSTRAINT "job_export_rows_application_status_check" CHECK ("application_status" is null)
);

CREATE OR REPLACE FUNCTION prevent_job_export_snapshot_change() RETURNS trigger AS $$
BEGIN
  IF OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.command_id IS DISTINCT FROM NEW.command_id
    OR OLD.filter IS DISTINCT FROM NEW.filter
    OR OLD.field_version IS DISTINCT FROM NEW.field_version
    OR OLD.row_count IS DISTINCT FROM NEW.row_count
    OR OLD.object_key IS DISTINCT FROM NEW.object_key
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN
    RAISE EXCEPTION 'job export snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "job_exports_snapshot_immutable" BEFORE UPDATE ON "job_exports" FOR EACH ROW EXECUTE FUNCTION prevent_job_export_snapshot_change();

CREATE OR REPLACE FUNCTION prevent_job_export_row_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'job export rows are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "job_export_rows_immutable_update" BEFORE UPDATE OR DELETE ON "job_export_rows" FOR EACH ROW EXECUTE FUNCTION prevent_job_export_row_change();
