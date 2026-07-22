-- The v2 backend provisions app.users transactionally after Supabase creates
-- the identity. Keeping the legacy public.users auth trigger makes identity
-- creation fail on old username constraints before the v2 transaction runs.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
--> statement-breakpoint
ALTER TABLE app.users
ADD COLUMN IF NOT EXISTS date_of_birth date;
--> statement-breakpoint
ALTER TABLE app.users
ADD COLUMN IF NOT EXISTS onboarding_completed boolean;
--> statement-breakpoint
-- Accounts that predate the explicit flag are established accounts and must
-- not be forced back through onboarding on their next login.
UPDATE app.users
SET onboarding_completed = true
WHERE onboarding_completed IS NULL;
--> statement-breakpoint
ALTER TABLE app.users
ALTER COLUMN onboarding_completed SET DEFAULT false,
ALTER COLUMN onboarding_completed SET NOT NULL;
--> statement-breakpoint
UPDATE app.users current_profile
SET date_of_birth = legacy_profile.date_of_birth
FROM public.users legacy_profile
WHERE legacy_profile.user_id = current_profile.user_id
  AND current_profile.date_of_birth IS NULL
  AND legacy_profile.date_of_birth IS NOT NULL;
