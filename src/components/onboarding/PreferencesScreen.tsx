import { useRef, useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { KeyboardForm } from '@/components/keyboard/keyboard-layout';
import PrimaryButton from '@/components/onboarding/PrimaryButton';
import { useAuth } from '../../store/AuthContext';
import { useOnboarding } from '../../store/OnboardingContext';
import { GitHubImportPanel } from './GitHubImportPanel';

// Broad choices use the existing taxonomy; detailed skills are no longer a questionnaire.
const TOPICS = [
  { id: 'web', label: 'Frontend', interest: 'frontend' },
  { id: 'backend', label: 'Backend & APIs', interest: 'backend' },
  { id: 'data', label: 'AI & ML', interest: 'machine learning' },
  { id: 'devops', label: 'Cloud & DevOps', interest: 'cloud' },
  { id: 'databases', label: 'Databases', interest: 'database' },
  { id: 'mobile', label: 'Mobile apps', interest: 'mobile' },
  { id: 'systems', label: 'Systems', interest: 'system' },
];

export default function PreferencesScreen() {
  const { data, updateData, githubImportRevision } = useOnboarding();
  const { user, checkOnboardingStatus, completeOnboarding: saveOnboarding,
    reconcileOnboarding, retryOnboarding, onboardingSave } = useAuth();
  const [importMode, setImportMode] = useState(false);
  const [technologyDraft, setTechnologyDraft] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const submitting = useRef(false);
  const technologies = technologyDraft ?? (data.tech_stack ?? []).join(', ');
  const parsedTechnologies = () => technologies.split(',').map(value => value.trim()).filter(Boolean);
  const selected = data.skills ?? [];
  const needsConfirmation = ['unknown', 'checking', 'retryable'].includes(onboardingSave.status);
  const blocked = isSubmitting || onboardingSave.status !== 'idle';

  const toggleTopic = (id: string, interest: string) => {
    updateData(previous => {
      const skills = previous.skills ?? [];
      const removing = skills.includes(id);
      return {
        skills: removing ? skills.filter(value => value !== id) : [...skills, id],
        // The context prunes interests belonging to removed categories and keeps retained drafts.
        interests: removing ? previous.interests ?? [] : [...new Set([...(previous.interests ?? []), interest])],
      };
    });
  };
  const finish = async () => {
    if (!selected.length || blocked || submitting.current) return;
    submitting.current = true;
    setIsSubmitting(true);
    setErrorMsg('');
    try {
      const tech_stack = parsedTechnologies();
      updateData({ tech_stack });
      await saveOnboarding({ ...data, username: data.username ?? '', full_name: data.full_name ?? '',
        date_of_birth: data.date_of_birth ?? '', skills: selected, interests: data.interests ?? [], tech_stack });
      // Auth's confirmed completion controls navigation, including uncertain-write recovery.
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Failed to save preferences.');
    } finally {
      submitting.current = false;
      setIsSubmitting(false);
    }
  };
  const checkSaveStatus = async () => {
    setErrorMsg('');
    try { await reconcileOnboarding(); }
    catch (error) { setErrorMsg(error instanceof Error ? error.message : 'Could not check save status. Try again.'); }
  };
  const retrySavedPreferences = async () => {
    setErrorMsg('');
    try { await retryOnboarding(); }
    catch (error) { setErrorMsg(error instanceof Error ? error.message : 'Could not retry your saved preferences. Check save status.'); }
  };

  return <KeyboardForm style={{ flex: 1, backgroundColor: '#000000' }}
    contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 24, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
    <View style={{ maxWidth: 450, width: '100%', alignSelf: 'center' }}>
      {importMode && user ? <GitHubImportPanel key={`${user.user_id}:${githubImportRevision}`}
        userId={user.user_id} onSaved={checkOnboardingStatus} onManual={() => setImportMode(false)}
        identityDraft={{ username: data.username ?? '', full_name: data.full_name ?? '', date_of_birth: data.date_of_birth ?? '', bio: data.bio }} />
        : <>
          <Text style={{ color: '#FFFFFF', fontSize: 30, fontWeight: '700', marginBottom: 8 }}>Make it your feed</Text>
          <Text style={{ color: 'rgba(235,235,245,0.6)', fontSize: 15, lineHeight: 22, marginBottom: 24 }}>
            Pick what you want to discover. One is enough.
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {TOPICS.map(topic => {
              const checked = selected.includes(topic.id);
              return <Pressable key={topic.id} accessibilityRole="checkbox" accessibilityLabel={topic.label}
                accessibilityState={{ checked, disabled: blocked }} aria-checked={checked} disabled={blocked}
                {...(Platform.OS === 'web' ? { onKeyDown: (event: React.KeyboardEvent) => {
                  if (event.key === ' ') {
                    event.preventDefault();
                    if (!event.repeat && !blocked) toggleTopic(topic.id, topic.interest);
                  }
                } } : {})}
                onPress={() => toggleTopic(topic.id, topic.interest)}
                style={{ width: '48%', flexGrow: 1, minHeight: 50, padding: 12, borderRadius: 14,
                  justifyContent: 'center', borderWidth: 1, borderColor: checked ? '#63E08A' : '#303032',
                  backgroundColor: checked ? '#17291D' : '#1C1C1E' }}>
                <Text style={{ color: checked ? '#63E08A' : '#FFFFFF', fontSize: 15, fontWeight: '600' }}>{topic.label}</Text>
              </Pressable>;
            })}
          </View>
          <Text style={{ color: 'rgba(235,235,245,0.6)', fontSize: 14, marginTop: 24, marginBottom: 8 }}>Technologies (optional)</Text>
          <TextInput accessibilityLabel="Technologies (optional)" placeholder="Python, React, Docker" placeholderTextColor="#77767C"
            value={technologies} onChangeText={setTechnologyDraft} onBlur={() => updateData({ tech_stack: parsedTechnologies() })}
            editable={!blocked} autoCapitalize="none" autoCorrect={false}
            style={{ color: '#FFFFFF', backgroundColor: '#1C1C1E', borderColor: '#303032', borderWidth: 1,
              borderRadius: 14, paddingHorizontal: 14, paddingVertical: 14, fontSize: 15 }} />
          {onboardingSave.message || errorMsg ? <Text accessibilityLiveRegion="polite"
            style={{ color: '#FF453A', fontSize: 14, marginTop: 16 }}>{onboardingSave.message || errorMsg}</Text> : null}
          {needsConfirmation ? <View style={{ marginTop: 16 }}>
            <PrimaryButton title={onboardingSave.status === 'checking' ? 'Checking save...' : 'Check save status'}
              onPress={checkSaveStatus} disabled={onboardingSave.status === 'checking' || isSubmitting} />
          </View> : null}
          {onboardingSave.status === 'retryable' ? <View style={{ marginTop: 12 }}>
            <Text style={{ color: 'rgba(235,235,245,0.6)', fontSize: 14, marginBottom: 8 }}>Retries your originally submitted preferences.</Text>
            <PrimaryButton title="Retry saved preferences" onPress={retrySavedPreferences} disabled={isSubmitting} />
          </View> : null}
          <View style={{ marginTop: 24 }}>
            <PrimaryButton title={isSubmitting ? 'Saving...' : 'Finish'} onPress={finish} disabled={!selected.length || blocked} />
          </View>
          {user ? <Pressable accessibilityRole="button" accessibilityLabel="Use GitHub public activity instead" disabled={blocked}
            accessibilityState={{ disabled: blocked }} onPress={() => setImportMode(true)} style={{ padding: 16, alignItems: 'center' }}>
            <Text style={{ color: '#63E08A', fontSize: 14 }}>Use GitHub public activity instead</Text>
          </Pressable> : null}
        </>}
    </View>
  </KeyboardForm>;
}
