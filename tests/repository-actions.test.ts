import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { buildRepositoryShareContent, buildRepositoryWebUrl, normalizePublicWebUrl, parseRepositoryIdFromLink, repositoryHref, repositoryHrefFromLink, repositoryPath, resolveRepositoryShareUrl } from "../src/utils/repository-links";
import { shareResultConfirmsCompletion } from "../src/utils/share-feedback";

describe("repository links", () => {
  test('repository routes keep the raw parameter separate from the encoded path', () => {
    assert.equal(repositoryPath(' repo id '), '/repository/repo%20id');
    assert.deepEqual(repositoryHref(' repo id '), {
      pathname: '/repository/[repoId]',
      params: { repoId: 'repo id' },
    });
    assert.throws(() => repositoryPath('  '), /Repository ID is required/);
  });

  test('public web URL accepts a secure origin and rejects placeholders or path prefixes', () => {
    assert.equal(normalizePublicWebUrl('https://weave.example.com/'), 'https://weave.example.com');
    assert.equal(normalizePublicWebUrl('http://localhost:8081/'), 'http://localhost:8081');
    assert.equal(normalizePublicWebUrl('https://your-web-frontend.example'), null);
    assert.equal(normalizePublicWebUrl('http://weave.example.com'), null);
    assert.equal(normalizePublicWebUrl('https://weave.example.com/app'), null);
    assert.equal(normalizePublicWebUrl('https://weave.example.com/?from=test'), null);
    assert.equal(normalizePublicWebUrl(undefined), null);
  });

  test('configured web origin builds the canonical repository URL', () => {
    assert.equal(
      buildRepositoryWebUrl('7be6d88f', 'https://weave.example.com/'),
      'https://weave.example.com/repository/7be6d88f',
    );
    assert.equal(
      buildRepositoryWebUrl('7be6d88f', 'https://your-web-frontend.example'),
      null,
    );
  });

  test('relative, custom-scheme, Expo Go, and configured HTTPS links resolve one route', () => {
    const repoId = '7be6d88f';
    const webBaseUrl = 'https://weave.example.com';
    assert.equal(parseRepositoryIdFromLink(`/repository/${repoId}`), repoId);
    assert.equal(parseRepositoryIdFromLink(`repository/${repoId}`), repoId);
    assert.equal(parseRepositoryIdFromLink(`ghsocial://repository/${repoId}`), repoId);
    assert.equal(parseRepositoryIdFromLink(`ghsocial:///repository/${repoId}`), repoId);
    assert.equal(parseRepositoryIdFromLink(`exp://127.0.0.1:8081/--/repository/${repoId}`), repoId);
    assert.equal(
      parseRepositoryIdFromLink(`${webBaseUrl}/repository/${repoId}`, webBaseUrl),
      repoId,
    );
    assert.deepEqual(repositoryHrefFromLink(`ghsocial://repository/${repoId}`), {
      pathname: '/repository/[repoId]',
      params: { repoId },
    });
  });

  test('repository link parser rejects foreign, malformed, and unconfigured web links', () => {
    assert.equal(parseRepositoryIdFromLink('https://github.com/acme/project'), null);
    assert.equal(
      parseRepositoryIdFromLink(
        'https://other.example.com/repository/7be6d88f',
        'https://weave.example.com',
      ),
      null,
    );
    assert.equal(parseRepositoryIdFromLink('https://weave.example.com/repository/7be6d88f'), null);
    assert.equal(parseRepositoryIdFromLink('ghsocial://other/repository/7be6d88f'), null);
    assert.equal(parseRepositoryIdFromLink('/repository/owner%2Frepo'), null);
    assert.equal(parseRepositoryIdFromLink('/repository/'), null);
  });

  test('share URL prefers configured web origin and otherwise requires the matching native route', () => {
    assert.equal(resolveRepositoryShareUrl({
      repoId: '7be6d88f',
      webBaseUrl: 'https://weave.example.com',
      nativeUrl: 'ghsocial://repository/7be6d88f',
    }), 'https://weave.example.com/repository/7be6d88f');

    assert.equal(resolveRepositoryShareUrl({
      repoId: '7be6d88f',
      webBaseUrl: 'https://your-web-frontend.example',
      nativeUrl: 'ghsocial://repository/7be6d88f',
    }), 'ghsocial://repository/7be6d88f');

    assert.equal(resolveRepositoryShareUrl({
      repoId: '7be6d88f',
      webBaseUrl: 'http://localhost:8096',
      nativeUrl: 'http://localhost:8096/repository/7be6d88f',
    }), 'http://localhost:8096/repository/7be6d88f');

    assert.throws(() => resolveRepositoryShareUrl({
      repoId: '7be6d88f',
      nativeUrl: 'https://github.com/acme/project',
    }), /valid native Weave repository link/);
  });

  test('share content names Weave and uses the canonical Weave URL', () => {
    const url = 'ghsocial://repository/7be6d88f';
    assert.deepEqual(buildRepositoryShareContent('acme/project', url), {
      title: 'acme/project on Weave',
      message: `View acme/project on Weave:\n${url}`,
      url,
    });
  });
});

