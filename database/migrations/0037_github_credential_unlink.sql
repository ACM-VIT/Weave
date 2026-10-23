CREATE TABLE app.user_github_unlinks (
  user_id uuid PRIMARY KEY REFERENCES app.users(user_id) ON DELETE CASCADE,
  operation_id uuid NOT NULL UNIQUE,
  github_id text NOT NULL CHECK (github_id ~ '^[1-9][0-9]{0,18}$'),
  status text NOT NULL CHECK (status IN ('prepared','done','refused','superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON app.user_github_unlinks TO ghsocial_backend;
