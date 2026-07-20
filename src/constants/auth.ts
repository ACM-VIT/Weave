export const AUTH_BYPASS_ENABLED = __DEV__ && process.env.EXPO_PUBLIC_BYPASS_AUTH === "true"

export const AUTH_BYPASS_PROFILE_STORAGE_KEY = "auth_bypass_profile"

export const AUTH_BYPASS_USER = {
  user_id: "local-development-user",
  username: "demo_user",
  email: "local-development@gh-social.test",
  full_name: "Demo User",
  bio: "Developer preview",
  onboarding_completed: true,
  likes_given_count: 1200,
  followers_count: 300,
  saved_repos_count: 156,
  following_count: 289,
}
