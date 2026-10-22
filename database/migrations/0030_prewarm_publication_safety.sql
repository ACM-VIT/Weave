-- Additive upgrade of the published 0029 schema. Legacy jobs have no immutable
-- scheduling timestamp, so their seven-day eligibility horizon starts at upgrade.
ALTER TABLE telemetry.feed_prewarm_jobs
ADD COLUMN scheduled_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
ALTER TABLE telemetry.feed_prewarm_jobs DROP CONSTRAINT feed_prewarm_status_check;
--> statement-breakpoint
ALTER TABLE telemetry.feed_prewarm_jobs ADD CONSTRAINT feed_prewarm_status_check
CHECK (status IN ('pending','claimed','completed','expired'));
--> statement-breakpoint
CREATE INDEX feed_prewarm_expiry_idx ON telemetry.feed_prewarm_jobs(scheduled_at,user_id)
WHERE status IN ('pending','claimed');
--> statement-breakpoint
ALTER TABLE app.user_feed_state
ADD COLUMN last_published_feed_version bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX generation_attempts_published_idx
ON telemetry.generation_attempts(user_id,feed_version)
WHERE status='completed' AND mode IN ('live','prewarm');
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
    status='pending',scheduled_at=now(),available_at=now(),claimed_at=NULL,claim_token=NULL,attempts=0,last_error=NULL
  WHERE telemetry.feed_prewarm_jobs.profile_version<EXCLUDED.profile_version
    OR (telemetry.feed_prewarm_jobs.profile_version=EXCLUDED.profile_version
      AND telemetry.feed_prewarm_jobs.feed_version<>EXCLUDED.feed_version);
  RETURN NEW;
END;
$$;
