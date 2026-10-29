import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { repositoryDetailQueryKey, repositoryMetadataQueryKey, repositoryReadmeMetadataQueryKey, repositoryReadmeQueryKey } from "../src/models/repository";
import { authSessionLifecycle } from "../src/api/session-lifecycle";
import { mapRepositoryDetail } from "../src/utils/repository-mapper";
import { decodeFeedPage } from "../src/api/feed-data";
import { createFeedItemMapper } from "../src/utils/feed-items";
import { repository, feed, waitForReadmeState } from "./support/feed-harness";

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

test('one feed action opens the original README viewer without repository navigation', async () => {
  const app = feed(['repo'], true);
  await app.mount();
  try {
    await app.open(0, 'onOpenReadme');
    assert.equal(app.mountedOverlays, 1);
    assert.ok(app.messages.includes('README'));
    assert.ok(app.renderedReadmeHtml.includes('README'));
    assert.ok(!app.messages.includes('README SUMMARY'));
    assert.deepEqual(app.requests, [], 'canonical bytes already on the card need no new request');
    assert.equal(app.events[0].action, 'readme_open');
    assert.equal(app.events[0].serve_id, 'repo');
    assert.equal(app.events[0].position, 3);
  } finally { await app.unmount(); }
});

test('mapped feed README seeds exact canonical bytes for same-account cache reuse', async () => {
  const canonical = '  # Canonical README\r\n\r\nContent with source whitespace.  \r\n';
  const page = decodeFeedPage({
    serve_id: '00000000-0000-4000-8000-000000000011', feed_version: '1', next_cursor: null,
    items: [{ repo_id: 'repo', position: 0, repository: {
      full_name: 'owner/repo', url: 'https://github.com/owner/repo', content_version: 7,
      content_hash: 'body-hash-v7', readme_available: true, readme_md: canonical,
    } }],
  }, '00000000-0000-4000-8000-000000000010');
  const mapped = createFeedItemMapper()([page])[0].repository;
  assert.equal(mapped.readmeFull, canonical, 'feed mapping retains the canonical response bytes');
  const app = feed(['repo'], true, { ownerId: 'viewer', repository: mapped });
  app.setReadme(async () => { throw new Error('An exact feed body must seed the shared version cache'); });
  await app.mount();
  try {
    await app.open(0, 'onOpenReadme');
    const key = repositoryReadmeQueryKey('repo', 'viewer', 7);
    assert.equal(app.client.getQueryData<any>(key)?.readmeFull, canonical,
      'the shared document cache keeps leading and trailing canonical whitespace');
    assert.deepEqual(app.requests, [], 'the feed body is reusable without a second request');
    await app.requestClose();
    await app.open(0, 'onOpenReadme');
    assert.equal(app.client.getQueryData<any>(key)?.readmeFull, canonical);
    assert.deepEqual(app.requests, [], 'reopening reuses the same immutable version cache');
  } finally { await app.unmount(); }
});

test('matching deferred media manifest keeps feed previews without fetching the README until open', async () => {
  const manifest = {
    schema_version: 2 as const, content_version: 7, content_hash: 'fixture-content-hash', readme_available: true,
    representation: 'deferred' as const,
    poster: { alt: 'Repository poster', url: 'https://cdn.example.com/poster.png' },
    images: [{ alt: 'Architecture', url: 'https://cdn.example.com/architecture.png' },
      {alt:'Diagram',url:'https://cdn.example.com/diagram.png'}, {alt:'Extra',url:'https://cdn.example.com/extra.png'}],
    videos: ['https://cdn.example.com/demo.mp4'],
  };
  const app = feed(['repo'], true, { ownerId: 'viewer', repository: {
    readmeFull: null, contentVersion: 7, contentHash: 'fixture-content-hash',
    hasReadme: true, readmeMediaManifest: manifest,
  } });
  app.setReadme(async () => { throw new Error('A matching manifest supplies summary previews without a body request'); });
  assert.deepEqual(await app.readmeCardImages({ ...repository('repo'), readmeFull: null, readmeMediaManifest: manifest }),
    ['https://cdn.example.com/poster.png']);
  await app.mount();
  try {
    await app.open(0, 'onReadFullPress');
    await waitForReadmeState(() => app.previewImages.includes('https://cdn.example.com/architecture.png')
      && app.videoUrls.includes('https://cdn.example.com/demo.mp4'));
    assert.deepEqual(app.requests, [], 'the summary manifest avoids an eager canonical body request');
    assert.deepEqual(app.previewImages,['https://cdn.example.com/poster.png','https://cdn.example.com/architecture.png','https://cdn.example.com/diagram.png'], 'include the cached card poster while keeping summary images bounded');
    assert.equal(app.readmePopupProps.mediaMessage, null);
    assert.equal(app.videoPopup, undefined, 'manifest videos remain previews until tapped');
    await app.openVideo();
    assert.equal(app.videoPopup.props.url, 'https://cdn.example.com/demo.mp4');
    await app.closeVideo();
    await app.requestClose();

    app.setReadme(async () => ({ ...repository('repo'), readmeFull: '# Full canonical README' }));
    await app.open(0, 'onOpenReadme');
    await waitForReadmeState(() => app.renderedReadmeHtml.includes('Full canonical README'));
    assert.deepEqual(app.requests, ['readme:repo'], 'opening the original document still fetches it on demand');
  } finally { await app.unmount(); }
});

