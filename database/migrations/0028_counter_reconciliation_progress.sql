-- Durable rotating audit cursors. The fixed upper ID closes each sweep even
-- while ingestion creates new rows; rows inserted behind the cursor and rows
-- skipped under foreground locks are revisited on the following sweep.
CREATE TABLE IF NOT EXISTS telemetry.counter_reconciliation_progress (
  scope text PRIMARY KEY CONSTRAINT counter_reconciliation_scope_check CHECK (scope IN ('repositories','users')),
  last_id uuid,
  upper_id uuid,
  completed_sweeps bigint NOT NULL DEFAULT 0 CONSTRAINT counter_reconciliation_sweeps_check CHECK (completed_sweeps >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT counter_reconciliation_cursor_check CHECK (
    last_id IS NULL OR (upper_id IS NOT NULL AND last_id <= upper_id)
  )
);
--> statement-breakpoint
INSERT INTO telemetry.counter_reconciliation_progress(scope)
VALUES ('repositories'),('users') ON CONFLICT (scope) DO NOTHING;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON telemetry.counter_reconciliation_progress TO ghsocial_backend;
