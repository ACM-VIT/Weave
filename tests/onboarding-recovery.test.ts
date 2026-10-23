import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import ts from 'typescript';

function loadSource(path: string, mocks: Record<string, unknown>): Record<string, any> {
  const filename = resolve(path), nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', javascript)(
    (specifier: string) => specifier in mocks ? mocks[specifier] : nativeRequire(specifier), module, module.exports,
  );
  return module.exports;
}

for (const manualMode of [false, true]) {
test(`mounted onboarding recovery preserves drafts and refreshes controls (manualMode=${manualMode})`, async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let linked = true, reads = 0, refreshes = 0;
  const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'Pressable', 'ActivityIndicator'].map(name => [name, name]));
  const safeArea = { SafeAreaView: 'SafeAreaView' };
  const theme = { APP_THEME: {}, REFERENCE_THEME: {}, Fonts: {}, Spacing: { two: 8, three: 12, four: 16 } };
  const auth = { useAuth: () => ({ user: { user_id: 'viewer' }, checkOnboardingStatus: async () => { refreshes++; } }) };
  const onboarding = loadSource('src/store/OnboardingContext.tsx', {});
  const importPanel = loadSource('src/components/onboarding/GitHubImportPanel.tsx', {
    'react-native': native, '../../constants/theme': theme,
    '../../api/githubImport': { githubImportApi: { status: async () => { reads++; return { linked, active: false, provenance: {} }; } } },
  });
  const unlinkPanel = loadSource('src/components/onboarding/GitHubUnlinkPanel.tsx', {
    'react-native': native, 'react-native-safe-area-context': safeArea, '../../constants/theme': theme,
    '../../api/githubUnlink': { githubUnlinkApi: { status: async () => ({ status: linked ? 'pending' : 'done' }) } },
    '../../services/githubUnlink': { startGithubUnlink: async () => null },
  });
  const blank = () => null;
  const step = loadSource('src/app/onboarding/step1.tsx', {
    'react-native': native, 'react-native-safe-area-context': safeArea,
    'expo-router': { router: { push() {} } },
    '@/components/onboarding/PrimaryButton': (props: any) => React.createElement('PrimaryButton', props), '@/components/onboarding/ProgressBar': blank,
    '@/components/onboarding/SkillCard': (props: any) => React.createElement('SkillCard', props), '@/components/onboarding/LogoPlaceholder': blank,
    '@/constants/onboarding': { SKILL_CATEGORIES: [{ id: 'data', title: 'Data' }, { id: 'systems', title: 'Systems' }] },
    '../../store/OnboardingContext': onboarding, '../../store/AuthContext': auth,
    '../../components/onboarding/GitHubImportPanel': importPanel,
  });
  let current: any;
  function Probe() { current = onboarding.useOnboarding(); return null; }
  const layout = loadSource('src/app/onboarding/_layout.tsx', {
    'react-native': native, '../../components/onboarding/GitHubUnlinkPanel': unlinkPanel,
    'expo-router': { Stack: () => React.createElement(React.Fragment, null, React.createElement(Probe), React.createElement(step.default)) },
    '../../store/OnboardingContext': onboarding, '../../store/AuthContext': auth,
  });
  let renderer!: ReturnType<typeof create>;
  try {
    await act(async () => { renderer = create(React.createElement(layout.default)); });
    assert.ok(JSON.stringify(renderer.toJSON()).includes('Preview public activity'));
    const recovery = renderer.root.findAllByType('SafeAreaView' as any).find(node => node.props.edges?.includes('top'));
    assert.ok(recovery, 'recovery text needs its own top safe-area edge outside the scroll viewport');
    assert.equal(recovery.props.style.maxHeight, '45%');
    assert.equal(recovery.findAllByType('ScrollView' as any).length, 1);
    await act(async () => { current.updateData({ username: 'draft-name', bio: 'draft-bio' }); });
    if (manualMode) {
      await act(async () => { renderer.root.findByProps({ accessibilityLabel: 'Choose preferences myself' }).props.onPress(); });
      await act(async () => {
        for (const card of renderer.root.findAllByType('SkillCard' as any)) card.props.onPress();
      });
      assert.deepEqual(renderer.root.findAllByType('SkillCard' as any).map(card => card.props.selected), [true, true]);
      assert.equal(current.data.skills, undefined, 'category picks are still an unsaved step-local draft');
    }
    const before = reads;
    linked = false;
    const check = renderer.root.findByProps({ accessibilityLabel: 'Check disconnect status' });
    await act(async () => { check.props.onPress(); });
    if (!manualMode) assert.ok(reads > before, 'the mounted import panel must reload after recovery refresh');
    else {
      assert.deepEqual(renderer.root.findAllByType('SkillCard' as any).map(card => card.props.selected), [true, true],
        'recovery must not remount the whole step and lose unsaved category picks');
      assert.equal(renderer.root.findByType('PrimaryButton' as any).props.disabled, false);
      assert.equal(current.data.skills, undefined);
    }
    assert.ok(refreshes >= 2);
    assert.ok(!JSON.stringify(renderer.toJSON()).includes('Preview public activity'));
    assert.equal(current.data.username, 'draft-name');
    assert.equal(current.data.bio, 'draft-bio');
    assert.equal(renderer.root.findAllByType('SafeAreaView' as any).filter(node => node.props.edges?.includes('top')).length, 0,
      'completed recovery leaves no empty safe-area strip');
  } finally {
    await act(async () => renderer?.unmount());
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  }
});

}
