import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { repositoryDetailQueryKey } from "../src/models/repository";
import { authSessionLifecycle } from "../src/api/session-lifecycle";
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
    assert.ok(app.client.getQueryData(repositoryDetailQueryKey('repo', 'viewer')));
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

test('a retired account cannot publish a late canonical README response', async () => {
  const app = feed(['repo'], true, { ownerId: 'viewer', repository: { readmeFull: null } });
  let finish!: (value: unknown) => void;
  app.setReadme(() => new Promise(resolve => { finish=resolve; }));
  await app.mount();
  try {
    await app.open(0, 'onOpenReadme');
    await act(async () => {
      authSessionLifecycle.retire(authSessionLifecycle.currentGeneration());
      finish({ ...repository('repo'), readmeFull: '# Previous account README' });
      await new Promise(resolve=>setTimeout(resolve,0));
    });
    await waitForReadmeState(() => app.client.getQueryCache().getAll().some(query=>query.state.status==='error'));
    assert.ok(!app.renderedReadmeHtml.includes('Previous account README'));
    assert.ok(app.client.getQueryCache().getAll().every(query=>query.state.data===undefined));
  } finally { await app.unmount(); }
});

test('a failed background refresh retains the cached original README', async () => {
  const app = feed(['repo'], true, { ownerId: 'viewer', repository: { readmeFull: null } });
  const key = repositoryDetailQueryKey('repo', 'viewer');
  app.client.setQueryData(key, { ...repository('repo'), readmeFull: '# Cached original README' }, { updatedAt: Date.now() - 120_000 });
  app.setReadme(async () => { throw new Error('Background refresh unavailable'); });
  await app.mount();
  try {
    await app.open(0, 'onOpenReadme');
    await waitForReadmeState(() => app.client.getQueryState(key)?.status === 'error');
    assert.equal(app.client.getQueryData<any>(key)?.readmeFull, '# Cached original README', 'React Query retains the unchanged stale canonical data');
    assert.equal(app.readmePopupProps.errorMessage, null);
    assert.equal(app.readmePopupProps.loading, false);
    assert.ok(app.renderedReadmeHtml.includes('Cached original README'), 'background failure must not replace cached content');
    assert.ok(!app.messages.includes('Background refresh unavailable'));
  } finally { await app.unmount(); }
});

