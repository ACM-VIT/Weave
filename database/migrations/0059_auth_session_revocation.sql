ALTER TABLE app.users ADD COLUMN sessions_revoked_at timestamptz;
--> statement-breakpoint
GRANT UPDATE(sessions_revoked_at) ON app.users TO ghsocial_backend;
