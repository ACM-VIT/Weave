import type { QueryClient } from '@tanstack/react-query';
import { authSessionLifecycle } from '../api/session-lifecycle';

/** Reconcile only the current viewer's feed and the affected relationship slices. */
export async function settleFollowCache(
  client: QueryClient,
  viewer: string,
  target: { userId?: string | null; profileId?: string | null },
  following: boolean,
  generation: number,
): Promise<void> {
  if (!authSessionLifecycle.isCurrent(generation)) return;
  const key = ['feed', viewer] as const;
  client.setQueryData<{ pages: { items: Record<string, unknown>[] }[] }>(key, current => {
    if (!current) return current;
    let changed = false;
    const pages = current.pages.map(page => {
      let pageChanged = false;
      const items = page.items.map(item => {
        const matches = Boolean(target.userId && (item.owner_user_id === target.userId
          || item.owner_profile_claimed_user_id === target.userId))
          || Boolean(target.profileId && item.owner_profile_id === target.profileId);
        if (!matches || item.viewer_follows_owner === following) return item;
        changed = pageChanged = true;
        return { ...item, viewer_follows_owner: following };
      });
      return pageChanged ? { ...page, items } : page;
    });
    return changed ? { ...current, pages } : current;
  });
  for (const [kind, id] of [['user', target.userId], ['profile', target.profileId]] as const) {
    if (!id) continue;
    const flag = kind === 'user' ? 'viewer_follows_user' : 'viewer_follows_profile';
    client.setQueryData<{ kind: string; data: Record<string, unknown> }>(
      ['public-user-profile', kind, id], current => {
        if (!current || current.data[flag] === following) return current;
        const previous = current.data[flag];
        return { ...current, data: { ...current.data, [flag]: following,
          ...(typeof previous === 'boolean' && typeof current.data.followers_count === 'number'
            ? { followers_count: Math.max(0, current.data.followers_count + (following ? 1 : -1)) } : {}),
        } };
      },
    );
  }
  client.setQueriesData<{pages: {items: Record<string, unknown>[] }[] }>(
    {queryKey: ['connections']}, current => current ? {...current, pages: current.pages.map(page => ({...page,
      items: page.items.map(item => {
        const matches = Boolean(target.userId && item.user_id === target.userId)
          || Boolean(target.profileId && item.profile_id === target.profileId);
        return matches ? {...item, viewer_follows_user: following, viewer_follows_profile: following} : item;
      }),
    }))} : current,
  );
  await Promise.all([
    client.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' }),
    client.invalidateQueries({ queryKey: ['connections', viewer, 'following'], exact: true }),
    ...(target.userId ? [client.invalidateQueries({ queryKey: ['connections', target.userId, 'followers'], exact: true })] : []),
  ]);
}