describe("share feedback", () => {
  test('share feedback is recorded only when iOS can distinguish completion from dismissal', () => {
    assert.equal(shareResultConfirmsCompletion('ios', 'sharedAction', 'sharedAction'), true);
    assert.equal(shareResultConfirmsCompletion('ios', 'dismissedAction', 'sharedAction'), false);
    assert.equal(shareResultConfirmsCompletion('android', 'sharedAction', 'sharedAction'), false);
    assert.equal(shareResultConfirmsCompletion('web', 'sharedAction', 'sharedAction'), false);
  });
});


test('repository previews show immediately without marking incomplete details fresh or leaking attribution/accounts', async () => {
  const {QueryClient,QueryObserver}=await import('@tanstack/react-query');
  const {rememberRepositoryPreview,repositoryPreview}=await import('../src/services/repositoryPreview');
  const {mapRepositoryDetail}=await import('../src/utils/repository-mapper');
  const {repositoryDetailQueryKey}=await import('../src/models/repository');
  const client=new QueryClient();
  const card=mapRepositoryDetail({repo_id:'repo',full_name:'owner/repo',name:'repo',owner:'owner',status:'active',url:'https://github.com/owner/repo',serve_id:'serve',position:2});
  assert.ok(card);
  rememberRepositoryPreview(client,'alice',card);
  assert.equal(repositoryPreview(client,'bob','repo'),undefined);
  assert.equal(repositoryPreview(client,'alice','repo')?.serveId,null);
  assert.equal(repositoryPreview(client,'alice','repo')?.feedPosition,null);
  let resolve!: (value:typeof card)=>void;
  const pending=new Promise<typeof card>(done=>{resolve=done;});
  const key=repositoryDetailQueryKey('repo','alice');
  const observer=new QueryObserver(client,{queryKey:key,queryFn:()=>pending,
    placeholderData:()=>repositoryPreview(client,'alice','repo'),retry:false});
  const unsubscribe=observer.subscribe(()=>{});
  try {
    assert.equal(observer.getCurrentResult().isPlaceholderData,true);
    assert.equal(observer.getCurrentResult().data?.name,'repo');
    assert.equal(client.getQueryData(key),undefined,'Partial card is not persisted as a complete detail response');
    resolve({...card,description:'fresh detail',viewerSaved:true});
    await pending; await new Promise(done=>setTimeout(done,0));
    assert.equal(observer.getCurrentResult().isPlaceholderData,false);
    assert.equal(observer.getCurrentResult().data?.description,'fresh detail');
    rememberRepositoryPreview(client,'alice',card);
    assert.equal(observer.getCurrentResult().data?.viewerSaved,true,'Old card cannot overwrite authoritative detail');
    for(let i=0;i<110;i++) rememberRepositoryPreview(client,'alice',{...card,id:String(i)});
    assert.equal(client.getQueryCache().findAll({queryKey:['repository-preview','alice']}).length,100);
    client.clear();
    assert.equal(repositoryPreview(client,'alice','109'),undefined);
  } finally {unsubscribe();client.clear();}
});

