ALTER TABLE app.repo_content
  ADD COLUMN readme_media_manifest jsonb;
--> statement-breakpoint
ALTER TABLE telemetry.feed_serves
  ADD COLUMN readme_mode text NOT NULL DEFAULT 'inline';
--> statement-breakpoint
ALTER TABLE telemetry.feed_serves
  ADD CONSTRAINT feed_serves_readme_mode_check
  CHECK (readme_mode IN ('inline','deferred')) NOT VALID;
--> statement-breakpoint
ALTER TABLE telemetry.feed_serves
  VALIDATE CONSTRAINT feed_serves_readme_mode_check;
