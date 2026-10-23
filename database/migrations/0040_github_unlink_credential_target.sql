-- Bind retryable disconnects to the exact Supabase credential resource.
-- Existing prepared rows remain unknown; numeric GitHub IDs cannot backfill this.
ALTER TABLE app.user_github_unlinks
  ADD COLUMN IF NOT EXISTS provider_identity_id uuid;
