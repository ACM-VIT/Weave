import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { feedServes } from '../../db/v2Schema.js';

test('session delivery index is modeled, audited and scheduled after existing migrations', () => {
  const index = getTableConfig(feedServes).indexes.find(candidate => candidate.config.name === 'feed_serves_user_session_idx');
  assert.ok(index);
  assert.equal(index.config.unique, false, 'sessions can contain multiple serves');
  assert.deepEqual(index.config.columns.map(column => 'name' in column ? column.name : null), ['user_id', 'session_id']);
  const audit = JSON.parse(readFileSync(new URL('../../../database/audits/expected-v2-schema.json', import.meta.url), 'utf8'));
  assert.ok(audit.indexes.includes(index.config.name));
  const journal = JSON.parse(readFileSync(new URL('../../../database/migrations/meta/_journal.json', import.meta.url), 'utf8'));
  const entry = journal.entries.at(-1);
  assert.equal(entry.tag, '0041_feed_serves_session_lookup');
  assert.equal(entry.idx, journal.entries.at(-2).idx + 1);
  assert.ok(entry.when > journal.entries.at(-2).when);
  assert.match(readFileSync(new URL(`../../../database/migrations/${entry.tag}.sql`, import.meta.url), 'utf8'),
    /CREATE INDEX IF NOT EXISTS feed_serves_user_session_idx\s+ON telemetry\.feed_serves\s*\(user_id,\s*session_id\)/);
});
