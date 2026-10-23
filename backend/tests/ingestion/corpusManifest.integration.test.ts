import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { postgresCorpusManifest } from '../../adapters/postgresCorpusManifest.js';
import { assertDisposableDatabase } from '../database/disposableDatabase.js';

const integration = process.env.RUN_DATABASE_INTEGRATION === '1' ? test : test.skip;
integration('PostgreSQL inventory uses UUID keysets, normalized names and conservative content/identity cutoff', async () => {
  assertDisposableDatabase();
  const db = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    // This fixture owns only its disposable database and rolls back all DDL/data.
    await db.begin(async (tx) => {
      await tx`CREATE SCHEMA app`;
      await tx`CREATE TABLE app.repos (repo_id uuid PRIMARY KEY, github_id bigint, full_name text, status text, updated_at timestamptz)`;
      await tx`CREATE TABLE app.repo_content (repo_id uuid PRIMARY KEY, content_hash text, content_version integer, updated_at timestamptz, source_updated_at timestamptz)`;
      for (let i = 1; i <= 5; i++) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        await tx`INSERT INTO app.repos VALUES (${id},${String(9007199254740990n+BigInt(i))},${`Owner/Repo${i}`},${i===5?'blocked':'active'},${i===4?'2026-01-03':'2026-01-01'}::timestamptz)`;
        await tx`INSERT INTO app.repo_content VALUES (${id},'hash',2,${i===3?'2026-01-03':'2026-01-01'}::timestamptz,null)`;
      }
      // Adapter expects a transaction boundary; expose this existing transaction
      // as the boundary so the fixture can roll back its entire scratch schema.
      const reader = postgresCorpusManifest(Object.assign((...args: any[]) => (tx as any)(...args), {
        begin: (fn: (sql: any) => Promise<unknown>) => fn(tx),
      }) as any);
      const first = await reader(null, '2026-01-02T00:00:00Z', 1);
      assert.equal(first.length, 1);
      assert.equal(first[0].full_name, 'owner/repo1');
      assert.equal(first[0].github_id, '9007199254740991');
      const rest = await reader(first[0].repo_id, '2026-01-02T00:00:00Z', 251);
      assert.equal(rest.length, 1); assert.equal(rest[0].full_name, 'owner/repo2');
      assert.equal(rest[0].content_version, 2);
      assert.equal(rest[0].content_updated_at, '2026-01-01T00:00:00.000Z');
      throw new Error('rollback-fixture');
    }).catch((error) => { if (error.message !== 'rollback-fixture') throw error; });
  } finally { await db.end(); }
});
