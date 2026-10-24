-- Raw references are immutable event data, not an immediate foreign-key claim.
-- Offline actions may arrive before their genuine qualifying impression.
ALTER TABLE telemetry.interaction_events ADD COLUMN impression_event_id uuid;
ALTER TABLE telemetry.interaction_events ADD CONSTRAINT interaction_events_impression_ref_check CHECK(
  impression_event_id IS NULL OR(event_type<>'impression' AND serve_id IS NOT NULL AND position IS NOT NULL)
);

-- Version two freezes original-ID resolution in this same RR snapshot.
-- Existing v1 snapshots and approved policy digests keep their exact shape.
CREATE OR REPLACE FUNCTION private_scoring.create_export_snapshot(principal uuid,subject uuid,window_from timestamptz,window_to timestamptz,policy_text text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  policy jsonb; approved_digest text; observation timestamptz:=clock_timestamp(); expiry timestamptz;
  job uuid:=gen_random_uuid(); rows_json jsonb; manifest_json jsonb; event_count integer; earliest_expiry timestamptz;
BEGIN
  IF current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION 'invalid'; END IF;
  IF octet_length(policy_text)>2048 THEN RAISE EXCEPTION 'invalid'; END IF;
  policy:=policy_text::jsonb;
  IF NOT private_scoring.exact_keys(policy,ARRAY['policyId','policyVersion','snapshotTtlSeconds','labelHorizonSeconds','lateArrivalSeconds','clockSkewSeconds','labelerVersion'])
    OR COALESCE(policy->>'labelerVersion','') NOT IN ('scoring-labels-v1','scoring-labels-v2') THEN RAISE EXCEPTION 'invalid'; END IF;
  IF jsonb_typeof(policy->'policyId') IS DISTINCT FROM 'string' OR jsonb_typeof(policy->'policyVersion') IS DISTINCT FROM 'string'
    OR octet_length(policy->>'policyId') NOT BETWEEN 1 AND 128 OR octet_length(policy->>'policyVersion') NOT BETWEEN 1 AND 128
    OR btrim(policy->>'policyId')<>policy->>'policyId' OR btrim(policy->>'policyVersion')<>policy->>'policyVersion' THEN RAISE EXCEPTION 'invalid'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(policy) entry WHERE entry.key IN ('snapshotTtlSeconds','labelHorizonSeconds','lateArrivalSeconds','clockSkewSeconds')
    AND (jsonb_typeof(entry.value)<>'number' OR entry.value::text !~ '^(0|[1-9][0-9]{0,6})$'))
    OR (policy->>'snapshotTtlSeconds')::integer NOT BETWEEN 60 AND 86400
    OR (policy->>'labelHorizonSeconds')::integer NOT BETWEEN 1 AND 604800
    OR (policy->>'lateArrivalSeconds')::integer NOT BETWEEN 0 AND 604800
    OR (policy->>'clockSkewSeconds')::integer NOT BETWEEN 0 AND 3600
    OR window_from IS NULL OR window_to IS NULL OR window_from>=window_to OR window_to-window_from>interval '31 days' OR window_to>observation THEN RAISE EXCEPTION 'invalid'; END IF;
  approved_digest:=encode(sha256(convert_to(policy_text,'UTF8')),'hex');
  -- Account deletion takes the parent user row before cascading to source and
  -- fence rows. Follow that same lock order, including a separate admin caller.
  PERFORM user_id FROM app.users WHERE user_id=ANY(ARRAY[principal,subject])
    ORDER BY user_id FOR KEY SHARE;
  IF NOT EXISTS(SELECT 1 FROM app.users WHERE user_id=principal)
    OR NOT EXISTS(SELECT 1 FROM app.users WHERE user_id=subject) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_FORBIDDEN'; END IF;
  PERFORM private_scoring.lock_subject(subject);
  INSERT INTO private_scoring.subject_export_fences(user_id,epoch) VALUES(subject,1)
    ON CONFLICT(user_id) DO UPDATE SET epoch=private_scoring.subject_export_fences.epoch;
  PERFORM private_scoring.authorize_export(principal,subject,approved_digest);
  IF EXISTS(SELECT 1 FROM private_scoring.subject_revocations WHERE user_id=subject) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_EXPIRED'; END IF;
  -- Short global admission lock only covers bounded snapshot materialization.
  PERFORM pg_advisory_xact_lock(260044,1);
  UPDATE private_scoring.export_admission_fence SET epoch=epoch+1 WHERE singleton;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='58000',MESSAGE='SCORING_EXPORT_UNAVAILABLE'; END IF;
  IF (SELECT count(*) FROM private_scoring.export_snapshots WHERE principal_id=principal AND expires_at>observation)>=5
    OR (SELECT count(*) FROM private_scoring.export_snapshots WHERE expires_at>observation)>=1000 THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_CAPACITY'; END IF;
  -- Bound globally matched work BEFORE constructing any event JSON. The same
  -- RR snapshot makes this preflight and the later frozen membership identical.
  IF EXISTS(SELECT 1 FROM telemetry.feed_serves serve JOIN telemetry.feed_serve_items item USING(serve_id)
    WHERE serve.user_id=subject AND serve.created_at>=window_from AND serve.created_at<window_to
    ORDER BY serve.created_at,serve.serve_id,item.position OFFSET 500 LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_BOUNDS'; END IF;
  SELECT count(*) INTO event_count FROM (
    SELECT 1 FROM telemetry.interaction_events event WHERE event.user_id=subject AND EXISTS(
      SELECT 1 FROM telemetry.feed_serves serve JOIN telemetry.feed_serve_items item USING(serve_id)
      WHERE serve.user_id=subject AND serve.created_at>=window_from AND serve.created_at<window_to
        AND event.serve_id=serve.serve_id AND event.repo_id=item.repo_id AND event.position=item.position)
    LIMIT 5001
  ) matched;
  IF event_count>5000 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_BOUNDS'; END IF;
  -- Hold exact immutable source rows through the snapshot transaction. Retention
  -- obtains the same subject lock before generation FOR UPDATE/delete.
  PERFORM generation.generation_id FROM (
    SELECT serve.serve_id,item.position FROM telemetry.feed_serves serve
    JOIN telemetry.feed_serve_items item USING(serve_id)
    WHERE serve.user_id=subject AND serve.created_at>=window_from AND serve.created_at<window_to
    ORDER BY serve.created_at,serve.serve_id,item.position LIMIT 501
  ) selected JOIN telemetry.feed_item_provenance provenance USING(serve_id,position)
  JOIN private_scoring.scoring_generations generation ON generation.generation_id=provenance.generation_id AND generation.user_id=provenance.user_id
  JOIN private_scoring.scoring_inputs input ON input.generation_id=generation.generation_id AND input.user_id=generation.user_id
  WHERE provenance.repo_id=input.repo_id AND provenance.record_digest=input.record_digest
  ORDER BY generation.generation_id,input.repo_id FOR KEY SHARE OF generation,input;
  WITH selected AS MATERIALIZED (
    SELECT serve.user_id,serve.serve_id,serve.session_id,serve.created_at AS served_at,item.repo_id,item.position,
      provenance.exposure_id,provenance.generation_id,provenance.record_digest,provenance.capture_status,
      CASE WHEN provenance.capture_status='captured' THEN NULL ELSE COALESCE(provenance.legacy_generation_hint,
        CASE WHEN provenance.generation_id IS NULL THEN serve.generation_id END) END AS legacy_generation_hint,
      generation.expires_at, input.generation_id AS found_input,
      EXISTS(SELECT 1 FROM private_scoring.generation_witnesses witness WHERE witness.generation_id=generation.generation_id AND witness.event_type='revoked') AS revoked
    FROM telemetry.feed_serves serve JOIN telemetry.feed_serve_items item USING(serve_id)
    LEFT JOIN telemetry.feed_item_provenance provenance USING(serve_id,position)
    LEFT JOIN private_scoring.scoring_generations generation ON generation.generation_id=provenance.generation_id AND generation.user_id=serve.user_id
    LEFT JOIN private_scoring.scoring_inputs input ON input.generation_id=generation.generation_id AND input.user_id=serve.user_id
      AND input.repo_id=item.repo_id AND input.record_digest=provenance.record_digest
    WHERE serve.user_id=subject AND serve.created_at>=window_from AND serve.created_at<window_to
    ORDER BY serve.created_at,serve.serve_id,item.position LIMIT 501
  ), frozen AS (
    SELECT selected.*, COALESCE((SELECT jsonb_agg(event_value ORDER BY occurred,received,event_id) FROM (
      SELECT event.event_id,event.client_occurred_at AS occurred,event.server_received_at AS received,
        jsonb_build_object('event_id',event.event_id,'user_id',event.user_id,'serve_id',event.serve_id,'repo_id',event.repo_id,
          'raw_session_id',event.session_id,'session_attribution',CASE WHEN event.session_id IS NULL THEN 'not_recorded' WHEN event.session_id=selected.session_id THEN 'matches_serve' ELSE 'differs_from_serve' END,
          'position',event.position,'event_type',event.event_type,'dwell_ms',event.dwell_ms,'feedback_version',event.feedback_version::text,
          'client_occurred_at',private_scoring.export_timestamp(event.client_occurred_at),
          'server_received_at',private_scoring.export_timestamp(event.server_received_at))
        || CASE WHEN policy->>'labelerVersion'='scoring-labels-v2' THEN jsonb_build_object(
          'impression_event_id',event.impression_event_id,'impression_linkage',CASE
            WHEN event.impression_event_id IS NULL THEN 'not_recorded'
            WHEN target_impression.event_id IS NULL THEN 'unresolved_at_cutoff'
            WHEN event.event_type<>'impression' AND target_impression.event_type='impression'
              AND target_impression.serve_id IS NOT DISTINCT FROM event.serve_id
              AND target_impression.repo_id=event.repo_id AND target_impression.position IS NOT DISTINCT FROM event.position
              AND target_impression.session_id=event.session_id AND event.session_id=selected.session_id
              AND target_impression.client_occurred_at<=event.client_occurred_at THEN 'resolved_exact'
            ELSE 'invalid_attribution' END) ELSE '{}'::jsonb END AS event_value
      FROM telemetry.interaction_events event
      LEFT JOIN telemetry.interaction_events target_impression ON policy->>'labelerVersion'='scoring-labels-v2'
        AND target_impression.event_id=event.impression_event_id AND target_impression.user_id=event.user_id
      WHERE event.user_id=selected.user_id AND event.serve_id=selected.serve_id
        AND event.repo_id=selected.repo_id AND event.position=selected.position
      ORDER BY event.client_occurred_at,event.server_received_at,event.event_id LIMIT 5001
    ) observed_events),'[]'::jsonb) AS events FROM selected
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',user_id,'serve_id',serve_id,'repo_id',repo_id,'position',position,
      'session_id',session_id,'exposure_id',exposure_id,'served_at',private_scoring.export_timestamp(served_at),
      'generation_id',generation_id,'legacy_generation_hint',legacy_generation_hint,'record_digest',record_digest,
      'source_status',CASE WHEN capture_status IS NULL THEN 'legacy_unknown' WHEN capture_status='not_captured' THEN 'not_captured'
        WHEN found_input IS NULL OR expires_at<=observation OR revoked THEN 'provenance_unavailable' ELSE 'captured' END,
      'source_expires_at',CASE WHEN capture_status='captured' AND found_input IS NOT NULL AND expires_at>observation AND NOT revoked
        THEN private_scoring.export_timestamp(expires_at) ELSE NULL END,'events',events)
    ORDER BY served_at,serve_id,position),'[]'::jsonb),COALESCE(sum(jsonb_array_length(events)),0),
    min(expires_at) FILTER(WHERE capture_status='captured' AND found_input IS NOT NULL AND expires_at>observation AND NOT revoked)
  INTO rows_json,event_count,earliest_expiry FROM frozen;
  IF jsonb_array_length(rows_json)>500 OR event_count>5000 OR octet_length(rows_json::text)>8300000 THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_BOUNDS'; END IF;
  expiry:=least(observation+(policy->>'snapshotTtlSeconds')::integer*interval '1 second',earliest_expiry);
  manifest_json:=jsonb_build_object('job_id',job,'principal_id',principal,'subject_user_id',subject,
    'observed_at',private_scoring.export_timestamp(observation),'pg_snapshot',pg_current_snapshot()::text,
    'expires_at',private_scoring.export_timestamp(expiry),'served_from',private_scoring.export_timestamp(window_from),
    'served_to',private_scoring.export_timestamp(window_to),'policy',policy,'row_count',jsonb_array_length(rows_json),'event_count',event_count);
  INSERT INTO private_scoring.export_snapshots(job_id,principal_id,subject_user_id,policy_digest,manifest,frozen_rows,expires_at)
    VALUES(job,principal,subject,approved_digest,manifest_json,rows_json,expiry);
  RETURN jsonb_build_object('manifest',manifest_json,'frozen_rows',rows_json);
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE='P0001' AND SQLERRM IN ('SCORING_EXPORT_FORBIDDEN','SCORING_EXPORT_EXPIRED','SCORING_EXPORT_CAPACITY','SCORING_EXPORT_BOUNDS') THEN RAISE; END IF;
  IF SQLSTATE='40001' THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='SCORING_EXPORT_RETRY'; END IF;
  IF (SQLSTATE='P0001' AND SQLERRM='invalid') OR left(SQLSTATE,2) IN ('22','23') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='SCORING_EXPORT_INVALID'; END IF;
  RAISE EXCEPTION USING ERRCODE='58000',MESSAGE='SCORING_EXPORT_UNAVAILABLE';
