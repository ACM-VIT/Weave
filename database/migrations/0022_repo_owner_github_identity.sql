ALTER TABLE app.repos
  ADD COLUMN IF NOT EXISTS owner_github_id bigint;

ALTER TABLE app.repos
  DROP CONSTRAINT IF EXISTS app_repos_owner_github_id_positive;

ALTER TABLE app.repos
  ADD CONSTRAINT app_repos_owner_github_id_positive
  CHECK (owner_github_id IS NULL OR owner_github_id > 0);

CREATE INDEX IF NOT EXISTS app_repos_owner_github_id_idx
  ON app.repos (owner_github_id)
  WHERE owner_github_id IS NOT NULL;
