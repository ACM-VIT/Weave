-- Headers remain durable serve/capture provenance after their context expires.
ALTER TABLE telemetry.feed_model_generations ALTER COLUMN applied_context DROP NOT NULL;
ALTER TABLE telemetry.feed_model_generations ADD CONSTRAINT model_context_live_body
  CHECK(applied_context IS NOT NULL OR valid_until_ms<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
CREATE INDEX feed_model_generations_expired_body ON telemetry.feed_model_generations(valid_until_ms,generation_id) WHERE applied_context IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION telemetry.prune_model_transients(batch_limit integer DEFAULT 1000)
RETURNS TABLE(contexts integer,feedback_copies integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE bounded integer:=greatest(1,least(coalesce(batch_limit,1000),1000));
BEGIN
  WITH candidates AS MATERIALIZED (
    SELECT generation_id FROM telemetry.feed_model_generations
    WHERE applied_context IS NOT NULL AND valid_until_ms<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
    ORDER BY valid_until_ms,generation_id LIMIT bounded FOR UPDATE SKIP LOCKED
  ), changed AS (
    UPDATE telemetry.feed_model_generations g SET applied_context=NULL FROM candidates c WHERE g.generation_id=c.generation_id RETURNING 1
  ) SELECT count(*)::integer INTO contexts FROM changed;
  -- Delivered is Redis acceptance, not application. The immutable model outbox
  -- journal is retained independently and is the exact original byte witness.
  WITH candidates AS MATERIALIZED (
    SELECT p.event_id FROM telemetry.pending_model_feedback p
    JOIN telemetry.ml_outbox o ON o.outbox_id=p.operation_id AND o.aggregate_id=p.user_id
    JOIN app.user_feed_state s ON s.user_id=p.user_id AND s.model_initialized
    WHERE o.job_type='model_operation' AND o.status='delivered'
      AND o.operation_json::jsonb->>'kind'='feedback'
      AND o.operation_json::jsonb->'operation'->>'original_feedback_json'=p.original_feedback_json
    ORDER BY p.accepted_at_ms,p.event_id LIMIT bounded FOR UPDATE OF p SKIP LOCKED
  ), removed AS (
    DELETE FROM telemetry.pending_model_feedback p USING candidates c WHERE p.event_id=c.event_id RETURNING 1
  ) SELECT count(*)::integer INTO feedback_copies FROM removed;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION telemetry.prune_model_transients(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION telemetry.prune_model_transients(integer) TO ghsocial_backend;
