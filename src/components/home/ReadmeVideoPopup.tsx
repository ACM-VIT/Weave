import React, { useEffect, useRef } from 'react';
import { Modal, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { REFERENCE_THEME } from '@/constants/theme';
import { openReadmeExternalLink } from '@/utils/readme-external-link';

/** Unmounted on close, releasing the sole active player while preserving the summary. */
export function ReadmeVideoPopup({ url, onClose }: { url: string; onClose: () => void }) {
  const closeButton = useRef<View>(null);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const player = useVideoPlayer(url);
  // Start after VideoView attaches. Calling play during player construction
  // precedes its HTML video element on web and silently leaves it paused.
  useEffect(() => {
    player.play();
    // Native useVideoPlayer releases its object before later effect cleanups.
    // Only web needs an explicit pause of a possibly detached HTML element.
    return () => { if (Platform.OS === 'web') player.pause(); };
  }, [player]);
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  return <Modal transparent visible animationType="fade" presentationStyle="overFullScreen"
    statusBarTranslucent onShow={() => closeButton.current?.focus()} onRequestClose={onClose}>
    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.94)', justifyContent: 'center', padding: 12,
      paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }}>
      <View accessibilityViewIsModal style={{ width: '100%', maxWidth: 1100, alignSelf: 'center', gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: REFERENCE_THEME.textPrimary }}>Repository video</Text>
          <Pressable ref={closeButton} accessibilityRole="button" accessibilityLabel="Close video and return to summary"
            onPress={onClose} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <X color={REFERENCE_THEME.textPrimary} size={24} />
          </Pressable>
        </View>
        {status === 'error' ? <Text accessibilityRole="alert" style={{ color: REFERENCE_THEME.textPrimary }}>
          This video could not be played here. You can open the original below.
        </Text> : <VideoView player={player} nativeControls contentFit="contain"
          style={{ width: '100%', height: Math.max(80, Math.min((Math.min(width - 24, 1100)) * 9 / 16,
            height - insets.top - insets.bottom - 150)), backgroundColor: '#000' }} />}
        <Pressable accessibilityRole="link" onPress={() => openReadmeExternalLink(url)}
          style={{ minHeight: 44, justifyContent: 'center' }}>
          <Text style={{ color: REFERENCE_THEME.accentLight }}>Open original video ↗</Text>
        </Pressable>
      </View>
    </View>
  </Modal>;
}
