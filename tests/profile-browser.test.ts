import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import ts from 'typescript';
import { profileSectionQueries } from '../src/api/profile-section-queries';
import { mapCollectionList, mapLegacyBoardList } from '../src/models/list';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Only the native host boundary is substituted. Real components and React Query
// own the pending/error/retry transitions; this is not a browser/layout proof.
function profileLists() {
  const native = {
    View: 'View', Text: 'Text', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator',
    Platform: { select: (options: any) => options.default },
    StyleSheet: { create: (value: unknown) => value, absoluteFill: {}, hairlineWidth: 1 },
    FlatList: ({ data, renderItem, ListHeaderComponent }: any) => React.createElement('FlatList', null, ListHeaderComponent,
      ...data.map((item: any) => React.createElement(React.Fragment, { key: item.key }, renderItem({ item })))),
  };
  const load = (relative: string): any => {
    const filename = path.resolve(relative), nativeRequire = createRequire(filename), module = { exports: {} as any };
    const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
      fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    new Function('require', 'module', 'exports', javascript)((name: string) => {
      if (name === 'react-native') return native;
      if (name === 'lucide-react-native') return { FolderPlus: 'FolderPlus', FolderOpen: 'FolderOpen', ChevronRight: 'ChevronRight', Pin: 'Pin' };
      if (name === './BoardListCard') return load('src/components/profile/BoardListCard.tsx');
      if (name === '../explore/RepoCard') return {__esModule:true,default:'RepoCard'};
      if (name === '@/constants/theme') return load('src/constants/theme.ts');
      if (name.endsWith('.css')) return {};
      return nativeRequire(name);
    }, module, module.exports);
    return module.exports;
  };
  return load('src/components/profile/ProfileContentLists.tsx').ProfileContentLists;
}

test('own profile repository and List sections render separately and pinned cards open their canonical repo',async()=>{
  const Lists=profileLists();const opened:string[]=[];
  const id='00000000-0000-4000-8000-000000000001';
  const props={viewer:'viewer',header:React.createElement('View'),compact:true,horizontalPadding:20,maxWidth:600,paddingTop:20,paddingBottom:20,
    collections:{data:[mapCollectionList({collection_id:'one',name:'My List',repo_count:2})],isPending:false,isError:false,refetch(){}},
    pinned:{data:[{key:'pinned',repositoryId:id,name:'repo',owner:'owner',description:'Pinned repo',primaryLanguage:null,url:'https://github.com/owner/repo',pinnedAt:'2026-10-29T00:00:00Z'}],isPending:false,isError:false,refetch(){}},
    openList(){},openRepository:(repo:any)=>opened.push(repo.id)};
  let root!:ReturnType<typeof create>;
  await act(async()=>{root=create(React.createElement(Lists,{...props,section:'Repositories'}));});
  try {
    const card=root.root.findByType('RepoCard');assert.equal(card.props.repo.id,id);assert.equal(card.props.showMetrics,false);
    assert.equal(root.root.findAllByProps({testID:'profile-list-collection:one'}).length,0);
    await act(async()=>card.props.onPress());assert.deepEqual(opened,[id]);
    await act(async()=>root.update(React.createElement(Lists,{...props,section:'Lists'})));
    assert.equal(root.root.findAllByType('RepoCard').length,0);
    assert.equal(root.root.findAllByProps({testID:'profile-list-collection:one'}).length,1);
    assert.equal(root.root.findAllByProps({testID:'profile-list-pinned'}).length,0,'Pinned is no longer mixed into Lists as a folder');
  }finally{await act(async()=>root.unmount());}
});

