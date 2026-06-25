import type { UserProfile } from './database.js';

/** GET /onboarding/status — no request body */

export interface OnboardingStepStatus {
  profile: boolean;
  github: boolean;
  interests: boolean;
  skills: boolean;
  tech_stack: boolean;
}

export interface OnboardingStatusResponse {
  isComplete: boolean;
  steps: OnboardingStepStatus;
  missingFields: string[];
  profile: UserProfile | null;
}

/** PUT /onboarding/setup */

export interface OnboardingSetupBody {
  username: string;
  full_name: string;
  date_of_birth?: string | null;
  bio?: string | null;
  interests?: string[];
  skills?: string[];
  tech_stack?: string[];
  avatar_url?: string | null;
}

/** Response payload for POST /onboarding/sync-github */

export interface SyncGitHubResponse {
  github_id: string;
  github_handle: string;
  github_url: string;
  avatar_url: string | null;
  bio: string | null;
  full_name: string | null;
}
