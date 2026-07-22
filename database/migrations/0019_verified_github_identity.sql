-- Repository cards may expose an app user as the owner Follow target. Keep a
-- durable marker that is written only after Supabase/GitHub has verified both
-- the immutable numeric account id and its current handle.
ALTER TABLE app.users
ADD COLUMN IF NOT EXISTS github_identity_verified_at timestamptz;
--> statement-breakpoint
-- One GitHub account must never resolve to multiple Weave Follow targets.
-- Handles are intentionally not unique because GitHub permits rename/reuse;
-- the most recently verified identity wins a temporary handle collision.
CREATE UNIQUE INDEX IF NOT EXISTS app_users_verified_github_id_uidx
ON app.users (github_id)
WHERE github_identity_verified_at IS NOT NULL AND github_id IS NOT NULL;
