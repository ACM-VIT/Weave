-- Support the per-board recent membership sample without sorting its full
-- membership. Apply before qualifying FEED_SOCIAL_CANDIDATES_ENABLED traffic;
-- this migration does not enable the feature or change visibility/exclusions.
CREATE INDEX IF NOT EXISTS app_board_repos_recent_idx
  ON app.board_repos(board_id, added_at DESC, repo_id);
