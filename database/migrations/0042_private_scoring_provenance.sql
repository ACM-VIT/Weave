-- Private ML26 storage is outside the broad app/telemetry default grants.
-- No login, cohort, retention duration or collection/export activation is granted.
CREATE SCHEMA IF NOT EXISTS private_scoring;
REVOKE ALL ON SCHEMA private_scoring FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ghsocial_scoring_writer') THEN
    CREATE ROLE ghsocial_scoring_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ghsocial_scoring_exporter') THEN
    CREATE ROLE ghsocial_scoring_exporter NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ghsocial_scoring_retention') THEN
    CREATE ROLE ghsocial_scoring_retention NOLOGIN;
  END IF;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA private_scoring REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA private_scoring REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE OR REPLACE FUNCTION private_scoring.exact_keys(value jsonb, expected text[])
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(value)='object' THEN
    COALESCE((SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(value) AS keys(key)) =
    (SELECT array_agg(key ORDER BY key) FROM unnest(expected) AS keys(key)),false)
  ELSE false END
$$;

CREATE OR REPLACE FUNCTION private_scoring.finite_input(value bytea)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN octet_length(value)=3112 THEN NOT EXISTS (
    SELECT 1 FROM generate_series(0,777) AS offsets(n)
    WHERE (get_byte(value,n*4+3) & 127)=127 AND (get_byte(value,n*4+2) & 128)=128
  ) ELSE false END
$$;

CREATE TABLE private_scoring.scoring_generations (
  generation_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  feed_version bigint NOT NULL CHECK(feed_version>0),
  context_bytes bytea NOT NULL CHECK(octet_length(context_bytes) BETWEEN 1 AND 16384),
  context_digest text NOT NULL CHECK(context_digest ~ '^[a-f0-9]{64}$'),
  scored_at timestamptz NOT NULL,
  policy_id text NOT NULL CHECK(char_length(policy_id) BETWEEN 1 AND 128),
  policy_version text NOT NULL CHECK(char_length(policy_version) BETWEEN 1 AND 128),
  retention_days integer NOT NULL CHECK(retention_days BETWEEN 1 AND 365),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  input_count smallint NOT NULL CHECK(input_count BETWEEN 1 AND 150),
  CONSTRAINT scoring_generations_owner_key UNIQUE(generation_id,user_id),
  CONSTRAINT scoring_generations_context_digest CHECK(context_digest=encode(sha256(context_bytes),'hex')),
  CONSTRAINT scoring_generations_expiry CHECK(expires_at=created_at+retention_days*interval '24 hours')
);
CREATE INDEX scoring_generations_expiry_idx ON private_scoring.scoring_generations(expires_at,generation_id);

CREATE TABLE private_scoring.scoring_inputs (
  generation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  repo_id uuid NOT NULL REFERENCES app.repos(repo_id) ON DELETE CASCADE,
  provider_position smallint NOT NULL CHECK(provider_position BETWEEN 0 AND 149),
  snapshot_bytes bytea NOT NULL CHECK(octet_length(snapshot_bytes) BETWEEN 1 AND 4096),
  input_bytes bytea NOT NULL CHECK(private_scoring.finite_input(input_bytes)),
  binding_digest text NOT NULL CHECK(binding_digest ~ '^[a-f0-9]{64}$'),
  stage_bytes bytea NOT NULL CHECK(octet_length(stage_bytes) BETWEEN 1 AND 8192),
  record_digest text NOT NULL CHECK(record_digest ~ '^[a-f0-9]{64}$'),
  raw_heavy_score double precision NOT NULL CHECK(raw_heavy_score>'-Infinity'::double precision AND raw_heavy_score<'Infinity'::double precision),
  final_score double precision NOT NULL CHECK(final_score>'-Infinity'::double precision AND final_score<'Infinity'::double precision),
  source text NOT NULL CHECK(char_length(source) BETWEEN 1 AND 128),
  PRIMARY KEY(generation_id,repo_id),
  CONSTRAINT scoring_inputs_owner_fkey FOREIGN KEY(generation_id,user_id)
    REFERENCES private_scoring.scoring_generations(generation_id,user_id) ON DELETE CASCADE,
  CONSTRAINT scoring_inputs_position_key UNIQUE(generation_id,provider_position),
  CONSTRAINT scoring_inputs_reference_key UNIQUE(generation_id,user_id,repo_id,record_digest)
);