test('rendered Lists keep ready content through pending, failed and retried independent sections', async () => {
  const Lists = profileLists();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let resolveCollections!: (items: ReturnType<typeof mapCollectionList>[]) => void;
  let rejectCollections!: (error: Error) => void;
  const options = profileSectionQueries('viewer', {
    boards: async () => [mapLegacyBoardList({ board_id: 'legacy', name: 'Existing legacy List', repo_count: 1 })],
    collections: () => new Promise((resolve, reject) => { resolveCollections = resolve; rejectCollections = reject; }),
  });
  function Fixture({ includeLegacy = true }: { includeLegacy?: boolean }) {
    const boards = useQuery(options.boards), collections = useQuery(options.collections);
    return React.createElement(Lists, { viewer: 'viewer', header: React.createElement('View'), compact: true,
      horizontalPadding: 24, maxWidth: 600, paddingTop: 20, paddingBottom: 20, boards: includeLegacy ? boards : undefined, collections,
      pinned: { data: [], isPending: false, isError: false, refetch() {} }, openList() {} });
  }
  let root!: ReturnType<typeof create>;
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  await act(async () => { root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Fixture))); });
  await settle();
  const row = (id: string) => root.root.findAllByProps({ testID: `profile-list-${id}` });
  const loading = () => root.root.findAllByProps({ accessibilityRole: 'progressbar', accessibilityLabel: 'Loading Lists' });
  const retry = () => root.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === 'Retry Lists');
  try {
    assert.ok(row('legacy-board:legacy').length, 'a delayed collection cannot hide a ready independent section');
    assert.ok(loading().length, 'pending Lists announce an accessible loading placeholder, not an empty-success state');
    assert.equal(loading()[0].props.accessible, true, 'native screen readers can focus the loading status');
    assert.equal(loading()[0].props.accessibilityState.busy, true, 'the loading status remains busy until the query settles');
    assert.equal(retry(), undefined);
    await act(async () => rejectCollections(Object.assign(new Error('Fixture collection unavailable'), { status: 503 })));
    await settle();
    assert.equal(loading().length, 0);
    assert.ok(retry(), 'failed Lists expose their own actionable retry');
    assert.equal(row('empty').length, 0, 'failure is never presented as an empty successful List');
    await act(async () => retry()!.props.onPress());
    await settle();
    assert.ok(loading().length, 'retry visibly returns to loading until the collection actually succeeds');
    assert.ok(row('legacy-board:legacy').length);
    await act(async () => resolveCollections([mapCollectionList({ collection_id: 'current', name: 'Current List', repo_count: 2 })]));
    await settle();
    assert.equal(loading().length, 0);
    assert.ok(row('collection:current').length);
    // A subsequent unauthorized fixture response cannot erase cached content or
    // silently masquerade as a successful empty result.
    await act(async () => { void client.invalidateQueries({ queryKey: options.collections.queryKey }); });
    await act(async () => rejectCollections(Object.assign(new Error('Fixture unauthorized'), { status: 401 })));
    await settle();
    assert.ok(row('collection:current').length);
    assert.ok(retry());
    const messages=() => root.root.findAllByType('Text').map(node => React.Children.toArray(node.props.children).join(''));
    assert.ok(messages().includes('Couldn’t refresh Lists.'), 'retained Lists report a refresh failure, not a missing initial load');
    assert.ok(!messages().includes('Unable to load your Lists.'));

    await act(async () => retry()!.props.onPress());
    await settle();
    assert.equal(retry()!.props.disabled, true, 'in-flight retry cannot be submitted repeatedly');
    assert.equal(retry()!.props.accessibilityState.busy, true);
    assert.ok(messages().includes('Refreshing Lists…'), 'an active retry must not keep showing the previous error');
    await act(async () => resolveCollections([]));
    await settle();
    assert.equal(retry(), undefined);
    assert.equal(row('collection:current').length, 0, 'only a successful empty response clears previous collection rows');
    assert.ok(row('legacy-board:legacy').length);
    await act(async () => root.update(React.createElement(QueryClientProvider, { client }, React.createElement(Fixture, { includeLegacy: false }))));
    assert.ok(row('empty').length, 'the current Collections-only profile shows its first-List prompt only after successful empty loading');
    assert.equal(row('legacy-board:legacy').length, 0, 'the current profile does not restore the hidden legacy UI');
  } finally { await act(async () => root.unmount()); client.clear(); }
});

