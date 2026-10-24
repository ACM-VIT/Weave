import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { openReadmeExternalLink } from '@/utils/readme-external-link';

/** Mounted only inside an open popup; useVideoPlayer releases playback on unmount. */
export function ReadmeVideo({ url }: { url: string }) {
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);
  const player = useVideoPlayer(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const status = useEvent(player, 'statusChange', { status: player.status });
  const hasError = failed || status.status === 'error';
  return <View style={{ marginVertical: 12, gap: 8 }}>
    {started && !hasError ? <VideoView player={player} nativeControls contentFit="contain"
      style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: '#111' }} /> : null}
    {!started ? <Pressable accessibilityRole="button" accessibilityLabel="Play README video"
      style={{ minHeight: 64, justifyContent: 'center', padding: 16, backgroundColor: '#222', borderRadius: 8 }}
      onPress={() => {
        setStarted(true);
        void player.replaceAsync(url).then(() => { if (mounted.current) player.play(); })
          .catch(() => { if (mounted.current) setFailed(true); });
      }}><Text style={{ color: '#87e49e' }}>▶ Play demo video</Text></Pressable> : null}
    {hasError ? <Text style={{ color: '#ddd' }}>This video could not be played here.</Text> : null}
    <Pressable accessibilityRole="link" onPress={() => openReadmeExternalLink(url)}
      style={{ minHeight: 44, justifyContent: 'center' }}>
      <Text style={{ color: '#87e49e' }}>Open original video ↗</Text>
    </Pressable>
  </View>;
}
