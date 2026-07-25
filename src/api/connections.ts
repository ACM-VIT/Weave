import { apiV2, apiV2Raw } from './client';

export type ConnectionType = 'followers' | 'following';

export type ConnectionUser = {
  user_id: string | null;
  profile_id: string | null;
  username: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
  viewer_follows_user: boolean;
  viewer_follows_profile: boolean;
};

export type ConnectionPage = {
  items: ConnectionUser[];
  limit: number;
  offset: number;
};

export const CONNECTION_PAGE_SIZE = 50;
export const MAX_CONNECTION_OFFSET = 10_000;

export async function getUserConnections(
  userId: string,
  type: ConnectionType,
  token: string,
  options: {
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ConnectionPage> {
  const limit = options.limit ?? CONNECTION_PAGE_SIZE;
  const offset = options.offset ?? 0;

  return apiV2<ConnectionPage>(
    `/users/${encodeURIComponent(userId)}/${type}?limit=${limit}&offset=${offset}`,
    { signal: options.signal },
    token,
  );
}

export async function setUserFollowing(
  targetUserId: string,
  following: boolean,
  token: string,
): Promise<void> {
  // Follow mutations intentionally return HTTP 204 with no response envelope,
  // so apiV2() cannot be used here.
  await apiV2Raw<null>(
    `/users/${encodeURIComponent(targetUserId)}/follow`,
    { method: following ? 'PUT' : 'DELETE' },
    token,
  );
}
