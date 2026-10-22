ALTER TABLE app.repo_content
  ADD COLUMN IF NOT EXISTS readme_source_path text,
  ADD COLUMN IF NOT EXISTS readme_default_branch text,
  ADD COLUMN IF NOT EXISTS readme_base_url text;
--> statement-breakpoint
ALTER TABLE app.repo_content
  DROP CONSTRAINT IF EXISTS repo_content_readme_metadata_check;
--> statement-breakpoint
ALTER TABLE app.repo_content
  ADD CONSTRAINT repo_content_readme_metadata_check CHECK (
    (readme_source_path IS NULL OR (
      btrim(readme_source_path)=readme_source_path
      AND btrim(readme_source_path)<>''
      AND char_length(readme_source_path)<=1024
      AND readme_source_path !~ '^/'
      AND right(readme_source_path,1)<>'/'
      AND position('//' in readme_source_path)=0
      AND position(chr(92) in readme_source_path)=0
      AND readme_source_path !~ '(^|/)[.]{1,2}(/|$)'
    ))
    AND (readme_default_branch IS NULL OR (
      btrim(readme_default_branch)=readme_default_branch
      AND btrim(readme_default_branch)<>''
      AND char_length(readme_default_branch)<=256
      AND readme_default_branch !~ '^/'
      AND right(readme_default_branch,1)<>'/'
      AND position('//' in readme_default_branch)=0
      AND position(chr(92) in readme_default_branch)=0
      AND readme_default_branch !~ '(^|/)[.]{1,2}(/|$)'
    ))
    AND (
      readme_base_url IS NULL
      OR (
        char_length(readme_base_url)<=2048
        AND readme_base_url ~ '^https://raw[.]githubusercontent[.]com/[^/[:space:]?#]+/[^/[:space:]?#]+/refs/heads/[^[:space:]?#]+/$'
      )
    )
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE app.repo_content
  VALIDATE CONSTRAINT repo_content_readme_metadata_check;
--> statement-breakpoint
ALTER TABLE app.repo_card_summaries
  ADD COLUMN IF NOT EXISTS prompt_version text,
  ADD COLUMN IF NOT EXISTS format_version text,
  ADD COLUMN IF NOT EXISTS highlights jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS source text;
--> statement-breakpoint
-- Pre-Phase-3 rows have no prompt/format provenance and may contain a cleaned
-- or truncated README. Keep them for historical serve references, but ensure
-- none can remain the active discovery-card summary.
UPDATE app.repo_card_summaries
SET prompt_version=COALESCE(NULLIF(btrim(prompt_version),''),'legacy-unversioned'),
    format_version=COALESCE(NULLIF(btrim(format_version),''),'legacy-unversioned'),
    model_version=COALESCE(NULLIF(btrim(model_version),''),'legacy-unversioned'),
    source='legacy',
    active=false
WHERE prompt_version IS NULL OR btrim(prompt_version)=''
   OR format_version IS NULL OR btrim(format_version)=''
   OR model_version IS NULL OR btrim(model_version)=''
   OR source IS NULL OR btrim(source)='' OR source NOT IN ('generated','description_fallback','legacy')
   OR (source='legacy' AND active)
   OR char_length(btrim(summary)) NOT BETWEEN 1 AND 360;
--> statement-breakpoint
UPDATE app.repo_card_summaries
SET highlights='[]'::jsonb
WHERE highlights IS NULL
   OR CASE WHEN jsonb_typeof(highlights)='array'
      THEN jsonb_array_length(highlights)>3 ELSE true END;
--> statement-breakpoint
ALTER TABLE app.repo_card_summaries
  ALTER COLUMN prompt_version SET NOT NULL,
  ALTER COLUMN format_version SET NOT NULL,
  ALTER COLUMN highlights SET DEFAULT '[]'::jsonb,
  ALTER COLUMN highlights SET NOT NULL,
  ALTER COLUMN source SET NOT NULL;
--> statement-breakpoint
ALTER TABLE app.repo_card_summaries
  DROP CONSTRAINT IF EXISTS repo_card_summaries_repo_id_content_version_model_version_key;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS repo_card_summaries_versioned_uidx
  ON app.repo_card_summaries(
    repo_id,content_version,prompt_version,model_version,format_version
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS repo_card_summaries_repo_active_idx
  ON app.repo_card_summaries(repo_id,active);
--> statement-breakpoint
ALTER TABLE app.repo_card_summaries
  DROP CONSTRAINT IF EXISTS repo_card_summaries_versions_check,
  DROP CONSTRAINT IF EXISTS repo_card_summaries_highlights_check,
  DROP CONSTRAINT IF EXISTS repo_card_summaries_source_check,
  DROP CONSTRAINT IF EXISTS repo_card_summaries_active_length_check;
--> statement-breakpoint
ALTER TABLE app.repo_card_summaries
  ADD CONSTRAINT repo_card_summaries_versions_check CHECK (
    btrim(prompt_version) <> ''
    AND btrim(model_version) <> ''
    AND btrim(format_version) <> ''
  ) NOT VALID,
  ADD CONSTRAINT repo_card_summaries_highlights_check CHECK (
    jsonb_typeof(highlights)='array' AND jsonb_array_length(highlights)<=3
  ) NOT VALID,
  ADD CONSTRAINT repo_card_summaries_source_check CHECK (
    source IN ('generated','description_fallback','legacy')
  ) NOT VALID,
  ADD CONSTRAINT repo_card_summaries_active_length_check CHECK (
    (source='legacy' AND NOT active)
    OR (
      source<>'legacy'
      AND char_length(btrim(summary)) BETWEEN 1 AND 360
    )
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE app.repo_card_summaries
  VALIDATE CONSTRAINT repo_card_summaries_versions_check;
--> statement-breakpoint
ALTER TABLE app.repo_card_summaries
  VALIDATE CONSTRAINT repo_card_summaries_highlights_check;
--> statement-breakpoint
ALTER TABLE app.repo_card_summaries
  VALIDATE CONSTRAINT repo_card_summaries_source_check;
--> statement-breakpoint
ALTER TABLE app.repo_card_summaries
  VALIDATE CONSTRAINT repo_card_summaries_active_length_check;
--> statement-breakpoint
ALTER TABLE telemetry.ml_outbox
  ADD COLUMN IF NOT EXISTS response_payload jsonb;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.activate_repo_summary(target_summary uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE target_repo uuid;
BEGIN
  SELECT summary.repo_id INTO STRICT target_repo
  FROM app.repo_card_summaries summary
  JOIN app.repo_content content
    ON content.repo_id=summary.repo_id
   AND content.content_version=summary.content_version
  WHERE summary.summary_id=target_summary
    AND summary.source<>'legacy'
    AND char_length(btrim(summary.summary)) BETWEEN 1 AND 360
  FOR UPDATE OF content;

  UPDATE app.repo_card_summaries
  SET active=false
  WHERE repo_id=target_repo AND active AND summary_id<>target_summary;

  UPDATE app.repo_card_summaries SET active=true WHERE summary_id=target_summary;
END $$;
--> statement-breakpoint
GRANT UPDATE (response_payload) ON telemetry.ml_outbox TO ghsocial_backend;
