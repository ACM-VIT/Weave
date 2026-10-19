import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { clearAccountQueryCache, listRepositoryQueryKey } from '../src/services/accountQueryCache';
import { SessionLifecycle } from '../src/api/session-lifecycle';

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