-- Publication/expiry/revocation witnesses can evolve separately. Tensor/context
-- rows never become mutable merely to record a queue/worker outcome.
CREATE TABLE private_scoring.generation_witnesses (
  witness_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL REFERENCES private_scoring.scoring_generations(generation_id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK(event_type IN ('persisted','published','stale','revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(generation_id,event_type)
);

CREATE OR REPLACE FUNCTION private_scoring.reject_update()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_IMMUTABLE'; END
$$;
CREATE TRIGGER scoring_generations_immutable BEFORE UPDATE ON private_scoring.scoring_generations
  FOR EACH ROW EXECUTE FUNCTION private_scoring.reject_update();
CREATE TRIGGER scoring_inputs_immutable BEFORE UPDATE ON private_scoring.scoring_inputs
  FOR EACH ROW EXECUTE FUNCTION private_scoring.reject_update();
CREATE TRIGGER scoring_witnesses_immutable BEFORE UPDATE ON private_scoring.generation_witnesses
  FOR EACH ROW EXECUTE FUNCTION private_scoring.reject_update();

CREATE OR REPLACE FUNCTION private_scoring.persist_generation(payload_text text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  payload jsonb; context jsonb; snapshot jsonb; stage jsonb; item jsonb;
  context_raw bytea; snapshot_raw bytea; stage_raw bytea; input_raw bytea;
  context_hash text; record_hash text; owner_id uuid; generation uuid; repository uuid;
  feed bigint; count_inputs integer; position integer:=0; days integer; collected timestamptz:=clock_timestamp();
  existing private_scoring.scoring_generations%ROWTYPE; previous private_scoring.scoring_inputs%ROWTYPE;
  seen uuid[]:='{}'; references_json jsonb:='[]'; inserted boolean; inserted_count integer; key_name text;
BEGIN
  IF octet_length(payload_text)>1000000 THEN RAISE EXCEPTION 'invalid'; END IF;
  payload:=payload_text::jsonb;
  IF NOT private_scoring.exact_keys(payload,ARRAY['schema_version','context_json','context_digest','items','policy_id','policy_version','retention_days'])
    OR payload->'schema_version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(payload->'context_json')<>'string'
    OR jsonb_typeof(payload->'items')<>'array' OR jsonb_typeof(payload->'context_digest') IS DISTINCT FROM 'string'
    OR (payload->>'context_digest' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'invalid'; END IF;
  context_raw:=convert_to(payload->>'context_json','UTF8');
  IF octet_length(context_raw) NOT BETWEEN 1 AND 16384 THEN RAISE EXCEPTION 'invalid'; END IF;
  context:=(payload->>'context_json')::jsonb;
  IF NOT private_scoring.exact_keys(context,ARRAY['encoding','dimensions','user_id','generation_id','scored_at','feed_version','profile_version',
    'feedback_version','feedback_state_revision','embedding_model','embedding_revision','user_embedding_version','repository_embedding_versions',
    'user_vector_sha256','model_version','model_sha256','scaler_sha256','manifest_sha256','feature_spec_version','feature_order_sha256','code_commit'])
    OR context->'encoding' IS DISTINCT FROM '"float32-le-v1"'::jsonb OR context->'dimensions' IS DISTINCT FROM '778'::jsonb
    OR context->'feature_spec_version' IS DISTINCT FROM '"v2"'::jsonb THEN RAISE EXCEPTION 'invalid'; END IF;
  FOREACH key_name IN ARRAY ARRAY['user_vector_sha256','model_sha256','scaler_sha256','manifest_sha256','feature_order_sha256'] LOOP
    IF jsonb_typeof(context->key_name) IS DISTINCT FROM 'string' OR (context->>key_name ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'invalid'; END IF;
  END LOOP;
  FOREACH key_name IN ARRAY ARRAY['embedding_revision','code_commit'] LOOP
    IF jsonb_typeof(context->key_name) IS DISTINCT FROM 'string' OR (context->>key_name ~ '^[a-f0-9]{40}$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'invalid'; END IF;
  END LOOP;
  FOREACH key_name IN ARRAY ARRAY['user_id','generation_id','embedding_model','model_version','scored_at'] LOOP
    IF jsonb_typeof(context->key_name) IS DISTINCT FROM 'string' OR char_length(context->>key_name)<1 THEN RAISE EXCEPTION 'invalid'; END IF;
  END LOOP;
  IF char_length(context->>'embedding_model')>128 OR char_length(context->>'model_version')>512
    OR char_length(context->>'scored_at')>40 OR (context->>'scored_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|\+00:00)$') IS DISTINCT FROM true
    OR context->>'feature_order_sha256'<>'33ac5e7e6345e6d71c879693451ab551c08b599163214fd2423a3735f5016e72'
    OR (context->'user_embedding_version'<>'null'::jsonb AND (jsonb_typeof(context->'user_embedding_version') IS DISTINCT FROM 'string' OR char_length(context->>'user_embedding_version') NOT BETWEEN 1 AND 128))
    OR jsonb_typeof(context->'repository_embedding_versions') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid'; END IF;
  IF jsonb_array_length(context->'repository_embedding_versions') NOT BETWEEN 1 AND 8
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(context->'repository_embedding_versions') AS v(value) WHERE jsonb_typeof(value)<>'string' OR char_length(value#>>'{}') NOT BETWEEN 1 AND 128)
    OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(context->'repository_embedding_versions'))<>jsonb_array_length(context->'repository_embedding_versions') THEN RAISE EXCEPTION 'invalid'; END IF;
  owner_id:=(context->>'user_id')::uuid; generation:=(context->>'generation_id')::uuid;
  IF owner_id::text<>context->>'user_id' OR generation::text<>context->>'generation_id' THEN RAISE EXCEPTION 'invalid'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(jsonb_build_array(context->'feed_version',context->'profile_version',context->'feedback_version',context->'feedback_state_revision')) LOOP
    IF jsonb_typeof(item)<>'string' OR (item#>>'{}') !~ '^(0|[1-9][0-9]{0,18})$' OR (item#>>'{}')::numeric>9223372036854775807 THEN RAISE EXCEPTION 'invalid'; END IF;
  END LOOP;
  feed:=(context->>'feed_version')::bigint;
  IF feed<1 OR (context->>'profile_version')::bigint<1 THEN RAISE EXCEPTION 'invalid'; END IF;
  context_hash:=encode(sha256(context_raw),'hex');
  IF context_hash<>payload->>'context_digest' THEN RAISE EXCEPTION 'invalid'; END IF;
  count_inputs:=jsonb_array_length(payload->'items');
  days:=(payload->>'retention_days')::integer;
  IF count_inputs NOT BETWEEN 1 AND 150 OR days NOT BETWEEN 1 AND 365
    OR jsonb_typeof(payload->'retention_days')<>'number'
    OR jsonb_typeof(payload->'policy_id')<>'string' OR jsonb_typeof(payload->'policy_version')<>'string'
    OR char_length(payload->>'policy_id') NOT BETWEEN 1 AND 128 OR char_length(payload->>'policy_version') NOT BETWEEN 1 AND 128
    OR btrim(payload->>'policy_id')<>payload->>'policy_id' OR btrim(payload->>'policy_version')<>payload->>'policy_version'
    THEN RAISE EXCEPTION 'invalid'; END IF;
  INSERT INTO private_scoring.scoring_generations(generation_id,user_id,feed_version,context_bytes,context_digest,scored_at,
    policy_id,policy_version,retention_days,created_at,expires_at,input_count)
  VALUES(generation,owner_id,feed,context_raw,context_hash,(context->>'scored_at')::timestamptz,
    payload->>'policy_id',payload->>'policy_version',days,collected,collected+days*interval '24 hours',count_inputs)
  ON CONFLICT(generation_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT; inserted:=inserted_count=1;
  SELECT * INTO STRICT existing FROM private_scoring.scoring_generations WHERE generation_id=generation FOR UPDATE;
  IF existing.user_id<>owner_id OR existing.feed_version<>feed OR existing.context_bytes<>context_raw OR existing.context_digest<>context_hash
    OR existing.policy_id<>payload->>'policy_id' OR existing.policy_version<>payload->>'policy_version'
    OR existing.retention_days<>days OR existing.input_count<>count_inputs THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_CAPTURE_CONFLICT'; END IF;
  IF existing.expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM private_scoring.generation_witnesses WHERE generation_id=generation AND event_type='revoked') THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_CAPTURE_EXPIRED'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(payload->'items') LOOP
    IF NOT private_scoring.exact_keys(item,ARRAY['snapshot_json','input_base64','binding_sha256','stage_json','record_digest'])
      OR jsonb_typeof(item->'snapshot_json')<>'string' OR jsonb_typeof(item->'stage_json')<>'string'
      OR jsonb_typeof(item->'input_base64')<>'string'
      OR jsonb_typeof(item->'binding_sha256') IS DISTINCT FROM 'string' OR (item->>'binding_sha256' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
      OR jsonb_typeof(item->'record_digest') IS DISTINCT FROM 'string' OR (item->>'record_digest' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'invalid'; END IF;
    snapshot_raw:=convert_to(item->>'snapshot_json','UTF8'); stage_raw:=convert_to(item->>'stage_json','UTF8');
    IF octet_length(snapshot_raw) NOT BETWEEN 1 AND 4096 OR octet_length(stage_raw) NOT BETWEEN 1 AND 8192
      OR char_length(item->>'input_base64')<>4152 OR item->>'input_base64' !~ '^[A-Za-z0-9+/]+==$' THEN RAISE EXCEPTION 'invalid'; END IF;
    snapshot:=(item->>'snapshot_json')::jsonb; stage:=(item->>'stage_json')::jsonb;
    IF NOT private_scoring.exact_keys(snapshot,ARRAY['repo_id','content_version','feature_version','content_hash','source_hash','embedding_version_index'])
      OR NOT private_scoring.exact_keys(stage,ARRAY['provider_position','raw_heavy_score','final_score','source','retrieval_scores']) THEN RAISE EXCEPTION 'invalid'; END IF;
    FOREACH key_name IN ARRAY ARRAY['content_version','feature_version'] LOOP
      IF jsonb_typeof(snapshot->key_name) IS DISTINCT FROM 'string' OR (snapshot->>key_name ~ '^(0|[1-9][0-9]{0,18})$') IS DISTINCT FROM true OR (snapshot->>key_name)::numeric>9223372036854775807 THEN RAISE EXCEPTION 'invalid'; END IF;
    END LOOP;
    IF (snapshot->>'content_version')::bigint<1 OR jsonb_typeof(snapshot->'content_hash') IS DISTINCT FROM 'string'
      OR char_length(snapshot->>'content_hash') NOT BETWEEN 1 AND 128 OR (snapshot->>'source_hash' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
      OR jsonb_typeof(snapshot->'embedding_version_index') IS DISTINCT FROM 'number' OR (snapshot->>'embedding_version_index' ~ '^[0-7]$') IS DISTINCT FROM true
      OR (snapshot->>'embedding_version_index')::integer>=jsonb_array_length(context->'repository_embedding_versions') THEN RAISE EXCEPTION 'invalid'; END IF;
    repository:=(snapshot->>'repo_id')::uuid;
    IF repository::text<>snapshot->>'repo_id' OR repository=ANY(seen)
      OR stage->'provider_position'<>to_jsonb(position) OR jsonb_typeof(stage->'raw_heavy_score')<>'number'
      OR jsonb_typeof(stage->'final_score')<>'number' OR jsonb_typeof(stage->'source')<>'string'
      OR char_length(stage->>'source') NOT BETWEEN 1 AND 128 OR btrim(stage->>'source')<>stage->>'source' OR jsonb_typeof(stage->'retrieval_scores')<>'object'
      THEN RAISE EXCEPTION 'invalid'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(stage->'retrieval_scores'))>16
      OR EXISTS(SELECT 1 FROM jsonb_each(stage->'retrieval_scores') AS score(key,value)
        WHERE key !~ '^[a-z_]{1,32}$' OR jsonb_typeof(value)<>'number'
          OR NOT((value#>>'{}')::double precision>'-Infinity'::double precision AND (value#>>'{}')::double precision<'Infinity'::double precision)) THEN RAISE EXCEPTION 'invalid'; END IF;
    input_raw:=decode(item->>'input_base64','base64');
    IF replace(encode(input_raw,'base64'),E'\n','')<>item->>'input_base64' OR NOT private_scoring.finite_input(input_raw)
      OR encode(sha256(substring(input_raw FROM 1 FOR 1536)),'hex')<>context->>'user_vector_sha256'
      OR encode(sha256(convert_to('{"context":','UTF8')||context_raw||convert_to(',"snapshot":','UTF8')||snapshot_raw||convert_to('}','UTF8')||input_raw),'hex')<>item->>'binding_sha256'
      THEN RAISE EXCEPTION 'invalid'; END IF;
    record_hash:=encode(sha256(context_raw||snapshot_raw||input_raw||stage_raw),'hex');
    IF record_hash<>item->>'record_digest' THEN RAISE EXCEPTION 'invalid'; END IF;
    IF inserted THEN
      INSERT INTO private_scoring.scoring_inputs(generation_id,user_id,repo_id,provider_position,snapshot_bytes,input_bytes,binding_digest,
        stage_bytes,record_digest,raw_heavy_score,final_score,source)
      VALUES(generation,owner_id,repository,position,snapshot_raw,input_raw,item->>'binding_sha256',stage_raw,record_hash,
        (stage->>'raw_heavy_score')::double precision,(stage->>'final_score')::double precision,stage->>'source');
    ELSE
      SELECT * INTO previous FROM private_scoring.scoring_inputs WHERE generation_id=generation AND repo_id=repository;
      IF NOT FOUND OR previous.user_id<>owner_id OR previous.provider_position<>position OR previous.snapshot_bytes<>snapshot_raw
        OR previous.input_bytes<>input_raw OR previous.binding_digest<>item->>'binding_sha256' OR previous.stage_bytes<>stage_raw
        OR previous.record_digest<>record_hash THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='SCORING_CAPTURE_CONFLICT'; END IF;
    END IF;
    seen:=array_append(seen,repository);
    references_json:=references_json||jsonb_build_array(jsonb_build_object('generation_id',generation,'repo_id',repository,'record_digest',record_hash));
    position:=position+1;
  END LOOP;
  IF (SELECT count(*) FROM private_scoring.scoring_inputs WHERE generation_id=generation)<>count_inputs THEN RAISE EXCEPTION 'invalid'; END IF;
  INSERT INTO private_scoring.generation_witnesses(generation_id,event_type) VALUES(generation,'persisted') ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('generation_id',generation,'expires_at',existing.expires_at,'references',references_json);
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE='P0001' AND SQLERRM IN ('SCORING_CAPTURE_CONFLICT','SCORING_CAPTURE_EXPIRED') THEN RAISE; END IF;
  IF (SQLSTATE='P0001' AND SQLERRM='invalid') OR left(SQLSTATE,2) IN ('22','23') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='SCORING_CAPTURE_INVALID';
  END IF;
  RAISE EXCEPTION USING ERRCODE='58000',MESSAGE='SCORING_PERSISTENCE_UNAVAILABLE';
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA private_scoring FROM PUBLIC,ghsocial_backend,ghsocial_scoring_writer,ghsocial_scoring_exporter,ghsocial_scoring_retention;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private_scoring FROM PUBLIC,ghsocial_backend,ghsocial_scoring_writer,ghsocial_scoring_exporter,ghsocial_scoring_retention;
GRANT USAGE ON SCHEMA private_scoring TO ghsocial_scoring_writer;
GRANT EXECUTE ON FUNCTION private_scoring.persist_generation(text) TO ghsocial_scoring_writer;
