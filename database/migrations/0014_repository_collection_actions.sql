ALTER TABLE app.board_collections
  ADD COLUMN IF NOT EXISTS icon text,
  ADD COLUMN IF NOT EXISTS color varchar(7),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE app.board_collections
  DROP CONSTRAINT IF EXISTS board_collections_color_check;
ALTER TABLE app.board_collections
  ADD CONSTRAINT board_collections_color_check
  CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');

CREATE TABLE IF NOT EXISTS app.collection_repos (
  collection_id uuid NOT NULL REFERENCES app.board_collections(collection_id) ON DELETE CASCADE,
  repo_id uuid NOT NULL REFERENCES app.repos(repo_id) ON DELETE CASCADE,
  added_by uuid REFERENCES app.users(user_id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, repo_id)
);

CREATE INDEX IF NOT EXISTS app_collection_repos_repo_idx
  ON app.collection_repos(repo_id);
CREATE INDEX IF NOT EXISTS app_collection_repos_added_idx
  ON app.collection_repos(collection_id, added_at DESC);
