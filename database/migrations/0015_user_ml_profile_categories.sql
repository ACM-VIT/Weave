ALTER TABLE app.users
ADD COLUMN IF NOT EXISTS interests jsonb NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS skills jsonb NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS tech_stack jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE app.users
DROP CONSTRAINT IF EXISTS app_users_interests_array_check,
DROP CONSTRAINT IF EXISTS app_users_skills_array_check,
DROP CONSTRAINT IF EXISTS app_users_tech_stack_array_check;
--> statement-breakpoint
ALTER TABLE app.users
ADD CONSTRAINT app_users_interests_array_check CHECK (jsonb_typeof(interests) = 'array') NOT VALID,
ADD CONSTRAINT app_users_skills_array_check CHECK (jsonb_typeof(skills) = 'array') NOT VALID,
ADD CONSTRAINT app_users_tech_stack_array_check CHECK (jsonb_typeof(tech_stack) = 'array') NOT VALID;
--> statement-breakpoint
UPDATE app.users user_profile
SET interests = legacy.interests
FROM (
  SELECT user_topic.user_id,jsonb_agg(topic.slug::text ORDER BY topic.slug) AS interests
  FROM app.user_topics user_topic JOIN app.topics topic USING(topic_id)
  GROUP BY user_topic.user_id
) legacy
WHERE legacy.user_id=user_profile.user_id
  AND user_profile.interests='[]'::jsonb
  AND user_profile.skills='[]'::jsonb
  AND user_profile.tech_stack='[]'::jsonb;
--> statement-breakpoint
ALTER TABLE app.users
VALIDATE CONSTRAINT app_users_interests_array_check;
ALTER TABLE app.users
VALIDATE CONSTRAINT app_users_skills_array_check;
ALTER TABLE app.users
VALIDATE CONSTRAINT app_users_tech_stack_array_check;
