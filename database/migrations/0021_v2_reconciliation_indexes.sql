CREATE INDEX IF NOT EXISTS app_reactions_repo_idx
  ON app.reactions(repo_id, reaction);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_saves_repo_idx
  ON app.saves(repo_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS telemetry_user_repo_engagement_repo_idx
  ON telemetry.user_repo_engagement(repo_id);
