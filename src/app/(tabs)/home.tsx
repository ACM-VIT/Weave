import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, LayoutChangeEvent, ListRenderItemInfo, NativeScrollEvent, NativeSyntheticEvent, StyleSheet, View } from "react-native";
import { ReadmeModal } from "@/components/home/readme-modal";
import { RepositoryCard } from "@/components/home/repository-card";
import { SavePopup } from "@/components/save-popup";
import { colors } from "@/constants/colors";
import { repositories } from "@/data/repositories";
import type { Repository } from "@/types/repository";

type Reaction = "like" | "dislike" | null;

export default function HomeScreen() {
  const [viewportHeight, setViewportHeight] = useState(0);
  const [activeReadme, setActiveReadme] = useState<Repository | null>(null);
  const [activeSaveRepo, setActiveSaveRepo] = useState<Repository | null>(null);
  const [reactions, setReactions] = useState<Record<string, Reaction>>({});
  const listRef = useRef<FlatList<Repository>>(null);

  const counts = useMemo(
    () =>
      repositories.reduce<Record<string, { likes: number; dislikes: number }>>((acc, repo) => {
        const reaction = reactions[repo.id] ?? null;
        acc[repo.id] = {
          likes: repo.likes + (reaction === "like" ? 1 : 0),
          dislikes: repo.dislikes + (reaction === "dislike" ? 1 : 0)
        };
        return acc;
      }, {}),
    [reactions]
  );

  const setReaction = useCallback((id: string, next: Exclude<Reaction, null>) => {
    setReactions((current) => ({
      ...current,
      [id]: current[id] === next ? null : next
    }));
  }, []);


  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setViewportHeight((current) => (current === nextHeight ? current : nextHeight));
  }, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Repository>) => (
      <RepositoryCard
        repository={item}
        viewportHeight={viewportHeight}
        counts={counts[item.id]}
        reaction={reactions[item.id] ?? null}
        onOpenReadme={() => setActiveReadme(item)}
        onReaction={setReaction}
        onSaveRepository={() => setActiveSaveRepo(item)}
      />
    ),
    [counts, reactions, setReaction, viewportHeight]
  );

  const getItemLayout = useCallback(
    (_: ArrayLike<Repository> | null | undefined, index: number) => ({
      length: viewportHeight,
      offset: viewportHeight * index,
      index
    }),
    [viewportHeight]
  );

  const handleMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!viewportHeight) {
        return;
      }

      const index = Math.round(event.nativeEvent.contentOffset.y / viewportHeight);
      listRef.current?.scrollToIndex({ index, animated: true });
    },
    [viewportHeight]
  );

  return (
    <View onLayout={handleLayout} style={styles.screen}>
      {viewportHeight > 0 ? (
        <FlatList
          ref={listRef}
          data={repositories}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          getItemLayout={getItemLayout}
          showsVerticalScrollIndicator={false}
          snapToInterval={viewportHeight}
          snapToAlignment="start"
          decelerationRate="fast"
          disableIntervalMomentum
          pagingEnabled
          bounces={false}
          overScrollMode="never"
          onMomentumScrollEnd={handleMomentumEnd}
          windowSize={3}
          maxToRenderPerBatch={2}
          initialNumToRender={1}
          removeClippedSubviews
        />
      ) : null}

      <ReadmeModal repository={activeReadme} onClose={() => setActiveReadme(null)} />
      <SavePopup isVisible={activeSaveRepo !== null} onClose={() => setActiveSaveRepo(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.black,
    flex: 1
  }
});