test('a failed background refresh retains cached summary media without a false error', async () => {
  const app = feed(['repo'], true, { ownerId: 'viewer', repository: { readmeFull: null } });
  const key = repositoryDetailQueryKey('repo', 'viewer');
  const cached = '![Architecture](https://cdn.example.com/diagram.png)\n<video src="https://cdn.example.com/demo.mp4"></video>';
  app.client.setQueryData(key, { ...repository('repo'), readmeFull: cached }, { updatedAt: Date.now() - 120_000 });
  app.setReadme(async () => { throw new Error('Background refresh unavailable'); });
  await app.mount();
  try {
    await app.open(0, 'onReadFullPress');
    await waitForReadmeState(() => app.client.getQueryState(key)?.status === 'error');
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


for (const closure of ['unmount', 'inactive'] as const) {
  test(`real GitHub failure modal pauses qualification through ${closure}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-24T17:00:00Z') });
    const app = feed(['repo'], false, { ownerId: 'viewer', repository: {}, viewable: true, actualScreen: true });
    app.setExternalOpen(async () => { throw new Error('OS rejected opening'); });
    await app.mount();
    let unmounted = false;
    try {
      await act(async () => t.mock.timers.tick(250));
      await app.pressScreen('Open repository on GitHub');
      assert.equal(app.failureModalVisible, true);
      assert.equal(app.swipe.gesture.config.enabled, false, 'blocking errors reuse the existing overlay gesture gate');
      await act(async () => t.mock.timers.tick(4000));
      assert.deepEqual(app.events, [], 'modal reading must not qualify an obscured repository');
      if (closure === 'inactive') {
        await app.setViewable(false);
        assert.equal(app.failureModalVisible, false);
        await act(async () => t.mock.timers.tick(4000));
        assert.deepEqual(app.events, []);
      }
      await app.unmount(); unmounted = true;
      assert.deepEqual(app.events, [], 'modal-only time must not emit dwell during cleanup');
    } finally { if (!unmounted) await app.unmount(); t.mock.timers.reset(); }
  });
}

test('real error-modal dismissal and retry resume qualification without duplicate impressions or blocked dwell', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-24T17:00:00Z') });
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const app = feed([id(2)], false, { ownerId: id(1), repository: { serveId: id(3), feedSessionId: id(4), feedPosition: 0 }, viewable: true, actualScreen: true });
  app.setExternalOpen(async () => { throw new Error('OS rejected opening'); });
  await app.mount();
  let unmounted = false;
  try {
    await app.pressScreen('Open repository on GitHub');
    await act(async () => t.mock.timers.tick(4000));
    assert.deepEqual(app.events, []);
    await app.pressScreen('Dismiss GitHub opening error');
    assert.equal(app.swipe.gesture.config.enabled, true);
    await act(async () => t.mock.timers.tick(1000));
    assert.deepEqual(app.events.map(event => event.action), ['impression']);
    const original = app.events[0].event_id;
    await app.pressScreen('Open repository on GitHub');
    await act(async () => t.mock.timers.tick(4000));
    assert.deepEqual(app.events.map(event => event.action), ['impression']);
    app.setExternalOpen(async () => {});
    await app.pressScreen('Retry opening GitHub');
    assert.equal(app.failureModalVisible, false);
    assert.equal(app.swipe.gesture.config.enabled, true);
    await act(async () => t.mock.timers.tick(3000));
    await app.unmount(); unmounted = true;
    assert.deepEqual(app.events.map(event => event.action), ['impression', 'github_open', 'dwell']);
    assert.equal(app.events[1].impression_event_id, original);
    assert.equal(app.events[2].dwell_seconds, 3, 'only resumed repository reading counts, not eight seconds of dialogs');
    assert.ok(app.events.every(event => event.session_id === id(4) && event.serve_id === id(3) && event.position === 0));
  } finally { if (!unmounted) await app.unmount(); t.mock.timers.reset(); }
});

test('a late failed opening cannot show or pause an error modal for a replacement owner/session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-24T17:00:00Z') });
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const scope = { ownerId: id(1), repository: { serveId: id(3), feedSessionId: id(4), feedPosition: 0 }, viewable: true, actualScreen: true };
  const app = feed([id(2)], false, scope);
  let fail!: (error: Error) => void;
  app.setExternalOpen(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  await app.mount();
  try {
    await app.pressScreen('Open repository on GitHub');
    scope.ownerId = id(6); scope.repository.feedSessionId = id(7);
    authSessionLifecycle.retire(authSessionLifecycle.currentGeneration());
    await app.rerender();
    await act(async () => { fail(new Error('Previous owner rejected opening')); });
    assert.equal(app.failureModalVisible, false);
    assert.equal(app.swipe.gesture.config.enabled, true);
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(app.events.length, 1);
    assert.equal(app.events[0].action, 'impression');
    assert.equal(app.events[0].session_id, id(7));
  } finally { await app.unmount(); t.mock.timers.reset(); }
});

test('a prior-owner opening rejection cannot overwrite a replacement owner active failure or release its gate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-24T17:00:00Z') });
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const scope = { ownerId: id(1), repository: { serveId: id(3), feedSessionId: id(4), feedPosition: 0 }, viewable: true, actualScreen: true };
  const app = feed([id(2)], false, scope);
  let rejectOld!: (error: Error) => void;
  app.setExternalOpen(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
  await app.mount();
  try {
    await app.pressScreen('Open repository on GitHub');
    scope.ownerId = id(6); scope.repository.feedSessionId = id(7);
    authSessionLifecycle.retire(authSessionLifecycle.currentGeneration());
    await app.rerender();
    app.setExternalOpen(async () => { throw new Error('Current owner opening failed'); });
    await app.pressScreen('Open repository on GitHub');
    assert.equal(app.failureModalVisible, true);
    assert.equal(app.swipe.gesture.config.enabled, false);
    await act(async () => { rejectOld(new Error('Previous owner opening failed later')); });
    assert.equal(app.failureModalVisible, true, 'obsolete rejection must not dismiss the current owner failure');
    assert.equal(app.swipe.gesture.config.enabled, false);
    await act(async () => t.mock.timers.tick(4000));
    assert.deepEqual(app.events, [], 'the current modal must keep qualification paused');
    await app.pressScreen('Dismiss GitHub opening error');
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(app.events.length, 1);
    assert.equal(app.events[0].action, 'impression');
    assert.equal(app.events[0].session_id, id(7));
  } finally { await app.unmount(); t.mock.timers.reset(); }
});

test('an older opening rejection cannot replace a newer successful attempt in the same row', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-24T17:00:00Z') });
  const app = feed(['repo'], false, { ownerId: 'viewer', repository: {}, viewable: true, actualScreen: true });
  let rejectOld!: (error: Error) => void;
  app.setExternalOpen(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
  await app.mount();
  try {
    await app.pressScreen('Open repository on GitHub');
    app.setExternalOpen(async () => {});
    await app.pressScreen('Open repository on GitHub');
    await act(async () => { rejectOld(new Error('Older attempt failed')); });
    assert.equal(app.failureModalVisible, false, 'old failure cannot overwrite the latest successful outcome');
    assert.equal(app.swipe.gesture.config.enabled, true);
    assert.deepEqual(app.events.map(event => event.action), ['github_open']);
  } finally { await app.unmount(); t.mock.timers.reset(); }
});
