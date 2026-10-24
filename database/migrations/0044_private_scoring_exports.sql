-- Empty authorization registry and NOLOGIN roles: no collection/export activation.
CREATE TABLE private_scoring.export_authorizations (
  principal_id uuid NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  policy_digest text NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
  scope text NOT NULL CHECK(scope IN ('owner','admin')),
  subject_ids uuid[] NOT NULL CHECK(cardinality(subject_ids) BETWEEN 1 AND 100 AND array_position(subject_ids,NULL) IS NULL),
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  PRIMARY KEY(principal_id,policy_digest),
  CHECK(scope<>'owner' OR subject_ids=ARRAY[principal_id])
);
CREATE TABLE private_scoring.subject_revocations (
  user_id uuid PRIMARY KEY REFERENCES app.users(user_id) ON DELETE CASCADE,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- A write conflict fences an RR snapshot created before a concurrent revoke.
-- Advisory locking alone would leave that old visibility snapshot unchanged.
CREATE TABLE private_scoring.subject_export_fences (
  user_id uuid PRIMARY KEY REFERENCES app.users(user_id) ON DELETE CASCADE,
  epoch bigint NOT NULL CHECK(epoch>0)
);
-- A singleton write turns an admission lock acquired under an old RR snapshot
-- into a40001 whole-transaction retry; advisory serialization alone is stale.
CREATE TABLE private_scoring.export_admission_fence (
  singleton boolean PRIMARY KEY CHECK(singleton), epoch bigint NOT NULL CHECK(epoch>0)
);
INSERT INTO private_scoring.export_admission_fence(singleton,epoch) VALUES(true,1);
CREATE TABLE private_scoring.export_snapshots (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  subject_user_id uuid NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  policy_digest text NOT NULL,
  manifest jsonb NOT NULL,
  frozen_rows jsonb NOT NULL CHECK(jsonb_typeof(frozen_rows)='array' AND jsonb_array_length(frozen_rows)<=500),
  created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  expires_at timestamptz NOT NULL,
  CHECK(octet_length(manifest::text)+octet_length(frozen_rows::text)<=8388608)
);
CREATE TABLE private_scoring.export_snapshot_labels (
  job_id uuid PRIMARY KEY REFERENCES private_scoring.export_snapshots(job_id) ON DELETE CASCADE,
  labels jsonb NOT NULL CHECK(jsonb_typeof(labels)='array' AND jsonb_array_length(labels)<=500 AND octet_length(labels::text)<=2097152)
);
CREATE TRIGGER export_snapshot_labels_immutable BEFORE UPDATE ON private_scoring.export_snapshot_labels
  FOR EACH ROW EXECUTE FUNCTION private_scoring.reject_update();
CREATE INDEX export_snapshots_expiry_idx ON private_scoring.export_snapshots(expires_at,job_id);
CREATE INDEX export_snapshots_principal_idx ON private_scoring.export_snapshots(principal_id,expires_at);
CREATE TRIGGER export_snapshots_immutable BEFORE UPDATE ON private_scoring.export_snapshots
  FOR EACH ROW EXECUTE FUNCTION private_scoring.reject_update();
CREATE TRIGGER subject_revocations_immutable BEFORE UPDATE ON private_scoring.subject_revocations
  FOR EACH ROW EXECUTE FUNCTION private_scoring.reject_update();

CREATE FUNCTION private_scoring.export_timestamp(value timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT to_char(value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;
CREATE FUNCTION private_scoring.lock_subject(value uuid) RETURNS void
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT pg_advisory_xact_lock(hashtextextended(value::text,260044))
$$;
CREATE FUNCTION private_scoring.enforce_subject_capture_barrier() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_SCHEMA='telemetry' THEN
    IF NEW.capture_status<>'captured' THEN RETURN NEW; END IF;
  END IF;
  PERFORM private_scoring.lock_subject(NEW.user_id);
  IF EXISTS(SELECT 1 FROM private_scoring.subject_revocations WHERE user_id=NEW.user_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_CAPTURE_EXPIRED';
  END IF;
  RETURN NEW;
END $$;
-- BEFORE INSERT also runs on ON CONFLICT retries; no persistence API replacement.
CREATE TRIGGER scoring_generations_subject_barrier BEFORE INSERT ON private_scoring.scoring_generations
  FOR EACH ROW EXECUTE FUNCTION private_scoring.enforce_subject_capture_barrier();
-- Lexically precedes 0043's generation/input KEY SHARE validation.
CREATE TRIGGER a_scoring_subject_exposure_barrier BEFORE INSERT ON telemetry.feed_item_provenance
  FOR EACH ROW EXECUTE FUNCTION private_scoring.enforce_subject_capture_barrier();

CREATE FUNCTION private_scoring.authorize_export(principal uuid,subject uuid,approved_digest text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  PERFORM 1 FROM private_scoring.export_authorizations grant_record
    WHERE grant_record.principal_id=principal AND grant_record.policy_digest=approved_digest
      AND NOT grant_record.revoked AND grant_record.expires_at>clock_timestamp()
      AND subject=ANY(grant_record.subject_ids) AND (grant_record.scope='admin' OR principal=subject)
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_FORBIDDEN';
  END IF;
END $$;

CREATE FUNCTION private_scoring.create_export_snapshot(principal uuid,subject uuid,window_from timestamptz,window_to timestamptz,policy_text text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  policy jsonb; approved_digest text; observation timestamptz:=clock_timestamp(); expiry timestamptz;
  job uuid:=gen_random_uuid(); rows_json jsonb; manifest_json jsonb; event_count integer; earliest_expiry timestamptz;
BEGIN
  IF current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION 'invalid'; END IF;
  IF octet_length(policy_text)>2048 THEN RAISE EXCEPTION 'invalid'; END IF;
  policy:=policy_text::jsonb;
  IF NOT private_scoring.exact_keys(policy,ARRAY['policyId','policyVersion','snapshotTtlSeconds','labelHorizonSeconds','lateArrivalSeconds','clockSkewSeconds','labelerVersion'])
    OR policy->>'labelerVersion' IS DISTINCT FROM 'scoring-labels-v1' THEN RAISE EXCEPTION 'invalid'; END IF;
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
          'server_received_at',private_scoring.export_timestamp(event.server_received_at)) AS event_value
      FROM telemetry.interaction_events event WHERE event.user_id=selected.user_id AND event.serve_id=selected.serve_id
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

CREATE FUNCTION private_scoring.seal_export_labels(principal uuid,job uuid,approved_digest text,labels_text text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE snapshot private_scoring.export_snapshots%ROWTYPE; labels jsonb; label jsonb; exposure jsonb;
  ordinal integer:=0; key text; ids jsonb; value jsonb; input_wire jsonb;
BEGIN
  IF current_setting('transaction_isolation')<>'repeatable read' OR octet_length(labels_text)>2097152 THEN RAISE EXCEPTION 'invalid'; END IF;
  SELECT * INTO snapshot FROM private_scoring.export_snapshots WHERE job_id=job AND principal_id=principal;
  IF NOT FOUND OR snapshot.created_xid<>pg_current_xact_id() OR snapshot.policy_digest<>approved_digest THEN RAISE EXCEPTION 'invalid'; END IF;
  PERFORM private_scoring.authorize_export(principal,snapshot.subject_user_id,approved_digest);
  IF snapshot.expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM private_scoring.subject_revocations WHERE user_id=snapshot.subject_user_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_EXPIRED'; END IF;
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
      'unsupported_event_types','unavailable_targets','product_transition_state'])
      OR label->>'labeler_version' IS DISTINCT FROM 'scoring-labels-v1'
      OR label->>'attribution_method' IS DISTINCT FROM 'serve_tuple_v1'
      OR label->>'original_client_impression_linkage' IS DISTINCT FROM 'not_recorded'
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

CREATE FUNCTION private_scoring.read_export_snapshot(principal uuid,job uuid,approved_digest text,after_ordinal integer,page_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE snapshot private_scoring.export_snapshots%ROWTYPE; values_json jsonb;
BEGIN
  IF after_ordinal IS NULL OR page_limit IS NULL OR after_ordinal<0 OR after_ordinal>500 OR page_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid'; END IF;
  SELECT * INTO snapshot FROM private_scoring.export_snapshots WHERE job_id=job AND principal_id=principal;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_FORBIDDEN'; END IF;
  PERFORM user_id FROM app.users WHERE user_id=ANY(ARRAY[principal,snapshot.subject_user_id]) ORDER BY user_id FOR KEY SHARE;
  PERFORM private_scoring.lock_subject(snapshot.subject_user_id);
  PERFORM private_scoring.authorize_export(principal,snapshot.subject_user_id,approved_digest);
  IF snapshot.policy_digest<>approved_digest OR snapshot.expires_at<=clock_timestamp()
    OR EXISTS(SELECT 1 FROM private_scoring.subject_revocations WHERE user_id=snapshot.subject_user_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_EXPIRED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM private_scoring.export_snapshot_labels WHERE job_id=job) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_EXPIRED'; END IF;
  PERFORM generation.generation_id FROM private_scoring.scoring_generations generation
    JOIN private_scoring.scoring_inputs input USING(generation_id,user_id)
    WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot.frozen_rows) frozen(value)
      WHERE value->>'source_status'='captured' AND generation.generation_id=(value->>'generation_id')::uuid
        AND input.repo_id=(value->>'repo_id')::uuid AND input.record_digest=value->>'record_digest')
    ORDER BY generation.generation_id,input.repo_id FOR KEY SHARE OF generation,input;
  -- Any missing formerly-captured input invalidates this whole frozen export,
  -- including when the missing row would be on a different page.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot.frozen_rows) frozen(value)
    LEFT JOIN private_scoring.scoring_generations generation ON generation.generation_id=(value->>'generation_id')::uuid AND generation.user_id=snapshot.subject_user_id
    LEFT JOIN private_scoring.scoring_inputs input ON input.generation_id=generation.generation_id AND input.user_id=snapshot.subject_user_id
      AND input.repo_id=(value->>'repo_id')::uuid AND input.record_digest=value->>'record_digest'
    WHERE value->>'source_status'='captured' AND (input.generation_id IS NULL OR generation.expires_at<=clock_timestamp()
      OR EXISTS(SELECT 1 FROM private_scoring.generation_witnesses witness WHERE witness.generation_id=generation.generation_id AND witness.event_type='revoked'))) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_EXPIRED'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ordinal',ordinal,'exposure',value,
    'labels',(SELECT labels->(ordinal::integer-1) FROM private_scoring.export_snapshot_labels WHERE job_id=job),
    'input',CASE WHEN value->>'source_status'='captured' THEN
    jsonb_build_object('context_json',convert_from(generation.context_bytes,'UTF8'),'context_digest',generation.context_digest,
      'snapshot_json',convert_from(input.snapshot_bytes,'UTF8'),'input_base64',replace(encode(input.input_bytes,'base64'),E'\n',''),
      'binding_sha256',input.binding_digest,'stage_json',convert_from(input.stage_bytes,'UTF8'),'record_digest',input.record_digest)
    ELSE NULL END) ORDER BY ordinal),'[]'::jsonb) INTO values_json
  FROM (SELECT value,ordinal FROM jsonb_array_elements(snapshot.frozen_rows) WITH ORDINALITY frozen(value,ordinal)
    WHERE ordinal>after_ordinal ORDER BY ordinal LIMIT page_limit) page
  LEFT JOIN private_scoring.scoring_generations generation ON generation.generation_id=(value->>'generation_id')::uuid AND generation.user_id=snapshot.subject_user_id
  LEFT JOIN private_scoring.scoring_inputs input ON input.generation_id=generation.generation_id AND input.user_id=snapshot.subject_user_id
    AND input.repo_id=(value->>'repo_id')::uuid AND input.record_digest=value->>'record_digest';
  IF snapshot.expires_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_EXPORT_EXPIRED'; END IF;
  PERFORM private_scoring.authorize_export(principal,snapshot.subject_user_id,approved_digest);
  RETURN jsonb_build_object('manifest',snapshot.manifest,'rows',values_json);
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE='P0001' AND SQLERRM IN ('SCORING_EXPORT_FORBIDDEN','SCORING_EXPORT_EXPIRED') THEN RAISE; END IF;
  IF SQLSTATE='40001' THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='SCORING_EXPORT_RETRY'; END IF;
  IF (SQLSTATE='P0001' AND SQLERRM='invalid') OR left(SQLSTATE,2) IN ('22','23') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='SCORING_EXPORT_INVALID'; END IF;
  RAISE EXCEPTION USING ERRCODE='58000',MESSAGE='SCORING_EXPORT_UNAVAILABLE';
