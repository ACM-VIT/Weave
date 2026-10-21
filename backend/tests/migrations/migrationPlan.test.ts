import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { RETROACTIVE_V2_TAGS } from '../../scripts/migrationPlan.js';

test('retroactive V2 migrations include collection storage before reconciliation indexes', () => {
  assert.deepEqual([...RETROACTIVE_V2_TAGS], [
    '0020_repository_collection_actions',
    '0021_v2_reconciliation_indexes',
    '0022_repo_owner_github_identity',
    '0023_active_social_profile_handles',
    '0024_repository_summary_artifacts',
    '0024_explore_search',
  ]);
});

test('normal pending migrations run before retroactive V2 repair timestamps are recorded', async () => {
  const source = await readFile(new URL('../../scripts/migrate.ts', import.meta.url), 'utf8');
  assert.ok(source.indexOf('await migrate(drizzle(client)') < source.indexOf('await applyRetroactiveV2Migrations()'));
});
