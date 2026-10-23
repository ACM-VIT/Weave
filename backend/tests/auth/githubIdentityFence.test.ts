import assert from 'node:assert/strict';
import test from 'node:test';
import { githubIdentityFenceMatches } from '../../services/githubIdentityFence.js';
test('provider observations are bound to the exact unlink generation and state', () => {
  const old = { operationId: 'first', status: 'done' };
  assert.equal(githubIdentityFenceMatches(undefined, null), true);
  assert.equal(githubIdentityFenceMatches(null, old), false, 'pre-unlink login cannot relink');
  assert.equal(githubIdentityFenceMatches(undefined, old), false, 'unfenced callers cannot relink');
  assert.equal(githubIdentityFenceMatches(old, old), true, 'fresh post-terminal observation may relink');
  assert.equal(githubIdentityFenceMatches(old, { ...old, status: 'superseded' }), false);
  assert.equal(githubIdentityFenceMatches(old, { ...old, operationId: 'second' }), false);
  assert.equal(githubIdentityFenceMatches({ ...old, status: 'prepared' }, { ...old, status: 'prepared' }), false);
});
