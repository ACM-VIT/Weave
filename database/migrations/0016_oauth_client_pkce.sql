ALTER TABLE app.oauth_codes
ADD COLUMN IF NOT EXISTS client_code_challenge text;
--> statement-breakpoint
ALTER TABLE app.oauth_codes
DROP CONSTRAINT IF EXISTS app_oauth_codes_client_challenge_check;
--> statement-breakpoint
ALTER TABLE app.oauth_codes
ADD CONSTRAINT app_oauth_codes_client_challenge_check
CHECK (
  client_code_challenge IS NULL
  OR client_code_challenge ~ '^[A-Za-z0-9_-]{43}$'
) NOT VALID;
--> statement-breakpoint
ALTER TABLE app.oauth_codes
VALIDATE CONSTRAINT app_oauth_codes_client_challenge_check;
