import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { repoCardSummaries } from '../../db/v2Schema.js';

test('Drizzle models immutable summary successors and both uniqueness guards', () => {
  const config = getTableConfig(repoCardSummaries);
  assert.equal(repoCardSummaries.artifactRevision.notNull, true);
  assert.equal(repoCardSummaries.artifactRevision.default, 0);
  assert.equal(repoCardSummaries.supersedesSummaryId.notNull, false);
  const key = config.indexes.find(index => index.config.name === 'repo_card_summaries_revisioned_uidx');
  assert.equal(key?.config.unique, true);
  assert.deepEqual(key?.config.columns.map(column => 'name' in column ? column.name : null),
    ['repo_id','content_version','prompt_version','model_version','format_version','artifact_revision']);
  assert.ok(!config.indexes.some(index => index.config.name === 'repo_card_summaries_versioned_uidx'));
  const active = config.indexes.find(index => index.config.name === 'repo_card_summaries_one_active_uidx');
  assert.equal(active?.config.unique, true);
  assert.ok(active?.config.where);
  const predecessor = config.foreignKeys.map(key => key.reference()).find(ref => ref.columns[0].name === 'supersedes_summary_id');
  assert.equal(predecessor?.foreignTable, repoCardSummaries);
  assert.deepEqual(predecessor?.foreignColumns.map(column => column.name), ['summary_id']);
  assert.ok(config.checks.some(check => check.name === 'repo_card_summaries_revision_check'));
});
