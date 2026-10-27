import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import React from "react";
import { act } from "react";
import { QueryObserver } from "@tanstack/react-query";
import { authSessionLifecycle } from "../src/api/session-lifecycle";
import { listRepositoryQueryKey } from "../src/services/accountQueryCache";
import { subscribeToHomeFeedInvalidations } from "../src/utils/home-feed";
import { repository, feed, waitForReadmeState } from "./support/feed-harness";
import { SAVE_SWIPE_THRESHOLD, shouldOpenSavePicker } from "../src/components/home/save-swipe-gesture";

describe("Membership and save sheet lifecycle", () => {
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
      assert.ok(app.messages.includes('offline'), 'the reopened popup must display the original failure');
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

  test('collection creation failure remains visible after closing and reopening its popup', async () => {
    const app = feed(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
    let reject!: (error: Error) => void;
    app.setCreate(() => new Promise((_yes, no) => { reject = no; }));
    await app.mount();
    try {
      await app.open(0, 'onSavePress'); await app.createCollection('New collection');
      await app.requestClose(); await app.finishClose(); await app.open(0, 'onSavePress');
      await act(async () => { reject(new Error('Collection could not be created')); await new Promise(resolve => setTimeout(resolve, 0)); });
      assert.equal(app.button('Create new List').props.disabled, false);
      assert.ok(app.messages.includes('Collection could not be created'));
      await app.requestClose(); await app.finishClose(); await app.open(1, 'onSavePress');
      assert.ok(!app.messages.includes('Collection could not be created'), 'errors must stay repository-local');
      await app.requestClose(); await app.finishClose(); await app.open(0, 'onSavePress');
      assert.ok(app.messages.includes('Collection could not be created'), 'dismissal must not erase an unacknowledged failure');
    } finally { await app.unmount(); }
  });

  for (const outcome of ['success', 'failure'] as const) {
    test(`retired save ${outcome} cannot restore cleared private cache`, async () => {
      const app=feed([]); let finish!: (value: any)=>void; let fail!: (error: Error)=>void;
      app.setSave(()=>new Promise((yes,no)=>{finish=yes;fail=no;}));
      await app.mountStandaloneSave('00000000-0000-4000-8000-000000000010');
      await app.press('Save repository to selected Lists');
      await app.unmount();
      authSessionLifecycle.retire(authSessionLifecycle.currentGeneration());
      await act(async()=>{
        if(outcome==='success')finish({saved:true,selectedListIds:['collection:list'],saveStateChanged:true});
        else fail(new Error('Retired request'));
        await new Promise(r=>setTimeout(r,10));
      });
      assert.equal(app.client.getQueryCache().getAll().length,0);
    });
  }

  test('unchanged List membership does not refetch its contents or any loaded Home page',async()=>{
    const app=feed([]);
    app.setSave(async()=>({saved:true,selectedListIds:['collection:list'],saveStateChanged:false}));
    let homeReads=0;let listReads=0;
    const home=new QueryObserver(app.client,{queryKey:['feed','viewer'],queryFn:async()=>{homeReads++;return {pages:[{items:[],nextCursor:'keep'}],pageParams:[null]};},staleTime:Infinity});
    const list=new QueryObserver(app.client,{queryKey:listRepositoryQueryKey('collection','viewer','list'),queryFn:async()=>{listReads++;return [];},staleTime:Infinity});
    const stops=[home.subscribe(()=>{}),list.subscribe(()=>{})];
    await home.refetch();await list.refetch();
    const before=[homeReads,listReads];
    try{await app.mountStandaloneSave('00000000-0000-4000-8000-000000000011');await app.press('Save repository to selected Lists');assert.deepEqual([homeReads,listReads],before);}
    finally{for(const stop of stops)stop();await app.unmount();}
  });

  test('final unsave from stale empty selection refreshes known List contents without Home refetch',async()=>{
   const app=feed([]); app.setSave(async()=>({saved:false,selectedListIds:[],saveStateChanged:true}));app.clearSelectedLists();
   let reads=0;
   const observer=new QueryObserver(app.client,{queryKey:listRepositoryQueryKey('collection','viewer','list'),queryFn:async()=>{reads++;return [];},staleTime:Infinity});
   const stop=observer.subscribe(()=>{}); await observer.refetch(); const before=reads;
   try {await app.mountStandaloneSave('00000000-0000-4000-8000-000000000011');await app.press('Save repository to selected Lists');assert.equal(reads,before+1);}
   finally{stop();await app.unmount();}
  });

  test('feed has no swipe-reveal panel and still reserves the loading footer', async()=>{
    const app=feed(['repo'],true,{ownerId:'viewer',repository:{},boundary:React.createElement('View',{style:{height:56}})});
    await app.mount();
    try {assert.equal(app.saveRevealBottom,undefined,'the green panel is removed');assert.equal(app.screenHeight,744);}
    finally {await app.unmount();}
  });

  test('one web right-swipe opens the complete List picker without a reveal or saving', async () => {
    const app = feed(['repo'], true, {ownerId: 'viewer', repository: {}, platform: 'web', viewable: true});
    await app.mount();
    try {
      await app.swipeRight();
      assert.equal(app.swipe.touchAction, 'pan-y', 'browser vertical scrolling stays enabled');
      assert.equal(app.saveRevealed, false, 'there is no intermediate Save panel');
      assert.equal(app.mountedOverlays, 1);
      assert.deepEqual(app.requests, ['save:repo']);
      assert.equal(app.swipe.gesture.config.enabled, false, 'an open picker blocks underlying gestures');
      assert.equal(app.events.filter(event => event.action === 'save').length, 0);
    } finally {await app.unmount();}
  });

  test('a cancelled swipe beyond the threshold does not open or load Lists', async () => {
    const app = feed(['repo'], true, {ownerId: 'viewer', repository: {}, platform: 'web', viewable: true});
    await app.mount();
    try {
      await app.swipeRight(150, 0, false);
      assert.equal(app.mountedOverlays, 0);
      assert.deepEqual(app.requests, []);
      await app.swipeRight(150, 0, true);
      assert.equal(app.mountedOverlays, 1, 'the next completed swipe still works');
      assert.deepEqual(app.requests, ['save:repo']);
    } finally {await app.unmount();}
  });

  test('a failed complete membership load can retry in the save sheet without allowing a partial save', async () => {
    const app = feed(['repo'], true);
    app.setListLoader(async () => {throw new Error('Network request failed');});
    await app.mount();
    try {
      await app.open(0, 'onSavePress');
      await act(async () => {await new Promise(resolve => setTimeout(resolve, 650));});
      assert.equal(app.client.getQueryState(['repository-lists', 'viewer', 'repo'])?.status, 'error');
      assert.equal(app.button('Save repository to selected Lists').props.disabled, true);
      assert.equal(app.button('Create new List').props.disabled, true, 'creating from an unknown membership baseline can erase existing selections');
      assert.ok(app.button('Retry loading Lists'), 'a failed list load needs an in-place retry');
      app.setListLoader(async () => [{id:'list', source:'collection', name:'Recovered list', selected:true, repositoryCount:1}]);
      await app.press('Retry loading Lists');
      await waitForReadmeState(() => app.messages.includes('Recovered list'));
      assert.equal(app.button('Save repository to selected Lists').props.disabled, false);
      assert.deepEqual(app.requests, ['save:repo', 'save:repo', 'save:repo']);
    } finally {await app.unmount();}
  });

  test('removing current memberships never reports Saved to zero Lists when an older save remains', async () => {
    const app = feed([]);
    app.setSave(async () => ({saved:true,selectedListIds:[],saveStateChanged:false}));
    app.clearSelectedLists();
    try {
      await app.mountStandaloneSave('00000000-0000-4000-8000-000000000011');
      await app.press('Save repository to selected Lists');
      assert.ok(app.messages.includes('Removed from Lists.'));
      assert.ok(!app.messages.includes('Saved to 0 Lists.'));
    } finally {await app.unmount();}
  });

  test('failed-load creation attempts cannot erase memberships after retry and legitimate creation', async()=>{
    const app=feed(['00000000-0000-4000-8000-000000000011'],true);let creates=0,saves=0;
    app.setSave(async(_repo, selected)=>{saves++;assert.deepEqual([...selected].sort(),['collection:existing','collection:new']);return{saved:true,selectedListIds:selected,saveStateChanged:false};});
    app.setListLoader(async()=>{throw new Error('offline');});
    app.setCreate(async()=>{creates++;return{id:'new',source:'collection',name:'New List',selected:false,repositoryCount:0};});
    await app.mount();
    try {
      await app.open(0,'onSavePress');
      await act(async()=>{await new Promise(resolve=>setTimeout(resolve,650));});
      await app.press('Create new List');
      assert.equal(app.hasNewListForm,false,'the handler also rejects creation while the baseline is unknown');
      assert.equal(creates,0);
      app.setListLoader(async()=>[{id:'existing',source:'collection',name:'Existing List',selected:true,repositoryCount:1}]);
      await app.press('Retry loading Lists');
      await waitForReadmeState(()=>app.messages.includes('Existing List'));
      await app.createCollection('New List');
      assert.equal(creates,1);
      await app.press('Save repository to selected Lists');
      assert.equal(saves,1);
    }finally{await app.unmount();}
  });
});

describe("Swipe admission", () => {
  test('a short or leftward swipe never opens the List picker', () => {
    assert.equal(shouldOpenSavePicker(SAVE_SWIPE_THRESHOLD - 1, 0), false);
    assert.equal(shouldOpenSavePicker(-SAVE_SWIPE_THRESHOLD, 0), false);
  });

  test('a diagonal drag must be clearly horizontal before it opens the List picker', () => {
    assert.equal(shouldOpenSavePicker(SAVE_SWIPE_THRESHOLD, 51), false);
    assert.equal(shouldOpenSavePicker(SAVE_SWIPE_THRESHOLD, 20), true);
  });

  test('accidental motion never commits a List picker in either vertical direction', () => {
    for (let x = -20; x <= 20; x += 1) {
      for (const y of [-100, -20, -1, 0, 1, 20, 100]) {
        assert.equal(shouldOpenSavePicker(x, y), false);
      }
    }
    assert.equal(shouldOpenSavePicker(SAVE_SWIPE_THRESHOLD, -60), false);
  });
});


test('the windowed save grid retains offscreen memberships while filtering and creating a List', async()=>{
  const app=feed([],true);const submitted:string[][]=[];
  app.setSave(async(_repo, selected)=>{
    submitted.push([...selected]);
    return {saved:true,selectedListIds:selected,saveStateChanged:false};
  });
  const lists=Array.from({length:5000},(_,index)=>({id:String(index),source:index%2?'legacy-board':'collection',
    name:`List ${String(index).padStart(5,'0')}`,selected:index===4999,repositoryCount:index}));
  app.setListLoader(async()=>lists);
  app.setCreate(async()=>({id:'new',source:'collection',name:'New List',selected:false,repositoryCount:0}));
  await app.mountStandaloneSave('00000000-0000-4000-8000-000000000011');
  try {
    await waitForReadmeState(()=>app.messages.includes('List 00000'));
    assert.ok(!app.messages.includes('List 04999'),'the selected tail membership is outside the render window');
    await app.moveListWindow(2500);
    await app.press('List 02500, 2500 repositories');
    await app.moveListWindow(0);
    assert.ok(!app.messages.includes('List 02500'));
    await app.moveListWindow(2500);
    assert.equal(app.button('List 02500, 2500 repositories').props.accessibilityState.checked,true);
    await app.moveListWindow(0);
    await app.searchLists('List 00000');
    await app.press('List 00000, 0 repositories');
    await app.searchLists('no match');
    assert.ok(app.messages.includes('No matching Lists'));
    await app.createCollection('New List');
    await app.press('Save repository to selected Lists');
    assert.deepEqual(submitted.map(ids=>ids.sort()),[['collection:0','collection:2500','legacy-board:4999','collection:new'].sort()]);
  } finally {await app.unmount();}
});
