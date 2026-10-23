import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { APP_THEME, Fonts, REFERENCE_THEME, Spacing } from '../../constants/theme';
import { githubImportApi, type GitHubImportApi, type GitHubImportPreview, type GitHubImportStatus, type ImportIdentityDraft } from '../../api/githubImport';

type State = { owner: string; status: GitHubImportStatus | null; preview: GitHubImportPreview | null;
  busy: string | null; error: string; declined: boolean };
const empty = (owner: string): State => ({ owner, status: null, preview: null, busy: null, error: '', declined: false });

type Props = { userId: string; identityDraft?: ImportIdentityDraft; onSaved: () => Promise<unknown>; onManual?: () => void; api?: GitHubImportApi };
export function GitHubImportPanel(props: Props) {
  return <GitHubImportPanelBody key={props.userId} {...props} />;
}
function GitHubImportPanelBody({ userId, identityDraft, onSaved, onManual, api = githubImportApi }: {
  userId: string; identityDraft?: ImportIdentityDraft; onSaved: () => Promise<unknown>; onManual?: () => void; api?: GitHubImportApi;
}) {
  const [state, setState] = useState<State>(() => ({ ...empty(userId), busy: 'Loading preferences' }));
  const alive = useRef(false);
  const sequence = useRef(0);
  const request = useRef<AbortController | null>(null);
  const current = state;
  const update = (_actor: string, values: Partial<State>) => { if (alive.current) setState(previous => ({ ...previous, ...values })); };

  useEffect(() => {
    const actor = userId;
    const operation = ++sequence.current;
    const controller = new AbortController();
    alive.current = true;
    api.status(controller.signal).then(status => {
      if (!controller.signal.aborted && alive.current && sequence.current === operation) setState({ ...empty(actor), status });
    }).catch(error => {
      if (!controller.signal.aborted && alive.current && sequence.current === operation) setState({ ...empty(actor), error: error instanceof Error ? error.message : 'Unable to load GitHub preferences. Retry below.' });
    });
    return () => { alive.current = false; controller.abort(); request.current?.abort(); };
  }, [api, userId]);

  const run = async (label: string, work: (signal: AbortSignal, isCurrent: () => boolean) => Promise<void>) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const actor = userId, operation = ++sequence.current;
    const isCurrent = () => !controller.signal.aborted && alive.current && sequence.current === operation;
    update(actor, { busy: label, error: '' });
    try { await work(controller.signal, isCurrent); }
    catch (error) { if (isCurrent()) update(actor, { error: error instanceof Error ? error.message : 'Unable to save preferences. Try again.' }); }
    finally { if (isCurrent()) update(actor, { busy: null }); }
  };
  const preview = () => run('Reading public activity', async (signal, isCurrent) => {
    const result = await api.preview(signal);
    if (isCurrent()) update(userId, { preview: result, declined: false });
  });
  const accept = () => run('Saving preferences', async (signal, isCurrent) => {
    if (!current.preview || Date.parse(current.preview.expires_at) <= Date.now()) throw new Error('This preview expired. Read public activity again.');
    if (identityDraft) await api.saveIdentity(identityDraft, signal);
    if (!isCurrent()) return;
    await api.accept(current.preview.snapshot_id, signal);
    if (!isCurrent()) return;
    update(userId, { preview: null, status: { linked: true, active: true, provenance: { collected_at: current.preview.collected_at } } });
    await onSaved();
  });
  const revoke = () => run('Removing imported preferences', async (signal, isCurrent) => {
    await api.revoke(signal);
    if (!isCurrent()) return;
    update(userId, { preview: null, status: { linked: current.status?.linked ?? true, active: false, provenance: {} }, declined: true });
    await onSaved();
  });
  const decline = () => {
    request.current?.abort(); sequence.current++;
    if (current.preview || current.busy === 'Reading public activity') {
      void run('Closing preview', async (signal, isCurrent) => {
        await api.revoke(signal);
        if (isCurrent()) { update(userId, { preview: null, declined: true }); onManual?.(); }
      });
    } else { update(userId, { preview: null, busy: null, declined: true, error: '' }); onManual?.(); }
  };
  const hasSuggestions = current.preview && Object.values(current.preview.suggestions).some(values => values.length > 0);
  return <View style={{ gap: Spacing.two, paddingVertical: Spacing.three, width: '100%' }}>
    <Text accessibilityRole="header" style={{ fontFamily: Fonts.sans, color: REFERENCE_THEME.text, fontSize: 18, fontWeight: '700' }}>GitHub activity</Text>
    <Text style={{ fontFamily: Fonts.sans, color: REFERENCE_THEME.textStrong, fontSize: 14, lineHeight: 21 }}>
      Optionally use public owned, starred and contributed repositories to suggest preferences. Private content stays excluded. Your manual choices are kept.
    </Text>
    {current.busy ? <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', gap: Spacing.two, alignItems: 'center' }}>
      <ActivityIndicator color={APP_THEME.primary} /><Text style={{ fontFamily: Fonts.sans, color: REFERENCE_THEME.textStrong }}>{current.busy}…</Text>
    </View> : null}
    {current.error ? <Text accessibilityRole="alert" style={{ fontFamily: Fonts.sans, color: REFERENCE_THEME.text, fontSize: 14, lineHeight: 21 }}>{current.error}</Text> : null}
    {current.status?.active ? <>
      <Text style={{ fontFamily: Fonts.sans, color: REFERENCE_THEME.textStrong, lineHeight: 21 }}>Imported {current.status.provenance.collected_at ? new Date(current.status.provenance.collected_at).toLocaleDateString() : 'from public GitHub activity'}. Recommendation updates are prepared asynchronously.</Text>
      <Text style={{ fontFamily: Fonts.sans, color: REFERENCE_THEME.textStrong, lineHeight: 21 }}>Revoke removes unchanged imported fields and keeps later manual edits. It does not disconnect your GitHub login.</Text>
      <ImportButton label="Revoke activity import" onPress={() => void revoke()} disabled={Boolean(current.busy)} />
    </> : current.preview ? <>
      <Text style={{ fontFamily: Fonts.sans, color: REFERENCE_THEME.text, lineHeight: 21 }}>Read {current.preview.repository_count} public repositories on {new Date(current.preview.collected_at).toLocaleDateString()}.</Text>
      {current.preview.status === 'partial' ? <Text style={{ fontFamily: Fonts.sans, color: REFERENCE_THEME.textStrong, lineHeight: 21 }}>Some sources were unavailable or reached their limit. These suggestions use only the public activity shown below.</Text> : null}
      {(['skills', 'interests', 'tech_stack'] as const).map(field => <Text key={field} style={{ fontFamily: Fonts.sans, color: REFERENCE_THEME.textStrong, lineHeight: 21 }}>
        {field === 'tech_stack' ? 'Technologies' : field === 'skills' ? 'Skills' : 'Interests'}: {current.preview!.suggestions[field].join(', ') || 'None found'}
      </Text>)}
      {!hasSuggestions ? <Text style={{ fontFamily: Fonts.sans, color: REFERENCE_THEME.textStrong, lineHeight: 21 }}>No usable public preferences were found. Choose your preferences below.</Text> : null}
      <ImportButton label={identityDraft ? 'Use preferences and finish setup' : 'Add these preferences'} onPress={() => void accept()} primary disabled={Boolean(current.busy) || !hasSuggestions} />
      <ImportButton label="Read public activity again" onPress={() => void preview()} disabled={Boolean(current.busy)} />
    </> : current.status?.linked && !current.declined ? <ImportButton label="Preview public activity" onPress={() => void preview()} primary disabled={Boolean(current.busy)} />
      : current.status && !current.status.linked ? <Text style={{ fontFamily: Fonts.sans, color: REFERENCE_THEME.textStrong, lineHeight: 21 }}>A verified GitHub login is needed to import activity. You can choose preferences manually.</Text> : null}
    {!current.status && !current.busy ? <ImportButton label="Retry preferences status" onPress={() => void run('Loading preferences', async (signal, isCurrent) => {
      const status = await api.status(signal); if (isCurrent()) update(userId, { status });
    })} /> : null}
    {!current.status?.active ? <ImportButton label={current.declined ? 'Show import option' : 'Choose preferences myself'} onPress={() => {
      if (current.declined) update(userId, { declined: false }); else decline();
    }} /> : null}
  </View>;
}

function ImportButton({ label, onPress, primary = false, disabled = false }: { label: string; onPress: () => unknown; primary?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
      disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 48, justifyContent: 'center', alignItems: 'center',
        padding: Spacing.three, borderRadius: 18, opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
        backgroundColor: primary ? APP_THEME.primary : 'transparent' })}>
      <Text style={{ fontFamily: Fonts.sans, fontSize: 15, fontWeight: '600', color: primary ? APP_THEME.primaryForeground : REFERENCE_THEME.textStrong }}>{label}</Text>
    </Pressable>;
}
