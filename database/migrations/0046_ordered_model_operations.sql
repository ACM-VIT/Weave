ALTER TABLE app.user_feed_state
  ADD COLUMN model_operation_version bigint NOT NULL DEFAULT 0 CHECK(model_operation_version>=0),
  ADD COLUMN model_accepted_at_ms bigint NOT NULL DEFAULT 0 CHECK(model_accepted_at_ms>=0),
  ADD COLUMN model_policy_sha256 text CHECK(model_policy_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN model_policy_limits jsonb,
  ADD COLUMN model_initialized boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT model_policy_registration CHECK((model_policy_sha256 IS NULL AND model_policy_limits IS NULL AND NOT model_initialized)
    OR (model_policy_sha256 IS NOT NULL AND jsonb_typeof(model_policy_limits)='object'));
--> statement-breakpoint
ALTER TABLE telemetry.ml_outbox DROP CONSTRAINT ml_outbox_job_type_check;
ALTER TABLE telemetry.ml_outbox ADD CONSTRAINT ml_outbox_job_type_check CHECK(job_type IN('feedback','onboard','repo_index','repo_refresh','model_operation'));
ALTER TABLE telemetry.ml_outbox
  ADD COLUMN model_operation_version bigint,
  ADD COLUMN previous_model_operation_version bigint,
  ADD COLUMN operation_json text,
  ADD COLUMN source_envelope_sha256 text,
  ADD COLUMN logical_request_sha256 text,
  ADD COLUMN withdrawal_json text,
  ADD CONSTRAINT model_outbox_source CHECK(
    (job_type<>'model_operation' AND model_operation_version IS NULL AND previous_model_operation_version IS NULL
      AND operation_json IS NULL AND source_envelope_sha256 IS NULL AND logical_request_sha256 IS NULL AND withdrawal_json IS NULL)
    OR(job_type='model_operation' AND model_operation_version IS NOT NULL AND previous_model_operation_version IS NOT NULL
      AND source_envelope_sha256 IS NOT NULL AND logical_request_sha256 IS NOT NULL AND model_operation_version>0 AND previous_model_operation_version>=0
      AND model_operation_version=previous_model_operation_version+1
      AND operation_json IS NOT NULL AND octet_length(operation_json)<=131072
      AND source_envelope_sha256=encode(sha256(convert_to(operation_json,'UTF8')),'hex')
      AND logical_request_sha256 ~ '^[a-f0-9]{64}$'
      AND operation_json::jsonb->>'operation_id'=outbox_id::text
      AND operation_json::jsonb->>'user_id'=aggregate_id::text
      AND operation_json::jsonb->>'model_operation_version'=model_operation_version::text
      AND operation_json::jsonb->>'previous_model_operation_version'=previous_model_operation_version::text
      AND (withdrawal_json IS NULL OR octet_length(withdrawal_json)<=8192)));
CREATE UNIQUE INDEX model_outbox_owner_version ON telemetry.ml_outbox(aggregate_id,model_operation_version) WHERE job_type='model_operation';
--> statement-breakpoint
CREATE FUNCTION telemetry.keep_model_operation_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.job_type='model_operation' AND
    (NEW.outbox_id,NEW.job_type,NEW.aggregate_id,NEW.idempotency_key,NEW.model_operation_version,
     NEW.previous_model_operation_version,NEW.operation_json,NEW.source_envelope_sha256,NEW.logical_request_sha256)
    IS DISTINCT FROM
    (OLD.outbox_id,OLD.job_type,OLD.aggregate_id,OLD.idempotency_key,OLD.model_operation_version,
     OLD.previous_model_operation_version,OLD.operation_json,OLD.source_envelope_sha256,OLD.logical_request_sha256)
    OR (OLD.withdrawal_json IS NOT NULL AND NEW.withdrawal_json IS DISTINCT FROM OLD.withdrawal_json) THEN
    RAISE EXCEPTION 'MODEL_OPERATION_IMMUTABLE';
  END IF;
  IF NEW.job_type='model_operation' AND NEW.status='superseded' THEN RAISE EXCEPTION 'MODEL_OPERATION_CANNOT_SKIP'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_operation_source_immutable BEFORE UPDATE ON telemetry.ml_outbox FOR EACH ROW EXECUTE FUNCTION telemetry.keep_model_operation_source();
--> statement-breakpoint
CREATE TABLE telemetry.pending_model_feedback(
  event_id uuid PRIMARY KEY REFERENCES telemetry.interaction_events(event_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  feedback_version bigint NOT NULL CHECK(feedback_version>0),
  original_feedback_json text NOT NULL CHECK(octet_length(original_feedback_json)<=131072),
  accepted_at_ms bigint NOT NULL CHECK(accepted_at_ms>=0),
  canonical_attribution jsonb,
  operation_id uuid REFERENCES telemetry.ml_outbox(outbox_id),
  UNIQUE(user_id,feedback_version)
);
--> statement-breakpoint
CREATE TABLE telemetry.feed_intent_sessions(
  session_id uuid PRIMARY KEY,
  user_id uuid REFERENCES app.users(user_id) ON DELETE SET NULL,
  intent_epoch bigint NOT NULL CHECK(intent_epoch>0),
  epoch_started_ms bigint NOT NULL CHECK(epoch_started_ms>=0),
  policy_sha256 text NOT NULL CHECK(policy_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN('active','retired')),
  begin_operation_version bigint NOT NULL CHECK(begin_operation_version>0),
  last_control_operation_version bigint NOT NULL CHECK(last_control_operation_version>=begin_operation_version),
  epoch_witness_sha256 text NOT NULL CHECK(epoch_witness_sha256 ~ '^[a-f0-9]{64}$'),
  retirement_witness_sha256 text CHECK(retirement_witness_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK(user_id IS NOT NULL OR status='retired')
);
CREATE INDEX feed_intent_sessions_owner ON telemetry.feed_intent_sessions(user_id,status);
-- Parent deletion retains UUID collision proof without retained owner identity.
CREATE FUNCTION telemetry.retire_deleted_owner_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM session_id FROM telemetry.feed_intent_sessions WHERE user_id=OLD.user_id ORDER BY session_id FOR UPDATE;
  UPDATE telemetry.feed_intent_sessions SET status='retired' WHERE user_id=OLD.user_id;
  RETURN OLD;
END $$;
CREATE TRIGGER model_sessions_retire_owner BEFORE DELETE ON app.users FOR EACH ROW EXECUTE FUNCTION telemetry.retire_deleted_owner_sessions();
--> statement-breakpoint
ALTER TABLE telemetry.feed_serves
  ADD COLUMN intent_epoch bigint,
  ADD COLUMN intent_epoch_started_ms bigint,
  ADD COLUMN intent_epoch_witness_sha256 text,
  ADD COLUMN intent_policy_sha256 text,
  ADD CONSTRAINT feed_intent_stamp CHECK(
    (intent_epoch IS NULL AND intent_epoch_started_ms IS NULL AND intent_epoch_witness_sha256 IS NULL AND intent_policy_sha256 IS NULL)
    OR(intent_epoch IS NOT NULL AND intent_epoch_started_ms IS NOT NULL AND intent_epoch_witness_sha256 IS NOT NULL AND intent_policy_sha256 IS NOT NULL AND intent_epoch>0 AND intent_epoch_started_ms>=0 AND intent_epoch_witness_sha256 ~ '^[a-f0-9]{64}$' AND intent_policy_sha256 ~ '^[a-f0-9]{64}$'));
GRANT SELECT,INSERT,UPDATE,DELETE ON telemetry.pending_model_feedback,telemetry.feed_intent_sessions TO ghsocial_backend;
