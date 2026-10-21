import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ts from 'typescript';
import type { RepositoryData } from '../src/data/repositories';
import { subscribeToHomeFeedInvalidations } from '../src/utils/home-feed';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).requestAnimationFrame = (callback: (time: number) => void) => { callback(0); return 0; };

function repository(id: string): RepositoryData {
  return {
    id, name: id, fullName: `owner/${id}`, owner: 'owner', description: '', readmeSummary: 'Summary.', readmeFull: '# README',
    serveId: id, feedPosition: 3, githubUrl: `https://github.com/owner/${id}`,
    stats: { stars: 0, views: 0, openIssues: 0, forks: 0, comments: 0, likes: 0, dislikes: 0, saves: 0 },
  } as RepositoryData;
}

// Keep the real row, all four overlays, React state and QueryClient observers.
// Replace only native rendering/animation and external I/O boundaries.
function feed(ids: string[], reducedMotion = false) {
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: Infinity }, mutations: { retry: false },
  } });
  const requests: string[] = [];
  const events: any[] = [];
  const closeAnimations: ((result: { finished: boolean }) => void)[] = [];
  let postComment: () => Promise<any> = async () => { throw new Error('Unexpected post'); };
  let saveRepository: () => Promise<any> = async () => { throw new Error('Unexpected save'); };
  let createCollection: () => Promise<any> = async () => { throw new Error('Unexpected create'); };
  let saveCollections: any[] = [];
  let root: ReturnType<typeof create>;
  const animation = () => ({
    start: (callback?: (result: { finished: boolean }) => void) => { if (callback) closeAnimations.push(callback); },
    stop: () => undefined,
  });
  class Value {
    setValue() {}
    stopAnimation() {}
    interpolate() { return 0; }
  }
  const native = {
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Platform: { OS: 'ios', select: (value: any) => value.ios ?? value.default },
    StyleSheet: { create: (value: unknown) => value, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { Value, View: 'AnimatedView', timing: animation, parallel: animation, sequence: animation, delay: animation },
    Easing: { bezier: () => 0, in: () => 0, out: () => 0, cubic: 0, quad: 0 },
    useWindowDimensions: () => ({ height: 800, width: 400 }),
    Keyboard: { dismiss() {} }, Linking: { openURL: async () => undefined },
    Share: { share: async () => ({ action: 'sharedAction' }) },
    ...Object.fromEntries(['ActivityIndicator', 'FlatList', 'Image', 'KeyboardAvoidingView', 'Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map(name => [name, name])),
  };
  const auth = { useAuth: () => ({ user: { user_id: 'viewer', username: 'viewer' }, checkOnboardingStatus: async () => undefined }) };
  const storage = { getItemAsync: async () => 'token', getStorageItem: async () => 'token' };
  const gesture = new Proxy({}, {get: () => () => gesture});
  const mocks: Record<string, any> = {
    'react-native': native,
    '@/api/client': {apiV2: async () => {throw new Error('Unexpected API call');}, apiV2Raw: async () => {throw new Error('Unexpected API call');}},
    './client': {apiV2: async () => {throw new Error('Unexpected API call');}, apiV2Raw: async () => {throw new Error('Unexpected API call');}},
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    'react-native-reanimated': {
      __esModule: true, default: { View: 'AnimatedView' }, useReducedMotion: () => reducedMotion,
      useSharedValue: (initial: unknown) => React.useRef({value: initial, get() {return this.value;}, set(value: unknown) {this.value = value;}}).current,
      useAnimatedStyle: (style: () => unknown) => style(), withSpring: (value: unknown) => value,
    },
    'react-native-worklets': {scheduleOnRN: (fn: (...args: any[]) => void, ...args: any[]) => fn(...args)},
    'react-native-gesture-handler': {Gesture: {Pan: () => gesture}, GestureDetector: ({children}: any) => children},
    './SafeReadmeImage': {SafeReadmeImageRenderer: 'SafeReadmeImageRenderer'},
    './DescriptionCard': {SaveSwipeGestureContext: React.createContext(null)},
    '@/components/keyboard/keyboard-layout': {KeyboardSurface: 'KeyboardSurface'},
    'expo-blur': { BlurView: 'BlurView' },
    'expo-haptics': { selectionAsync: async () => undefined, notificationAsync: async () => undefined, NotificationFeedbackType: { Success: 'success' } },
    'expo-linking': {createURL: (path: string) => `ghsocial://${path}`},
    'expo-clipboard': { setStringAsync: async () => undefined },
    'lucide-react-native': new Proxy({}, { get: (_target, key) => String(key) }),
    'react-native-qrcode-svg': { __esModule: true, default: 'QRCode' },
    'react-native-svg': { __esModule: true, default: 'Svg', Defs: 'Defs', LinearGradient: 'LinearGradient', Rect: 'Rect', Stop: 'Stop' },
    'react-native-render-html': { __esModule: true, default: 'RenderHtml', defaultSystemFonts: [] },
    '../../store/AuthContext': auth, '@/store/AuthContext': auth,
    '../../utils/storage': storage, '@/utils/storage': storage,
    '@/constants/theme': { REFERENCE_THEME: {} }, '../../constants/theme': { REFERENCE_THEME: {} },
    '@/hooks/use-modal-scroll-lock': { useModalScrollLock: () => undefined },
    '@/api/lists': {
      ...createRequire(resolve('src/api/lists.ts'))('../models/list'),
      getRepositoryLists: async (id: string) => { requests.push(`save:${id}`); return saveCollections; },
      createRepositoryList: () => createCollection(),
      syncRepositoryLists: () => saveRepository(),
    },
    '@/api/repository-actions': {
      getSaveCollections: async (id: string) => { requests.push(`save:${id}`); return saveCollections; },
      getRepositoryShareDetails: async (id: string) => { requests.push(`share:${id}`); return {}; },
      createSaveCollection: () => createCollection(),
      saveRepositoryToCollections: () => saveRepository(),
    },
    '../../api/comments': {
      getCommentsByRepo: async (id: string) => { requests.push(`comments:${id}`); return []; },
      getCommentAuthor: async () => { requests.push('author'); return {}; },
      createComment: () => postComment(),
    },
    './RepositoryScreen': { RepositoryScreen: (props: any) => React.createElement('RepositoryScreen', props) },
  };
  const loaded = new Map<string, any>();
  function loadSource(path: string): any {
    const filename = resolve(path);
    if (loaded.has(filename)) return loaded.get(filename);
    const module = { exports: {} };
    const nativeRequire = createRequire(filename);
    const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const boundary = (specifier: string) => {
      if (specifier in mocks) return mocks[specifier];
      if (specifier.startsWith('@/')) return loadSource(`src/${specifier.slice(2)}.ts`);
      if (/^\.\/(CommentSheet|ReadmePopup|save-popup|share-repository-sheet)$/.test(specifier)) {
        return loadSource(`src/components/home/${specifier.slice(2)}.tsx`);
      }
      return nativeRequire(specifier);
    };
    new Function('require', 'module', 'exports', javascript)(boundary, module, module.exports);
    loaded.set(filename, module.exports);
    return module.exports;
  }
  const Row = loadSource('src/components/home/RepositoryFeedItem.tsx').RepositoryFeedItem;
  const overlayTypes = [
    loadSource('src/components/home/save-popup.tsx').SavePopup,
    loadSource('src/components/home/share-repository-sheet.tsx').ShareRepositorySheet,
    loadSource('src/components/home/CommentSheet.tsx').CommentSheet,
    loadSource('src/components/home/ReadmePopup.tsx').ReadmePopup,
  ];
  return {
    requests, events, client,
    setPost(value: () => Promise<any>) { postComment = value; },
    setSave(value: () => Promise<any>) {
      saveRepository = value;
      saveCollections = [{ id: 'list', source: 'collection', name: 'List', repositoryCount: 0, selected: true }];
    },
    setCreate(value: () => Promise<any>) { createCollection = value; },
    get pendingCloseAnimations() { return closeAnimations.length; },
    button(label: string) { return root.root.findAllByType('Modal').find(node => node.props.visible)!.findAllByType('Pressable').find(node => node.props.accessibilityLabel === label)!; },
    async press(label: string) { await act(async () => { this.button(label).props.onPress(); await new Promise(resolve => setTimeout(resolve, 0)); }); },
    get mountedOverlays() { return overlayTypes.reduce((count, type) => count + root.root.findAllByType(type).length, 0); },
    get observers() { return client.getQueryCache().getAll().reduce((count, query) => count + query.getObserversCount(), 0); },
    get input() { return root.root.findAllByType('Modal').find(node => node.props.visible)!.findAllByType('TextInput').find(node => node.props.accessibilityLabel === 'Add a comment')!; },
    async mountStandaloneSave(repoId: string) {
      await act(async () => { root = create(React.createElement(QueryClientProvider, { client },
        React.createElement(overlayTypes[0], {repoId, isVisible: true, onClose: () => undefined}),
      )); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    },
    async mount() {
      await act(async () => { root = create(React.createElement(QueryClientProvider, { client },
        ids.map(id => React.createElement(Row, { key: id, repository: repository(id), pageWidth: 400, pageHeight: 800,
          onQueueActivity: (event: unknown) => events.push(event) })),
      )); });
    },
    async open(index: number, action: string) {
      await act(async () => { root.root.findAllByType('RepositoryScreen')[index].props[action](); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    },
    async requestClose() {
      await act(async () => { root.root.findAllByType('Modal').find(node => node.props.visible)?.props.onRequestClose(); });
    },
    async finishClose(finished = true) {
      await act(async () => { closeAnimations.splice(0).forEach(callback => callback({ finished })); });
    },
    async type(text: string) { await act(async () => { this.input.props.onChangeText(text); }); },
    async submit() { await act(async () => { this.input.props.onSubmitEditing(); await new Promise(resolve => setTimeout(resolve, 0)); }); },
    async createCollection(name: string) {
      await this.press('Create new List');
      const input = () => root.root.findAllByType('TextInput').find(node => node.props.accessibilityLabel === 'List name')!;
      await act(async () => { input().props.onChangeText(name); });
      await act(async () => { input().props.onSubmitEditing(); await new Promise(resolve => setTimeout(resolve, 0)); });
    },
    async unmount() { await act(async () => { root.unmount(); }); client.clear(); },
  };
}

test('100 inactive rows mount no overlays, hidden fetches or query observers', async (t) => {
  const app = feed(Array.from({ length: 100 }, (_, index) => `repo-${index}`));
  await app.mount();
  try {
    t.diagnostic(`mounted overlays=${app.mountedOverlays}; query observers=${app.observers}; hidden fetches=${app.requests.length}`);
    assert.equal(app.mountedOverlays, 0);
    assert.equal(app.observers, 0);
    assert.deepEqual(app.requests, []);
  } finally { await app.unmount(); }
});

test('each real overlay survives interrupted close and unmounts only after its close animation', async () => {
  const app = feed(['00000000-0000-4000-8000-000000000001']);
  await app.mount();
  try {
    for (const action of ['onSavePress', 'onSharePress', 'onCommentPress', 'onReadFullPress']) {
      await app.open(0, action);
      assert.equal(app.mountedOverlays, 1, action);
      await app.requestClose();
      assert.equal(app.mountedOverlays, 1, 'keep accessibility/modal tree during animation');
      await app.finishClose(false);
      assert.equal(app.mountedOverlays, 1, 'cancelled animation must not dismiss');
      await app.requestClose();
      await app.finishClose();
      assert.equal(app.mountedOverlays, 0);
      assert.equal(app.observers, 0);
    }
    assert.deepEqual(app.requests, ['save:00000000-0000-4000-8000-000000000001', 'comments:00000000-0000-4000-8000-000000000001']);
    assert.deepEqual(app.events, [{ repo_id: '00000000-0000-4000-8000-000000000001', action: 'readme_open', serve_id: '00000000-0000-4000-8000-000000000001', position: 3 }]);
  } finally { await app.unmount(); }
});

test('comment drafts remain repository-local across close, reopen and repository switches', async () => {
  const app = feed(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
  await app.mount();
  try {
    await app.open(0, 'onCommentPress');
    await app.type('Draft for one');
    await app.requestClose(); await app.finishClose();
    await app.open(1, 'onCommentPress');
    assert.equal(app.input.props.value, '');
    await app.type('Draft for two');
    await app.requestClose(); await app.finishClose();
    await app.open(0, 'onCommentPress');
    assert.equal(app.input.props.value, 'Draft for one');
    await app.requestClose(); await app.finishClose();
    await app.open(1, 'onCommentPress');
    assert.equal(app.input.props.value, 'Draft for two');
  } finally { await app.unmount(); }
});

test('a failed comment after dismissal restores its draft before the next mount', async () => {
  const app = feed(['00000000-0000-4000-8000-000000000001']);
  let reject!: (error: Error) => void;
  app.setPost(() => new Promise((_yes, no) => { reject = no; }));
  await app.mount();
  try {
    await app.open(0, 'onCommentPress'); await app.type('Keep this draft'); await app.submit();
    assert.equal(app.input.props.value, '');
    await app.requestClose(); await app.finishClose();
    await act(async () => { reject(new Error('offline')); });
    await app.open(0, 'onCommentPress');
    assert.equal(app.input.props.value, 'Keep this draft');
  } finally { await app.unmount(); }
});

// Reduced-motion README intentionally skips the close animation altogether.
test('reduced-motion README dismisses immediately through its existing close callback', async () => {
  const app = feed(['00000000-0000-4000-8000-000000000001'], true);
  await app.mount();
  try {
    await app.open(0, 'onReadFullPress');
    assert.equal(app.mountedOverlays, 1);
    await app.requestClose();
    assert.equal(app.mountedOverlays, 0);
  } finally { await app.unmount(); }
});

test('reopening comments during an in-flight post cannot submit that draft twice', async () => {
  const app = feed(['00000000-0000-4000-8000-000000000001']);
  let finish!: (comment: any) => void;
  let posts = 0;
  app.setPost(() => { posts++; return new Promise(resolve => { finish = resolve; }); });
  await app.mount();
  try {
    await app.open(0, 'onCommentPress'); await app.type('Post once'); await app.submit();
    await app.requestClose(); await app.finishClose();
    await app.open(0, 'onCommentPress');
    assert.equal(app.input.props.editable, false);
    await app.type('Post once'); await app.submit();
    assert.equal(posts, 1);
    await act(async () => { finish({ comment_id: 'saved', user_id: 'viewer', repo_id: '00000000-0000-4000-8000-000000000001', comment: 'Post once' }); });
    assert.equal(app.input.props.editable, true);
  } finally { await app.unmount(); }
});

test('reopening a pending save blocks overlapping replacements and ignores the old popup close timer', async () => {
  const app = feed(['00000000-0000-4000-8000-000000000001']);
  let finish!: (result: any) => void;
  let saves = 0;
  app.setSave(() => { saves++; return new Promise(resolve => { finish = resolve; }); });
  await app.mount();
  try {
    await app.open(0, 'onSavePress'); await app.press('Save repository to selected Lists');
    assert.equal(saves, 1);
    await app.requestClose(); await app.finishClose();
    await app.open(0, 'onSavePress');
    assert.equal(app.button('Save repository to selected Lists').props.disabled, true);
    await app.press('Save repository to selected Lists');
    assert.equal(saves, 1, 'a second full collection-set replacement must not race the first');
    await act(async () => { finish({ saved: true, selectedListIds: ['collection:list'], saveStateChanged: true }); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(app.button('Save repository to selected Lists').props.disabled, false);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 950)); });
    assert.equal(app.pendingCloseAnimations, 0, 'the unmounted instance must not schedule a close on the reopened popup');
    assert.equal(app.mountedOverlays, 1);
  } finally { await app.unmount(); }
});

test('a failed save after close/reopen releases busy state so the user can retry', async () => {
  const app = feed(['00000000-0000-4000-8000-000000000001']);
  let reject!: (error: Error) => void;
  let saves = 0;
  app.setSave(() => {
    saves++;
    return saves === 1 ? new Promise((_yes, no) => { reject = no; }) : Promise.resolve({ saved: true, selectedListIds: ['collection:list'], saveStateChanged: true });
  });
  await app.mount();
  try {
    await app.open(0, 'onSavePress'); await app.press('Save repository to selected Lists');
    await app.requestClose(); await app.finishClose(); await app.open(0, 'onSavePress');
    assert.equal(app.button('Save repository to selected Lists').props.disabled, true);
    await act(async () => { reject(new Error('offline')); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(app.button('Save repository to selected Lists').props.disabled, false);
    await app.press('Save repository to selected Lists');
    assert.equal(saves, 2);
  } finally { await app.unmount(); }
});

test('collection creation also remains busy across save-popup close/reopen until it settles', async () => {
  const app = feed(['00000000-0000-4000-8000-000000000001']);
  let finish!: (collection: any) => void;
  app.setCreate(() => new Promise(resolve => { finish = resolve; }));
  await app.mount();
  try {
    await app.open(0, 'onSavePress'); await app.createCollection('New collection');
    await app.requestClose(); await app.finishClose(); await app.open(0, 'onSavePress');
    assert.equal(app.button('Create new List').props.disabled, true);
    assert.equal(app.button('Save repository to selected Lists').props.disabled, true);
    await act(async () => { finish({ id: 'new', source: 'collection', name: 'New collection' }); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(app.button('Create new List').props.disabled, false);
    assert.equal(app.button('Save repository to selected Lists').props.disabled, false);
  } finally { await app.unmount(); }
});

for (const changed of [true, false]) {
  test(`standalone detail save invalidates Home only when save state changes: ${changed}`, async () => {
    const app = feed([]);
    const repoId = '00000000-0000-4000-8000-000000000001';
    app.setSave(async () => ({saved: true, selectedListIds: ['collection:list'], saveStateChanged: changed}));
    const key = ['feed', 'viewer'] as const;
    app.client.setQueryData(key, {pages: [{mode: 'personalized', nextCursor: 'loaded-cursor', items: [{repo_id: repoId, viewer_saved: false}]}], pageParams: [null]});
    let invalidations = 0;
    const unsubscribe = subscribeToHomeFeedInvalidations(app.client, key, () => {invalidations++;});
    await app.mountStandaloneSave(repoId);
    try {
      await app.press('Save repository to selected Lists');
      assert.equal(invalidations, changed ? 1 : 0);
      assert.equal(app.client.getQueryState(key)?.isInvalidated, changed);
      const data = app.client.getQueryData<any>(key);
      assert.equal(data.pages[0].items[0].viewer_saved, true);
      assert.equal(data.pages[0].nextCursor, 'loaded-cursor', 'Keep loaded pages until the user refreshes');
    } finally {unsubscribe(); await app.unmount();}
  });
}
