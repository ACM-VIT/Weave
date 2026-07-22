export const CONNECTION_PAGE_SIZE = 25;
export const FOLLOWING_LOOKUP_PAGE_SIZE = 100;
export const CONNECTION_MAX_OFFSET = 10_000;

export type ConnectionIdentity = {
  user_id: string;
};

export type ConnectionPage<T extends ConnectionIdentity = ConnectionIdentity> = {
  items: T[];
  limit: number;
  offset: number;
};

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
  pages: readonly ConnectionPage<T>[],
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];

  for (const page of pages) {
    for (const item of page.items) {
      if (!item.user_id || seen.has(item.user_id)) continue;
      seen.add(item.user_id);
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
