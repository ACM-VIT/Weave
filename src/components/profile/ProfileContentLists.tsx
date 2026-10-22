import React, { useMemo } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { FolderPlus } from 'lucide-react-native';
import { listMembershipKey, type ListDto } from '../../models/list';
import { BoardListCard } from './BoardListCard';

type SectionQuery<T> = {
  data?: T;
  isPending: boolean;
  isError: boolean;
  refetch: () => unknown;
};

type Props = {
  viewer: string | undefined;
  header: React.ReactElement;
  compact: boolean;
  gap: number;
  horizontalPadding: number;
  maxWidth: number;
  paddingTop: number;
  paddingBottom: number;
  boards: SectionQuery<ListDto[]>;
  collections: SectionQuery<ListDto[]>;
  pinned: SectionQuery<unknown[]>;
  openList: (params: Record<string, string>) => void;
};

type ListRow =
  | { key: string; kind: 'list'; item: ListDto }
  | { key: string; kind: 'pinned' }
  | { key: string; kind: 'state'; section: 'boards' | 'collections' | 'pinned' }
  | { key: string; kind: 'empty' };

export function ProfileContentLists(props: Props) {
  const { compact, gap, boards, collections, pinned, openList } = props;
  const rows = useMemo(() => {
    if (!props.viewer) return [];
    const result: ListRow[] = [];
    if (pinned.data) result.push({ key: 'pinned', kind: 'pinned' });
    if (pinned.isPending || pinned.isError) result.push({ key: 'state:pinned', kind: 'state', section: 'pinned' });
    if (boards.isPending || boards.isError) result.push({ key: 'state:boards', kind: 'state', section: 'boards' });
    if (collections.isPending || collections.isError) result.push({ key: 'state:collections', kind: 'state', section: 'collections' });
    // Both stores represent the same product List. Keep one global ordering,
    // including ready cached rows when a section fails to refresh.
    const lists = [...(boards.data ?? []), ...(collections.data ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    result.push(...lists.map(item => ({ key: listMembershipKey(item), kind: 'list' as const, item })));
    if (boards.data?.length === 0 && collections.data?.length === 0 && !boards.isError && !collections.isError) {
      result.push({ key: 'empty', kind: 'empty' });
    }
    return result;
  }, [props.viewer, boards.data, boards.isPending, boards.isError, collections.data, collections.isPending, collections.isError, pinned.data, pinned.isPending, pinned.isError]);

  const sectionState = (label: string, query: SectionQuery<unknown>) => (
    <View style={{ minHeight: 70, alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 12 }}>
      {query.isPending ? <>
        <ActivityIndicator color="#63E08A" accessibilityLabel={`Loading ${label}`} />
        <Text className="text-[#77767C] font-nata">Loading {label}…</Text>
      </> : query.isError ? <>
        <Text accessibilityLiveRegion="polite" className="text-[#FF6878] font-nata text-center">Unable to load your {label}.</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Retry ${label}`} onPress={() => void query.refetch()} className="rounded-[12px] bg-[#292929] px-5 py-3">
          <Text className="text-white font-nataSemiBold">Retry</Text>
        </Pressable>
      </> : null}
    </View>
  );

  const renderListRow = ({ item: row }: { item: ListRow }) => {
    let content: React.ReactNode;
    if (row.kind === 'list') {
      const { item } = row;
      const params: Record<string, string> = item.source === 'legacy-board'
        ? { boardId: item.id, boardName: item.name }
        : { collectionId: item.id, collectionType: 'collection', boardName: item.name };
      content = <BoardListCard compact={compact} description={item.description} name={item.name} repositoryCount={item.repositoryCount}
        onPress={() => openList({ ...params, ...(item.description ? { boardDescription: item.description } : {}) })} />;
    } else if (row.kind === 'pinned') {
      content = <BoardListCard compact={compact} name="Pinned" variant="pinned" repositoryCount={pinned.data?.length ?? 0}
        onPress={() => openList({ boardName: 'Pinned', collectionType: 'pinned' })} />;
    } else if (row.kind === 'state') {
      const label = row.section === 'pinned' ? 'pinned repositories' : row.section === 'boards' ? 'legacy Lists' : 'Lists';
      content = sectionState(label, props[row.section]);
    } else {
      content = <View className="items-center justify-center py-9 px-6 gap-4">
        <View className="w-[68px] h-[68px] rounded-[22px] bg-[#151515] border border-[#252525] items-center justify-center" style={{ borderCurve: 'continuous' }}>
          <FolderPlus size={29} color="#63E08A" strokeWidth={1.7} />
        </View>
        <View className="items-center gap-2" style={{ maxWidth: 330 }}>
          <Text className="text-[#F7F7F8] font-nataSemiBold text-center" style={{ fontSize: compact ? 15 : 17 }}>Create your first list</Text>
          <Text className="text-[#77767C] font-nata text-center" style={{ fontSize: compact ? 11 : 13, lineHeight: compact ? 17 : 19 }}>Lists you create while saving repositories will appear here.</Text>
        </View>
      </View>;
    }
    return <View testID={`profile-list-${row.key}`} style={{ paddingBottom: gap }}>{content}</View>;
  };

  // The profile header scrolls with the content without nesting a virtualized
  // list in a ScrollView. Account changes reset both rows and scroll position.
  return <FlatList key={`lists:${props.viewer}`} testID="profile-lists" style={{ flex: 1 }}
    data={rows} renderItem={renderListRow} keyExtractor={row => row.key}
    initialNumToRender={8} maxToRenderPerBatch={8} windowSize={5}
    ListHeaderComponent={<View style={{ paddingBottom: gap }}>{props.header}</View>}
    showsVerticalScrollIndicator={false} contentInsetAdjustmentBehavior="automatic"
    contentContainerStyle={{
      paddingHorizontal: props.horizontalPadding, paddingTop: props.paddingTop, paddingBottom: props.paddingBottom,
      flexGrow: 1, justifyContent: 'center',
      width: '100%', maxWidth: props.maxWidth + props.horizontalPadding * 2, alignSelf: 'center',
    }} />;
}
