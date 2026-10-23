import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import ts from 'typescript';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const internalSurfaceFiles = [
  'src/models/search.ts',
  'src/app/(tabs)/home.tsx',
  'src/app/board.tsx',
  'src/app/user/[username].tsx',
  'src/components/liked-repositories-screen.tsx',
  'src/components/profile-repository-list.tsx',
] as const;

test('internal repository surfaces route to Weave rather than opening GitHub', async () => {
  for (const path of internalSurfaceFiles) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(source, /repositoryHref\(/, `${path} must use the canonical repository route`);
    assert.doesNotMatch(source, /Linking\.openURL/, `${path} must not open GitHub directly`);
  }
});

test('Explore uses the shared internal search result router', async () => {
  const source = await readFile(new URL('../src/app/(tabs)/explore.tsx', import.meta.url), 'utf8');
  assert.match(source, /router\.push\(searchResultHref\(item\)\)/);
  assert.doesNotMatch(source, /Linking\.openURL/);
});

test('the dynamic repository route renders the canonical detail screen', async () => {
  const source = await readFile(
    new URL('../src/app/repository/[repoId].tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /RepositoryDetailScreen/);
  assert.match(source, /repoId/);
});

test('feed and Trending cards delegate repository presses to internal navigation', async () => {
  const feedItem = await readFile(
    new URL('../src/components/home/RepositoryFeedItem.tsx', import.meta.url),
    'utf8',
  );
  const trendingCard = await readFile(
    new URL('../src/components/explore/TrendingRepoCard.tsx', import.meta.url),
    'utf8',
  );

  assert.match(feedItem, /onRepositoryPress=\{onRepositoryPress\}/);
  assert.doesNotMatch(feedItem, /Linking\.openURL/);
  assert.match(trendingCard, /onPress=\{onPress\}/);
  assert.doesNotMatch(trendingCard, /Linking\.openURL/);
});

test('profile repository sheets finish dismissing before navigating', async () => {
  const filename = resolve('src/components/connection-sheet.tsx');
  const nativeRequire = createRequire(filename);
  const closeAnimations: ((result: { finished: boolean }) => void)[] = [];
  const animation = () => ({
    start: (callback?: (result: { finished: boolean }) => void) => {
      if (callback) closeAnimations.push(callback);
    },
  });
  class Value {
    setValue() {}
  }
  const mocks: Record<string, any> = {
    'react-native': {
      Animated: { Value, View: 'AnimatedView', timing: animation, parallel: animation },
      Easing: { bezier: () => 0, in: () => 0, out: () => 0, quad: 0 },
      Keyboard: { dismiss() {} },
      Modal: 'Modal',
      Pressable: 'Pressable',
      StyleSheet: { absoluteFill: {}, create: (value: unknown) => value, hairlineWidth: 1 },
      Text: 'Text',
      View: 'View',
      useWindowDimensions: () => ({ height: 800, width: 400 }),
    },
    'react-native-reanimated': { useReducedMotion: () => false },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0, top: 0 }) },
    'expo-blur': { BlurView: 'BlurView' },
    'lucide-react-native': { X: 'X' },
    '@/components/keyboard/keyboard-layout': { KeyboardSurface: 'KeyboardSurface' },
    '@/constants/theme': { REFERENCE_THEME: {} },
    './connection-list': { ConnectionList: 'ConnectionList' },
    './profile-repository-list': {
      ProfileRepositoryList: ({ onRepositoryPress }: any) => React.createElement('Pressable', {
        accessibilityLabel: 'Open owner/repository',
        onPress: () => onRepositoryPress('/repository/repository'),
      }),
    },
  };
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} as any };
  new Function('require', 'module', 'exports', source)(
    (specifier: string) => mocks[specifier] ?? nativeRequire(specifier),
    loaded,
    loaded.exports,
  );
  const ConnectionSheet = loaded.exports.ConnectionSheet;
  const calls: string[] = [];
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(React.createElement(ConnectionSheet, {
      visible: true,
      type: 'likes',
      userId: 'viewer',
      onClose: () => calls.push('close'),
      onRepositoryPress: () => calls.push('navigate'),
    }));
  });

  const repositoryRow = root.root.findAllByType('Pressable')
    .find((node) => node.props.accessibilityLabel === 'Open owner/repository')!;
  await act(async () => repositoryRow.props.onPress());
  assert.deepEqual(calls, [], 'navigation must wait for the close animation');
  await act(async () => closeAnimations.shift()!({ finished: true }));
  assert.deepEqual(calls, ['close', 'navigate']);

  calls.length = 0;
  await act(async () => repositoryRow.props.onPress());
  await act(async () => closeAnimations.shift()!({ finished: false }));
  assert.deepEqual(calls, [], 'an interrupted close must not navigate');
  await act(async () => root.root.findByType('Modal').props.onRequestClose());
  await act(async () => closeAnimations.shift()!({ finished: true }));
  assert.deepEqual(calls, ['close'], 'a later ordinary close must not replay stale navigation');
  await act(async () => root.unmount());
});

test('every intentional GitHub escape has an explicit visible Open on GitHub action', async () => {
  for (const path of [
    'src/components/home/RepositoryScreen.tsx',
    'src/components/repository-detail-screen.tsx',
    'src/components/home/share-repository-sheet.tsx',
  ]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(source, /Linking\.openURL/, `${path} must contain the intentional external open`);
    assert.match(source, />Open on GitHub<|label="Open on GitHub"/, `${path} must visibly label the external action`);
  }
});

test('README GitHub links use the shared explicit confirmation policy', async () => {
  const popup = await readFile(
    new URL('../src/components/home/ReadmePopup.tsx', import.meta.url),
    'utf8',
  );
  assert.match(popup, /openReadmeExternalLink\(href\)/);
  assert.doesNotMatch(popup, /Linking\.openURL/);

  const policy = await readFile(
    new URL('../src/utils/readme-external-link.ts', import.meta.url),
    'utf8',
  );
  assert.match(policy, /Platform\.OS === 'web'[\s\S]*window\.confirm/);
  assert.match(policy, /Alert\.alert/);

  const card = await readFile(
    new URL('../src/components/home/ReadmeCard.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(card, /RenderHtml|Linking\.openURL/);

  assert.match(policy, /isGithubReadmeLink\(href\)/);
  assert.match(policy, /Alert\.alert\(/);
  assert.match(policy, /text: 'Open on GitHub'/);
  assert.match(policy, /hostname === 'github\.com'/);
});