test('feed README viewer loads canonical bytes and retries failures without a second open', async () => {
  const app = feed(['repo'], true, { ownerId: 'viewer', repository: { readmeFull: null } });
  let finish!: (value: unknown) => void;
  app.setReadme(() => new Promise(resolve => { finish=resolve; }));
  await app.mount();
  try {
    await app.open(0, 'onOpenReadme');
    assert.ok(app.messages.includes('Loading README…'));
    assert.deepEqual(app.requests, ['readme:repo']);
    await act(async () => { finish({ ...repository('repo'), readmeFull: '# Original canonical source' }); await new Promise(resolve=>setTimeout(resolve,0)); });
    await waitForReadmeState(() => app.renderedReadmeHtml.includes('Original canonical source'));
    assert.ok(app.renderedReadmeHtml.includes('Original canonical source'));
    assert.ok(app.client.getQueryData(repositoryReadmeQueryKey('repo', 'viewer',1)));
    assert.equal(app.client.getQueryData(repositoryDetailQueryKey('repo','viewer')),undefined,'Body loading cannot populate viewer state');
    await app.requestClose();
    await app.open(0, 'onOpenReadme');
    assert.deepEqual(app.requests, ['readme:repo'], 'reopening uses the owner-scoped canonical cache');
    await app.requestClose();
    app.client.clear();
    app.setReadme(async () => {throw new Error('Read failed');});
    await app.open(0, 'onOpenReadme');
    assert.ok(app.messages.includes('Read failed'));
    app.setReadme(async () => ({ ...repository('repo'), readmeFull: '# Recovered README' }));
    await app.press('Retry loading README');
    await waitForReadmeState(() => app.renderedReadmeHtml.includes('Recovered README'));
    assert.ok(app.renderedReadmeHtml.includes('Recovered README'));
  } finally { await app.unmount(); }
});

test('a replaced session for the same viewer cannot publish a late canonical README response', async () => {
  const app = feed(['repo'], true, { ownerId: 'viewer', repository: { readmeFull: null } });
  let finish!: (value: unknown) => void;
  app.setReadme(() => new Promise(resolve => { finish=resolve; }));
  await app.mount();
  try {
    await app.open(0, 'onOpenReadme');
    await act(async () => {authSessionLifecycle.retire(authSessionLifecycle.currentGeneration());});
    await app.requestClose();
    const {clearAccountQueryCache}=await import('../src/services/accountQueryCache');
    clearAccountQueryCache(app.client);
    app.setReadme(async()=>({...repository('repo'),readmeFull:'# Replacement session README'}));
    await app.open(0,'onOpenReadme');
    await waitForReadmeState(()=>app.renderedReadmeHtml.includes('Replacement session README'));
    await act(async()=>{finish({...repository('repo'),readmeFull:'# Previous session private README'});await new Promise(resolve=>setTimeout(resolve,0));});
    assert.ok(!app.renderedReadmeHtml.includes('Previous session private README'));
    assert.equal(app.client.getQueryData<any>(repositoryReadmeQueryKey('repo','viewer',1))?.readmeFull,'# Replacement session README');
    clearAccountQueryCache(app.client);
    assert.equal(app.client.getQueryCache().getAll().length,0,'Logout removes the document and metadata keys too');
  } finally { await app.unmount(); }
});

