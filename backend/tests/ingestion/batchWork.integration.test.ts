import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import type { RepositoryUpsert } from '../../contracts/ingestion.v2.js';
import { assertDisposableDatabase } from '../database/disposableDatabase.js';

test('same-owner ingestion bounds SQL work by batches rather than repeated identity reconciliation', {
  skip: process.env.RUN_DATABASE_INTEGRATION !== '1', timeout: 30_000,
}, async t => {
  assertDisposableDatabase();
  const [{ default: postgres }, { PostgresRepositoryPersistence }] = await Promise.all([
    import('postgres'), import('../../adapters/postgresRepositoryPersistence.js'),
  ]);
  let recording = false;
  let statements = 0;
  const db = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, fetch_types: false,
    debug: () => { if (recording) statements++; } });
  const persistence = new PostgresRepositoryPersistence(db);
  const suffix = crypto.randomUUID().slice(0, 8);
  const base = BigInt(`0x${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`) + 800_000_000_000_000n;
  const ownerId = String(base);
  const owner = `batch-work-${suffix}`;
  const githubIds: string[] = [];
  const topics = [`${suffix}-batch-work`];
  t.after(async () => {
    try {
      if (githubIds.length) {
        await db`DELETE FROM telemetry.ml_outbox WHERE aggregate_id IN
          (SELECT repo_id FROM app.repos WHERE github_id IN (SELECT jsonb_array_elements_text(${db.json(githubIds)}::jsonb)::bigint))`;
        await db`DELETE FROM app.repos WHERE github_id IN (SELECT jsonb_array_elements_text(${db.json(githubIds)}::jsonb)::bigint)`;
      }
      await db`DELETE FROM app.topics topic WHERE topic.slug::text IN (SELECT jsonb_array_elements_text(${db.json(topics)}::jsonb))
        AND NOT EXISTS(SELECT 1 FROM app.repo_topics membership WHERE membership.topic_id=topic.topic_id)`;
      await db`DELETE FROM app.social_profiles WHERE provider='github' AND provider_subject=${ownerId}
        AND claimed_by_user_id IS NULL`;
    } finally { await db.end({ timeout: 1 }); }
  });
  // Equalize owner/connection setup across all samples; only the batch grows.
  await db`INSERT INTO app.social_profiles(provider,provider_subject,handle,profile_kind)
    VALUES('github',${ownerId},${owner},'unknown')`;
  const measured: { repositories: number; statements: number; transactionMs: number; clusterWalBytes: number }[] = [];
  let next = 1n;
  for (const size of [1, 25, 100]) {
    const input: RepositoryUpsert[] = Array.from({ length: size }, () => {
      const id = String(base + next++); githubIds.push(id);
      const name = `repository-${id}`;
      return { github_id: id, owner_github_id: ownerId, owner, name, full_name: `${owner}/${name}`,
        url: `https://github.com/${owner}/${name}`, description: 'Batch work measurement fixture.',
        topics, star_count: 1, observed_at: '2026-10-21T00:00:00Z' };
    });
    const walStart = String((await db`SELECT pg_current_wal_insert_lsn() AS lsn`)[0].lsn);
    statements = 0; recording = true;
    const started = performance.now();
    const rows = await persistence.bulkUpsert(input);
    const transactionMs = performance.now() - started;
    recording = false;
    assert.equal(rows.length, size);
    assert.ok(rows.every(row => row.changed && row.content_version === 1));
    const clusterWalBytes = Number((await db`SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),${walStart}::pg_lsn) AS bytes`)[0].bytes);
    measured.push({ repositories: size, statements, transactionMs, clusterWalBytes });
  }
  t.diagnostic(JSON.stringify({ fixture: 'one owner, one topic, new repositories', measured,
    walScope: 'cluster-wide insertion delta during each local transaction; not an exclusive attribution or production claim' }));
  assert.ok(measured[1].statements <= measured[0].statements + 5,
    `one staged batch must not repeat owner SQL per repository: ${JSON.stringify(measured)}`);
  assert.ok(measured[2].statements <= measured[1].statements * 4,
    'four 25-repository stages must remain bounded by their batch count');
});

