import assert from 'node:assert/strict';
import test from 'node:test';

import { RETROACTIVE_V2_TAGS } from '../../scripts/migrationPlan.js';

test('retroactive V2 migrations include collection storage before reconciliation indexes', () => {
  assert.deepEqual([...RETROACTIVE_V2_TAGS], [
    '0020_repository_collection_actions',
    '0021_v2_reconciliation_indexes',
  ]);
});
