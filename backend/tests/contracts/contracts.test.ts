import assert from 'node:assert/strict';
import test from 'node:test';

import { INTERACTION_EVENT_TYPES } from '../../contracts/interactions.v2.js';
import { FEED_SCHEMA_VERSION } from '../../contracts/feed.v2.js';
import { ML_SCHEMA_VERSION } from '../../contracts/ml.v2.js';

test('v2 contracts freeze schema versions and canonical actions', () => {
  assert.equal(FEED_SCHEMA_VERSION, 2);
  assert.equal(ML_SCHEMA_VERSION, 2);
  assert.deepEqual(INTERACTION_EVENT_TYPES, [
    'impression', 'dwell', 'readme_open', 'github_open', 'like', 'unlike',
    'dislike', 'undislike', 'save', 'unsave', 'share', 'follow', 'unfollow',
  ]);
});
