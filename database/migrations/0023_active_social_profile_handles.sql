DROP INDEX app.social_profiles_provider_handle_uidx;
--> statement-breakpoint
CREATE UNIQUE INDEX social_profiles_provider_handle_uidx
  ON app.social_profiles(provider,lower(handle))
  WHERE status='active';