END $$;

CREATE OR REPLACE FUNCTION private_scoring.seal_export_labels(principal uuid,job uuid,approved_digest text,labels_text text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE snapshot private_scoring.export_snapshots%ROWTYPE; labels jsonb; label jsonb; exposure jsonb;
  ordinal integer:=0; key text; ids jsonb; value jsonb; input_wire jsonb; is_v2 boolean; link jsonb;
BEGIN
  IF current_setting('transaction_isolation')<>'repeatable read' OR octet_length(labels_text)>2097152 THEN RAISE EXCEPTION 'invalid'; END IF;
  SELECT * INTO snapshot FROM private_scoring.export_snapshots WHERE job_id=job AND principal_id=principal;
  IF NOT FOUND OR snapshot.created_xid<>pg_current_xact_id() OR snapshot.policy_digest<>approved_digest THEN RAISE EXCEPTION 'invalid'; END IF;
  PERFORM private_scoring.authorize_export(principal,snapshot.subject_user_id,approved_digest);
  IF snapshot.expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM private_scoring.subject_revocations WHERE user_id=snapshot.subject_user_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_EXPIRED'; END IF;
  is_v2:=snapshot.manifest->'policy'->>'labelerVersion'='scoring-labels-v2';
  labels:=labels_text::jsonb;
  IF jsonb_typeof(labels) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid'; END IF;
  IF jsonb_array_length(labels)<>jsonb_array_length(snapshot.frozen_rows) THEN RAISE EXCEPTION 'invalid'; END IF;
  IF octet_length(labels::text)+octet_length(snapshot.frozen_rows::text)+octet_length(snapshot.manifest::text)>8388608 THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_BOUNDS'; END IF;
  FOR label IN SELECT element FROM jsonb_array_elements(labels) entry(element) LOOP
    exposure:=snapshot.frozen_rows->ordinal; ordinal:=ordinal+1;
    IF NOT private_scoring.exact_keys(label,ARRAY['labeler_version','attribution_method','original_client_impression_linkage','observation_completeness',
      'observed_at','selected_impression_event_id','observed_impression_event_ids','multiple_impressions','outcome_status','right_censored',
      'horizon_end','late_arrival_risk','action_counts','invalid_session_event_ids','clock_invalid_event_ids','unqualified_dwell_event_ids','outside_horizon_event_ids',
      'unsupported_event_types','unavailable_targets','product_transition_state']||CASE WHEN is_v2 THEN ARRAY['impression_links'] ELSE ARRAY[]::text[] END)
      OR label->>'labeler_version' IS DISTINCT FROM snapshot.manifest->'policy'->>'labelerVersion'
      OR label->>'attribution_method' IS DISTINCT FROM (CASE WHEN is_v2 THEN 'original_impression_v2' ELSE 'serve_tuple_v1' END)
      OR label->>'original_client_impression_linkage' IS DISTINCT FROM (CASE WHEN is_v2 THEN 'recorded_per_event' ELSE 'not_recorded' END)
      OR label->>'observation_completeness' IS DISTINCT FROM 'cutoff_observed'
      OR label->>'observed_at' IS DISTINCT FROM snapshot.manifest->>'observed_at'
      OR label->'late_arrival_risk' IS DISTINCT FROM 'true'::jsonb
      OR label->'unavailable_targets' IS DISTINCT FROM '["starred","dismissed","follow"]'::jsonb
      OR label->>'product_transition_state' IS DISTINCT FROM 'not_inferred'
      OR jsonb_typeof(label->'multiple_impressions') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(label->'right_censored') IS DISTINCT FROM 'boolean'
      OR (label->>'outcome_status'=ANY(ARRAY['unobserved','attribution_uncertain','clock_uncertain','unsupported_events','positive_observed','explicit_negative_observed',
        'inverse_only_observed','no_action_observed_by_cutoff','right_censored'])) IS DISTINCT FROM true THEN RAISE EXCEPTION 'invalid'; END IF;
    SELECT COALESCE(jsonb_agg(event->'event_id'),'[]'::jsonb) INTO ids FROM jsonb_array_elements(exposure->'events') entry(event);
    IF label->'selected_impression_event_id'<>'null'::jsonb AND NOT ids @> jsonb_build_array(label->'selected_impression_event_id') THEN RAISE EXCEPTION 'invalid'; END IF;
    IF label->'horizon_end'<>'null'::jsonb AND (jsonb_typeof(label->'horizon_end')<>'string' OR char_length(label->>'horizon_end')>32) THEN RAISE EXCEPTION 'invalid'; END IF;
    FOREACH key IN ARRAY ARRAY['observed_impression_event_ids','invalid_session_event_ids','clock_invalid_event_ids','unqualified_dwell_event_ids','outside_horizon_event_ids'] LOOP
      IF jsonb_typeof(label->key) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid'; END IF;
      IF jsonb_array_length(label->key)>jsonb_array_length(exposure->'events') OR NOT ids @> (label->key) THEN RAISE EXCEPTION 'invalid'; END IF;
    END LOOP;
    IF NOT private_scoring.exact_keys(label->'action_counts',ARRAY['dwell','readme_open','github_open','share','like','unlike','dislike','undislike','save','unsave']) THEN RAISE EXCEPTION 'invalid'; END IF;
    FOR value IN SELECT entry.value FROM jsonb_each(label->'action_counts') entry LOOP
      IF jsonb_typeof(value)<>'number' OR value::text !~ '^(0|[1-9][0-9]{0,3})$' OR value::text::integer>5000 THEN RAISE EXCEPTION 'invalid'; END IF;
    END LOOP;
    IF jsonb_typeof(label->'unsupported_event_types') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid'; END IF;
    IF jsonb_array_length(label->'unsupported_event_types')>jsonb_array_length(exposure->'events')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(label->'unsupported_event_types') entry(value) WHERE jsonb_typeof(entry.value)<>'string' OR char_length(entry.value#>>'{}') NOT BETWEEN 1 AND 64) THEN RAISE EXCEPTION 'invalid'; END IF;
    IF is_v2 THEN
      IF jsonb_typeof(label->'impression_links') IS DISTINCT FROM 'array'
        OR jsonb_array_length(label->'impression_links')<>(SELECT count(*) FROM jsonb_array_elements(exposure->'events') entry(event) WHERE event->>'event_type'<>'impression')
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(label->'impression_links') entry(link) GROUP BY entry.link->>'event_id' HAVING count(*)>1)
        THEN RAISE EXCEPTION 'invalid'; END IF;
      FOR link IN SELECT element FROM jsonb_array_elements(label->'impression_links') entry(element) LOOP
        IF NOT private_scoring.exact_keys(link,ARRAY['event_id','impression_event_id','status'])
          OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(exposure->'events') entry(event)
            WHERE event->>'event_type'<>'impression' AND event->>'event_id'=link->>'event_id'
              AND event->'impression_event_id' IS NOT DISTINCT FROM link->'impression_event_id'
              AND event->>'impression_linkage'=link->>'status') THEN RAISE EXCEPTION 'invalid'; END IF;
      END LOOP;
    END IF;
    input_wire:=NULL;
    IF exposure->>'source_status'='captured' THEN
      SELECT jsonb_build_object('context_json',convert_from(generation.context_bytes,'UTF8'),'context_digest',generation.context_digest,
        'snapshot_json',convert_from(input.snapshot_bytes,'UTF8'),'input_base64',replace(encode(input.input_bytes,'base64'),E'\n',''),
        'binding_sha256',input.binding_digest,'stage_json',convert_from(input.stage_bytes,'UTF8'),'record_digest',input.record_digest)
      INTO input_wire FROM private_scoring.scoring_generations generation JOIN private_scoring.scoring_inputs input USING(generation_id,user_id)
      WHERE generation.generation_id=(exposure->>'generation_id')::uuid AND generation.user_id=snapshot.subject_user_id
        AND input.repo_id=(exposure->>'repo_id')::uuid AND input.record_digest=exposure->>'record_digest';
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_EXPIRED'; END IF;
    END IF;
    -- PostgreSQL's spaced JSON is a conservative bound for this string/integer
    -- wire shape. Reject atomically if even a complete one-row page cannot fit;
    -- never create a job that can only fail or truncate a raw event list later.
    IF octet_length(jsonb_build_object('manifest',snapshot.manifest,'rows',jsonb_build_array(jsonb_build_object(
      'ordinal',ordinal,'exposure',exposure,'labels',label||jsonb_build_object('raw_events',exposure->'events'),'input',input_wire)),
      'next_after',CASE WHEN ordinal<jsonb_array_length(snapshot.frozen_rows) THEN ordinal ELSE NULL END)::text)>1000000 THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_BOUNDS'; END IF;
  END LOOP;
  INSERT INTO private_scoring.export_snapshot_labels(job_id,labels) VALUES(job,labels);
  RETURN snapshot.manifest;
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE='P0001' AND SQLERRM IN ('SCORING_EXPORT_FORBIDDEN','SCORING_EXPORT_EXPIRED','SCORING_EXPORT_BOUNDS') THEN RAISE; END IF;
  IF SQLSTATE='40001' THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='SCORING_EXPORT_RETRY'; END IF;
  IF (SQLSTATE='P0001' AND SQLERRM='invalid') OR left(SQLSTATE,2) IN ('22','23') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='SCORING_EXPORT_INVALID'; END IF;
  RAISE EXCEPTION USING ERRCODE='58000',MESSAGE='SCORING_EXPORT_UNAVAILABLE';
END $$;
