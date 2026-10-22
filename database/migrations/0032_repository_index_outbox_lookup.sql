CREATE INDEX IF NOT EXISTS ml_outbox_repository_index_lookup_idx
  ON telemetry.ml_outbox (aggregate_id, status, created_at)
  WHERE job_type = 'repo_index';
