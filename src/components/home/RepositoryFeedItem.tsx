import React, { useRef, useState } from 'react';
import {
  AppState,
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
import { CommentSheet, type CommentComposerState } from './CommentSheet';
import { ReadmePopup } from './ReadmePopup';
import { RepositoryScreen } from './RepositoryScreen';
import { SavePopup, type SavePopupMutationState } from './save-popup';
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
  boundary,
  onOwnerPress,
  onQueueActivity,
}: {
  repository: RepositoryData;
  pageWidth: number;
  pageHeight: number;
  isViewable?: boolean;
  boundary?: React.ReactNode;
  onOwnerPress?: () => void;
  onQueueActivity?: (
    event: {
      repo_id: string;
      action: FeedbackAction;
      dwell_seconds?: number;
      serve_id?: string | null;
      position?: number | null;
    },
    flushNow?: boolean
  ) => void;
}) {
  const [isSaveVisible, setIsSaveVisible] = useState(false);
  const [saveMutations, setSaveMutations] = useState<SavePopupMutationState>({ save: false, create: false, error: null });
  const [isShareVisible, setIsShareVisible] = useState(false);
  const [isReadmeVisible, setIsReadmeVisible] = useState(false);
  const [isCommentsVisible, setIsCommentsVisible] = useState(false);
  // Keep only lightweight composer state while the expensive sheet is unmounted.
  const [commentComposer, setCommentComposer] = useState<CommentComposerState>({ draft: '', error: null, pending: false });
  const [isAppActive, setIsAppActive] = useState(
    AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
  );
  const [isSaved, setIsSaved] = useState(repository.viewerSaved === true);
  const [commentCount, setCommentCount] = useState(
    Number(repository.stats.comments || 0) || 0
  );

  const visibleStartTime = useRef<number | null>(null);
  const impressionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const impressionSentRef = useRef(false);
  const touchStartRef = useRef({ x: 0, y: 0 });
  const saveSwipeRef = useRef(false);
  const overlaysOpen = isSaveVisible || isShareVisible || isReadmeVisible || isCommentsVisible;
  const measurementActive = isViewable && isAppActive && !overlaysOpen;
  const queueRepositoryActivity = React.useCallback((
    event: { repo_id: string; action: FeedbackAction; dwell_seconds?: number },
    flushNow?: boolean,
  ) => {
    onQueueActivity?.({
      ...event,
      serve_id: repository.serveId ?? null,
      position: repository.feedPosition ?? null,
    }, flushNow);
  }, [onQueueActivity, repository.feedPosition, repository.serveId]);

  React.useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setIsAppActive(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  React.useEffect(() => {
    if (isViewable) return;
    impressionSentRef.current = false;
  }, [isViewable]);

  React.useEffect(() => {
    const finishVisibility = () => {
      if (visibleStartTime.current === null) return;
      const dwellSeconds = (Date.now() - visibleStartTime.current) / 1000;
      if (impressionTimeoutRef.current) {
        clearTimeout(impressionTimeoutRef.current);
        impressionTimeoutRef.current = null;
      }
      if (dwellSeconds * 1000 >= DWELL_VISIBILITY_THRESHOLD_MS) {
        queueRepositoryActivity({
          repo_id: repository.id,
          action: FEEDBACK_ACTIONS.dwell,
          dwell_seconds: dwellSeconds,
        });
      }
      visibleStartTime.current = null;
    };

    if (measurementActive) {
      visibleStartTime.current = Date.now();
      if (impressionTimeoutRef.current) clearTimeout(impressionTimeoutRef.current);
      impressionTimeoutRef.current = setTimeout(() => {
        if (visibleStartTime.current !== null && !impressionSentRef.current) {
          impressionSentRef.current = true;
          queueRepositoryActivity({ repo_id: repository.id, action: FEEDBACK_ACTIONS.impression });
        }
      }, IMPRESSION_VISIBILITY_THRESHOLD_MS);
    } else finishVisibility();

    return finishVisibility;
  }, [measurementActive, queueRepositoryActivity, repository.id]);

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
        onOwnerPress={onOwnerPress}
        onQueueActivity={onQueueActivity}
        onReadFullPress={() => {
          queueRepositoryActivity(
            { repo_id: repository.id, action: FEEDBACK_ACTIONS.readmeOpen },
            true
          );
          setIsReadmeVisible(true);
        }}
        onSavePress={() => setIsSaveVisible(true)}
        onSharePress={() => setIsShareVisible(true)}
        pageHeight={Math.max(1, pageHeight - (boundary ? 56 : 0))}
        pageWidth={pageWidth}
        repository={repository}
      />

      {boundary}
      {isSaveVisible ? (
        <SavePopup
          mutations={{ state: saveMutations, onChange: setSaveMutations }}
          isVisible={isSaveVisible}
          onClose={() => setIsSaveVisible(false)}
          onSaved={setIsSaved}
          repoId={repository.id}
          repoName={repository.title}
          serveId={repository.serveId}
          position={repository.feedPosition}
        />
      ) : null}
      {isShareVisible ? (
        <ShareRepositorySheet
          isVisible={isShareVisible}
          onClose={() => setIsShareVisible(false)}
          onShared={() => onQueueActivity?.(
            { repo_id: repository.id, action: FEEDBACK_ACTIONS.share },
            true,
          )}
          repositoryId={repository.id}
          repositoryDetails={{
            id: repository.id,
            name: repository.title,
            fullName: `${repository.owner}/${repository.title}`,
            githubUrl: repository.githubUrl ?? `https://github.com/${repository.owner}/${repository.title}`,
            description: repository.description,
          }}
        />
      ) : null}
      {isCommentsVisible ? (
        <CommentSheet
          composer={{ state: commentComposer, onChange: setCommentComposer }}
          initialCommentCount={commentCount}
          isVisible={isCommentsVisible}
          onClose={() => setIsCommentsVisible(false)}
          onCommentCountChange={setCommentCount}
          repoId={repository.id}
        />
      ) : null}
      {isReadmeVisible ? (
        <ReadmePopup
          isVisible={isReadmeVisible}
          onClose={() => setIsReadmeVisible(false)}
          readmeText={repository.readmeFull}
          title={repository.title}
        />
      ) : null}
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
