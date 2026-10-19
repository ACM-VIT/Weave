-- pg_trgm accelerates lexical fallback; PostgreSQL never stores vectors.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
--> statement-breakpoint
-- Supabase may already own pg_trgm in its extensions schema. Resolve its
-- namespace rather than relocating a shared extension or assuming search_path.
DO $$
DECLARE
  trgm_schema text;
  index_sql text;
BEGIN
  SELECT n.nspname INTO STRICT trgm_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
  WHERE e.extname='pg_trgm';

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO ghsocial_backend',trgm_schema);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.similarity(text,text) TO ghsocial_backend',trgm_schema);

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION app.explore_similarity(text,text) RETURNS real LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS %L',
    format('SELECT %I.similarity($1,$2)',trgm_schema)
  );

  FOR index_sql IN SELECT definition FROM (VALUES
    ('CREATE INDEX IF NOT EXISTS repos_active_search_trgm ON app.repos USING gin (lower(full_name) %I.gin_trgm_ops) WHERE status=''active'''),
    ('CREATE INDEX IF NOT EXISTS repo_content_search_trgm ON app.repo_content USING gin (lower(coalesce(description,'''')) %I.gin_trgm_ops)'),
    ('CREATE INDEX IF NOT EXISTS users_active_search_trgm ON app.users USING gin ((lower(coalesce(username::text,'''')||'' ''||coalesce(full_name,'''')||'' ''||coalesce(github_handle,'''')||'' ''||coalesce(bio,''''))) %I.gin_trgm_ops) WHERE status=''active'''),
    ('CREATE INDEX IF NOT EXISTS profiles_active_search_trgm ON app.social_profiles USING gin ((lower(coalesce(handle,'''')||'' ''||coalesce(display_name,''''))) %I.gin_trgm_ops) WHERE status=''active'''),
    ('CREATE INDEX IF NOT EXISTS boards_public_search_trgm ON app.boards USING gin ((lower(name||'' ''||coalesce(description,''''))) %I.gin_trgm_ops) WHERE visibility=''public'''),
    ('CREATE INDEX IF NOT EXISTS collections_search_trgm ON app.board_collections USING gin ((lower(name||'' ''||coalesce(description,''''))) %I.gin_trgm_ops)')
  ) definitions(definition)
  LOOP
    EXECUTE format(index_sql,trgm_schema);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS boards_owner_search_idx ON app.boards(user_id,board_id);
REVOKE ALL ON FUNCTION app.explore_similarity(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.explore_similarity(text,text) TO ghsocial_backend;