test('an immutable cached original README remains readable offline', async () => {
  const app = feed(['repo'], true, { ownerId: 'viewer', repository: { readmeFull: null } });
  const key = repositoryDetailQueryKey('repo', 'viewer');
  app.client.setQueryData(key, { ...repository('repo'), readmeFull: '# Cached original README' }, { updatedAt: Date.now() - 120_000 });
  app.setReadme(async () => { throw new Error('Background refresh unavailable'); });
  await app.mount();
  try {
    await app.open(0, 'onOpenReadme');
    assert.deepEqual(app.requests,[],'A matching immutable cached body requires no background request');
    assert.equal(app.client.getQueryData<any>(key)?.readmeFull, '# Cached original README', 'React Query retains the unchanged stale canonical data');
    assert.equal(app.readmePopupProps.errorMessage, null);
    assert.equal(app.readmePopupProps.loading, false);
    assert.ok(app.renderedReadmeHtml.includes('Cached original README'), 'background failure must not replace cached content');
    assert.ok(!app.messages.includes('Background refresh unavailable'));
  } finally { await app.unmount(); }
});

test('immutable cached summary media remains readable offline without a new request', async () => {
  const app = feed(['repo'], true, { ownerId: 'viewer', repository: { readmeFull: null } });
  const key = repositoryDetailQueryKey('repo', 'viewer');
  const cached = '![Architecture](https://cdn.example.com/diagram.png)\n<video src="https://cdn.example.com/demo.mp4"></video>';
  app.client.setQueryData(key, { ...repository('repo'), readmeFull: cached }, { updatedAt: Date.now() - 120_000 });
  app.setReadme(async () => { throw new Error('Background refresh unavailable'); });
  await app.mount();
  try {
    await app.open(0, 'onReadFullPress');
    assert.deepEqual(app.requests,[],'A matching immutable cached body requires no background request');
    assert.equal(app.client.getQueryData<any>(key)?.readmeFull, cached);
    assert.ok(app.renderedReadmeHtml.includes('Summary.'));
    assert.deepEqual(app.previewImages, ['https://cdn.example.com/diagram.png']);
    assert.deepEqual(app.videoUrls, ['https://cdn.example.com/demo.mp4']);
    assert.equal(app.readmePopupProps.mediaMessage, null);
    assert.equal(app.readmePopupProps.errorMessage, null);
    assert.equal(app.readmePopupProps.loading, false);
    assert.ok(!app.messages.includes('Could not load README videos.'));
  } finally { await app.unmount(); }
});

test('Read more keeps the summary and lazily hydrates original README videos', async () => {
  const app = feed(['repo'], true, { ownerId: 'viewer', repository: { readmeFull: null } });
  app.setReadme(async () => ({ ...repository('repo'), readmeFull: '<video src="https://cdn.example.com/demo.mp4"></video>' }));
  await app.mount();
  try {
    assert.deepEqual(app.requests, []);
    await app.open(0, 'onReadFullPress');
    await waitForReadmeState(() => app.videoUrls.length > 0);
    assert.deepEqual(app.requests, ['readme:repo']);
    assert.equal(app.readmePopupProps.contentKind, 'summary');
    assert.ok(app.renderedReadmeHtml.includes('Summary.'));
    assert.deepEqual(app.videoUrls, ['https://cdn.example.com/demo.mp4']);
    assert.equal(app.videoPopup, undefined, 'summary previews do not mount a player');
    await app.openVideo();
    assert.equal(app.videoPopup.props.url, 'https://cdn.example.com/demo.mp4');
    await app.closeVideo();
    assert.equal(app.videoPopup, undefined);
    assert.ok(app.renderedReadmeHtml.includes('Summary.'), 'closing video preserves the summary');
    await app.requestClose();
    assert.deepEqual(app.videoUrls, [], 'closing removes the previews');
    await app.open(0,'onOpenReadme');
    assert.deepEqual(app.requests,['readme:repo'],'Read more and original README share one version body');
  } finally { await app.unmount(); }
});

test('summary image tap opens a separate viewer and returns to the retained digest',async()=>{
  const app=feed(['repo'],true,{ownerId:'viewer',repository:{readmeFull:null}});
  app.setReadme(async()=>({...repository('repo'),readmeFull:'![Architecture](https://cdn.example.com/diagram.png)'}));
  await app.mount();
  try{
    await app.open(0,'onReadFullPress');
    await waitForReadmeState(()=>app.previewImages.length===1);
    assert.equal(app.imagePopup,undefined);
    await app.openImage();
    assert.equal(app.imagePopup.props.url,'https://cdn.example.com/diagram.png');
    assert.equal(app.imagePopup.props.alt,'Architecture');
    assert.equal(app.videoPopup,undefined);
    await app.closeImage();
    assert.equal(app.imagePopup,undefined);
    assert.ok(app.renderedReadmeHtml.includes('Summary.'));
    assert.equal(app.mountedOverlays,1);
  }finally{await app.unmount();}
});