END $$;

CREATE FUNCTION private_scoring.revoke_subject_capture(principal uuid,subject uuid,approved_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM user_id FROM app.users WHERE user_id=ANY(ARRAY[principal,subject]) ORDER BY user_id FOR KEY SHARE;
  PERFORM private_scoring.lock_subject(subject);
  PERFORM private_scoring.authorize_export(principal,subject,approved_digest);
  INSERT INTO private_scoring.subject_export_fences(user_id,epoch) VALUES(subject,1)
    ON CONFLICT(user_id) DO UPDATE SET epoch=private_scoring.subject_export_fences.epoch+1;
  INSERT INTO private_scoring.subject_revocations(user_id) VALUES(subject) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('revoked',true,'purge_pending',true);
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE='P0001' AND SQLERRM='SCORING_EXPORT_FORBIDDEN' THEN RAISE; END IF;
  IF SQLSTATE='40001' THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='SCORING_EXPORT_RETRY'; END IF;
  IF (SQLSTATE='P0001' AND SQLERRM='invalid') OR left(SQLSTATE,2) IN ('22','23') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='SCORING_EXPORT_INVALID'; END IF;
  RAISE EXCEPTION USING ERRCODE='58000',MESSAGE='SCORING_EXPORT_UNAVAILABLE';
END $$;

CREATE FUNCTION private_scoring.purge_scoring_private(batch_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE generation_count integer; job_count integer;
BEGIN
  IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid'; END IF;
  WITH selected AS (SELECT generation.generation_id FROM private_scoring.scoring_generations generation
    WHERE (expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM private_scoring.subject_revocations revoked WHERE revoked.user_id=generation.user_id)
      OR EXISTS(SELECT 1 FROM private_scoring.generation_witnesses witness WHERE witness.generation_id=generation.generation_id AND witness.event_type='revoked'))
    AND pg_try_advisory_xact_lock(hashtextextended(generation.user_id::text,260044))
    ORDER BY generation.user_id,generation.generation_id FOR UPDATE SKIP LOCKED LIMIT batch_limit)
  DELETE FROM private_scoring.scoring_generations generation USING selected WHERE generation.generation_id=selected.generation_id;
  GET DIAGNOSTICS generation_count=ROW_COUNT;
  WITH selected AS (SELECT job_id FROM private_scoring.export_snapshots snapshot WHERE (expires_at<=clock_timestamp()
    OR EXISTS(SELECT 1 FROM private_scoring.subject_revocations revoked WHERE revoked.user_id=snapshot.subject_user_id))
    AND pg_try_advisory_xact_lock(hashtextextended(snapshot.subject_user_id::text,260044))
    ORDER BY snapshot.subject_user_id,expires_at,job_id FOR UPDATE SKIP LOCKED LIMIT batch_limit)
  DELETE FROM private_scoring.export_snapshots snapshot USING selected WHERE snapshot.job_id=selected.job_id;
  GET DIAGNOSTICS job_count=ROW_COUNT;
  RETURN jsonb_build_object('generations_deleted',generation_count,'snapshots_deleted',job_count);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION USING ERRCODE='58000',MESSAGE='SCORING_RETENTION_UNAVAILABLE';
END $$;

REVOKE ALL ON private_scoring.export_admission_fence,private_scoring.export_authorizations,private_scoring.subject_revocations,private_scoring.subject_export_fences,private_scoring.export_snapshots,private_scoring.export_snapshot_labels
  FROM PUBLIC,ghsocial_backend,ghsocial_scoring_writer,ghsocial_scoring_exporter,ghsocial_scoring_retention;
REVOKE ALL ON FUNCTION private_scoring.export_timestamp(timestamptz),private_scoring.lock_subject(uuid),
  private_scoring.enforce_subject_capture_barrier(),private_scoring.authorize_export(uuid,uuid,text),
  private_scoring.create_export_snapshot(uuid,uuid,timestamptz,timestamptz,text),private_scoring.read_export_snapshot(uuid,uuid,text,integer,integer),
  private_scoring.seal_export_labels(uuid,uuid,text,text),
  private_scoring.revoke_subject_capture(uuid,uuid,text),private_scoring.purge_scoring_private(integer)
  FROM PUBLIC,ghsocial_backend,ghsocial_scoring_writer,ghsocial_scoring_exporter,ghsocial_scoring_retention;
GRANT USAGE ON SCHEMA private_scoring TO ghsocial_scoring_exporter,ghsocial_scoring_retention;
GRANT EXECUTE ON FUNCTION private_scoring.create_export_snapshot(uuid,uuid,timestamptz,timestamptz,text),
  private_scoring.seal_export_labels(uuid,uuid,text,text),
  private_scoring.read_export_snapshot(uuid,uuid,text,integer,integer),private_scoring.revoke_subject_capture(uuid,uuid,text)
  TO ghsocial_scoring_exporter;
GRANT EXECUTE ON FUNCTION private_scoring.purge_scoring_private(integer) TO ghsocial_scoring_retention;
