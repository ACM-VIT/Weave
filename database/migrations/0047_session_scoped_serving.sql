CREATE TABLE telemetry.feed_model_generations(
  generation_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES telemetry.feed_intent_sessions(session_id),
  queue_scope text NOT NULL CHECK(queue_scope ~ '^[a-f0-9]{64}$'),
  applied_context jsonb NOT NULL CHECK(jsonb_typeof(applied_context)='object' AND octet_length(applied_context::text)<=32768),
  valid_until_ms bigint NOT NULL CHECK(valid_until_ms>0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feed_model_generations_scope ON telemetry.feed_model_generations(user_id,queue_scope,valid_until_ms);
-- The accepted timestamp and opaque feedback envelope may never be reconstructed.
CREATE FUNCTION telemetry.keep_pending_model_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.event_id,NEW.user_id,NEW.feedback_version,NEW.original_feedback_json,NEW.accepted_at_ms,NEW.canonical_attribution)
    IS DISTINCT FROM (OLD.event_id,OLD.user_id,OLD.feedback_version,OLD.original_feedback_json,OLD.accepted_at_ms,OLD.canonical_attribution)
    OR(OLD.operation_id IS NOT NULL AND NEW.operation_id IS DISTINCT FROM OLD.operation_id) THEN RAISE EXCEPTION 'MODEL_FEEDBACK_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pending_model_source_immutable BEFORE UPDATE ON telemetry.pending_model_feedback FOR EACH ROW EXECUTE FUNCTION telemetry.keep_pending_model_source();
CREATE FUNCTION telemetry.keep_serve_intent_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF(NEW.intent_epoch,NEW.intent_epoch_started_ms,NEW.intent_epoch_witness_sha256,NEW.intent_policy_sha256)
    IS DISTINCT FROM(OLD.intent_epoch,OLD.intent_epoch_started_ms,OLD.intent_epoch_witness_sha256,OLD.intent_policy_sha256) THEN RAISE EXCEPTION 'MODEL_SERVE_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER serve_intent_stamp_immutable BEFORE UPDATE ON telemetry.feed_serves FOR EACH ROW EXECUTE FUNCTION telemetry.keep_serve_intent_stamp();
GRANT SELECT,INSERT ON telemetry.feed_model_generations TO ghsocial_backend;
