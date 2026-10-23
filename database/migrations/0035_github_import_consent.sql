CREATE TABLE app.user_github_imports (
  user_id uuid PRIMARY KEY REFERENCES app.users(user_id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
  github_id text,
  snapshot_id uuid,
  snapshot_hash text,
  expires_at timestamptz,
  collect_token uuid,
  collect_until timestamptz,
  last_collected_at timestamptz,
  consented_at timestamptz,
  accepted_at timestamptz,
  accepted_profile_version bigint,
  revoked_at timestamptz,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  baseline jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (jsonb_typeof(provenance)='object' AND octet_length(provenance::text)<=524288),
  CHECK (jsonb_typeof(baseline)='object' AND octet_length(baseline::text)<=32768),
  CHECK (jsonb_typeof(applied)='object' AND octet_length(applied::text)<=32768)
);
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON app.user_github_imports TO ghsocial_backend;
