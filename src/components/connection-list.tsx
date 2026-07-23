import React, { memo, useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  RotateCcw,
  Search,
  UserPlus,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react-native';

import {
  CONNECTION_PAGE_SIZE,
  MAX_CONNECTION_OFFSET,
  getUserConnections,
  type ConnectionPage,
  type ConnectionType,
  type ConnectionUser,
} from '@/api/connections';
import { REFERENCE_THEME } from '@/constants/theme';
import { useAuth } from '@/store/AuthContext';
import {
  collectConnectionIds,
  FOLLOWING_LOOKUP_PAGE_SIZE,
  mergeConnectionPages,
} from '@/utils/connection-pagination';
import { getStorageItem } from '@/utils/storage';
import { FollowButton } from './follow-button';

const QUERY_STALE_TIME = 30_000;
const ROW_GAP = 10;
const EMPTY_FOLLOW_OVERRIDES = new Map<string, boolean>();

export type ConnectionListProps = {
  active?: boolean;
  type: ConnectionType;
  username?: string;
  userId?: string;
  contentPaddingBottom?: number;
  onFollowingCountChange?: (delta: 1 | -1) => void;
};

function connectionQueryKey(userId: string | undefined, type: ConnectionType) {
  return ['connections', userId, type] as const;
}

async function loadConnections(
  userId: string,
  type: ConnectionType,
  offset: number,
  signal?: AbortSignal,
): Promise<ConnectionPage> {
  const token = await getStorageItem('access_token');
  if (!token) throw new Error('Your session has expired. Please sign in again.');
  return getUserConnections(userId, type, token, {
    limit: CONNECTION_PAGE_SIZE,
    offset,
    signal,
  });
}

function nextConnectionOffset(page: ConnectionPage): number | undefined {
  const itemCount = Array.isArray(page.items) ? page.items.length : 0;
  if (itemCount < page.limit) return undefined;
  const nextOffset = page.offset + itemCount;
  return nextOffset <= MAX_CONNECTION_OFFSET ? nextOffset : undefined;
}

function initials(person: ConnectionUser) {
  return (person.full_name || person.username)
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';
}

function avatarColor(seed: string) {
  const colors = ['#984BE0', '#3478C9', '#C94869', '#2E9E6B', '#C2772E'];
  const value = Array.from(seed).reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return colors[value % colors.length];
}

const ConnectionRow = memo(function ConnectionRow({
  person,
  compact,
  following,
  isSelf,
  stateKnown,
  onFollowingChange,
}: {
  person: ConnectionUser;
  compact: boolean;
  following: boolean;
  isSelf: boolean;
  stateKnown: boolean;
  onFollowingChange: (person: ConnectionUser, following: boolean) => void;
}) {
  const handleFollowingChange = useCallback(
    (next: boolean) => onFollowingChange(person, next),
    [onFollowingChange, person],
  );
  const avatarSize = compact ? 42 : 48;

  return (
    <View style={[styles.row, compact && styles.rowCompact]}>
      {person.avatar_url ? (
        <Image
          accessibilityLabel={`${person.username}'s avatar`}
          resizeMode="cover"
          source={{ uri: person.avatar_url }}
          style={{ width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 }}
        />
      ) : (
        <View
          style={[
            styles.avatarFallback,
            {
              width: avatarSize,
              height: avatarSize,
              borderRadius: avatarSize / 2,
              backgroundColor: avatarColor(person.user_id),
            },
          ]}
        >
          <Text style={[styles.avatarText, compact && styles.avatarTextCompact]}>
            {initials(person)}
          </Text>
        </View>
      )}

      <View style={styles.personText}>
        <Text numberOfLines={1} style={[styles.displayName, compact && styles.displayNameCompact]}>
          {person.full_name || person.username}
        </Text>
        <Text numberOfLines={1} selectable style={styles.username}>
          @{person.username.replace(/^@/, '')}
        </Text>
      </View>

      {!isSelf ? (
        <FollowButton
          compact={compact}
          disabled={!stateKnown}
          isFollowing={following}
          onFollowingChange={handleFollowingChange}
          stateKnown={stateKnown}
          targetUserId={person.user_id}
        />
      ) : null}
    </View>
  );
});

function StateView({
  icon,
  title,
  message,
  loading = false,
  onRetry,
}: {
  icon?: React.ReactNode;
  title: string;
  message?: string;
  loading?: boolean;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.stateView}>
      {loading ? (
        <ActivityIndicator color={REFERENCE_THEME.accent} size="small" />
      ) : (
        <View style={styles.stateIcon}>{icon}</View>
      )}
      <Text style={styles.stateTitle}>{title}</Text>
      {message ? <Text style={styles.stateMessage}>{message}</Text> : null}
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
        >
          <RotateCcw color={REFERENCE_THEME.accent} size={14} strokeWidth={2} />
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ConnectionList({
  active = true,
  type,
  username,
  userId,
  contentPaddingBottom = 24,
  onFollowingCountChange,
}: ConnectionListProps) {
  const { width } = useWindowDimensions();
  const compact = width < 360;
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const viewerId = user?.user_id;
  const stateKey = `${type}:${userId ?? 'missing'}`;
  const [searchState, setSearchState] = useState({ key: stateKey, value: '' });
  const [followOverrideState, setFollowOverrideState] = useState<{
    key: string;
    values: Map<string, boolean>;
  }>({ key: stateKey, values: new Map() });
  const search = searchState.key === stateKey ? searchState.value : '';
  const followOverrides = followOverrideState.key === stateKey
    ? followOverrideState.values
    : EMPTY_FOLLOW_OVERRIDES;
  const setSearch = useCallback((value: string) => {
    setSearchState({ key: stateKey, value });
  }, [stateKey]);

  const peopleQuery = useInfiniteQuery({
    queryKey: connectionQueryKey(userId, type),
    queryFn: ({ pageParam, signal }) => loadConnections(userId!, type, pageParam, signal),
    enabled: active && Boolean(userId),
    getNextPageParam: nextConnectionOffset,
    initialPageParam: 0,
    staleTime: QUERY_STALE_TIME,
  });

  const viewerFollowingQueryKey = useMemo(
    () => ['connection-following-ids', viewerId] as const,
    [viewerId],
  );
  const sameAsViewerFollowing = type === 'following' && userId === viewerId;
  const viewerFollowingQuery = useQuery({
    queryKey: viewerFollowingQueryKey,
    queryFn: async ({ signal }) => {
      const token = await getStorageItem('access_token');
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      return collectConnectionIds((offset, limit) => getUserConnections(
        viewerId!,
        'following',
        token,
        { limit, offset, signal },
      ), FOLLOWING_LOOKUP_PAGE_SIZE);
    },
    enabled: active && Boolean(viewerId) && !sameAsViewerFollowing,
    staleTime: QUERY_STALE_TIME,
  });

  const people = useMemo(
    () => mergeConnectionPages(peopleQuery.data?.pages ?? []),
    [peopleQuery.data?.pages],
  );
  const serverFollowingIds = useMemo(
    () => new Set(viewerFollowingQuery.data ?? []),
    [viewerFollowingQuery.data],
  );
  const allFollowingLoaded = sameAsViewerFollowing
    || (Boolean(viewerId) && viewerFollowingQuery.isSuccess);

  const filteredPeople = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return people;

    return people.filter((person) =>
      person.username.toLocaleLowerCase().includes(query)
      || (person.full_name ?? '').toLocaleLowerCase().includes(query)
    );
  }, [people, search]);

  const handleFollowingChange = useCallback((person: ConnectionUser, following: boolean) => {
    setFollowOverrideState((current) => {
      const next = current.key === stateKey
        ? new Map(current.values)
        : new Map<string, boolean>();
      next.set(person.user_id, following);
      return { key: stateKey, values: next };
    });

    if (viewerId) {
      const followingKey = connectionQueryKey(viewerId, 'following');
      queryClient.setQueryData<string[]>(viewerFollowingQueryKey, (current) => {
        const next = new Set(current ?? viewerFollowingQuery.data ?? []);
        if (following) next.add(person.user_id);
        else next.delete(person.user_id);
        return [...next];
      });
      if (sameAsViewerFollowing && !following) {
        queryClient.setQueryData<InfiniteData<ConnectionPage>>(followingKey, (current) => (
          current ? {
            ...current,
            pages: current.pages.map((page) => ({
              ...page,
              items: page.items.filter((item) => item.user_id !== person.user_id),
            })),
          } : current
        ));
      }
      void queryClient.invalidateQueries({ queryKey: viewerFollowingQueryKey, exact: true });
      void queryClient.invalidateQueries({ queryKey: followingKey });
    }

    onFollowingCountChange?.(following ? 1 : -1);
  }, [
    onFollowingCountChange,
    queryClient,
    sameAsViewerFollowing,
    stateKey,
    viewerFollowingQuery.data,
    viewerFollowingQueryKey,
    viewerId,
  ]);

  const renderPerson = useCallback(({ item }: { item: ConnectionUser }) => {
    const override = followOverrides.get(item.user_id);
    const serverFollowing = sameAsViewerFollowing || serverFollowingIds.has(item.user_id);
    const following = override ?? serverFollowing;
    const stateKnown = override !== undefined || serverFollowing || allFollowingLoaded;
    return (
      <ConnectionRow
        compact={compact}
        following={following}
        isSelf={item.user_id === viewerId}
        onFollowingChange={handleFollowingChange}
        person={item}
        stateKnown={stateKnown}
      />
    );
  }, [
    allFollowingLoaded,
    compact,
    followOverrides,
    handleFollowingChange,
    sameAsViewerFollowing,
    serverFollowingIds,
    viewerId,
  ]);

  const emptyState = (() => {
    if (!userId) {
      return (
        <StateView
          icon={<UserRound color={REFERENCE_THEME.textTertiary} size={29} strokeWidth={1.5} />}
          message="This profile could not be identified."
          title="Profile unavailable"
        />
      );
    }
    if (peopleQuery.isLoading) {
      return <StateView loading title={`Loading ${type}...`} />;
    }
    if (peopleQuery.isError) {
      return (
        <StateView
          icon={<UserRound color={REFERENCE_THEME.textTertiary} size={29} strokeWidth={1.5} />}
          message={peopleQuery.error instanceof Error
            ? peopleQuery.error.message
            : 'Check your connection and try again.'}
          onRetry={() => void peopleQuery.refetch()}
          title={`${type === 'followers' ? 'Followers' : 'Following'} could not load`}
        />
      );
    }
    if (search.trim()) {
      return (
        <StateView
          icon={<Search color={REFERENCE_THEME.textTertiary} size={27} strokeWidth={1.5} />}
          message={peopleQuery.hasNextPage
            ? 'No matches in the people loaded so far. Clear search to load more.'
            : 'Try another name or username.'}
          title="No matching people"
        />
      );
    }
    if (type === 'followers') {
      return (
        <StateView
          icon={<UsersRound color={REFERENCE_THEME.textTertiary} size={29} strokeWidth={1.5} />}
          message={username
            ? `When people follow @${username.replace(/^@/, '')}, they'll appear here.`
            : 'New followers will appear here.'}
          title="No followers yet"
        />
      );
    }
    return (
      <StateView
        icon={<UserPlus color={REFERENCE_THEME.textTertiary} size={29} strokeWidth={1.5} />}
        message="People followed from Weave will appear here."
        title="Not following anyone yet"
      />
    );
  })();

  const handleEndReached = useCallback(() => {
    if (peopleQuery.hasNextPage && !peopleQuery.isFetchingNextPage) {
      void peopleQuery.fetchNextPage();
    }
  }, [peopleQuery]);

  const listFooter = peopleQuery.isFetchingNextPage
    ? (
      <View style={styles.listFooter}>
        <ActivityIndicator color={REFERENCE_THEME.accent} size="small" />
        <Text style={styles.listFooterText}>Loading more people...</Text>
      </View>
    )
    : null;

  return (
    <View style={styles.root}>
      <View style={[styles.searchBox, compact && styles.searchBoxCompact]}>
        <Search color={REFERENCE_THEME.textTertiary} size={18} strokeWidth={1.8} />
        <TextInput
          accessibilityLabel={`Search ${type}`}
          accessibilityHint="Searches people loaded so far. More results load as you scroll."
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setSearch}
          placeholder={`Search ${type}`}
          placeholderTextColor={REFERENCE_THEME.textTertiary}
          returnKeyType="search"
          style={styles.searchInput}
          value={search}
        />
        {search ? (
          <Pressable
            accessibilityLabel="Clear search"
            hitSlop={8}
            onPress={() => setSearch('')}
            style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}
          >
            <X color={REFERENCE_THEME.textSecondary} size={13} strokeWidth={2.4} />
          </Pressable>
        ) : null}
      </View>

      {viewerFollowingQuery.isError && people.length > 0 ? (
        <View style={styles.statusError}>
          <Text style={styles.statusErrorText}>Follow status is unavailable.</Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => void viewerFollowingQuery.refetch()}
          >
            <Text style={styles.statusRetryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      <FlatList
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: contentPaddingBottom },
          filteredPeople.length === 0 && styles.emptyListContent,
        ]}
        data={filteredPeople}
        initialNumToRender={12}
        ItemSeparatorComponent={() => <View style={{ height: ROW_GAP }} />}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.user_id}
        ListEmptyComponent={emptyState}
        ListFooterComponent={listFooter}
        maxToRenderPerBatch={12}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.55}
        onRefresh={userId ? () => {
          void peopleQuery.refetch();
          if (viewerId && !sameAsViewerFollowing) void viewerFollowingQuery.refetch();
        } : undefined}
        refreshing={peopleQuery.isRefetching || viewerFollowingQuery.isRefetching}
        renderItem={renderPerson}
        showsVerticalScrollIndicator={false}
        style={styles.list}
        windowSize={7}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
  },
  searchBox: {
    height: 44,
    marginHorizontal: 18,
    marginTop: 14,
    marginBottom: 12,
    borderRadius: 14,
    borderCurve: 'continuous',
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: REFERENCE_THEME.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: REFERENCE_THEME.separator,
  },
  searchBoxCompact: {
    height: 40,
    marginHorizontal: 14,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 0,
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Regular',
    fontSize: 14,
  },
  clearButton: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: REFERENCE_THEME.controlStrong,
  },
  statusError: {
    marginHorizontal: 18,
    marginBottom: 10,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: 'rgba(255,69,58,0.10)',
  },
  statusErrorText: {
    flex: 1,
    color: REFERENCE_THEME.textSecondary,
    fontFamily: 'NataSans-Regular',
    fontSize: 12,
  },
  statusRetryText: {
    color: REFERENCE_THEME.accent,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 12,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 18,
  },
  emptyListContent: {
    flexGrow: 1,
  },
  listFooter: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  listFooterText: {
    color: REFERENCE_THEME.textSecondary,
    fontFamily: 'NataSans-Regular',
    fontSize: 12,
  },
  row: {
    height: 76,
    borderRadius: 18,
    borderCurve: 'continuous',
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: REFERENCE_THEME.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: REFERENCE_THEME.separator,
  },
  rowCompact: {
    height: 68,
    paddingHorizontal: 10,
    gap: 9,
  },
  avatarFallback: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarText: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
    fontSize: 14,
  },
  avatarTextCompact: {
    fontSize: 12,
  },
  personText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  displayName: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 15,
    lineHeight: 19,
  },
  displayNameCompact: {
    fontSize: 13,
    lineHeight: 17,
  },
  username: {
    color: REFERENCE_THEME.textSecondary,
    fontFamily: 'NataSans-Regular',
    fontSize: 12,
    lineHeight: 16,
  },
  stateView: {
    flex: 1,
    minHeight: 250,
    paddingHorizontal: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stateIcon: {
    width: 64,
    height: 64,
    marginBottom: 16,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: REFERENCE_THEME.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: REFERENCE_THEME.separator,
  },
  stateTitle: {
    marginTop: 12,
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 17,
    lineHeight: 22,
    textAlign: 'center',
  },
  stateMessage: {
    maxWidth: 320,
    marginTop: 6,
    color: REFERENCE_THEME.textSecondary,
    fontFamily: 'NataSans-Regular',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  retryButton: {
    minHeight: 36,
    marginTop: 16,
    borderRadius: 999,
    paddingHorizontal: 15,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: REFERENCE_THEME.controlStrong,
  },
  retryText: {
    color: REFERENCE_THEME.accent,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 13,
  },
  pressed: {
    opacity: 0.72,
    transform: [{ scale: 0.97 }],
  },
});
