CREATE TABLE app.social_profiles (
  profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'github',
  provider_subject text,
  handle text NOT NULL,
  display_name text,
  avatar_url text,
  profile_kind text NOT NULL DEFAULT 'unknown',
  claimed_by_user_id uuid REFERENCES app.users(user_id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_profiles_provider_check CHECK (provider IN ('github')),
  CONSTRAINT social_profiles_subject_check CHECK (
    provider_subject IS NULL OR provider_subject ~ '^[0-9]{1,30}$'
  ),
  CONSTRAINT social_profiles_handle_check CHECK (
    handle ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'
  ),
  CONSTRAINT social_profiles_kind_check CHECK (profile_kind IN ('user','organization','unknown')),
  CONSTRAINT social_profiles_status_check CHECK (status IN ('active','blocked','deleted'))
);

CREATE UNIQUE INDEX social_profiles_provider_subject_uidx
  ON app.social_profiles(provider,provider_subject)
  WHERE provider_subject IS NOT NULL;
CREATE UNIQUE INDEX social_profiles_provider_handle_uidx
  ON app.social_profiles(provider,lower(handle));
CREATE UNIQUE INDEX social_profiles_claimed_user_uidx
  ON app.social_profiles(claimed_by_user_id)
  WHERE claimed_by_user_id IS NOT NULL;
CREATE INDEX social_profiles_active_handle_idx
  ON app.social_profiles(lower(handle))
  WHERE status='active';

CREATE TABLE app.social_profile_follows (
  follower_id uuid NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES app.social_profiles(profile_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id,profile_id)
);

CREATE INDEX social_profile_follows_profile_idx
  ON app.social_profile_follows(profile_id,created_at DESC);
CREATE INDEX social_profile_follows_follower_idx
  ON app.social_profile_follows(follower_id,created_at DESC);

-- Existing repository owners become followable immediately. These rows begin
-- as handle-only profiles and can later be upgraded with GitHub's immutable
-- numeric subject by verified ingestion or OAuth claiming.
INSERT INTO app.social_profiles(provider,handle)
SELECT 'github',owner
FROM (
  SELECT DISTINCT ON (lower(owner)) owner
  FROM app.repos
  WHERE status<>'deleted'
    AND owner ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'
  ORDER BY lower(owner),updated_at DESC
) repository_owners
ON CONFLICT DO NOTHING;

-- Claim any handle-only rows for identities that were already verified before
-- this migration. GitHub's immutable numeric id becomes the ownership anchor.
UPDATE app.social_profiles profile
SET provider_subject=app_user.github_id,
    handle=app_user.github_handle,
    display_name=app_user.full_name,
    avatar_url=app_user.avatar_url,
    profile_kind='user',
    claimed_by_user_id=app_user.user_id,
    updated_at=now()
FROM app.users app_user
WHERE profile.provider='github'
  AND profile.provider_subject IS NULL
  AND profile.claimed_by_user_id IS NULL
  AND lower(profile.handle)=lower(app_user.github_handle)
  AND app_user.github_identity_verified_at IS NOT NULL
  AND app_user.github_id IS NOT NULL
  AND app_user.github_handle IS NOT NULL;

INSERT INTO app.social_profiles(
  provider,provider_subject,handle,display_name,avatar_url,profile_kind,claimed_by_user_id
)
SELECT
  'github',github_id,github_handle,full_name,avatar_url,'user',user_id
FROM app.users app_user
WHERE github_identity_verified_at IS NOT NULL
  AND github_id IS NOT NULL
  AND github_handle IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM app.social_profiles profile
    WHERE profile.claimed_by_user_id=app_user.user_id
       OR (profile.provider='github' AND profile.provider_subject=app_user.github_id)
       OR (profile.provider='github' AND lower(profile.handle)=lower(app_user.github_handle))
  )
ON CONFLICT DO NOTHING;

GRANT SELECT,INSERT,UPDATE,DELETE ON
  app.social_profiles,
  app.social_profile_follows
TO ghsocial_backend;
