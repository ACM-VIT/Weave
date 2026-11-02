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

test('GitHub reconnection confirms only the current account and retires an old provider flight', async () => {
  const {loadSource}=await import('./support/startup-harness');
  const lifecycle=new SessionLifecycle();
  let token=`header.${Buffer.from(JSON.stringify({userId:'alice'})).toString('base64url')}.signature`;
  let finish!: (value:{type:string;url:string})=>void;
  let waiting=false, proofReads=0;
  const calls:{owner:string;path:string;body:unknown}[]=[];
  const source=loadSource('src/services/githubReconnect.ts',{
    'expo-linking':{createURL:()=> 'https://fixture.invalid/callback?github_reconnect=1',parse:()=>({queryParams:{code:'one-time-code'}})},
    'expo-web-browser':{openAuthSessionAsync:async()=>waiting?new Promise(resolve=>{finish=resolve;}):{type:'success',url:'callback'}},
    '../api/auth':{getOAuthUrl:async()=> 'https://fixture.invalid/authorize',exchangeCode:()=>{throw new Error('Reconnect cannot perform a login exchange');}},
    '../api/owner-request':{apiV2ForOwner:async(owner:string,path:string,options:RequestInit)=>{calls.push({owner,path,body:JSON.parse(String(options.body))});}},
    '../api/session-lifecycle':{authSessionLifecycle:lifecycle,SessionChangedError:(await import('../src/api/session-lifecycle')).SessionChangedError},
    '../utils/storage':{getStorageItem:async()=>token},
    './oauthClientPkce':{createOAuthClientPkce:async()=>({verifier:'v'.repeat(64),challenge:'challenge'})},
    './githubUnlinkProof':{saveGithubReconnectProof:async()=>{},takeGithubReconnectProof:async(owner:string)=>{assert.equal(owner,'alice');if(proofReads++)throw new Error('Proof already consumed');return 'v'.repeat(64);},clearGithubReconnectProof:async()=>{}},
  });
  await source.startGithubReconnect('alice',new AbortController().signal);
  assert.deepEqual(calls,[{owner:'alice',path:'/onboarding/github-reconnect',body:{code:'one-time-code',code_verifier:'v'.repeat(64)}}]);
  await Promise.all([source.finishGithubReconnect('alice','one-time-code',new AbortController().signal),source.finishGithubReconnect('alice','one-time-code',new AbortController().signal)]);
  assert.equal(proofReads,1,'the native callback and browser result share a single completion');
  assert.equal(calls.length,1);
  waiting=true;
  const stale=source.startGithubReconnect('alice',new AbortController().signal);
  await new Promise(resolve=>setImmediate(resolve));
  lifecycle.retire(lifecycle.currentGeneration());
  token=`header.${Buffer.from(JSON.stringify({userId:'bob'})).toString('base64url')}.signature`;
  finish({type:'success',url:'callback'});
  await assert.rejects(stale,{name:'SessionChangedError'});
  assert.equal(calls.length,1,'an old account cannot complete after another account signs in');
});
