import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Layers } from 'lucide-react-native';
import {
  Gesture,
  GestureDetector,
  type GestureType,
} from 'react-native-gesture-handler';

import { REFERENCE_THEME } from '@/constants/theme';
import type { RepositoryData } from '../../data/repositories';
import { TechStackIcon } from './TechStackIcon';

const TECH_COLORS: Record<string, string> = {
  Android: '#3DDC84',
  'Android SDK': '#3DDC84',
  Astro: '#FF5D01',
  Bash: '#8E8E93',
  'C#': '#9B4F96',
  'C++': '#659AD2',
  CSS: '#1572B6',
  Docker: '#2496ED',
  Expo: '#B8C2CC',
  Go: '#00ADD8',
  HTML: '#E34F26',
  Java: '#ED8B00',
  JavaScript: '#F7DF1E',
  Javascript: '#F7DF1E',
  MongoDB: '#47A248',
  Node: '#5FA04E',
  'Node.js': '#5FA04E',
  NumPy: '#4DABCF',
  PHP: '#777BB4',
  PostgreSQL: '#4169E1',
  Python: '#3572A5',
  Qdrant: '#DC244C',
  React: '#61DAFB',
  Redis: '#FF4438',
  Ruby: '#CC342D',
  Rust: '#DEA584',
  Shell: '#8E8E93',
  Supabase: '#3ECF8E',
  SVG: '#FFB13B',
  Tailwind: '#38BDF8',
  'Tailwind CSS': '#38BDF8',
  TypeScript: '#3178C6',
  WASM: '#654FF0',
};

type DescriptionCardProps = {
  repository: RepositoryData;
  compact?: boolean;
  availableWidth: number;
};

export const SaveSwipeGestureContext = React.createContext<GestureType | null>(null);
SaveSwipeGestureContext.displayName = 'SaveSwipeGestureContext';

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

export default function DescriptionCard({
  repository,
  compact = false,
  availableWidth,
}: DescriptionCardProps) {
  const technologies = repository.techStack ?? [];
  const veryNarrow = availableWidth < 240;
  const circleSize = compact
    ? clamp(availableWidth * 0.14, 31, 38)
    : clamp(availableWidth * 0.12, 40, 50);
  const iconSize = Math.round(circleSize * 0.58);
  const horizontalPadding = veryNarrow ? 10 : compact ? 12 : 21;
  const itemGap = compact ? 6 : 12;
  const hasOverflowingTechnologies = technologies.length > 3;
  const trailingPeek = hasOverflowingTechnologies ? (compact ? 26 : 36) : 0;
  const itemWidth = Math.max(
    (availableWidth - horizontalPadding * 2 - itemGap * 2 - trailingPeek) / 3,
    64,
  );
  const saveSwipeGesture = React.useContext(SaveSwipeGestureContext);
  const techStackScrollGesture = React.useMemo(() => {
    const gesture = Gesture.Native().shouldCancelWhenOutside(false);
    if (saveSwipeGesture) gesture.blocksExternalGesture(saveSwipeGesture);
    return gesture;
  }, [saveSwipeGesture]);

  return (
    <View
      style={[
        styles.card,
        compact && styles.cardCompact,
        { paddingHorizontal: horizontalPadding },
      ]}
    >
      <View style={styles.headingRow}>
        <Layers size={12} color={REFERENCE_THEME.accentLight} strokeWidth={2} />
        <Text style={styles.heading}>TECH STACK</Text>
      </View>

      <GestureDetector gesture={techStackScrollGesture}>
        <ScrollView
          contentContainerStyle={[
            styles.grid,
            compact && styles.gridCompact,
            hasOverflowingTechnologies && styles.gridScrollable,
          ]}
          directionalLockEnabled
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator={false}
        >
          {technologies.length > 0 ? technologies.map((technology) => {
            const colour = TECH_COLORS[technology] ?? '#8E8E93';

            return (
              <View
                key={technology}
                style={[styles.item, { width: itemWidth }]}
              >
                <View
                  style={[
                    styles.iconCircle,
                    {
                      width: circleSize,
                      height: circleSize,
                      borderRadius: circleSize / 2,
                      backgroundColor: `${colour}26`,
                    },
                  ]}
                >
                  <TechStackIcon color={colour} name={technology} size={iconSize} />
                </View>
                <Text
                  adjustsFontSizeToFit
                  minimumFontScale={0.76}
                  style={[
                    styles.label,
                    compact && styles.labelCompact,
                    veryNarrow && styles.labelVeryNarrow,
                  ]}
                  numberOfLines={1}
                >
                  {technology}
                </Text>
              </View>
            );
          }) : (
            <View style={styles.emptyRow}>
              <Text style={styles.emptyText}>Stack details unavailable</Text>
            </View>
          )}
        </ScrollView>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 18,
    backgroundColor: 'rgba(28,28,30,0.78)',
    paddingTop: 19,
    paddingRight: 21,
    paddingBottom: 20,
    paddingLeft: 21,
    overflow: 'hidden',
  },
  cardCompact: {
    paddingTop: 11,
    paddingBottom: 12,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  heading: {
    color: REFERENCE_THEME.accentLight,
    fontFamily: 'NataSans-Bold',
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.6,
  },
  grid: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 17,
    columnGap: 12,
  },
  gridCompact: {
    marginTop: 8,
    columnGap: 6,
  },
  gridScrollable: {
    paddingRight: 18,
  },
  item: {
    alignItems: 'center',
    gap: 8,
  },
  iconCircle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    width: '100%',
    color: REFERENCE_THEME.textPrimary,
    fontFamily: 'NataSans-Medium',
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
  labelCompact: {
    fontSize: 11,
    lineHeight: 15,
  },
  labelVeryNarrow: {
    fontSize: 10,
    lineHeight: 14,
  },
  emptyRow: {
    flex: 1,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: REFERENCE_THEME.textTertiary,
    fontFamily: 'NataSans-Regular',
    fontSize: 12,
  },
});