test('full README inline images open the same zoom viewer without following their surrounding link',async()=>{
  const app=feed(['repo'],true,{ownerId:'viewer',repository:{readmeFull:null}});
  const url='https://cdn.example.com/diagram.png';
  app.setReadme(async()=>({...repository('repo'),readmeFull:`# Original README\n[![Architecture](${url})](https://github.com/org/project)`}));
  await app.mount();
  try {
    await app.open(0,'onOpenReadme');
    await waitForReadmeState(()=>app.renderedReadmeHtml.includes(url));
    assert.equal(app.imagePopup,undefined);
    assert.equal(await app.pressMarkdownImage(url,'Architecture'),true,'image taps stop outer link navigation');
    assert.equal(app.imagePopup.props.url,url);
    assert.equal(app.imagePopup.props.alt,'Architecture');
    await app.closeImage();
    assert.equal(app.imagePopup,undefined);
    assert.ok(app.renderedReadmeHtml.includes('Original README'),'closing the image retains the full README underneath');
  }finally{await app.unmount();}
});


test('passive visibility requires a full second for impressions and three seconds for neutral dwell', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const app=feed(['repo'],true,{ownerId:'viewer',repository:{},viewable:false});
  await app.mount();
  try {
    await app.setViewable(true);
    await act(async()=>{t.mock.timers.tick(999);});
    assert.deepEqual(app.events,[]);
    await app.setViewable(false);
    await act(async()=>{t.mock.timers.tick(3001);});
    assert.deepEqual(app.events,[],'Quick swipe cancels impression and never emits a negative label');
    await app.setViewable(true);
    await act(async()=>{t.mock.timers.tick(1000);});
    assert.deepEqual(app.events.map(event=>event.action),['impression']);
    await act(async()=>{t.mock.timers.tick(1999);});
    await app.setViewable(false);
    assert.deepEqual(app.events.map(event=>event.action),['impression'],'Sub-three-second dwell remains neutral');
    await app.setViewable(true);
    await act(async()=>{t.mock.timers.tick(3000);});
    await app.setViewable(false);
    assert.deepEqual(app.events.map(event=>event.action),['impression','impression','dwell']);
    assert.equal(app.events.at(-1).dwell_seconds,3);
    assert.ok(app.events.every(event=>!['skip','dislike'].includes(event.action)));
  } finally {await app.unmount();}
});


test('a racing README version refresh is bounded and never mixes new body media with the opened digest',async()=>{
  const app=feed(['repo'],true,{ownerId:'viewer',repository:{readmeFull:null}});
  let attempts=0;
  app.setMetadata(async()=>({...repository('repo'),contentVersion:2,contentHash:'version-two',readmeFull:null}));
  app.setReadme(async()=>{attempts++;if(attempts===1)throw Object.assign(new Error('Repository version changed'),{status:409});
    return {...repository('repo'),contentVersion:2,contentHash:'version-two',readmeFull:'![New source](https://cdn.example.com/new.png)'};});
  await app.mount();
  try{
    await app.open(0,'onReadFullPress');
    await waitForReadmeState(()=>attempts===2 && app.messages.some(text=>text.includes('Repository updated')));
    assert.deepEqual(app.requests,['readme:repo','metadata:repo','readme:repo']);
    assert.deepEqual(app.previewImages,[],'New-version media cannot accompany the old digest');
    assert.ok(app.renderedReadmeHtml.includes('Summary.'));
    await app.requestClose();app.client.clear();attempts=0;
    app.setReadme(async()=>{attempts++;throw Object.assign(new Error('Repository version changed'),{status:409});});
    await app.open(0,'onOpenReadme');
    await waitForReadmeState(()=>attempts===2 && app.messages.includes('Repository version changed'));
    assert.equal(app.requests.filter(value=>value==='metadata:repo').length,2,'Only one metadata refresh per open, even if the replacement version races again');
    assert.equal(app.readmePopupProps.loading,false);
  }finally{await app.unmount();}
});

