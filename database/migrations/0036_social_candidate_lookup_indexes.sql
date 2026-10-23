-- Bound source membership lookup before per-actor/per-topic fanout. Apply before
-- enabling FEED_SOCIAL_CANDIDATES_ENABLED; this migration does not enable traffic.
CREATE INDEX IF NOT EXISTS app_reactions_user_recent_like_idx
  ON app.reactions(user_id, updated_at DESC, repo_id) WHERE reaction='like';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_reactions_repo_public_like_idx
  ON app.reactions(repo_id, user_id) WHERE reaction='like';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_board_repos_repository_idx
  ON app.board_repos(repo_id, board_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_repo_topics_topic_idx
  ON app.repo_topics(topic_id, repo_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_repos_owner_active_recent_idx
  ON app.repos(owner_github_id, updated_at DESC, repo_id) WHERE status='active' AND owner_github_id IS NOT NULL;
