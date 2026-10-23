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


test('fresh different credential can supersede the same target across cleanup status changes', () => {
  const target = '10000000-0000-4000-8000-000000000001';
  const newer = '10000000-0000-4000-8000-000000000003';
  const observed = { operationId: 'stable', status: 'prepared', providerIdentityId: target };
  for (const status of ['prepared', 'done', 'superseded']) {
    const current = { ...observed, status };
    assert.equal(githubIdentityFenceMatches(observed, current, newer), true);
    assert.equal(githubIdentityFenceMatches(observed, current, target), false);
    assert.equal(githubIdentityFenceMatches(observed, current, null), false);
    assert.equal(githubIdentityFenceMatches(observed, { ...current, operationId: 'new-op' }, newer), false);
  }
  assert.equal(githubIdentityFenceMatches({operationId:'legacy',status:'prepared'}, {operationId:'legacy',status:'prepared'}, newer), false);
});
