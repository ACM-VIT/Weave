import assert from 'node:assert/strict';
import test from 'node:test';
import { feedRecentExposureDays } from '../../config/feedExposure.js';
import { loadRecentExposureEligibleIds } from '../../services/feedExposureEligibility.js';

test('recent exposure defaults to the selected seven days and rejects invalid policies', () => {
  assert.equal(feedRecentExposureDays(''), 7);
  assert.equal(feedRecentExposureDays('7'), 7);
  assert.equal(feedRecentExposureDays('1'), 1);
  for (const raw of ['0', '366', '-1', '1.5', 'NaN', '7 days', 'Infinity']) {
    assert.throws(() => feedRecentExposureDays(raw), /integer from 1 to 365/);
  }
});

test('exposure checks bound candidate identities and reject unexpected persistence results', async () => {
  const user = '00000000-0000-4000-8000-000000000001';
  const repo = '00000000-0000-4000-8000-000000000002';
  let calls = 0;
  const reader = { query: async () => { calls++; return []; } };
  assert.deepEqual(await loadRecentExposureEligibleIds(reader, user, [], 7), []);
  assert.equal(calls, 0);
  await assert.rejects(loadRecentExposureEligibleIds(reader, user, Array(151).fill(repo), 7), /at most 150/);
  await assert.rejects(loadRecentExposureEligibleIds(reader, 'not-a-viewer', [repo], 7), /canonical viewer/);
  await assert.rejects(loadRecentExposureEligibleIds(reader, user, [repo], 0), /Invalid recent/);
  await assert.rejects(loadRecentExposureEligibleIds({ query: async () => [{ repo_id: user }] }, user, [repo], 7), /unexpected/);
});
