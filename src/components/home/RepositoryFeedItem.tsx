import React, { useRef, useState } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type ViewStyle,
} from 'react-native';

import type { RepositoryData } from '../../data/repositories';
import type { FeedbackAction } from '../../api/activity';
import {
  DWELL_VISIBILITY_THRESHOLD_MS,
  FEEDBACK_ACTIONS,
  IMPRESSION_VISIBILITY_THRESHOLD_MS,
} from '../../constants/feedbackActions';
import { CommentSheet } from './CommentSheet';
import { ReadmePopup } from './ReadmePopup';
import { RepositoryScreen } from './RepositoryScreen';
import { SavePopup } from './save-popup';
import { ShareRepositorySheet } from './share-repository-sheet';

const WEB_FEED_ITEM_STYLE =
  Platform.OS === 'web'
    ? ({ scrollSnapAlign: 'start', scrollSnapStop: 'always' } as ViewStyle)
    : null;

export function RepositoryFeedItem({
  repository,
  pageWidth,
  pageHeight,
  isViewable = false,
  onQueueActivity,
}: {
  repository: RepositoryData;
  pageWidth: number;
  pageHeight: number;
  isViewable?: boolean;
  onQueueActivity?: (
    event: { repo_id: string; action: FeedbackAction; dwell_seconds?: number },
    flushNow?: boolean
  ) => void;
}) {
  const [isSaveVisible, setIsSaveVisible] = useState(false);
  const [isShareVisible, setIsShareVisible] = useState(false);
  const [isReadmeVisible, setIsReadmeVisible] = useState(false);
  const [isCommentsVisible, setIsCommentsVisible] = useState(false);
  const [isSaved, setIsSaved] = useState(repository.viewerSaved === true);
  const [commentCount, setCommentCount] = useState(
    Number(repository.stats.comments || 0) || 0
  );

  const visibleStartTime = useRef<number | null>(null);
  const impressionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const impressionSentRef = useRef(false);
  const touchStartRef = useRef({ x: 0, y: 0 });
  const saveSwipeRef = useRef(false);

  React.useEffect(() => {
    const finishVisibility = () => {
      if (visibleStartTime.current === null) return;
      const dwellSeconds = (Date.now() - visibleStartTime.current) / 1000;
      if (impressionTimeoutRef.current) {
        clearTimeout(impressionTimeoutRef.current);
        impressionTimeoutRef.current = null;
      }
      if (dwellSeconds * 1000 >= DWELL_VISIBILITY_THRESHOLD_MS) {
        onQueueActivity?.({
          repo_id: repository.id,
          action: FEEDBACK_ACTIONS.dwell,
          dwell_seconds: dwellSeconds,
        });
      }
      visibleStartTime.current = null;
    };

    if (isViewable) {
      visibleStartTime.current = Date.now();
      impressionSentRef.current = false;
      if (impressionTimeoutRef.current) clearTimeout(impressionTimeoutRef.current);
      impressionTimeoutRef.current = setTimeout(() => {
        if (visibleStartTime.current !== null && !impressionSentRef.current) {
          impressionSentRef.current = true;
          onQueueActivity?.({ repo_id: repository.id, action: FEEDBACK_ACTIONS.impression });
        }
      }, IMPRESSION_VISIBILITY_THRESHOLD_MS);
    } else finishVisibility();

    return finishVisibility;
  }, [isViewable, onQueueActivity, repository.id]);

  const overlaysOpen = isSaveVisible || isShareVisible || isReadmeVisible || isCommentsVisible;

  const handleTouchStart = (event: GestureResponderEvent) => {
    if (overlaysOpen) return;
    const touch = event.nativeEvent.touches?.[0];
    touchStartRef.current = {
      x: event.nativeEvent.pageX ?? touch?.pageX ?? 0,
      y: event.nativeEvent.pageY ?? touch?.pageY ?? 0,
    };
    saveSwipeRef.current = false;
  };

  const handleTouchMove = (event: GestureResponderEvent) => {
    if (overlaysOpen) return;
    const touch = event.nativeEvent.touches?.[0];
    const x = event.nativeEvent.pageX ?? touch?.pageX ?? 0;
    const y = event.nativeEvent.pageY ?? touch?.pageY ?? 0;
    const deltaX = x - touchStartRef.current.x;
    const deltaY = y - touchStartRef.current.y;
    if (deltaX < -56 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
      saveSwipeRef.current = true;
    }
  };

  const handleTouchEnd = () => {
    if (saveSwipeRef.current && !overlaysOpen) setIsSaveVisible(true);
    saveSwipeRef.current = false;
  };

  return (
    <View
      onTouchCancel={handleTouchEnd}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
      onTouchStart={handleTouchStart}
      style={[styles.feedItem, { width: pageWidth, height: pageHeight }, WEB_FEED_ITEM_STYLE]}
    >
      <RepositoryScreen
        commentCount={commentCount}
        isActive={isViewable}
        isSaved={isSaved}
        onCommentPress={() => setIsCommentsVisible(true)}
        onQueueActivity={onQueueActivity}
        onReadFullPress={() => {
          onQueueActivity?.(
            { repo_id: repository.id, action: FEEDBACK_ACTIONS.readmeOpen },
            true
          );
          setIsReadmeVisible(true);
        }}
        onSavePress={() => setIsSaveVisible(true)}
        onSharePress={() => setIsShareVisible(true)}
        pageHeight={pageHeight}
        pageWidth={pageWidth}
        repository={repository}
      />

      <SavePopup
        isVisible={isSaveVisible}
        onClose={() => setIsSaveVisible(false)}
        onSaved={setIsSaved}
        repoId={repository.id}
        repoName={repository.title}
        serveId={repository.serveId}
        position={repository.feedPosition}
      />
      <ShareRepositorySheet
        isVisible={isShareVisible}
        onClose={() => setIsShareVisible(false)}
        onShared={() => onQueueActivity?.(
          { repo_id: repository.id, action: FEEDBACK_ACTIONS.share },
          true,
        )}
        repositoryId={repository.id}
      />
      <CommentSheet
        initialCommentCount={commentCount}
        isVisible={isCommentsVisible}
        onClose={() => setIsCommentsVisible(false)}
        onCommentCountChange={setCommentCount}
        repoId={repository.id}
      />
      <ReadmePopup
        isVisible={isReadmeVisible}
        onClose={() => setIsReadmeVisible(false)}
        readmeText={repository.readmeFull}
        title={repository.title}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  feedItem: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#000000',
  },
});
