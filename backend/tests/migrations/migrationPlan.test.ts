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
    '0025_repository_summary_artifacts',
    '0024_explore_search',
  ]);
});

test('normal pending migrations run before retroactive V2 repair timestamps are recorded', async () => {
  const source = await readFile(new URL('../../scripts/migrate.ts', import.meta.url), 'utf8');
  assert.ok(source.indexOf('await applySkippedJournalMigrations()') < source.indexOf('await migrate(drizzle(client)'));
  assert.ok(source.indexOf('await migrate(drizzle(client)') < source.indexOf('await applyRetroactiveV2Migrations()'));
  const journal = JSON.parse(await readFile(new URL('../../../database/migrations/meta/_journal.json', import.meta.url), 'utf8')) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  // The unlink recovery branch can precede the independently published lineage
  // and board-index branches. Preserve their journal IDs instead of renumbering
  // applied history; these are the only temporarily absent reserved slots.
  const reserved = new Map([[41, '0038_repository_lineage'], [42, '0039_social_board_sampling_index']]);
  let expectedIndex = 0;
  for (const [index, entry] of journal.entries.entries()) {
    while (reserved.has(expectedIndex) && !journal.entries.some(item => item.idx === expectedIndex)) expectedIndex++;
    assert.equal(entry.idx, expectedIndex++);
    if (reserved.has(entry.idx)) assert.equal(entry.tag, reserved.get(entry.idx));
    if (index) assert.ok(entry.when > journal.entries[index - 1].when);
  }
  const recovery = journal.entries.find(entry => entry.tag === '0040_github_unlink_credential_target');
  if (recovery) assert.equal(recovery.idx, 43);
  assert.equal(journal.entries.find(entry => entry.tag === '0025_repository_summary_artifacts')?.when, 1786291200000);
  assert.equal(journal.entries.some(entry => entry.tag === '0024_repository_summary_artifacts'), false);
});
