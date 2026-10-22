import { apiV2, apiV2Raw } from './client';
import type { RepositoryApiPayload } from './repositories';
import { keysetPageQuery, validateKeysetPageResponse, type KeysetPageMetadata, type KeysetPageOptions } from './keyset-pagination';

export type SocialProfile = {
  profile_id: string;
  provider: 'github';
  provider_subject: string | null;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  username: string | null;
  bio: string | null;
  github_handle: string | null;
  profile_kind: 'user' | 'organization' | 'unknown';
  claimed_by_user_id: string | null;
  created_at: string;
  followers_count: number;
  following_count: number;
  likes_given_count: number;
  viewer_follows_profile: boolean;
  is_self: boolean;
  repositories: RepositoryApiPayload[];
};

export async function getSocialProfile(
  profileId: string,
  token: string,
  signal?: AbortSignal,
): Promise<SocialProfile> {
  return apiV2<SocialProfile>(
    `/profiles/${encodeURIComponent(profileId)}`,
    { signal },
    token,
  );
}

/** Profile metadata with one bounded page of repositories, not the full portfolio. */
export type SocialProfilePage = SocialProfile & KeysetPageMetadata;

export async function getSocialProfilePage(
  profileId: string,
  token: string,
  options: KeysetPageOptions = {},
  signal?: AbortSignal,
): Promise<SocialProfilePage> {
  const data = await apiV2<SocialProfilePage>(
    `/profiles/${encodeURIComponent(profileId)}?${keysetPageQuery(options)}`,
    { signal },
    token,
  );
  validateKeysetPageResponse(data, 'repositories');
  return data;
}

export async function setSocialProfileFollowing(
  profileId: string,
  following: boolean,
  token: string,
): Promise<void> {
  await apiV2Raw<null>(
    `/profiles/${encodeURIComponent(profileId)}/follow`,
    { method: following ? 'PUT' : 'DELETE' },
    token,
  );
}
