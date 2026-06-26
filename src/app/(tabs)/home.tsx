import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Bug, Clock, Eye, GitFork, MessageSquare, Star, ThumbsDown, ThumbsUp } from 'lucide-react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import Svg, { Path } from 'react-native-svg';

import { RepoCard } from '@/components/repo-card';
import { SavePopup } from '@/components/save-popup';
import { getResponsiveContentWidth } from '@/components/responsive-layout';

type ScreenMode = 'home' | 'details';

const TAB_BAR_HEIGHT = 60;
const WEB_FEED_LIST_STYLE =
  Platform.OS === 'web'
    ? ({ overflowY: 'auto', scrollSnapType: 'y mandatory' } as ViewStyle)
    : null;
const WEB_FEED_ITEM_STYLE =
  Platform.OS === 'web'
    ? ({ scrollSnapAlign: 'start', scrollSnapStop: 'always' } as ViewStyle)
    : null;

type RepositoryData = {
  id: string;
  title: string;
  owner: string;
  stats: {
    stars: string;
    views: string;
    bugs: string;
  };
  updatedText: string;
};

type FeedRepository = {
  feedId: string;
  repository: RepositoryData;
};

type ViewabilityItem = {
  index?: number | null;
};

// ─── Card definitions ────────────────────────────────────────────────────────
const HOME_CARDS = [
  { label: 'Description',    height: 175 },
  { label: 'Tech Stack',     height: 160 },
  { label: 'README Summary', height: 140 },
];

const DETAIL_CARDS = [
  { label: 'ARCHITECTURE', height: 190 },
  { label: 'CODE SNIPPET',  height: 130 },
  { label: 'ISSUES',        height: 160 },
];

const REACTIONS = [
  { id: 'like',    Icon: ThumbsUp,      count: '1k',  color: '#F5C54D' },
  { id: 'dislike', Icon: ThumbsDown,    count: '200', color: '#F5C54D' },
  { id: 'fork',    Icon: GitFork,       count: '2k',  color: '#6DA963' },
  { id: 'comment', Icon: MessageSquare, count: '400', color: '#6DA963' },
];

const REPOSITORIES: RepositoryData[] = [
  {
    id: 'github-social',
    title: 'Github_Social',
    owner: 'acm_vit',
    stats: {
      stars: '1.2k',
      views: '5k',
      bugs: '12',
    },
    updatedText: 'updated 2 days ago',
  },
  {
    id: 'opensource-hub',
    title: 'OpenSourceHub',
    owner: 'open-source-team',
    stats: {
      stars: '980',
      views: '3.6k',
      bugs: '8',
    },
    updatedText: 'updated yesterday',
  },
  {
    id: 'ai-assistant',
    title: 'AI-Assistant',
    owner: 'ml-studio',
    stats: {
      stars: '2.1k',
      views: '8.4k',
      bugs: '16',
    },
    updatedText: 'updated 4 hours ago',
  },
  {
    id: 'interview-prep',
    title: 'InterviewPrep',
    owner: 'career-labs',
    stats: {
      stars: '740',
      views: '2.8k',
      bugs: '5',
    },
    updatedText: 'updated today',
  },
];

const VIEWABILITY_CONFIG = {
  itemVisiblePercentThreshold: 80,
};

