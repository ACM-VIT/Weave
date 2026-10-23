-- The old query evaluated advisory-lock predicates before LIMIT. Freeze only
-- a bounded row-locked candidate set first, then try each selected subject and
-- recheck eligibility. Busy subjects remain durable work for a later cycle.
CREATE OR REPLACE FUNCTION private_scoring.purge_scoring_private(batch_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE generation_count integer; job_count integer;
BEGIN
  IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid'; END IF;
  WITH candidates AS MATERIALIZED (
    SELECT generation.generation_id,generation.user_id FROM private_scoring.scoring_generations generation
    WHERE (expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM private_scoring.subject_revocations revoked WHERE revoked.user_id=generation.user_id)
      OR EXISTS(SELECT 1 FROM private_scoring.generation_witnesses witness WHERE witness.generation_id=generation.generation_id AND witness.event_type='revoked'))
    ORDER BY generation.user_id,generation.generation_id LIMIT batch_limit FOR UPDATE OF generation SKIP LOCKED
  ), selected AS MATERIALIZED (
    SELECT generation.generation_id FROM private_scoring.scoring_generations generation
    JOIN candidates ON candidates.generation_id=generation.generation_id
    WHERE pg_try_advisory_xact_lock(hashtextextended(candidates.user_id::text,260044))
      AND (generation.expires_at<=clock_timestamp()
        OR EXISTS(SELECT 1 FROM private_scoring.subject_revocations revoked WHERE revoked.user_id=generation.user_id)
        OR EXISTS(SELECT 1 FROM private_scoring.generation_witnesses witness WHERE witness.generation_id=generation.generation_id AND witness.event_type='revoked'))
  ) DELETE FROM private_scoring.scoring_generations generation USING selected WHERE generation.generation_id=selected.generation_id;
  GET DIAGNOSTICS generation_count=ROW_COUNT;
  WITH candidates AS MATERIALIZED (
    SELECT snapshot.job_id,snapshot.subject_user_id FROM private_scoring.export_snapshots snapshot
    WHERE (expires_at<=clock_timestamp()
      OR EXISTS(SELECT 1 FROM private_scoring.subject_revocations revoked WHERE revoked.user_id=snapshot.subject_user_id))
    ORDER BY snapshot.subject_user_id,expires_at,job_id LIMIT batch_limit FOR UPDATE OF snapshot SKIP LOCKED
  ), selected AS MATERIALIZED (
    SELECT snapshot.job_id FROM private_scoring.export_snapshots snapshot
    JOIN candidates ON candidates.job_id=snapshot.job_id
    WHERE pg_try_advisory_xact_lock(hashtextextended(candidates.subject_user_id::text,260044))
      AND (snapshot.expires_at<=clock_timestamp()
        OR EXISTS(SELECT 1 FROM private_scoring.subject_revocations revoked WHERE revoked.user_id=snapshot.subject_user_id))
  ) DELETE FROM private_scoring.export_snapshots snapshot USING selected WHERE snapshot.job_id=selected.job_id;
  GET DIAGNOSTICS job_count=ROW_COUNT;
  RETURN jsonb_build_object('generations_deleted',generation_count,'snapshots_deleted',job_count);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION USING ERRCODE='58000',MESSAGE='SCORING_RETENTION_UNAVAILABLE';
END $$;