test('explicit README retry restarts metadata recovery after its bounded refresh fails',async()=>{
  const app=feed(['repo'],true,{ownerId:'viewer',repository:{readmeFull:null}});
  let bodyAttempts=0,metadataAttempts=0;
  app.setReadme(async()=>{
    bodyAttempts++;
    if(bodyAttempts<3)throw Object.assign(new Error('Repository version changed'),{status:409});
    return {...repository('repo'),contentVersion:2,contentHash:'version-two',readmeFull:'# Recovered version two'};
  });
  app.setMetadata(async()=>{
    metadataAttempts++;
    if(metadataAttempts===1)throw Object.assign(new Error('Metadata service unavailable'),{status:503});
    return {...repository('repo'),contentVersion:2,contentHash:'version-two',readmeFull:null};
  });
  await app.mount();
  try{
    await app.open(0,'onOpenReadme');
    await waitForReadmeState(()=>app.readmePopupProps?.errorMessage==='Metadata service unavailable');
    assert.deepEqual(app.requests,['readme:repo','metadata:repo']);
    assert.equal(bodyAttempts,1,'A failed bounded refresh does not start an automatic retry loop');
    assert.equal(metadataAttempts,1);

    await app.press('Retry loading README');
    await waitForReadmeState(()=>app.renderedReadmeHtml.includes('Recovered version two'));
    assert.deepEqual(app.requests,['readme:repo','metadata:repo','readme:repo','metadata:repo','readme:repo']);
    assert.equal(bodyAttempts,3);
    assert.equal(metadataAttempts,2);
  }finally{await app.unmount();}
});

test('confirmed README absence settles the active popup without a body request',async()=>{
  const app=feed(['repo'],true,{ownerId:'viewer',repository:{contentVersion:null,contentHash:null,hasReadme:undefined,readmeFull:null}});
  app.setMetadata(async()=>({...repository('repo'),contentVersion:null,contentHash:null,hasReadme:false,readmeFull:null}));
  await app.mount();
  try{
    await app.open(0,'onOpenReadme');
    await waitForReadmeState(()=>app.client.getQueryData<any>(repositoryReadmeMetadataQueryKey('repo','viewer'))?.hasReadme===false);
    assert.deepEqual(app.requests,['metadata:repo']);
    assert.equal(app.readmePopupProps.loading,false,'Confirmed absence is a settled result, not a disabled query spinner');
    assert.equal(app.readmePopupProps.errorMessage,null);
  }finally{await app.unmount();}
});

test('a pending README version refresh preserves a confirmed save for the same viewer',async()=>{
  const repoId='00000000-0000-4000-8000-000000000012';
  const app=feed([repoId],true,{ownerId:'viewer',repository:{readmeFull:null}});
  const metadataKey=repositoryMetadataQueryKey(repoId,'viewer');
  const readmeMetadataKey=repositoryReadmeMetadataQueryKey(repoId,'viewer');
  app.client.setQueryData(metadataKey,{...repository(repoId),viewerSaved:false,selectedListIds:[]});
  let rejectReadme!:(error:Error)=>void;
  const staleBody=new Promise<unknown>((_resolve,reject)=>{rejectReadme=reject;});
  let finishMetadata!:(value:unknown)=>void;
  const staleMetadata=new Promise<unknown>(resolve=>{finishMetadata=resolve;});
  let bodyAttempts=0;
  app.setReadme(()=>++bodyAttempts===1?staleBody:new Promise(()=>{}));
  app.setMetadata(async()=>staleMetadata);
  app.setListLoader(async()=>[{id:'list',source:'collection',name:'List',repositoryCount:0,selected:false}]);
  app.setSave(async(_repoId,listIds)=>({saved:listIds.length>0,selectedListIds:listIds,saveStateChanged:true}));
  await app.mount();
  try{
    await app.open(0,'onOpenReadme');
    await waitForReadmeState(()=>app.requests.includes(`readme:${repoId}`));
    await act(async()=>{rejectReadme(Object.assign(new Error('Repository version changed'),{status:409}));await new Promise(resolve=>setTimeout(resolve,0));});
    await waitForReadmeState(()=>app.requests.includes(`metadata:${repoId}`));

    await app.open(0,'onSavePress');
    await waitForReadmeState(()=>app.requests.includes(`save:${repoId}`));
    await app.press('List, 0 repositories');
    await app.press('Save repository to selected Lists');
    await waitForReadmeState(()=>app.client.getQueryData<any>(metadataKey)?.viewerSaved===true);
    assert.deepEqual(app.client.getQueryData<any>(metadataKey)?.selectedListIds,['collection:list']);

    await act(async()=>{
      finishMetadata({...repository(repoId),contentVersion:2,contentHash:'new-hash',readmeFull:null,
        viewerSaved:false,selectedListIds:[]});
      await staleMetadata;await new Promise(resolve=>setTimeout(resolve,0));
    });
    await waitForReadmeState(()=>app.client.getQueryData<any>(readmeMetadataKey)?.contentVersion===2);
    assert.equal(app.client.getQueryData<any>(metadataKey)?.viewerSaved,true,'The delayed pre-save metadata response cannot undo confirmed membership');
    assert.deepEqual(app.client.getQueryData<any>(metadataKey)?.selectedListIds,['collection:list']);
    const identity=app.client.getQueryData<any>(readmeMetadataKey);
    assert.equal(identity?.contentVersion,2);
    assert.equal('viewerSaved' in identity,false,'README identity refresh never caches viewer membership');
    assert.equal('selectedListIds' in identity,false);
    assert.equal('readmeFull' in identity,false);
    await waitForReadmeState(()=>bodyAttempts===2);
    assert.equal(app.requests.filter(value=>value===`readme:${repoId}`).length,2);
    assert.equal(app.requests.filter(value=>value===`metadata:${repoId}`).length,1);
  }finally{await app.unmount();}
});


