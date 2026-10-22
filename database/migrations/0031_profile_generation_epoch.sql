-- Before applying this migration or enabling the new code, drain and replace
-- ALL old API, outbox and feed-generation processes, not just dedicated workers.
-- Old API instances can generate feeds and write profiles under obsolete rules.
-- Each profile
-- epoch now owns a distinct feed namespace. Invalidate legacy ambiguous success
-- witnesses without deleting business data or historical serves.
UPDATE app.user_feed_state SET feed_version=feed_version+1,updated_at=now();
--> statement-breakpoint
-- Old scheduling allowed malformed payload versions to borrow the current user
-- version. Keep only slots with retained exact-profile successful delivery proof.
-- Missing/retention-pruned proof is repaired synchronously before future ML use.
DELETE FROM telemetry.feed_prewarm_jobs job
WHERE NOT EXISTS (
  SELECT 1 FROM telemetry.ml_outbox delivery
  WHERE delivery.aggregate_id=job.user_id AND delivery.job_type='onboard'
    AND delivery.status='delivered'
    AND job.profile_version=CASE WHEN delivery.payload->>'profile_version' ~ '^[0-9]{1,18}$'
      THEN (delivery.payload->>'profile_version')::bigint ELSE NULL END
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION telemetry.schedule_onboarding_prewarm() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO telemetry.feed_prewarm_jobs(user_id,feed_version,profile_version)
  SELECT state.user_id,state.feed_version,
    CASE WHEN NEW.payload->>'profile_version' ~ '^[0-9]{1,18}$'
      THEN (NEW.payload->>'profile_version')::bigint ELSE NULL END
  FROM app.user_feed_state state
  JOIN app.users u ON u.user_id=state.user_id AND u.status='active'
  WHERE state.user_id=NEW.aggregate_id
    AND u.profile_version=CASE WHEN NEW.payload->>'profile_version' ~ '^[0-9]{1,18}$'
      THEN (NEW.payload->>'profile_version')::bigint ELSE NULL END
  ON CONFLICT (user_id) DO UPDATE SET feed_version=EXCLUDED.feed_version,
    profile_version=EXCLUDED.profile_version,
    status='pending',scheduled_at=now(),available_at=now(),claimed_at=NULL,claim_token=NULL,attempts=0,last_error=NULL
  WHERE telemetry.feed_prewarm_jobs.profile_version<EXCLUDED.profile_version
    OR (telemetry.feed_prewarm_jobs.profile_version=EXCLUDED.profile_version
      AND telemetry.feed_prewarm_jobs.feed_version<>EXCLUDED.feed_version);
  RETURN NEW;
END;
$$;
