CREATE INDEX IF NOT EXISTS ml_outbox_feedback_predecessor_idx
ON telemetry.ml_outbox (aggregate_id)
WHERE job_type='feedback' AND status<>'delivered';
