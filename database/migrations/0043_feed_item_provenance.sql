-- Durable attribution outlives private packet retention. No FK from product
-- history to captured input rows: expiry must never erase a delivered card.
CREATE TABLE telemetry.feed_item_provenance (
  serve_id uuid NOT NULL,
  position smallint NOT NULL,
  exposure_id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  repo_id uuid NOT NULL REFERENCES app.repos(repo_id),
  generation_id uuid,
  legacy_generation_hint uuid,
  record_digest text,
  capture_status text NOT NULL CHECK(capture_status IN ('captured','not_captured')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(serve_id,position),
  CONSTRAINT feed_item_provenance_exposure_key UNIQUE(exposure_id),
  CONSTRAINT feed_item_provenance_parent_fkey FOREIGN KEY(serve_id,position)
    REFERENCES telemetry.feed_serve_items(serve_id,position) ON DELETE CASCADE,
  CONSTRAINT feed_item_provenance_legacy_check CHECK(capture_status<>'captured' OR legacy_generation_hint IS NULL),
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

-- Repair only a known publication. Private persistence alone, a page header,
-- and a Redis queue's disappearance are never publication evidence. This
-- writer-only operation reveals only a bounded count, not product/private rows.
CREATE FUNCTION private_scoring.reconcile_publication_witnesses(owners uuid[], batch_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE repaired integer;
BEGIN
  IF owners IS NULL OR array_ndims(owners) IS DISTINCT FROM 1 OR cardinality(owners) NOT BETWEEN 1 AND 100 OR array_position(owners,NULL) IS NOT NULL
    OR batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid'; END IF;
  WITH candidates AS MATERIALIZED (
    SELECT generation.generation_id FROM private_scoring.scoring_generations generation
    WHERE generation.user_id=ANY(owners) AND generation.expires_at>clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM private_scoring.generation_witnesses witness
        WHERE witness.generation_id=generation.generation_id AND witness.event_type IN ('published','revoked'))
      AND (EXISTS(SELECT 1 FROM telemetry.generation_attempts attempt
        WHERE attempt.generation_id=generation.generation_id AND attempt.user_id=generation.user_id
          AND attempt.feed_version=generation.feed_version AND attempt.status='completed'
          AND attempt.mode IN ('live','prewarm') AND attempt.result_count>0)
        OR EXISTS(SELECT 1 FROM telemetry.feed_item_provenance item
          JOIN telemetry.feed_serves serve USING(serve_id)
          WHERE item.generation_id=generation.generation_id AND item.user_id=generation.user_id
            AND item.capture_status='captured' AND serve.feed_version=generation.feed_version))
    ORDER BY generation.created_at,generation.generation_id LIMIT batch_limit
    FOR UPDATE OF generation SKIP LOCKED
  ), inserted AS (
    INSERT INTO private_scoring.generation_witnesses(generation_id,event_type)
      SELECT generation_id,'published' FROM candidates ON CONFLICT DO NOTHING RETURNING 1
  ) SELECT count(*)::integer INTO repaired FROM inserted;
  RETURN repaired;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION USING ERRCODE='58000',MESSAGE='SCORING_WITNESS_UNAVAILABLE';
END $$;
REVOKE ALL ON FUNCTION private_scoring.reconcile_publication_witnesses(uuid[],integer) FROM PUBLIC,
  ghsocial_backend,ghsocial_scoring_exporter,ghsocial_scoring_retention;
GRANT EXECUTE ON FUNCTION private_scoring.reconcile_publication_witnesses(uuid[],integer) TO ghsocial_scoring_writer;