export default function HomeScreen() {
  const { width, height } = useWindowDimensions();
  const pageWidth = getResponsiveContentWidth(width) ?? width;
  const pageHeight = Math.max(height - TAB_BAR_HEIGHT, 1);
  const [activeRepositoryIndex, setActiveRepositoryIndex] = useState(0);
  const [feedItems, setFeedItems] = useState<FeedRepository[]>(
    REPOSITORIES.map((repository, index) => ({
      feedId: `${repository.id}-${index}`,
      repository,
    }))
  );

  const activeRepository = feedItems[activeRepositoryIndex]?.repository ?? feedItems[0]?.repository;
  void activeRepository;

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewabilityItem[] }) => {
      const nextIndex = viewableItems.find(
        (item) => typeof item.index === 'number' && item.index !== null
      )?.index;
      if (typeof nextIndex === 'number') {
        setActiveRepositoryIndex(nextIndex);
      }
    },
    []
  );

  const loadMoreRepositories = () => {
    setFeedItems((current) => {
      if (current.length >= 16) return current;

      const nextBatchStart = current.length;
      const nextBatch = REPOSITORIES.map((repository, index) => ({
        feedId: `${repository.id}-${nextBatchStart + index}`,
        repository,
      }));

      return [...current, ...nextBatch];
    });
  };

  const snapOffsets = feedItems.map((_, index) => pageHeight * index);

  return (
    <View style={styles.outer}>
      <View style={[styles.feedShell, { maxWidth: pageWidth, height: pageHeight }]}>
        <FlatList
          key={`${pageWidth}-${pageHeight}`}
          data={feedItems}
          keyExtractor={(item) => item.feedId}
          renderItem={({ item }) => (
            <RepositoryFeedItem
              repository={item.repository}
              pageWidth={pageWidth}
              pageHeight={pageHeight}
            />
          )}
          style={[styles.feedList, { height: pageHeight }, WEB_FEED_LIST_STYLE]}
          contentContainerStyle={styles.feedListContent}
          showsVerticalScrollIndicator={false}
          snapToInterval={pageHeight}
          snapToOffsets={snapOffsets}
          snapToAlignment="start"
          decelerationRate="fast"
          pagingEnabled
          disableIntervalMomentum
          overScrollMode="never"
          getItemLayout={(_, index) => ({
            length: pageHeight,
            offset: pageHeight * index,
            index,
          })}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={VIEWABILITY_CONFIG}
          onEndReached={loadMoreRepositories}
          onEndReachedThreshold={0.75}
          initialNumToRender={1}
          maxToRenderPerBatch={2}
          windowSize={3}
          removeClippedSubviews={false}
        />
      </View>
    </View>
  );
}

// ─── Per-screen component ────────────────────────────────────────────────────
function RepositoryFeedItem({
  repository,
  pageWidth,
  pageHeight,
}: {
  repository: RepositoryData;
  pageWidth: number;
  pageHeight: number;
}) {
  const [mode, setMode] = useState<ScreenMode>('home');
  const [isPopupVisible, setIsPopupVisible] = useState(false);
  const translateX = useSharedValue(0);

  useEffect(() => {
    translateX.value =
      mode === 'details'
        ? withTiming(-pageWidth, { duration: 280 })
        : withTiming(0, { duration: 280 });
  }, [mode, pageWidth, translateX]);

  const screensStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const openSaveSheet = () => setIsPopupVisible(true);
  const openDetails = () => setMode('details');
  const openHome = () => setMode('home');

  const swipeGesture = Gesture.Pan()
    .activeOffsetX([-18, 18])
    .failOffsetY([-16, 16])
    .onEnd((event) => {
      const isStrongSwipe =
        Math.abs(event.translationX) > 50 || Math.abs(event.velocityX) > 400;
      if (!isStrongSwipe) return;

      if (event.translationX > 0) {
        if (mode === 'home') {
          runOnJS(openSaveSheet)();
        } else if (mode === 'details') {
          runOnJS(openHome)();
        }
      }
      if (event.translationX < 0 && mode === 'home') {
        runOnJS(openDetails)();
      }
    });

  return (
    <View style={[styles.feedItem, { width: pageWidth, height: pageHeight }, WEB_FEED_ITEM_STYLE]}>
      <GestureDetector gesture={swipeGesture}>
        <Animated.View style={[styles.screens, { width: pageWidth * 2, height: pageHeight }, screensStyle]}>
          <RepositoryScreen type="home" pageWidth={pageWidth} pageHeight={pageHeight} repository={repository} />
          <RepositoryScreen type="details" pageWidth={pageWidth} pageHeight={pageHeight} repository={repository} />
        </Animated.View>
      </GestureDetector>
      <SavePopup isVisible={isPopupVisible} onClose={() => setIsPopupVisible(false)} />
    </View>
  );
}

