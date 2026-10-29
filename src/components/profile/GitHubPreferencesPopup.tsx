import GitHubIcon from '@/assets/icons/github.svg';
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReducedMotion } from 'react-native-reanimated';
import { X } from 'lucide-react-native';
import { APP_THEME, REFERENCE_THEME } from '../../constants/theme';
import { useModalScrollLock } from '../../hooks/use-modal-scroll-lock';
import { GitHubImportPanel } from '../onboarding/GitHubImportPanel';
import { GitHubUnlinkPanel } from '../onboarding/GitHubUnlinkPanel';

type Props = { visible: boolean; userId: string; onClose: () => void; onSaved: () => Promise<unknown> };
export function GitHubPreferencesPopup(props: Props) {
  if (!props.visible) return null;
  return <PopupBody key={props.userId} {...props} />;
}

function PopupBody({ userId, onClose, onSaved }: Props) {
  const [importRevision, setImportRevision] = useState(0);
  const [githubLinked, setGithubLinked] = useState<boolean | undefined>(undefined);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const top = Math.max(insets.top, 16), bottom = Math.max(insets.bottom, 16);
  useModalScrollLock(true);
  return (
    <Modal visible transparent statusBarTranslucent animationType={reducedMotion ? 'none' : 'fade'} onRequestClose={onClose}>
      <View style={[styles.overlay, { paddingTop: top, paddingBottom: bottom }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss GitHub preferences" onPress={onClose} style={StyleSheet.absoluteFill} />
        <View accessibilityViewIsModal style={[styles.popup, { maxHeight: Math.min(760, Math.max(1, height - top - bottom)) }]}>
          <View style={styles.header}>
            <View style={styles.icon}><GitHubIcon width={22} height={22} fill={APP_THEME.primary} /></View>
            <View style={styles.heading}>
              <Text accessibilityRole="header" className="font-nataBold" style={styles.title}>GitHub preferences</Text>
              <Text className="font-nata" style={styles.subtitle}>Activity and account connection</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close GitHub preferences" onPress={onClose} style={styles.close}>
              <X size={20} color={REFERENCE_THEME.textSecondary} />
            </Pressable>
          </View>
          <ScrollView accessibilityLabel="GitHub preference settings" keyboardShouldPersistTaps="handled" style={styles.scroll} contentContainerStyle={styles.content}>
            <View style={styles.section}>
              <GitHubImportPanel key={importRevision} userId={userId} onSaved={onSaved} onLinkedChange={setGithubLinked} />
            </View>
            <View style={styles.section}>
              <GitHubUnlinkPanel userId={userId} linked={githubLinked} onSaved={async () => {
                await onSaved();
                setImportRevision(revision => revision + 1);
              }} />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 16, backgroundColor: 'rgba(0,0,0,0.75)' },
  popup: { width: '100%', maxWidth: 480, flexShrink: 1, backgroundColor: REFERENCE_THEME.surface, borderColor: REFERENCE_THEME.border, borderWidth: 1, borderRadius: 24, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderBottomWidth: 1, borderBottomColor: REFERENCE_THEME.border, flexShrink: 0 },
  icon: { width: 42, height: 42, borderRadius: 13, backgroundColor: '#63E08A18', alignItems: 'center', justifyContent: 'center' },
  heading: { flex: 1, minWidth: 0, gap: 4 },
  title: { fontSize: 19, lineHeight: 25, color: REFERENCE_THEME.text },
  subtitle: { fontSize: 12, lineHeight: 18, color: REFERENCE_THEME.textSecondary },
  close: { width: 44, height: 44, borderRadius: 22, backgroundColor: REFERENCE_THEME.surfaceElevated, alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 0, flexShrink: 1 },
  content: { padding: 16, gap: 14 },
  section: { paddingHorizontal: 16, borderRadius: 17, borderWidth: 1, borderColor: REFERENCE_THEME.border, backgroundColor: REFERENCE_THEME.canvas },
});
