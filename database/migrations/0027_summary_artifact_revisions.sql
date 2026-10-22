-- Preserve immutable first writers and historical summary_id references while
-- allowing explicitly validated successors to supersede malformed artifacts.
ALTER TABLE app.repo_card_summaries
  ADD COLUMN IF NOT EXISTS artifact_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS supersedes_summary_id uuid REFERENCES app.repo_card_summaries(summary_id);
--> statement-breakpoint
ALTER TABLE app.repo_card_summaries
  DROP CONSTRAINT IF EXISTS repo_card_summaries_revision_check;
--> statement-breakpoint
ALTER TABLE app.repo_card_summaries
  ADD CONSTRAINT repo_card_summaries_revision_check CHECK (artifact_revision >= 0);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS repo_card_summaries_revisioned_uidx
  ON app.repo_card_summaries(repo_id,content_version,prompt_version,model_version,format_version,artifact_revision);
--> statement-breakpoint
DROP INDEX IF EXISTS app.repo_card_summaries_versioned_uidx;
