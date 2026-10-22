-- Notifications carry no user data and are delivered by PostgreSQL only after
-- commit. Queue contents, not these lossy hints, remain authoritative.
CREATE TABLE IF NOT EXISTS telemetry.feed_prewarm_jobs (
  user_id uuid PRIMARY KEY REFERENCES app.users(user_id) ON DELETE CASCADE,
  feed_version bigint NOT NULL,
  profile_version bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_token uuid,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  CONSTRAINT feed_prewarm_status_check CHECK (status IN ('pending','claimed','completed')),
  CONSTRAINT feed_prewarm_attempts_check CHECK (attempts>=0),
  CONSTRAINT feed_prewarm_claim_check CHECK (
    (status='claimed' AND claimed_at IS NOT NULL AND claim_token IS NOT NULL)
    OR (status<>'claimed' AND claimed_at IS NULL AND claim_token IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS feed_prewarm_ready_idx ON telemetry.feed_prewarm_jobs(available_at,user_id)
WHERE status IN ('pending','claimed');
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON telemetry.feed_prewarm_jobs TO ghsocial_backend;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION telemetry.notify_worker_ready() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_notify(CASE TG_TABLE_NAME WHEN 'ml_outbox' THEN 'weave_ml_outbox' ELSE 'weave_feed_prewarm' END,'');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ml_outbox_wake ON telemetry.ml_outbox;
CREATE TRIGGER ml_outbox_wake AFTER INSERT OR UPDATE OF status,available_at ON telemetry.ml_outbox
FOR EACH ROW WHEN (NEW.status='pending') EXECUTE FUNCTION telemetry.notify_worker_ready();
--> statement-breakpoint
DROP TRIGGER IF EXISTS feed_prewarm_wake ON telemetry.feed_prewarm_jobs;
CREATE TRIGGER feed_prewarm_wake AFTER INSERT OR UPDATE OF status,available_at ON telemetry.feed_prewarm_jobs
FOR EACH ROW WHEN (NEW.status='pending') EXECUTE FUNCTION telemetry.notify_worker_ready();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION telemetry.schedule_onboarding_prewarm() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO telemetry.feed_prewarm_jobs(user_id,feed_version,profile_version)
  SELECT state.user_id,state.feed_version,
    CASE WHEN NEW.payload->>'profile_version' ~ '^[0-9]{1,18}$'
      THEN (NEW.payload->>'profile_version')::bigint ELSE u.profile_version END
  FROM app.user_feed_state state
  JOIN app.users u ON u.user_id=state.user_id AND u.status='active'
  WHERE state.user_id=NEW.aggregate_id
  ON CONFLICT (user_id) DO UPDATE SET feed_version=EXCLUDED.feed_version,
    profile_version=EXCLUDED.profile_version,
    status='pending',available_at=now(),claimed_at=NULL,claim_token=NULL,attempts=0,last_error=NULL
  WHERE telemetry.feed_prewarm_jobs.profile_version<EXCLUDED.profile_version
    OR (telemetry.feed_prewarm_jobs.profile_version=EXCLUDED.profile_version
      AND telemetry.feed_prewarm_jobs.feed_version<>EXCLUDED.feed_version);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ml_outbox_onboarding_prewarm ON telemetry.ml_outbox;
CREATE TRIGGER ml_outbox_onboarding_prewarm AFTER UPDATE OF status ON telemetry.ml_outbox
FOR EACH ROW WHEN (NEW.job_type='onboard' AND NEW.status='delivered' AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION telemetry.schedule_onboarding_prewarm();