// Opt in: RUN_PROFILE_BROWSER=1 npx tsx --test tests/profile-browser.test.ts
// Requires Chromium (or CHROMIUM_BIN) and Node 22+ for native WebSocket.
test('rendered profile windows, lazy sheets, paging retry and scroll retention', {
  skip: process.env.RUN_PROFILE_BROWSER !== '1', timeout: 60_000,
}, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const fixture = path.join(root, 'tests/browser/profile');
  const output = await mkdtemp(path.join(tmpdir(), 'weave-profile-browser-'));
  let closeSocket = () => {};
  let closeBrowser = async () => {};
  let closeServer = async () => {};
  t.after(async () => {
    closeSocket();
    await closeBrowser();
    await closeServer();
    // Chromium child processes can finish profile writes just after the parent exits.
    await rm(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { build } = await import('esbuild');
  await build({
    entryPoints: [path.join(fixture, 'entry.tsx')], outfile: path.join(output, 'bundle.js'),
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', jsxImportSource: 'nativewind',
    alias: {
      'react-native': 'react-native-web',
      // The package barrel exports an unavailable LucideProvider; use real icons directly.
      'lucide-react-native': path.join(root, 'node_modules/lucide-react-native/dist/esm/icons/index.mjs'),
      'expo-router': path.join(fixture, 'router.ts'),
    },
    plugins: [{ name: 'fixture-transport', setup(builder) {
      builder.onResolve({ filter: /^@\/api\/client$/ }, () => ({ path: path.join(fixture, 'client.ts') }));
      builder.onResolve({ filter: /^@\/utils\/storage$/ }, () => ({ path: path.join(fixture, 'storage.ts') }));
    } }],
    loader: { '.css': 'empty' }, tsconfig: path.join(root, 'tsconfig.json'),
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.json'],
    define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
  });
  execFileSync(process.execPath, [path.join(root, 'node_modules/tailwindcss/lib/cli.js'),
    '-i', 'src/global.css', '-o', path.join(output, 'global.css')], { cwd: root, stdio: 'pipe' });
  const server = createServer(async (req, res) => {
    const files: Record<string, [string, string]> = {
      '/': [path.join(fixture, 'index.html'), 'text/html'],
      '/bundle.js': [path.join(output, 'bundle.js'), 'application/javascript'],
      '/global.css': [path.join(output, 'global.css'), 'text/css'],
    };
    const file = files[new URL(req.url ?? '/', 'http://fixture.invalid').pathname];
    if (!file) { res.writeHead(404).end(); return; }
    try { res.setHeader('Content-Type', file[1]); res.end(await readFile(file[0])); }
    catch { res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closeServer = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const chrome = spawn(process.env.CHROMIUM_BIN ?? 'chromium', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${path.join(output, 'chrome')}`, 'about:blank',
  ], { stdio: 'ignore' });
  let spawnError: Error | undefined;
  chrome.on('error', error => { spawnError = error; });
  closeBrowser = async () => {
    if (chrome.exitCode !== null || spawnError) return;
    const exited = new Promise<void>(resolve => chrome.once('exit', () => resolve()));
    chrome.kill(); await exited;
  };
  let port: string | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    try { port = (await readFile(path.join(output, 'chrome/DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(port, 'Chromium did not start its debugging endpoint');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  closeSocket = () => socket.close();
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  let sequence = 0;
  let pageLoaded: (() => void) | undefined;
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: any) => void }>();
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Page.loadEventFired') pageLoaded?.();
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      if (message.error) request.reject(message.error);
      else request.resolve(message.result);
    }
  };
  const send = (method: string, params = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  for (const [width, textScale] of [[320, 1], [820, 1], [320, 1.5]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 500 });
    const loaded = new Promise<void>(resolve => { pageLoaded = resolve; });
    await send('Page.navigate', { url: `http://127.0.0.1:${address.port}/?textScale=${textScale}` });
    await loaded;
    pageLoaded = undefined;
    const result = await send('Runtime.evaluate', {
    expression: `new Promise(resolve => {
      const timer = setInterval(() => {
        const element = document.getElementById('profile-check-result');
        if (element) { clearInterval(timer); resolve({ status: element.dataset.status, result: JSON.parse(element.textContent) }); }
      }, 100);
      setTimeout(() => { clearInterval(timer); resolve({ status: 'timeout' }); }, 30000);
    })`, awaitPromise: true, returnByValue: true,
  });
    t.diagnostic(JSON.stringify({ width, textScale, ...(result.result?.value ?? result) }));
    assert.equal(result.result?.value?.status, 'passed');
  }
});

test('other profile pages repositories on demand and opens only fetched public Lists', async t => {
  const {loadSource} = await import('./support/startup-harness');
  let viewer = 'viewer-a', failMore = false, legacyCalls = 0;
  const requests: any[] = [], routes: any[] = [];
  const owner = 'profile-owner';
  const repo = (id:string) => ({repo_id:id,full_name:`owner/${id}`,owner:'owner',name:id,url:`https://github.com/owner/${id}`});
  const metadata = {profile_id:'external',handle:'owner',display_name:'Owner',claimed_by_user_id:owner,
    followers_count:0,following_count:0,likes_given_count:0,viewer_follows_profile:false,is_self:false};
  const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
  const api = {getSocialProfile:async()=>{legacyCalls++;return {...metadata,repositories:[repo('first')]};},
    getSocialProfilePage:async (_id:string,_token:string,options:any,signal:AbortSignal)=>{
      requests.push({kind:'repositories',viewer,...options,signal});
      if(options.cursor && failMore)throw new Error('Temporary page failure');
      return {...metadata,repositories:options.cursor?[repo('first'),repo('second')]:[repo('first')],has_more:!options.cursor,next_cursor:options.cursor?null:'repo-next'};
    }};
  const Route = loadSource('src/app/user/[username].tsx', {
    'react-native':{Alert:{alert(){}}},
    'expo-router':{useLocalSearchParams:()=>({profileId:'external',username:'owner'}),router:{push:(route:any)=>routes.push(route),canGoBack:()=>true,back(){}}},
    '@/api/social-profiles':api,
    '@/api/profile':{getPublicUserProfile:async()=>{throw new Error('Unexpected user fetch');},getPublicUserBoardsPage:async (id:string,_token:string,options:any)=>{
      requests.push({kind:'lists',subject:id,viewer,...options});return {items:[{id:'public-board',name:'Public List',description:'Shared projects',repositoryCount:2}],has_more:false,next_cursor:null};
    }},
    '@/components/other-user-profile':{OtherUserProfile:'OtherUserProfile'},
    '@/components/connection-sheet':{ConnectionSheet:()=>null},
    '@/store/AuthContext':{useAuth:()=>({user:{user_id:viewer}})},
    '@/utils/follow-state':{followStateQueryKey:()=>[],getProfileFollowIdentity:()=>({})},
    '@/utils/storage':{getStorageItem:async()=> 'token'},
    '@/utils/repository-links':{repositoryHref:(id:string)=>({pathname:'/repository/[repoId]',params:{repoId:id}})},
    '@/utils/repository-mapper':await import('../src/utils/repository-mapper'),
  }).default;
  let root!:ReturnType<typeof create>;
  const render = () => React.createElement(QueryClientProvider,{client},React.createElement(Route));
  const settle = () => act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
  await act(async()=>{root=create(render());});await settle();
  t.after(async()=>{await act(async()=>root.unmount());client.clear();});
  const screen=()=>root.root.findByType('OtherUserProfile').props;
  assert.equal(legacyCalls,0,'the route must never fetch the complete external portfolio');
  assert.deepEqual(screen().profile.pinnedRepositories.map((repo:any)=>repo.id),['first']);
  assert.equal(requests[0].limit,25);
  assert.equal(requests.some(request=>request.kind==='lists'),false,'Lists load when their tab is opened');
  failMore=true;await act(async()=>screen().repositoriesPage.onLoadMore());await settle();
  assert.deepEqual(screen().profile.pinnedRepositories.map((repo:any)=>repo.id),['first'],'page errors preserve existing repos');
  assert.equal(screen().repositoriesPage.error,true);
  failMore=false;await act(async()=>screen().repositoriesPage.onRetry());await settle();
  assert.deepEqual(screen().profile.pinnedRepositories.map((repo:any)=>repo.id),['first','second']);
  assert.equal(screen().repositoriesPage.hasMore,false);
  await act(async()=>screen().onListsOpen());await settle();
  assert.deepEqual(screen().profile.lists.map((list:any)=>list.id),['public-board']);
  assert.equal(requests.find(request=>request.kind==='lists').subject,owner,'claimed external identity resolves the registered owner');
  await act(async()=>screen().onListPress('public-board'));
  assert.deepEqual(routes.at(-1),{pathname:'/board',params:{boardId:'public-board',boardName:'Public List',boardDescription:'Shared projects'}});
  await act(async()=>screen().onListPress('unknown-board'));assert.equal(routes.length,1);
  const {settleFollowCache} = await import('../src/services/followMutationCache');
  const {authSessionLifecycle} = await import('../src/api/session-lifecycle');
  await act(async()=>{await settleFollowCache(client,viewer,{profileId:'external'},true,authSessionLifecycle.currentGeneration());});await settle();
  assert.equal(screen().profile.isFollowing,true,'settled follows reconcile the paged profile even after the initiating control unmounts');
  assert.equal(screen().profile.stats.followers,1);
  viewer='viewer-b';await act(async()=>root.update(render()));await settle();
  assert.ok(requests.some(request=>request.kind==='repositories'&&request.viewer==='viewer-b'&&!request.cursor),'a new viewer gets its own first page');
});
