import assert from 'node:assert/strict';
import test from 'node:test';
import type postgres from 'postgres';

import { setRepositorySaved } from '../../services/savedRepositoryService.js';

type FakeTransaction = postgres.TransactionSql;

function transaction(saveChanged: boolean): {
  queries: string[];
  tx: FakeTransaction;
} {
  const queries: string[] = [];
  const tx = (async (strings: TemplateStringsArray) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();
    queries.push(query);
    if (query.startsWith('INSERT INTO app.saves') || query.startsWith('DELETE FROM app.saves')) {
      return saveChanged ? [{ repo_id: 'repo' }] : [];
    }
    return [];
  }) as unknown as FakeTransaction;
  return { queries, tx };
}

test('new board save updates repository and user counters in the same transition', async () => {
  const { queries, tx } = transaction(true);

  assert.equal(await setRepositorySaved(tx, 'user', 'repo', true), true);
  assert.equal(queries.some((query) => query.startsWith('INSERT INTO app.saves')), true);
  assert.equal(queries.some((query) => query.includes('UPDATE app.repo_engagement')), true);
  assert.equal(queries.some((query) => query.includes('UPDATE app.user_stats')), true);
});

test('duplicate board save is idempotent and does not increment counters', async () => {
  const { queries, tx } = transaction(false);

  assert.equal(await setRepositorySaved(tx, 'user', 'repo', true), false);
  assert.equal(queries.some((query) => query.includes('UPDATE app.repo_engagement')), false);
  assert.equal(queries.some((query) => query.includes('UPDATE app.user_stats')), false);
});