for (const saved of [true, false]) test(`confirmed preview membership ${saved} survives a delayed pre-save detail without crossing accounts`, async () => {
  const React=await import('react');
  const {act}=React;
  const {create}=await import('react-test-renderer');
  const {QueryClient,QueryClientProvider}=await import('@tanstack/react-query');
  const {loadSource}=await import('./support/startup-harness');
  const {rememberRepositoryPreview}=await import('../src/services/repositoryPreview');
  const {mapRepositoryDetail}=await import('../src/utils/repository-mapper');
  const {repositoryDetailQueryKey}=await import('../src/models/repository');
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
  let viewer='alice';
  const card=mapRepositoryDetail({repo_id:'repo',full_name:'owner/repo',name:'repo',status:'active',url:'https://github.com/owner/repo'});
  assert.ok(card);rememberRepositoryPreview(client,viewer,card);rememberRepositoryPreview(client,'bob',card);
  let finish!:(value:typeof card)=>void;
  const pending=new Promise<typeof card>(resolve=>{finish=resolve;});
  let finishBob!:(value:typeof card)=>void;
  const bobPending=new Promise<typeof card>(resolve=>{finishBob=resolve;});
  let aliceRequests=0;
  const icon=()=>null;
  const {RepositoryDetailScreen}=loadSource('src/components/repository-detail-screen.tsx',{
    '@tanstack/react-query':await import('@tanstack/react-query'),
    'react-native':{ActivityIndicator:'ActivityIndicator',Pressable:'Pressable',ScrollView:'ScrollView',Text:'Text',View:'View',
      StyleSheet:{create:(value:unknown)=>value},useWindowDimensions:()=>({width:400})},
    'expo-router':{router:{}},'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:0,bottom:0})},
    'lucide-react-native':new Proxy({},{get:()=>icon}),
    '@/constants/theme':{REFERENCE_THEME:{}},'@/store/AuthContext':{useAuth:()=>({user:{user_id:viewer},isLoading:false})},
    '@/api/repositories':{repositoryDetailQueryKey,fetchRepositoryDetail:()=>viewer==='alice'?(aliceRequests++===0?pending:Promise.resolve({...card,viewerSaved:!saved,selectedListIds:[]})):bobPending},
    '@/utils/storage':{getStorageItem:async()=> 'token'},
    '@/components/home/ReadmePopup':{ReadmePopup:()=>null},
    '@/components/home/save-popup':{SavePopup:(props:any)=>React.createElement('SavePopup',props)},
    '@/components/home/share-repository-sheet':{ShareRepositorySheet:()=>null},
    '@/hooks/use-repository-readme-summary':{useRepositoryReadmeSummary:()=>({})},
    '@/services/activityOutboxClient':{},
  });
  let root!:ReturnType<typeof create>;
  const render=()=>React.createElement(QueryClientProvider,{client},React.createElement(RepositoryDetailScreen,{repositoryId:'repo'}));
  await act(async()=>{root=create(render());});
  try {
    const callback=root.root.findByType('SavePopup').props.onListMembershipsChanged;
    await act(async()=>{callback(saved?['list-a']:[],saved);});
    const label=saved?'Manage saved Lists':'Save repository to Lists';
    assert.equal(root.root.findAllByProps({accessibilityLabel:label}).length>0,true);
    assert.equal(client.getQueryData(repositoryDetailQueryKey('repo','alice')),undefined);
    await act(async()=>{finish({...card,viewerSaved:!saved,selectedListIds:saved?[]:['old-list'],readmeFull:'# Complete'});await pending;});
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
    assert.equal(root.root.findAllByProps({accessibilityLabel:label}).length>0,true,'Pre-save detail cannot undo confirmed membership');
    assert.equal(client.getQueryData<any>(repositoryDetailQueryKey('repo','alice'))?.viewerSaved,saved);
    assert.equal(client.getQueryData<any>(repositoryDetailQueryKey('repo','alice'))?.readmeFull,'# Complete');
    await act(async()=>{await client.invalidateQueries({queryKey:repositoryDetailQueryKey('repo','alice'),exact:true});});
    assert.equal(client.getQueryData<any>(repositoryDetailQueryKey('repo','alice'))?.viewerSaved,!saved,'A fetch started after confirmation remains authoritative');
    await act(async()=>{viewer='bob';root.update(render());});
    await act(async()=>{callback(['alice-only'],true);});
    assert.equal(root.root.findAllByProps({accessibilityLabel:'Save repository to Lists'}).length>0,true);
    assert.equal(client.getQueryData(repositoryDetailQueryKey('repo','bob')),undefined);
    await act(async()=>{finishBob({...card,description:'complete README',readmeFull:'# Complete'});await bobPending;});
    assert.equal(client.getQueryData<any>(repositoryDetailQueryKey('repo','bob'))?.readmeFull,'# Complete');
  } finally {await act(async()=>root.unmount());client.clear();}
});
