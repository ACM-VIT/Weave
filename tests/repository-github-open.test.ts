import assert from 'node:assert/strict';
import test from 'node:test';
import { openRepositoryOnGitHub } from '../src/services/repositoryGithubOpen';

test('successful GitHub opens enqueue exactly one event before flushing', async () => {
  const calls: unknown[] = [];
  assert.equal(await openRepositoryOnGitHub('repo', 'https://github.com/owner/repo', {
    open: async url => { calls.push(url); }, token: async () => 'token',
    outbox: { enqueue: async event => { calls.push(event); }, flush: async token => { calls.push(token); } },
  }), true);
  assert.deepEqual(calls, ['https://github.com/owner/repo', { repo_id: 'repo', action: 'github_open' }, 'token']);
});

test('rejected GitHub opens never record feedback', async () => {
  const unexpected = async () => { assert.fail('No feedback or token access expected'); };
  assert.equal(await openRepositoryOnGitHub('repo', 'url', {
    open: async () => { throw new Error('Rejected'); }, token: unexpected,
    outbox: { enqueue: unexpected, flush: unexpected },
  }), false);
});

test('offline feedback delivery preserves a successful open and the queued event', async () => {
  let queued = false;
  assert.equal(await openRepositoryOnGitHub('repo', 'url', {
    open: async () => {}, token: async () => 'token',
    outbox: { enqueue: async () => { queued = true; }, flush: async () => { throw new Error('Offline'); } },
  }), true);
  assert.equal(queued, true);
});
