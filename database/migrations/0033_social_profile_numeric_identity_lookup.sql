-- Keep legacy padded aliases indexable; application reconciliation rejects ambiguity.
-- This transactional, non-concurrent build can block writes. Apply before batching rollout.
CREATE INDEX IF NOT EXISTS social_profiles_github_numeric_subject_idx
  ON app.social_profiles (ltrim(provider_subject,'0'))
  WHERE provider='github';
