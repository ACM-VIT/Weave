export const DEVELOPMENT_PREVIEW_ENABLED = process.env.NODE_ENV !== 'production'
  && process.env.EXPO_PUBLIC_BYPASS_AUTH === 'true';

export const DEVELOPMENT_PREVIEW_USER = {
  user_id: '00000000-0000-4000-8000-000000000001',
  username: 'local-preview',
  email: 'local-preview@weave.test',
  full_name: 'Local Preview',
  onboarding_completed: true,
  isPreview: true,
} as const;