function RepositoryScreen({
  type,
  pageWidth,
  pageHeight,
  repository,
}: {
  type: ScreenMode;
  pageWidth: number;
  pageHeight: number;
  repository: RepositoryData;
}) {
  const isDetails = type === 'details';
  const cards     = isDetails ? DETAIL_CARDS : HOME_CARDS;
  const variant   = isDetails ? 'section' : 'center';

  const isSmallPhone = pageWidth < 380;
  // Multiplier for vertical dimensions so they fit on small screens
  const baseHeight = 700;
  const heightMultiplier = Math.max(0.65, Math.min(1, pageHeight / baseHeight));

  const TIMELINE_COL_WIDTH = isSmallPhone ? 36 : 44;
  const TIMELINE_MID = TIMELINE_COL_WIDTH / 2;
  const ACTIONS_COL_WIDTH = isSmallPhone ? 60 : 72;

  // ── Fixed heights & gaps ──────────────────────────────────────────────────
  const HEADER_H  = 56 * heightMultiplier;
  const H1        = cards[0].height * heightMultiplier;
  const H2        = cards[1].height * heightMultiplier;
  const H3        = cards[2].height * heightMultiplier;
  const CARD_GAP  = 16 * heightMultiplier;

  // ── Y positions (relative to the top of gridContainer) ───────────────────
  const y0 = HEADER_H / 2;                              
  const y1 = HEADER_H + H1 / 2;                         
  const y2 = HEADER_H + H1 + CARD_GAP + H2 / 2;        
  const y2_bottom = HEADER_H + H1 + CARD_GAP + H2;     
  const y3_bottom = HEADER_H + H1 + CARD_GAP + H2 + CARD_GAP + H3; 

  // ── Dotted line spans card2-midpoint to card3-bottom ─────────────────────
  const y_dotted_start = HEADER_H + H1 + CARD_GAP + H2 / 2 - (24 * heightMultiplier);
  const y_dotted_end   = y3_bottom - (16 * heightMultiplier);

  // ── Evenly distribute 4 action buttons along the dotted line ─────────────
  const actionPositions = [
    y_dotted_start + (y_dotted_end - y_dotted_start) * 0,
    y_dotted_start + (y_dotted_end - y_dotted_start) * 0.333,
    y_dotted_start + (y_dotted_end - y_dotted_start) * 0.666,
    y_dotted_end,
  ];

  const ACTION_LINE_X = 16;
  const ACTION_BTN_SIZE = isSmallPhone ? 36 : 48;
  const ACTION_BTN_LEFT = isSmallPhone ? 20 : 22;
  const ACTION_BTN_RADIUS = ACTION_BTN_SIZE / 2;
  const actionBtnArmWidth = ACTION_BTN_LEFT - ACTION_LINE_X;

  return (
    <View style={[styles.screen, { width: pageWidth, height: pageHeight }]}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.screenInner}>
        <ScrollView 
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 24 }} 
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          <View style={styles.gridContainer}>
            {/* Column 1: Timeline */}
            <View style={[styles.timelineCol, { width: TIMELINE_COL_WIDTH }]}>
              {/* Vertical solid line from header dot to Node 2 */}
              <View style={[styles.timelineSpine, { top: y0, height: y2 - y0, left: TIMELINE_MID - 0.75 }]} />

              {/* Header Node */}
              <View style={[styles.timelineDot, { top: y0 - 6, left: TIMELINE_MID - 6 }]} />

              {/* Node 1 & Arm */}
              <View style={[styles.timelineDot, { top: y1 - 6, left: TIMELINE_MID - 6 }]} />
              <View style={[styles.timelineArm, { top: y1 - 0.75, left: TIMELINE_MID }]} />

              {/* Node 2 & Arm */}
              <View style={[styles.timelineDot, { top: y2 - 6, left: TIMELINE_MID - 6 }]} />
              <View style={[styles.timelineArm, { top: y2 - 0.75, left: TIMELINE_MID }]} />

              {/* Timeline Bottom Curve */}
              <Svg
                style={{ position: 'absolute', top: y2, left: 0 }}
                width={TIMELINE_COL_WIDTH}
                height={y3_bottom - y2}
                viewBox={`0 0 ${TIMELINE_COL_WIDTH} ${y3_bottom - y2}`}
                fill="none"
              >
                <Path
                  d={`M ${TIMELINE_MID} 0 L ${TIMELINE_MID} ${y3_bottom - y2 - TIMELINE_MID} Q ${TIMELINE_MID} ${y3_bottom - y2} ${TIMELINE_COL_WIDTH} ${y3_bottom - y2}`}
                  stroke="#6DA963"
                  strokeWidth={1.5}
                />
              </Svg>
            </View>

            {/* Column 2: Cards */}
            <View style={styles.cardsCol}>
              {/* Header */}
              <View style={[styles.header, { height: HEADER_H }]}>
                <Text style={[styles.title, isSmallPhone && { fontSize: 15, lineHeight: 20 }]}>{repository.title}</Text>
              </View>

              {/* Card 1 */}
              <RepoCard label={cards[0].label} height={H1} variant={variant} isSmallPhone={isSmallPhone} />

              <View style={{ height: CARD_GAP }} />

              {/* Card 2 */}
              <RepoCard label={cards[1].label} height={H2} variant={variant} isSmallPhone={isSmallPhone} />

              <View style={{ height: CARD_GAP }} />

              {/* Card 3 */}
              <RepoCard label={cards[2].label} height={H3} variant={variant} isSmallPhone={isSmallPhone} />

              {/* Footer */}
              <UserFooter repository={repository} isSmallPhone={isSmallPhone} />
            </View>

            {/* Column 3: Actions */}
            <View style={[styles.actionsCol, { width: ACTIONS_COL_WIDTH }]}>
              {/* Card 2 Bottom-Right Top Curve */}
              <Svg
                style={{ position: 'absolute', top: y2_bottom - 24, left: 0 }}
                width={16}
                height={16}
                viewBox="0 0 16 16"
                fill="none"
              >
                <Path
                  d="M 0 0.75 Q 16 0.75 16 16"
                  stroke="#6DA963"
                  strokeWidth={1.5}
                />
              </Svg>

              {/* Card 3 Bottom-Right Bottom Curve */}
              <Svg
                style={{ position: 'absolute', top: y3_bottom - 16, left: 0 }}
                width={16}
                height={16}
                viewBox="0 0 16 16"
                fill="none"
              >
                <Path
                  d="M 16 0 Q 16 15.25 0 15.25"
                  stroke="#6DA963"
                  strokeWidth={1.5}
                />
              </Svg>

              {/* Dotted vertical line in between curves */}
              <View style={[styles.actionDottedLine, { top: y_dotted_start, height: y_dotted_end - y_dotted_start }]} />

              {/* Action Buttons */}
              {REACTIONS.map(({ id, Icon, count, color }, index) => {
                const y_pos = actionPositions[index];
                return (
                  <View key={id} style={[styles.actionItemContainer, { top: y_pos - ACTION_BTN_RADIUS }]}>
                    {/* Small intersection dot on the line */}
                    <View style={[styles.actionArmDot, { top: ACTION_BTN_RADIUS - 4 }]} />

                    {/* Arm connecting dot to button */}
                    <View style={[styles.actionBtnArm, { width: actionBtnArmWidth, top: ACTION_BTN_RADIUS - 0.75 }]} />

                    {/* Pressable button */}
                    <Pressable
                      style={({ pressed }) => [
                        styles.reactionBtn,
                        { width: ACTION_BTN_SIZE, height: ACTION_BTN_SIZE, borderRadius: ACTION_BTN_RADIUS, left: ACTION_BTN_LEFT },
                        pressed && styles.reactionBtnPressed,
                      ]}
                    >
                      <Icon size={isSmallPhone ? 14 : 16} color={color} strokeWidth={2} />
                      <Text style={[styles.reactionCount, isSmallPhone && { fontSize: 8 }]}>{count}</Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

// helper — needed by Column 3 curves (card2 bottom y)
const _h = (cards: typeof HOME_CARDS, gap: number) => {
  const HEADER_H = 56;
  const H1 = cards[0].height;
  const H2 = cards[1].height;
  return HEADER_H + H1 + gap + H2;
};
// We reference y2_bottom inside RepositoryScreen via closure — kept local

// ─── Footer ──────────────────────────────────────────────────────────────────
function UserFooter({ repository, isSmallPhone }: { repository: RepositoryData, isSmallPhone?: boolean }) {
  return (
    <View style={[styles.footer, isSmallPhone && { marginTop: 16 }]}>
      <View style={[styles.avatar, isSmallPhone && { width: 32, height: 32, borderRadius: 16, marginRight: 10 }]} />
      <View style={styles.userMeta}>
        <Text style={[styles.username, isSmallPhone && { fontSize: 14, lineHeight: 18 }]}>{repository.owner}</Text>
        <View style={[styles.stats, isSmallPhone && { gap: 10, marginTop: 4 }]}>
          <View style={styles.statItem}>
            <Star size={isSmallPhone ? 12 : 15} color="#6DA963" strokeWidth={1.8} />
            <Text style={[styles.statText, isSmallPhone && { fontSize: 10 }]}>{repository.stats.stars}</Text>
          </View>
          <View style={styles.statItem}>
            <Eye size={isSmallPhone ? 12 : 15} color="#6DA963" strokeWidth={1.8} />
            <Text style={[styles.statText, isSmallPhone && { fontSize: 10 }]}>{repository.stats.views}</Text>
          </View>
          <View style={styles.statItem}>
            <Bug size={isSmallPhone ? 11 : 14} color="#6DA963" strokeWidth={2} />
            <Text style={[styles.statText, isSmallPhone && { fontSize: 10 }]}>{repository.stats.bugs}</Text>
          </View>
        </View>
        <View style={[styles.dateRow, isSmallPhone && { marginTop: 4 }]}>
          <Clock size={isSmallPhone ? 10 : 14} color="#A49898" strokeWidth={1.6} />
          <Text style={[styles.dateText, isSmallPhone && { fontSize: 9 }]}>{repository.updatedText}</Text>
        </View>
      </View>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  // Shell
  outer: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#090B08',
  },
  feedShell: {
    width: '100%',
    backgroundColor: '#10150F',
    overflow: 'hidden',
    position: 'relative',
  },
  feedList: {
    flex: 1,
    width: '100%',
  },
  feedListContent: {
    flexGrow: 0,
  },
  feedItem: {
    backgroundColor: '#10150F',
    overflow: 'hidden',
  },
  device: {
    flex: 1,
    width: '100%',
    backgroundColor: '#10150F',
    overflow: 'hidden',
    position: 'relative',
  },
  screens: {
    flexDirection: 'row',
  },
  screen: {
    backgroundColor: '#10150F',
  },
  screenInner: {
    flex: 1,
    width: '100%',
  },
  scrollContent: {
    flexGrow: 1,
  },
  title: {
    color: '#FFFFFF',
    fontFamily: 'NataSans-Bold',
    fontSize: 17,
    lineHeight: 22,
  },

  // ── Grid Layout ────────────────────────────────────────────────────────────
  gridContainer: {
    width: '100%',
    flexDirection: 'row',
    position: 'relative',
  },
  timelineCol: {
    width: 44,
    position: 'relative',
  },
  cardsCol: {
    flex: 1,
  },
  actionsCol: {
    width: 72,
    position: 'relative',
  },

  header: {
    height: 56,
    justifyContent: 'center',
  },

  // ── Timeline Column styles ─────────────────────────────────────────────────
  timelineSpine: {
    position: 'absolute',
    left: 22 - 0.75,
    width: 1.5,
    backgroundColor: '#6DA963',
    zIndex: 0,
  },
  timelineDot: {
    position: 'absolute',
    left: 22 - 6,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#6DA963',
    backgroundColor: '#FFFFFF',
    zIndex: 10,
  },
  timelineArm: {
    position: 'absolute',
    left: 22,
    right: 0,
    height: 1.5,
    backgroundColor: '#6DA963',
    zIndex: 10,
  },

  // ── Action Column styles ───────────────────────────────────────────────────
  actionDottedLine: {
    position: 'absolute',
    left: 16 - 0.75,
    width: 1.5,
    borderLeftWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#6DA963',
    zIndex: 0,
  },
  actionCardArm: {
    position: 'absolute',
    left: 0,
    width: 16,
    height: 1.5,
    backgroundColor: '#6DA963',
    zIndex: 10,
  },
  actionItemContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 48,
    zIndex: 10,
  },
  actionArmDot: {
    position: 'absolute',
    left: 16 - 4,
    top: 24 - 4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#6DA963',
  },
  actionBtnArm: {
    position: 'absolute',
    left: 16,
    width: 6,
    top: 24 - 0.75,
    height: 1.5,
    backgroundColor: '#6DA963',
    zIndex: 10,
  },
  reactionBtn: {
    position: 'absolute',
    left: 22,
    top: 0,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#1E241E',
    borderWidth: 1.5,
    borderColor: '#6DA963',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  reactionBtnPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.95 }],
  },
  reactionCount: {
    color: '#FFFFFF',
    fontSize: 9,
    fontFamily: 'NataSans-Bold',
    marginTop: 1,
    textAlign: 'center',
  },

  // ── Footer ─────────────────────────────────────────────────────────────────
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 0,
    marginTop: 24,
    paddingBottom: 8,
    width: '100%',
  },
  avatar: {
    width: 41,
    height: 41,
    borderRadius: 21,
    backgroundColor: '#6DA963',
    marginRight: 14,
  },
  userMeta: {
    flex: 1,
  },
  username: {
    color: '#FFFFFF',
    fontFamily: 'NataSans-Bold',
    fontSize: 16,
    lineHeight: 21,
  },
  stats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 17,
    marginTop: 8,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  statText: {
    color: '#FFFFFF',
    fontFamily: 'NataSans-Regular',
    fontSize: 12,
    lineHeight: 16,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
  },
  dateText: {
    color: '#A49898',
    fontFamily: 'NataSans-Regular',
    fontSize: 10,
    lineHeight: 14,
  },
});

// Suppress unused var — kept for potential future use
void _h;
