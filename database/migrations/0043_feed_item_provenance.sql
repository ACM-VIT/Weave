-- Durable attribution outlives private packet retention. No FK from product
-- history to captured input rows: expiry must never erase a delivered card.
CREATE TABLE telemetry.feed_item_provenance (
  serve_id uuid NOT NULL,
  position smallint NOT NULL,
  exposure_id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  repo_id uuid NOT NULL REFERENCES app.repos(repo_id),
  generation_id uuid,
  record_digest text,
  capture_status text NOT NULL CHECK(capture_status IN ('captured','not_captured')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(serve_id,position),
  CONSTRAINT feed_item_provenance_exposure_key UNIQUE(exposure_id),
  CONSTRAINT feed_item_provenance_parent_fkey FOREIGN KEY(serve_id,position)
    REFERENCES telemetry.feed_serve_items(serve_id,position) ON DELETE CASCADE,
  CONSTRAINT feed_item_provenance_capture_check CHECK(
    (capture_status='captured' AND generation_id IS NOT NULL AND record_digest IS NOT NULL AND record_digest ~ '^[a-f0-9]{64}$')
    OR (capture_status='not_captured' AND record_digest IS NULL))
);
CREATE INDEX feed_item_provenance_owner_created_idx ON telemetry.feed_item_provenance(user_id,created_at,exposure_id);

-- Trigger invocation alone grants no general private-table read authority to
-- the product role. All supplied identity/stage fields are compared to their
-- actual durable parent and immutable input within the serving transaction.
CREATE FUNCTION private_scoring.validate_feed_item_provenance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE parent record; captured record;
BEGIN
  SELECT serve.user_id,serve.feed_version,item.repo_id,item.score,item.source,item.model_version
  INTO parent FROM telemetry.feed_serve_items item
  JOIN telemetry.feed_serves serve USING(serve_id)
  WHERE item.serve_id=NEW.serve_id AND item.position=NEW.position;
  IF NOT FOUND OR parent.user_id IS DISTINCT FROM NEW.user_id OR parent.repo_id IS DISTINCT FROM NEW.repo_id
    THEN RAISE EXCEPTION 'invalid'; END IF;
  IF NEW.capture_status='captured' THEN
    SELECT generation.user_id,generation.feed_version,generation.expires_at,input.record_digest,
      input.final_score,input.source,convert_from(generation.context_bytes,'UTF8')::jsonb->>'model_version' AS model_version
    INTO captured FROM private_scoring.scoring_generations generation
    JOIN private_scoring.scoring_inputs input USING(generation_id,user_id)
    WHERE generation.generation_id=NEW.generation_id AND input.repo_id=NEW.repo_id
    FOR KEY SHARE OF generation,input;
    IF NOT FOUND OR captured.user_id IS DISTINCT FROM NEW.user_id
      OR captured.feed_version IS DISTINCT FROM parent.feed_version
      OR captured.record_digest IS DISTINCT FROM NEW.record_digest
      OR captured.final_score IS DISTINCT FROM parent.score
      OR captured.source IS DISTINCT FROM parent.source
      OR captured.model_version IS DISTINCT FROM parent.model_version
      OR captured.expires_at<=clock_timestamp()
      OR EXISTS(SELECT 1 FROM private_scoring.generation_witnesses witness
        WHERE witness.generation_id=NEW.generation_id AND witness.event_type='revoked')
      THEN RAISE EXCEPTION 'invalid'; END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  IF (SQLSTATE='P0001' AND SQLERRM='invalid') OR left(SQLSTATE,2) IN ('22','23') THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FEED_PROVENANCE_INVALID';
  END IF;
  RAISE EXCEPTION USING ERRCODE='58000',MESSAGE='FEED_PROVENANCE_UNAVAILABLE';
END $$;
REVOKE ALL ON FUNCTION private_scoring.validate_feed_item_provenance() FROM PUBLIC,
  ghsocial_backend,ghsocial_scoring_writer,ghsocial_scoring_exporter,ghsocial_scoring_retention;
CREATE TRIGGER feed_item_provenance_validate BEFORE INSERT ON telemetry.feed_item_provenance
  FOR EACH ROW EXECUTE FUNCTION private_scoring.validate_feed_item_provenance();
CREATE TRIGGER feed_item_provenance_immutable BEFORE UPDATE ON telemetry.feed_item_provenance
  FOR EACH ROW EXECUTE FUNCTION private_scoring.reject_update();
REVOKE ALL ON telemetry.feed_item_provenance FROM PUBLIC;
GRANT SELECT,INSERT ON telemetry.feed_item_provenance TO ghsocial_backend;

CREATE FUNCTION private_scoring.record_generation_witness(owner_id uuid, generation uuid, kind text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE captured private_scoring.scoring_generations%ROWTYPE;
BEGIN
  IF kind NOT IN ('published','stale') THEN RAISE EXCEPTION 'invalid'; END IF;
  SELECT * INTO captured FROM private_scoring.scoring_generations
    WHERE generation_id=generation AND user_id=owner_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF kind='published' AND (captured.expires_at<=clock_timestamp()
    OR EXISTS(SELECT 1 FROM private_scoring.generation_witnesses WHERE generation_id=generation AND event_type='revoked'))
    THEN RETURN false; END IF;
  INSERT INTO private_scoring.generation_witnesses(generation_id,event_type)
    VALUES(generation,kind) ON CONFLICT DO NOTHING;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_WITNESS_INVALID';
END $$;
REVOKE ALL ON FUNCTION private_scoring.record_generation_witness(uuid,uuid,text) FROM PUBLIC,
  ghsocial_backend,ghsocial_scoring_exporter,ghsocial_scoring_retention;
GRANT EXECUTE ON FUNCTION private_scoring.record_generation_witness(uuid,uuid,text) TO ghsocial_scoring_writer;