test('adjacent owner observations preserve renames and retry an empty reconciliation result', {
  skip: process.env.RUN_DATABASE_INTEGRATION !== '1', timeout: 30_000,
}, async t => {
  assertDisposableDatabase();
  const [{ default: postgres }, { PostgresRepositoryPersistence }] = await Promise.all([
    import('postgres'), import('../../adapters/postgresRepositoryPersistence.js'),
  ]);
  const db = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, fetch_types: false });
  const persistence = new PostgresRepositoryPersistence(db);
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const base = BigInt(`0x${suffix.slice(0, 12)}`) + 900_000_000_000_000n;
  const ownerIds = [String(base), String(base + 1n)];
  const githubIds = [String(base + 2n), String(base + 3n)];
  // Identifiers contain only a fixed prefix and generated hex, never caller text.
  const trigger = `ingestion_retry_${suffix}`;
  const counter = `attempts_${suffix}`;
  t.after(async () => {
    try {
      await db.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON app.social_profiles`);
      await db`DELETE FROM telemetry.ml_outbox WHERE aggregate_id IN
        (SELECT repo_id FROM app.repos WHERE github_id IN
          (SELECT jsonb_array_elements_text(${db.json(githubIds)}::jsonb)::bigint))`;
      await db`DELETE FROM app.repos WHERE github_id IN
        (SELECT jsonb_array_elements_text(${db.json(githubIds)}::jsonb)::bigint)`;
      await db`DELETE FROM app.social_profiles WHERE provider='github'
        AND provider_subject IN (SELECT jsonb_array_elements_text(${db.json(ownerIds)}::jsonb))
        AND claimed_by_user_id IS NULL`;
    } finally { await db.end({ timeout: 1 }); }
  });
  function repository(index: number, owner: string): RepositoryUpsert {
    const name = `repository-${githubIds[index]}`;
    return { github_id: githubIds[index], owner_github_id: ownerIds[index], owner, name,
      full_name: `${owner}/${name}`, url: `https://github.com/${owner}/${name}`,
      observed_at: '2026-10-21T00:00:00Z' };
  }
  await t.test('equal numeric owner IDs with adjacent different handles reconcile both observations', async () => {
    const original = repository(0, `before-${suffix.slice(0, 8)}`);
    const renamed = repository(0, `after-${suffix.slice(0, 8)}`);
    assert.equal((await persistence.bulkUpsert([original, renamed])).length, 2);
    const [profile] = await db`SELECT handle FROM app.social_profiles
      WHERE provider='github' AND provider_subject=${ownerIds[0]} AND status='active'`;
    assert.equal(profile.handle, renamed.owner);
    const [repo] = await db`SELECT owner FROM app.repos WHERE github_id=${githubIds[0]}::bigint`;
    assert.equal(repo.owner, renamed.owner);
  });
  await t.test('a null insert is retried by the next identical observation', async () => {
    // A scoped BEFORE INSERT failpoint deterministically produces the same empty
    // RETURNING result as a racing ON CONFLICT DO NOTHING. It does not model
    // concurrent claim scheduling; it verifies the adapter retries real SQL.
    await db.unsafe(`CREATE TEMP SEQUENCE ${counter}`);
    await db.unsafe(`CREATE FUNCTION pg_temp.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('pg_temp.${counter}')=1 THEN RETURN NULL; END IF;
        RETURN NEW;
      END $$`);
    await db.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON app.social_profiles
      FOR EACH ROW WHEN (NEW.provider='github' AND NEW.provider_subject='${ownerIds[1]}')
      EXECUTE FUNCTION pg_temp.${trigger}()`);
    const input = repository(1, `retry-${suffix.slice(0, 8)}`);
    assert.equal((await persistence.bulkUpsert([input, input])).length, 2);
    const [attempts] = await db.unsafe(`SELECT last_value FROM pg_temp.${counter}`);
    assert.equal(Number(attempts.last_value), 2, 'failed reconciliation must not be cached as complete');
    const [profile] = await db`SELECT handle FROM app.social_profiles
      WHERE provider='github' AND provider_subject=${ownerIds[1]} AND status='active'`;
    assert.equal(profile?.handle, input.owner);
  });
});
