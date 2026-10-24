import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { act } from "react";
import { repository, feed } from "./support/feed-harness";

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

test('share sheet scrolls on short screens and records GitHub opens only after success', async () => {
  const repoId='00000000-0000-4000-8000-000000000001';
  const app=feed([repoId]);app.setHeight(300);
  await app.mount();
  try {
    await app.open(0,'onSharePress');
    assert.equal(app.githubActionScrollable,true);
    app.setExternalOpen(async()=>{throw new Error('Unable to open');});
    await app.press('Open on GitHub');
    assert.deepEqual(app.events,[]);
    let finish!:()=>void;
    app.setExternalOpen(()=>new Promise(resolve=>{finish=resolve;}));
    await app.press('Open on GitHub');
    assert.deepEqual(app.events,[],'Do not acknowledge a pending external open');
    await act(async()=>{finish();await new Promise(resolve=>setTimeout(resolve,0));});
    assert.deepEqual(app.events,[{repo_id:repoId,action:'github_open',serve_id:repoId,position:3}]);
  } finally {await app.unmount();}
});

test('callback-only row renders do not rescan retained feed history after the original is cached', async t => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const original = { eventId: id(5), occurredAt: '2026-10-24T00:00:01.000Z' };
  const app = feed([id(2)], false, { ownerId: id(1), repository: { serveId: id(3), feedPosition: 0, feedSessionId: id(4), originalImpression: original } });
  app.client.setQueryData(['feed', id(1)], { pages: [{ items: Array.from({ length: 10000 }, (_, index) => ({ repo_id: index ? id(index + 10) : id(2),
    serve_id: id(3), feed_session_id: id(4), position: index, ...(index ? {} : { client_original_impression: original }) })) }] });
  const get = app.client.getQueryData.bind(app.client); let reads = 0;
  app.client.getQueryData = ((...args: Parameters<typeof get>) => { reads++; return get(...args); }) as typeof app.client.getQueryData;
  await app.mount();
  try {
    for (let render = 0; render < 10; render++) await app.rerender();
    t.diagnostic(`10 callback changes,10000 retained rows: cache reads=${reads}`);
    assert.equal(reads, 0, 'cached row attribution requires no history reconciliation');
  } finally { await app.unmount(); }
});

test('short, left and diagonal drags leave the List picker closed', async () => {
  const app = feed(['repo'], true, {ownerId: 'viewer', repository: {}, platform: 'web', viewable: true});
  await app.mount();
  try {
    await app.swipeRight(50, 0);
    assert.equal(app.mountedOverlays, 0);
    await app.swipeRight(-100, 0);
    assert.equal(app.saveRevealed, false);
    await app.swipeRight(76, 80);
    assert.equal(app.saveRevealed, false);
    assert.equal(app.mountedOverlays, 0);
    assert.deepEqual(app.requests, []);
  } finally {await app.unmount();}
});
