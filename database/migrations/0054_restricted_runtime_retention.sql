-- Topic INSERT already belongs to the runtime role; its serial allocator does too.
GRANT USAGE ON SEQUENCE app.topics_topic_id_seq TO ghsocial_backend;
--> statement-breakpoint
-- Restrict retention to this operation instead of exposing DELETE on the
-- immutable model-operation journal or arbitrary telemetry rows.
CREATE FUNCTION telemetry.prune_runtime_history(delivered_days integer DEFAULT 30,generation_days integer DEFAULT 30)
RETURNS TABLE(outbox integer,generations integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF delivered_days IS NULL OR delivered_days<1
    OR generation_days IS NULL OR generation_days<1 THEN
    RAISE EXCEPTION 'Retention days must be positive' USING ERRCODE='22023';
  END IF;
  WITH removed AS (

      WITH versioned_indexes AS (
        SELECT outbox_id,aggregate_id,created_at,
          CASE WHEN payload->>'content_version' ~ '^[1-9][0-9]{0,9}$'
            THEN CASE WHEN (payload->>'content_version')::numeric <= 2147483647
              THEN (payload->>'content_version')::numeric END
          END AS content_version
        FROM telemetry.ml_outbox
        WHERE job_type='repo_index' AND status='delivered'
      ), numeric_checkpoints AS (
        SELECT DISTINCT ON (aggregate_id) outbox_id
        FROM versioned_indexes WHERE content_version IS NOT NULL
        ORDER BY aggregate_id,content_version DESC,created_at DESC,outbox_id DESC
      )
      DELETE FROM telemetry.ml_outbox expired
      WHERE expired.job_type<>'model_operation' AND expired.status='delivered' AND expired.delivered_at < now()-(delivered_days::text || ' days')::interval
        -- Keep both the legacy/latest-time witness and the highest valid int32
        -- content version. A same-transaction UUID or malformed newer payload
        -- must not erase the index prerequisite for a numeric successor.
        AND NOT EXISTS (SELECT 1 FROM numeric_checkpoints checkpoint WHERE checkpoint.outbox_id=expired.outbox_id)
        AND (expired.job_type<>'repo_index' OR EXISTS (
          SELECT 1 FROM telemetry.ml_outbox newer
          WHERE newer.aggregate_id=expired.aggregate_id AND newer.job_type='repo_index'
            AND newer.status='delivered'
            AND (newer.created_at,newer.outbox_id)>(expired.created_at,expired.outbox_id)
        ))
      RETURNING 1

  ) SELECT count(*)::integer INTO outbox FROM removed;
  WITH removed AS (
    DELETE FROM telemetry.generation_attempts WHERE created_at < now()-(generation_days::text || ' days')::interval RETURNING 1
  ) SELECT count(*)::integer INTO generations FROM removed;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION telemetry.prune_runtime_history(integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION telemetry.prune_runtime_history(integer,integer) TO ghsocial_backend;