test('legacy feed bodies without identity verify current metadata before showing summary images and video', async () => {
  const body='![Architecture](https://cdn.example.com/diagram.png)\n<video src="https://cdn.example.com/demo.mp4"></video>';
  const app=feed(['repo'],true,{ownerId:'viewer',repository:{contentVersion:null,contentHash:null,readmeFull:body}});
  const digest={summary_id:'digest',content_version:1,content_hash:'fixture-content-hash',prompt_version:'v1',format_version:'readme-digest-json-v1',model_version:'model',source:'generated',generated_at:'2026-10-27T00:00:00Z',overview:'Complete summary.',capabilities:['Useful','Documented'],use_cases:['Use it'],considerations:[]};
  assert.equal(mapRepositoryDetail({repo_id:'repo',full_name:'owner/repo',content_version:2,readme_md:body,readme_digest:digest})?.contentHash,null,'A stale digest cannot identify a newer body');
  assert.equal(mapRepositoryDetail({repo_id:'repo',full_name:'owner/repo',readme_md:body,readme_digest:digest})?.contentHash,null,'An unversioned inline body stays unverified');
  app.setMetadata(async()=>mapRepositoryDetail({repo_id:'repo',full_name:'owner/repo',content_version:1,readme_md:body,readme_digest:digest})!);
  app.setReadme(async()=>{throw new Error('An older backend already returns its canonical body with metadata');});
  await app.mount();
  try {
    await app.open(0,'onReadFullPress',digest);
    await waitForReadmeState(()=>app.previewImages.length===1);
    assert.deepEqual(app.requests,['metadata:repo']);
    assert.deepEqual(app.previewImages,['https://cdn.example.com/diagram.png']);
    assert.deepEqual(app.videoUrls,['https://cdn.example.com/demo.mp4']);
    assert.ok(app.renderedReadmeHtml.includes('Complete summary.'));
    assert.equal(app.readmePopupProps.mediaMessage,null);
    await app.openImage();assert.equal(app.imagePopup.props.url,'https://cdn.example.com/diagram.png');await app.closeImage();
    await app.openVideo();assert.equal(app.videoPopup.props.url,'https://cdn.example.com/demo.mp4');
  }finally{await app.unmount();}
});


test('summary media shows Retry only after failure, never during initial loading',async()=>{
  const app=feed(['repo'],true,{ownerId:'viewer',repository:{readmeFull:null}});
  let fail!:(error:Error)=>void;
  app.setReadme(()=>new Promise((_resolve,reject)=>{fail=reject;}));
  await app.mount();
  try {
    await app.open(0,'onReadFullPress');
    assert.equal(app.readmePopupProps.onRetry,undefined,'A pending initial request is not a failed request');
    assert.equal(app.button('Retry loading README media'),undefined);
    await act(async()=>{fail(new Error('Offline'));await new Promise(resolve=>setTimeout(resolve,0));});
    await waitForReadmeState(()=>Boolean(app.button('Retry loading README media')));
  }finally{await app.unmount();}
});
