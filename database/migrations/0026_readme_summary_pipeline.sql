CREATE TABLE IF NOT EXISTS app.repo_readme_summaries (
  summary_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL,
  repo_id uuid NOT NULL REFERENCES app.repos(repo_id) ON DELETE CASCADE,
  content_version integer NOT NULL CHECK (content_version > 0),
  content_hash text NOT NULL CHECK (btrim(content_hash) <> ''),
  prompt_version text NOT NULL CHECK (btrim(prompt_version) <> ''),
  format_version text NOT NULL CHECK (btrim(format_version) <> ''),
  model_version text NOT NULL CHECK (btrim(model_version) <> ''),
  artifact jsonb NOT NULL CHECK (jsonb_typeof(artifact)='object' AND octet_length(artifact::text)<=12000),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (generation_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS repo_readme_summaries_active_uidx
  ON app.repo_readme_summaries(repo_id) WHERE active;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS telemetry.readme_summary_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL REFERENCES app.repos(repo_id) ON DELETE CASCADE,
  content_version integer NOT NULL CHECK (content_version > 0),
  content_hash text NOT NULL,
  prompt_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','completed','failed','superseded')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_token uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (repo_id,content_version,content_hash,prompt_version)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS readme_summary_jobs_pending_idx
  ON telemetry.readme_summary_jobs(available_at,created_at) WHERE status IN ('pending','claimed');
--> statement-breakpoint
REVOKE ALL ON app.repo_readme_summaries,telemetry.readme_summary_jobs FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON app.repo_readme_summaries,telemetry.readme_summary_jobs TO ghsocial_backend;
