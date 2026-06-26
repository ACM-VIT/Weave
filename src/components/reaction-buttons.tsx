import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { GitFork, MessageSquare, ThumbsDown, ThumbsUp } from 'lucide-react-native';

// ─── Keep these exports so any other import sites still compile ───────────────
export const BTN_SIZE = 40;
export const COL_W   = 60;

const TOP_REACTIONS = [
  { id: 'like',    Icon: ThumbsUp,   count: '1k',  color: '#F5C54D' },
  { id: 'dislike', Icon: ThumbsDown, count: '200', color: '#F5C54D' },
];

const BOTTOM_REACTIONS = [
  { id: 'fork',    Icon: GitFork,        count: '2k',  color: '#6DA963' },
  { id: 'comment', Icon: MessageSquare,  count: '400', color: '#6DA963' },
];

interface ReactionButtonsProps {
  /** 'top' renders buttons 1+2 (like/dislike) beside Card 2.
   *  'bottom' renders buttons 3+4 (fork/comment) beside Card 3. */
  slot: 'top' | 'bottom';
}

export function ReactionButtons({ slot }: ReactionButtonsProps) {
  const reactions = slot === 'top' ? TOP_REACTIONS : BOTTOM_REACTIONS;

  return (
    /**
     * w-[52px] ml-2 — fixed-width column, flex sibling of card wrapper.
     * pt-2 — a touch of top padding so first button aligns with card top area.
     * The dotted line runs full height of this column, giving a continuous
     * visual connector across the Card 2 and Card 3 rows (gap-4 handles spacing).
     */
    <View className="relative flex flex-col items-center w-[52px] ml-2 pt-2">

      {/* Dotted vertical line — full height of this button group */}
      <View className="absolute left-1/2 top-0 bottom-0 border-l-[1.5px] border-dashed border-[#6DA963] -translate-x-1/2 z-0" />

      {reactions.map(({ id, Icon, count, color }, i) => (
        <View
          key={id}
          className={`relative z-10 flex flex-col items-center${i < reactions.length - 1 ? ' mb-3' : ''}`}
        >
          {/* Small dot on the arm that connects dotted line → button */}
          <View className="absolute left-[-10px] top-1/2 w-2 h-2 rounded-full bg-[#6DA963] -translate-y-1/2" />

          <Pressable
            className="w-11 h-11 rounded-full bg-[#273126] border border-[#6DA963] flex items-center justify-center active:opacity-75"
          >
            <Icon size={18} color={color} strokeWidth={2} />
          </Pressable>

          <Text className="text-[#D9D9D9] text-[10px] mt-1 text-center">
            {count}
          </Text>
        </View>
      ))}
    </View>
  );
}
