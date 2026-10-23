ALTER TABLE app.users ADD COLUMN onboarding_taxonomy jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE app.users ADD CONSTRAINT app_users_onboarding_taxonomy_object
  CHECK (jsonb_typeof(onboarding_taxonomy)='object' AND octet_length(onboarding_taxonomy::text)<=32768);
