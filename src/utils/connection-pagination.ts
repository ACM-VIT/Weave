export const CONNECTION_PAGE_SIZE = 25;
export const FOLLOWING_LOOKUP_PAGE_SIZE = 100;
export const CONNECTION_MAX_OFFSET = 10_000;

export type ConnectionIdentity = {
  user_id?: string | null;
  profile_id?: string | null;
};

export type ConnectionFollowState = ConnectionIdentity & {
  viewer_follows_user?: boolean;
  viewer_follows_profile?: boolean;
};

export type ConnectionPage<T extends ConnectionIdentity = ConnectionIdentity> = {
  items: T[];
  limit: number;
  offset: number;
};

export function connectionIdentity(item: ConnectionIdentity): string | null {
  if (item.profile_id) return `profile:${item.profile_id}`;
  if (item.user_id) return `user:${item.user_id}`;
  return null;
}

export function connectionFollowState(
  item: ConnectionFollowState,
  isViewerFollowingList: boolean,
  override?: boolean,
): { following: boolean; stateKnown: boolean } {
  const serverFollowing = item.profile_id
    ? item.viewer_follows_profile
    : item.viewer_follows_user;

  return {
    following: override ?? (isViewerFollowingList || serverFollowing === true),
    stateKnown: override !== undefined
      || isViewerFollowingList
      || typeof serverFollowing === 'boolean',
  };
}

export function buildFollowMutation(userId: string, currentlyFollowing: boolean): {
  path: string;
  method: 'PUT' | 'DELETE';
  nextFollowing: boolean;
} {
  if (!userId) throw new Error('A user id is required to update a follow.');
  return {
    path: `/users/${encodeURIComponent(userId)}/follow`,
    method: currentlyFollowing ? 'DELETE' : 'PUT',
    nextFollowing: !currentlyFollowing,
  };
}

export function getNextConnectionOffset(
  page: ConnectionPage,
  maxOffset = CONNECTION_MAX_OFFSET,
): number | undefined {
  if (page.items.length === 0 || page.items.length < page.limit) return undefined;
  const nextOffset = page.offset + page.items.length;
  return nextOffset > page.offset && nextOffset <= maxOffset ? nextOffset : undefined;
}

export function mergeConnectionPages<T extends ConnectionIdentity>(
  pages: readonly { items: T[] }[],
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];

  for (const page of pages) {
    for (const item of page.items) {
      const identity = connectionIdentity(item);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      merged.push(item);
    }
  }

  return merged;
}

export async function collectConnectionIds(
  loadPage: (offset: number, limit: number) => Promise<ConnectionPage>,
  pageSize = FOLLOWING_LOOKUP_PAGE_SIZE,
  maxOffset = CONNECTION_MAX_OFFSET,
): Promise<string[]> {
  const ids = new Set<string>();
  let offset = 0;

  while (offset <= maxOffset) {
    const page = await loadPage(offset, pageSize);
    for (const item of page.items) {
      if (item.user_id) ids.add(item.user_id);
    }

    if (page.items.length === 0 || page.items.length < pageSize) break;
    const nextOffset = offset + page.items.length;
    if (nextOffset <= offset || nextOffset > maxOffset) break;
    offset = nextOffset;
  }

  return [...ids];
}
