DROP INDEX IF EXISTS app.repos_active_search_trgm;
DROP INDEX IF EXISTS app.repo_content_search_trgm;
DROP INDEX IF EXISTS app.users_active_search_trgm;
DROP INDEX IF EXISTS app.profiles_active_search_trgm;
DROP INDEX IF EXISTS app.boards_public_search_trgm;
DROP INDEX IF EXISTS app.boards_owner_search_idx;
DROP INDEX IF EXISTS app.collections_search_trgm;
-- Keep the shared pg_trgm extension: other applications may depend on it.
DROP FUNCTION IF EXISTS app.explore_similarity(text,text);
