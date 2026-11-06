CREATE TABLE app.auth_session_fences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  revoked_at timestamptz
);
--> statement-breakpoint
INSERT INTO app.auth_session_fences(user_id,revoked_at)
SELECT user_id,sessions_revoked_at FROM app.users WHERE sessions_revoked_at IS NOT NULL;
--> statement-breakpoint
REVOKE ALL ON app.auth_session_fences FROM PUBLIC, ghsocial_backend;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.auth_session_fences TO ghsocial_backend;
