-- Optional observed GitHub ancestry. Missing data is unknown, never nonfork.
-- Parent/family are external numeric identities and need not exist in our catalogue.
ALTER TABLE app.repos ADD COLUMN IF NOT EXISTS is_fork boolean;
ALTER TABLE app.repos ADD COLUMN IF NOT EXISTS fork_parent_github_id bigint;
ALTER TABLE app.repos ADD COLUMN IF NOT EXISTS fork_family_github_id bigint;
ALTER TABLE app.repos ADD COLUMN IF NOT EXISTS lineage_observed_at timestamptz;
ALTER TABLE app.repos ADD COLUMN IF NOT EXISTS lineage_source text;

DO $lineage$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='app.repos'::regclass
                 AND conname='app_repos_lineage_identity_check') THEN
    ALTER TABLE app.repos ADD CONSTRAINT app_repos_lineage_identity_check CHECK (
      (fork_parent_github_id IS NULL OR fork_parent_github_id>0)
      AND (fork_family_github_id IS NULL OR fork_family_github_id>0)
      AND (is_fork IS NOT NULL OR (fork_parent_github_id IS NULL AND fork_family_github_id IS NULL))
      AND (is_fork IS DISTINCT FROM false OR
        (fork_parent_github_id IS NULL AND (fork_family_github_id IS NULL OR fork_family_github_id=github_id)))
      AND (is_fork IS DISTINCT FROM true OR
        ((fork_parent_github_id IS NULL OR fork_parent_github_id<>github_id)
         AND (fork_family_github_id IS NULL OR fork_family_github_id<>github_id)))
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='app.repos'::regclass
                 AND conname='app_repos_lineage_provenance_check') THEN
    ALTER TABLE app.repos ADD CONSTRAINT app_repos_lineage_provenance_check CHECK (
      (lineage_source IS NULL)=(lineage_observed_at IS NULL)
      AND (is_fork IS NULL OR lineage_source IS NOT NULL)
      AND (lineage_observed_at IS NULL OR isfinite(lineage_observed_at))
      AND (lineage_source IS NULL OR lineage_source IN ('github-graphql-repository','github-rest-repository'))
    );
  END IF;
END
$lineage$;
