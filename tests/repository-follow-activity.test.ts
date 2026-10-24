import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ts from 'typescript';
import { deserializeActivitySnapshot } from '../src/services/activityOutboxFileStorage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('card owner-follow success callbacks record distinct durable product observations', async t => {
  const viewer = '00000000-0000-4000-8000-000000000001';
  const owner = '00000000-0000-4000-8000-000000000002';
  const repo = '00000000-0000-4000-8000-000000000003';
  const file = resolve('src/components/home/RepositoryScreen.tsx');
  const nativeRequire = createRequire(file);
  const activityFile = resolve('src/api/activity.ts');
  const activityCode = ts.transpileModule(readFileSync(activityFile, 'utf8'), { fileName: activityFile,
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const activityModule = { exports: {} as any };
  new Function('require', 'module', 'exports', activityCode)((specifier: string) => {
    if (specifier === './client') return { apiV2: async () => ({}), apiV2Raw: async () => ({}) };
    if (specifier === '../utils/uuid') return {
      createUuid: () => '00000000-0000-4000-8000-000000000099',
      getAppSessionId: () => '00000000-0000-4000-8000-000000000098',
    };
    return nativeRequire(specifier);
  }, activityModule, activityModule.exports);
  const { prepareQueuedActivity, toInteractionEventV2 } = activityModule.exports;
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const mocks: Record<string, unknown> = {
    'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView',
      StyleSheet: { create: (value: unknown) => value }, Linking: { openURL: async () => undefined } },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    'lucide-react-native': new Proxy({}, { get: (_target, key) => String(key) }),
    '@/constants/theme': { REFERENCE_THEME: {} },
    '@/store/AuthContext': { useAuth: () => ({ user: { user_id: viewer } }) },
    '@/utils/avatar-color': { getAvatarColor: () => '#000' },
    '@/utils/follow-state': nativeRequire('../../utils/follow-state.ts'),
    './DescriptionCard': { __esModule: true, default: 'DescriptionCard' },
    './ReadmeCard': { __esModule: true, default: 'ReadmeCard' },
    './RecommendationReason': { RecommendationReason: 'RecommendationReason' },
    '../follow-button': { FollowButton: 'FollowButton' },
  };
  const loaded = { exports: {} as any };
  new Function('require', 'module', 'exports', code)((specifier: string) =>
    specifier in mocks ? mocks[specifier] : nativeRequire(specifier), loaded, loaded.exports);
  const client = new QueryClient();
  const events: any[] = [];
  let root!: ReturnType<typeof create>;
  await act(async () => { root = create(React.createElement(QueryClientProvider, { client },
    React.createElement(loaded.exports.RepositoryScreen, { pageWidth: 390, pageHeight: 800,
      repository: { id: repo, owner: 'owner', ownerUserId: owner, name: 'Repo', viewerFollowsOwner: false,
        stats: { likes: 0, comments: 0 } }, onReadFullPress() {}, onSavePress() {}, onSharePress() {}, onCommentPress() {},
      onQueueActivity: (event: unknown, flush: boolean) => events.push({ event, flush }),
    }))); });
  t.after(async () => { await act(async () => root.unmount()); client.clear(); });
  assert.deepEqual(events, [], 'rendering or initial follow status is not a follow action');
  const button = root.root.findByType('FollowButton');
  await act(async () => button.props.onFollowingChange(true));
  await act(async () => button.props.onFollowingChange(false));
  assert.deepEqual(events, [
    { event: { repo_id: repo, action: 'follow' }, flush: true },
    { event: { repo_id: repo, action: 'unfollow' }, flush: true },
  ]);
  const persisted = deserializeActivitySnapshot(JSON.stringify(events.map(({ event }) => prepareQueuedActivity(event))));
  assert.deepEqual(persisted.map(event => toInteractionEventV2(event).event_type), ['follow', 'unfollow']);
  const dismiss = root.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === 'Not interested in this repository');
  assert.ok(dismiss);
  await act(async () => dismiss.props.onPress());
  assert.equal(events.at(-1).event.action, 'dislike', 'explicit dismissal preserves the existing ML preference contract');
});
