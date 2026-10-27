-- Add sourced composition without guessing weights for existing name-only records.
ALTER TABLE app.repo_content
  ADD COLUMN IF NOT EXISTS language_breakdown jsonb,
  ADD COLUMN IF NOT EXISTS language_total_size bigint,
  ADD COLUMN IF NOT EXISTS language_breakdown_complete boolean,
  ADD COLUMN IF NOT EXISTS language_observed_at timestamptz;
--> statement-breakpoint
ALTER TABLE app.repo_content DROP CONSTRAINT IF EXISTS repo_content_language_observation_check;
--> statement-breakpoint
ALTER TABLE app.repo_content ADD CONSTRAINT repo_content_language_observation_check CHECK (
  (language_breakdown IS NULL OR (
    jsonb_typeof(language_breakdown)='array' AND jsonb_array_length(language_breakdown)<=100
  ))
  AND (language_total_size IS NULL OR language_total_size BETWEEN 0 AND 9007199254740991)
  AND (language_observed_at IS NULL OR isfinite(language_observed_at))
  AND ((language_breakdown IS NULL AND language_total_size IS NULL AND language_breakdown_complete IS NULL)
    = (language_observed_at IS NULL))
);
