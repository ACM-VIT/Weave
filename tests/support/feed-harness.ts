import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import React, { act } from "react";
import { create } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ts from "typescript";
import { type RepositoryData } from "../../src/data/repositories";
import { repositoryDetailQueryKey, repositoryMetadataQueryKey, repositoryReadmeQueryKey } from "../../src/models/repository";
import { authSessionLifecycle } from "../../src/api/session-lifecycle";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

(globalThis as any).requestAnimationFrame = (callback: (time: number) => void) => { callback(0); return 0; };

export function repository(id: string): RepositoryData {
  return {
    contentVersion:1,contentHash:'fixture-content-hash',hasReadme:true,
    id, name: id, fullName: `owner/${id}`, owner: 'owner', description: '', readmeSummary: 'Summary.', readmeFull: '# README',
    languages: [], primaryLanguage: null,
    serveId: id, feedPosition: 3, githubUrl: `https://github.com/owner/${id}`,
    stats: { stars: 0, views: 0, openIssues: 0, forks: 0, comments: 0, likes: 0, dislikes: 0, saves: 0 },
  } as RepositoryData;
}

export function feed(ids: string[], reducedMotion = false, attribution?: { ownerId: string; repository: Partial<RepositoryData>; boundary?: React.ReactNode; platform?: string; viewable?: boolean; actualScreen?: boolean }) {
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: Infinity }, mutations: { retry: false },
  } });
  const requests: string[] = [];
  const events: any[] = [];
  const closeAnimations: ((result: { finished: boolean }) => void)[] = [];
  let loadComments: (cursor: string | null) => Promise<any> = async () => ({items:[],has_more:false,next_cursor:null});
  let postComment: () => Promise<any> = async () => { throw new Error('Unexpected post'); };
  let saveRepository: (...args: any[]) => Promise<any> = async () => { throw new Error('Unexpected save'); };
  let createCollection: () => Promise<any> = async () => { throw new Error('Unexpected create'); };
  let saveCollections: any[] = [];
  let loadLists: (signal?: AbortSignal) => Promise<any[]> = async () => saveCollections;
  let openExternal: () => Promise<void> = async () => undefined;
  let shareHeight=800;
  const pinFiles = new Map<string, string>();
  let pinStorageFailure = false;
  class PinFile {
    key: string;
    constructor(_directory: unknown, name: string) { this.key = name; }
    get exists() { return pinFiles.has(this.key); }
    create() { pinFiles.set(this.key, ''); }
    write(value: string) { if (pinStorageFailure) throw new Error('Storage unavailable'); pinFiles.set(this.key, value); }
    async text() { return pinFiles.get(this.key) ?? null; }
    async move(destination: PinFile) { pinFiles.set(destination.key, pinFiles.get(this.key)!); pinFiles.delete(this.key); }
  }

  let loadMetadata: (id:string)=>Promise<any> = async(id)=>({...repository(id),readmeFull:null});
  let loadReadme: () => Promise<any> = async () => ({ ...repository('canonical'), readmeFull: '# Canonical fetched README' });
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
  let moveSaveWindow: (index: number) => void = () => { throw new Error('Save grid is not mounted'); };
  const native = {
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Platform: { OS: attribution?.platform ?? 'ios', select: (value: any) => value.ios ?? value.default },
    StyleSheet: { create: (value: unknown) => value, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { Value, View: 'AnimatedView', createAnimatedComponent: (component: unknown) => component,
      timing: animation, parallel: animation, sequence: animation, delay: animation },
    Easing: { bezier: () => 0, in: () => 0, out: () => 0, cubic: 0, quad: 0 },
    useWindowDimensions: () => ({ height: shareHeight, width: 400 }),
    Keyboard: { dismiss() {} }, Linking: { openURL: () => openExternal() },
    Share: { share: async () => ({ action: 'sharedAction' }) },
    ...Object.fromEntries(['ActivityIndicator', 'FlatList', 'Image', 'KeyboardAvoidingView', 'Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map(name => [name, name])),
    FlatList: (props: any) => {
      const [first, setFirst] = React.useState(0);
      moveSaveWindow = setFirst;
      return props.numColumns === 2 ? React.createElement('FlatList', props,
        props.ListHeaderComponent,
        props.data.length ? props.data.slice(first, first + props.initialNumToRender * props.numColumns).map((item: any, index: number) =>
          React.createElement(React.Fragment, {key: props.keyExtractor(item)}, props.renderItem({item, index:first+index}))) : props.ListEmptyComponent,
      ) : React.createElement('FlatList', props);
    },

  };
  const auth = { useAuth: () => ({ user: { user_id: attribution?.ownerId ?? 'viewer', username: 'viewer' }, checkOnboardingStatus: async () => undefined }) };
  const storage = { getItemAsync: async () => 'token', getStorageItem: async (key: string) => key.startsWith('weave.pinned-repositories.') ? null : 'token' };
  function pan() {
    const config: Record<string, any> = {};
    const gesture = new Proxy({ config }, {get: (target, key) => key === 'config' ? target.config : (...args: any[]) => {
      config[String(key)] = args.length === 1 ? args[0] : args;
      return gesture;
    }});
    return gesture;
  }
  const mocks: Record<string, any> = {
    'react-native': native,
    '@/api/session-lifecycle': { authSessionLifecycle },
    '@/api/client': {apiV2: async () => {throw new Error('Unexpected API call');}, apiV2Raw: async () => {throw new Error('Unexpected API call');}},
    './client': {apiV2: async () => {throw new Error('Unexpected API call');}, apiV2Raw: async () => {throw new Error('Unexpected API call');}},
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    'react-native-reanimated': {
      __esModule: true, default: { View: 'AnimatedView' }, useReducedMotion: () => reducedMotion,
      useSharedValue: (initial: unknown) => React.useRef({value: initial, get() {return this.value;}, set(value: unknown) {this.value = value;}}).current,
      useAnimatedStyle: (style: () => unknown) => style(), withSpring: (value: unknown) => value,
    },
    'react-native-worklets': {scheduleOnRN: (fn: (...args: any[]) => void, ...args: any[]) => fn(...args)},
    'react-native-gesture-handler': {Gesture: {Pan: pan}, GestureDetector: 'GestureDetector'},
    './ReadmeImagePopup': {ReadmeImagePopup: 'ReadmeImagePopup'},
    './ReadmeVideoPopup': {ReadmeVideoPopup: 'ReadmeVideoPopup'},
    './ReadmeVideo': {ReadmeVideo: 'ReadmeVideo'},
    './SafeReadmeImage': {SafeReadmeImage: 'SafeReadmeImage', SafeReadmeImageRenderer: 'SafeReadmeImageRenderer'},
    './DescriptionCard': {__esModule: true, default: () => null, SaveSwipeGestureContext: React.createContext(null)},
    './ReadmeCard': {__esModule: true, default: () => null},
    './RecommendationReason': {RecommendationReason: () => null},
    '../follow-button': {FollowButton: () => null},
    '@/components/keyboard/keyboard-layout': {KeyboardSurface: 'KeyboardSurface'},
    'expo-blur': { BlurView: 'BlurView' },
    'expo-file-system': { File: PinFile, Paths: { document: 'documents' } },
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
      getRepositoryLists: async (id: string, _token: string, signal?: AbortSignal) => { requests.push(`save:${id}`); return loadLists(signal); },
      createRepositoryList: () => createCollection(),
      syncRepositoryLists: (...args: any[]) => saveRepository(...args),
    },
    '@/api/repositories': { repositoryDetailQueryKey, repositoryMetadataQueryKey, repositoryReadmeQueryKey,
      fetchRepositoryMetadata:async(id:string)=>{requests.push(`metadata:${id}`);return loadMetadata(id);},
      fetchRepositoryReadme: async (id: string) => { requests.push(`readme:${id}`); return loadReadme(); } },
    '@/api/repository-actions': {
      getSaveCollections: async (id: string) => { requests.push(`save:${id}`); return saveCollections; },
      getRepositoryShareDetails: async (id: string) => { requests.push(`share:${id}`); return {}; },
      createSaveCollection: () => createCollection(),
      saveRepositoryToCollections: () => saveRepository(),
    },
    '../../api/comments': {
      getCommentsKeysetPage: async (id: string, cursor: string | null) => { requests.push(`comments:${id}`); return loadComments(cursor); },
      getCommentAuthor: async () => { requests.push('author'); return {}; },
      createComment: () => postComment(),
    },
    './RepositoryScreen': { RepositoryScreen: (props: any) => React.createElement('RepositoryScreen', props) },
  };
  if (attribution?.actualScreen) delete mocks['./RepositoryScreen'];
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
      if (/^\.\/(CommentSheet|ReadmePopup|FeedReadmePopup|save-popup|share-repository-sheet|RepositoryScreen)$/.test(specifier)) {
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
  let viewable = attribution?.viewable ?? false;
  const renderRows = () => React.createElement(QueryClientProvider, { client },
    ids.map(id => React.createElement(Row, { key: id, isViewable: viewable, repository: { ...repository(id), ...attribution?.repository }, boundary: attribution?.boundary, pageWidth: 400, pageHeight: 800,
      onQueueActivity: (event: unknown) => events.push(event) })),
  );
  return {
    requests, events, client,
    setPinStorageFailure(value: boolean) { pinStorageFailure = value; },
    async pins(owner = attribution?.ownerId ?? 'viewer') { return loadSource('src/services/pinnedRepositoryStorage.ts').loadPinnedRepositories(owner); },
    get saveListOrder() { return root.root.findAllByType('FlatList').find(node => node.props.numColumns === 2)!.props.data.map((list: any) => list.id); },
    async moveListWindow(index: number) { await act(async () => { moveSaveWindow(index); }); },
    async setViewable(value: boolean) { viewable = value; await act(async () => { root.update(renderRows()); }); },
    get swipe() {return root.root.findByType('GestureDetector').props;},
    get saveRevealed() {return root.root.findAllByType('Pressable').some(node => node.props.accessibilityLabel === 'Close Save actions');},
    async swipeRight(x = 100, y = 0, success = true) {
      const config = this.swipe.gesture.config;
      assert.equal(config.enabled, true, 'right-swipe must be available on web');
      await act(async () => {
        config.onStart?.();
        config.onUpdate?.({translationX: x, translationY: y});
        config.onEnd({translationX: x, translationY: y}, success);
        config.onFinalize?.({}, success);
      });
    },
    setExternalOpen(value: () => Promise<void>) {openExternal=value;},
    get failureModalVisible() {return root.root.findAllByType('Modal').some(node => node.props.visible);},
    async pressScreen(label: string) {await act(async () => {
      root.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === label)!.props.onPress();
      await new Promise(resolve => setImmediate(resolve));
    });},
    setHeight(value:number) {shareHeight=value;},
    setMetadata(value:(id:string)=>Promise<any>) {loadMetadata=value;},
    setReadme(value: () => Promise<any>) {loadReadme=value;},
    get readmePopupProps() {return root.root.findAllByType(overlayTypes[3])[0]?.props;},
    get screenHeight() {return root.root.findByType('RepositoryScreen').props.pageHeight;},
    get saveRevealBottom() {
      const layers=root.root.findAllByType('View').map(node=>Object.assign({},...(Array.isArray(node.props.style)?node.props.style:[node.props.style])));
      return layers.find(style=>style.backgroundColor==='#123520')?.bottom;
    },
    get imagePopup() {return root.root.findAllByType('ReadmeImagePopup')[0];},
    get previewImages() {return root.root.findAllByType('SafeReadmeImage').map(node=>node.props.url);},
    async openImage() {await act(async()=>{root.root.findAllByType('Pressable').find(node=>node.props.accessibilityLabel?.startsWith('Enlarge README image:'))!.props.onPress();});},
    async pressMarkdownImage(url:string,alt:string) {
      const renderer=root.root.findByType('RenderHtml').props.renderers.img;
      let image!:ReturnType<typeof create>;let stopped=false;
      await act(async()=>{image=create(React.createElement(renderer,{tnode:{attributes:{src:url,alt}}}));});
      try {await act(async()=>image.root.findByType('Pressable').props.onPress({stopPropagation(){stopped=true;}}));}
      finally {await act(async()=>image.unmount());}
      return stopped;
    },
    async closeImage() {await act(async()=>{this.imagePopup.props.onClose();});},
    get videoPopup() {return root.root.findAllByType('ReadmeVideoPopup')[0];},
    async openVideo() {await act(async () => {root.root.findAllByType('ReadmeVideo')[0].props.onPress();});},
    async closeVideo() {await act(async () => {this.videoPopup.props.onClose();});},
    get videoUrls() {return root.root.findAllByType('ReadmeVideo').map(node=>node.props.url);},
    get renderedReadmeHtml() {return root.root.findAllByType('RenderHtml').map(node=>node.props.source.html).join('');},
    get githubActionScrollable() {return this.button('Open on GitHub').findAllByType('Text').length>0
      && root.root.findAllByType('ScrollView').some(scroll=>scroll.findAllByType('Pressable').some(node=>node.props.accessibilityLabel==='Open on GitHub'));},
    setCommentPages(value: (cursor: string | null) => Promise<any>) { loadComments = value; },
    get loadedCommentIds() {
      return root.root.findAllByType('Modal').find(node => node.props.visible)!.findAllByType('FlatList')[0].props.data.map((item:any)=>item.comment_id);
    },
    async pressCommentFooter() {
      await act(async()=>{
        const footer=root.root.findAllByType('Modal').find(node=>node.props.visible)!.findAllByType('FlatList')[0].props.ListFooterComponent;
        const button=React.Children.toArray(footer.props.children).find((child:any)=>child?.type==='Pressable') as React.ReactElement<any>;
        button.props.onPress();
        await new Promise(resolve=>setTimeout(resolve,0));
      });
    },
    setPost(value: () => Promise<any>) { postComment = value; },
    setListLoader(value: (signal?: AbortSignal) => Promise<any[]>) {loadLists = value;},
    setSave(value: (...args: any[]) => Promise<any>) {
      saveRepository = value;
      saveCollections = [{ id: 'list', source: 'collection', name: 'List', repositoryCount: 0, selected: true }];
    },
    clearSelectedLists(){saveCollections=saveCollections.map(list=>({...list,selected:false}));},
    setCreate(value: () => Promise<any>) { createCollection = value; },
    get pendingCloseAnimations() { return closeAnimations.length; },
    button(label: string) { return root.root.findAllByType('Modal').find(node => node.props.visible)!.findAllByType('Pressable').find(node => node.props.accessibilityLabel === label)!; },
    async press(label: string) { await act(async () => { this.button(label).props.onPress(); await new Promise(resolve => setTimeout(resolve, 0)); }); },
    get messages() { return root.root.findAllByType('Text').flatMap(node => typeof node.props.children === 'string' ? [node.props.children] : []); },
    get hasNewListForm() {return root.root.findAllByType('TextInput').some(node => node.props.accessibilityLabel === 'List name');},
    get mountedOverlays() { return overlayTypes.reduce((count, type) => count + root.root.findAllByType(type).length, 0); },
    get observers() { return client.getQueryCache().getAll().reduce((count, query) => count + query.getObserversCount(), 0); },
    get input() { return root.root.findAllByType('Modal').find(node => node.props.visible)!.findAllByType('TextInput').find(node => node.props.accessibilityLabel === 'Add a comment')!; },
    async mountStandaloneSave(repoId: string) {
      await act(async () => { root = create(React.createElement(QueryClientProvider, { client },
        React.createElement(overlayTypes[0], {repoId, isVisible: true, onClose: () => undefined}),
      )); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    },
    async readmeCardImages(cardRepository: RepositoryData) {
      const Card = loadSource('src/components/home/ReadmeCard.tsx').default;
      let cardRoot: ReturnType<typeof create>;
      await act(async () => { cardRoot = create(React.createElement(QueryClientProvider, { client },
        React.createElement(Card, { repository: cardRepository, availableWidth: 400, isActive: false,
          onReadFullPress: () => undefined, onOpenReadme: () => undefined }),
      )); });
      const images = cardRoot!.root.findAllByType('SafeReadmeImage').map(node => node.props.url);
      await act(async () => { cardRoot!.unmount(); });
      return images;
    },
    async mount() { await act(async () => { root = create(renderRows()); }); },
    async rerender() { await act(async () => { root.update(renderRows()); }); },
    async open(index: number, action: string, value?: unknown) {
      await act(async () => { root.root.findAllByType('RepositoryScreen')[index].props[action](value); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    },
    async requestClose() {
      await act(async () => { root.root.findAllByType('Modal').find(node => node.props.visible)?.props.onRequestClose(); });
    },
    async finishClose(finished = true) {
      await act(async () => { closeAnimations.splice(0).forEach(callback => callback({ finished })); });
    },
    async type(text: string) { await act(async () => { this.input.props.onChangeText(text); }); },
    async searchLists(text: string) { await act(async () => {
      root.root.findAllByType('TextInput').find(node => node.props.accessibilityLabel === 'Search Lists')!.props.onChangeText(text);
    }); },
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

export async function waitForReadmeState(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
  assert.ok(predicate(), 'README query state did not settle');
}
