import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { accessTokenOwner, selectCurrentSessionToken, tokensHaveSameOwner } from "../src/api/access-token-owner";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { clearAccountQueryCache, listRepositoryQueryKey, listRepositoryQueryOptions } from "../src/services/accountQueryCache";
import { SessionLifecycle } from "../src/api/session-lifecycle";
import { repositoryListsQueryKey } from "../src/models/list";
import { repositoryDetailQueryKey } from "../src/models/repository";
import { feedQueryKey } from "../src/utils/feed-repository";

describe("access token owner", () => {
  function tokenFor(owner: string, marker: string): string {
    const payload = Buffer.from(JSON.stringify({ userId: owner, marker })).toString('base64url');
    return `header.${payload}.signature`;
  }

  test('access token ownership reads the backend userId claim and fails closed', () => {
    assert.equal(accessTokenOwner(tokenFor('user-a', 'one')), 'user-a');
    assert.equal(accessTokenOwner('not-a-jwt'), null);
    assert.equal(accessTokenOwner('header.invalid!.signature'), null);
  });

  test('a rotated token is accepted only for the same authenticated account', () => {
    const oldToken = tokenFor('user-a', 'old');
    const rotatedToken = tokenFor('user-a', 'rotated');
    const otherAccountToken = tokenFor('user-b', 'login');

    assert.equal(tokensHaveSameOwner(oldToken, rotatedToken), true);
    assert.equal(tokensHaveSameOwner(oldToken, otherAccountToken), false);
    assert.equal(selectCurrentSessionToken(oldToken, rotatedToken), rotatedToken);
    assert.equal(selectCurrentSessionToken(oldToken, otherAccountToken), null);
    assert.equal(selectCurrentSessionToken(oldToken, null), null);
    assert.equal(selectCurrentSessionToken('opaque', 'opaque'), 'opaque');
  });
});

describe("account query cache", () => {
  test('private board, collection and pinned queries never share cache entries between viewers', () => {
    const client = new QueryClient();
    for (const kind of ['board', 'collection', 'pinned'] as const) {
      client.setQueryData(listRepositoryQueryKey(kind, 'alice', 'private'), ['private repository']);
      assert.equal(client.getQueryData(listRepositoryQueryKey(kind, 'bob', 'private')), undefined);
      assert.equal(client.getQueryData(listRepositoryQueryKey(kind, undefined, 'private')), undefined);
    }
    clearAccountQueryCache(client);
    assert.equal(client.getQueryCache().getAll().length, 0);
  });

  test('session changes cancel pending private queries and late results cannot repopulate the cache', async () => {
    const client = new QueryClient();
    const lifecycle = new SessionLifecycle();
    const unsubscribe = lifecycle.subscribe(() => clearAccountQueryCache(client));
    let finish!: (value: string[]) => void;
    let signal: AbortSignal | undefined;
    const key = listRepositoryQueryKey('board', 'alice', 'private');
    const pending = client.fetchQuery({ queryKey: key, queryFn: ({ signal: active }) => {
      signal = active;
      return new Promise<string[]>(resolve => { finish = resolve; });
    }}).catch(() => undefined);
    lifecycle.retire(lifecycle.currentGeneration());
    assert.equal(signal?.aborted, true);
    finish(['late private data']);
    await pending;
    assert.equal(client.getQueryData(key), undefined);
    assert.equal(client.getQueryCache().getAll().length, 0);
    unsubscribe();
  });
});

describe("viewer query keys", () => {
  test('viewer-aware repository state cannot collide across account switches', () => {
    const repositoryId = '00000000-0000-4000-8000-000000000001';

    assert.notDeepEqual(
      repositoryDetailQueryKey(repositoryId, 'viewer-a'),
      repositoryDetailQueryKey(repositoryId, 'viewer-b'),
    );
    assert.notDeepEqual(
      repositoryListsQueryKey(repositoryId, 'viewer-a'),
      repositoryListsQueryKey(repositoryId, 'viewer-b'),
    );
    assert.notDeepEqual(feedQueryKey('viewer-a'), feedQueryKey('viewer-b'));

    assert.deepEqual(
      repositoryDetailQueryKey(repositoryId, 'viewer-a'),
      ['repository-detail', 'viewer-a', repositoryId],
    );
    assert.deepEqual(
      repositoryListsQueryKey(repositoryId, 'viewer-a'),
      ['repository-lists', 'viewer-a', repositoryId],
    );
    assert.deepEqual(feedQueryKey('viewer-a'), ['feed', 'viewer-a']);
  });
});


test('List pages retain loaded rows on failure and resume the same cursor without crossing viewers', async () => {
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  const cursors: (string|null)[]=[]; let fail=true;
  const options=listRepositoryQueryOptions('collection','alice','private',async(cursor)=>{
    cursors.push(cursor);
    if(cursor && fail)throw new Error('offline');
    return {items:[cursor?'second':'first'],has_more:!cursor,next_cursor:cursor?null:'next'};
  });
  const observer=new InfiniteQueryObserver(client,options);const unsubscribe=observer.subscribe(()=>{});
  try {
    await observer.refetch(); await observer.fetchNextPage();
    assert.deepEqual(observer.getCurrentResult().data?.pages.flatMap(page=>page.items),['first']);
    fail=false;await observer.fetchNextPage();
    assert.deepEqual(cursors,[null,'next','next']);
    assert.deepEqual(observer.getCurrentResult().data?.pages.flatMap(page=>page.items),['first','second']);
    assert.equal(client.getQueryData(listRepositoryQueryOptions('collection','bob','private',async()=>({items:[],has_more:false,next_cursor:null})).queryKey),undefined);
  }finally{unsubscribe();client.clear();}
});
