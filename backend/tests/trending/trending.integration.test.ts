import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sqlClient } from '../../db/index.js';
import { trendingSnapshotSource } from '../../controllers/trendingController.js';
import { TRENDING_FRESHNESS_MS, TrendingSnapshotService } from '../../services/trendingSnapshotService.js';
import { assertDisposableDatabase } from '../database/disposableDatabase.js';

const integration = process.env.RUN_TRENDING_INTEGRATION === '1' ? test : test.skip;
test.after(async () => { await sqlClient.end({ timeout: 1 }); });

integration('PostgreSQL Trending preserves ranking, freshness, snapshot activation/replay and period recovery', async t => {
  assertDisposableDatabase();
  // Other complete snapshots would make period assertions ambiguous. This suite
  // is deliberately limited to the existing disposable, loopback scratch DB.
  const existing = await sqlClient`SELECT snapshot_id FROM app.trending_snapshots WHERE active AND complete`;
  assert.equal(existing.length, 0, 'Run Trending fixtures in an otherwise empty disposable database.');
  const repos = Array.from({ length: 3 }, () => randomUUID());
  const snapshots = Array.from({ length: 3 }, () => randomUUID());
  let time = 0;
  let probes = 0;
  let hydrations = 0;
  const service = new TrendingSnapshotService({
    available: async () => { probes++; return trendingSnapshotSource.available(); },
    cards: async id => { hydrations++; return trendingSnapshotSource.cards(id); },
  }, () => time);
  const unpack = (response: { body: string }) => JSON.parse(response.body).data as {
    period: string; available_periods: string[]; captured_at: string | null;
    items: { repo_id: string; position: number; likes_count: number; summary: string | null }[];
  };
  try {
    for (const [index, id] of repos.entries()) {
      const githubId = BigInt(`0x${id.replaceAll('-', '').slice(0, 13)}`).toString();
      await sqlClient`
        INSERT INTO app.repos(repo_id,github_id,owner,full_name,name,url,status)
        VALUES (${id}::uuid,${githubId}::bigint,'trending-test',${`trending-test/${id}`},${id},
          ${`https://github.com/trending-test/${id}`},${index === 2 ? 'archived' : 'active'})
      `;
      await sqlClient`INSERT INTO app.repo_content(repo_id,description,primary_language,content_hash)
        VALUES (${id}::uuid,'Public Trending fixture','TypeScript',${id})`;
      await sqlClient`INSERT INTO app.repo_engagement(repo_id) VALUES (${id}::uuid)`;
    }
    await sqlClient`
      INSERT INTO app.trending_snapshots(snapshot_id,period,source,computed_at,activated_at,complete,active)
      VALUES (${snapshots[0]}::uuid,'daily','trending-test','2026-10-22T00:00:00Z','2026-10-22T00:00:01Z',true,true),
        (${snapshots[1]}::uuid,'weekly','trending-test','2026-10-21T00:00:00Z',NULL,true,false)
    `;
    await sqlClient`
      INSERT INTO app.trending_snapshot_items(snapshot_id,position,repo_id,score,features)
      VALUES (${snapshots[0]}::uuid,7,${repos[0]}::uuid,0.9,'{}'),
        (${snapshots[0]}::uuid,2,${repos[1]}::uuid,0.8,'{}'),
        (${snapshots[0]}::uuid,1,${repos[2]}::uuid,1.0,'{}'),
        (${snapshots[1]}::uuid,3,${repos[0]}::uuid,0.7,'{}')
    `;
    const first = await service.get();
    assert.deepEqual(unpack(first).items.map(row => row.repo_id), [repos[1], repos[0]]);
    assert.deepEqual(unpack(first).items.map(row => row.position), [2, 7]);
    assert.deepEqual(unpack(first).available_periods, ['daily']);
    assert.equal(unpack(first).captured_at, '2026-10-22T00:00:00.000Z');
    const requests = 25;
    for (let n = 1; n < requests; n++) assert.equal(await service.get('weekly'), first);
    assert.equal(probes, requests);
    assert.equal(hydrations, 1);
    t.diagnostic(`${requests} real PostgreSQL reads: ${probes} eligibility queries + ${hydrations} card query; uncached handler would issue ${requests * 2} queries.`);

    await sqlClient`UPDATE app.repo_engagement SET likes_count=4 WHERE repo_id=${repos[0]}::uuid`;
    await sqlClient`UPDATE app.repos SET status='deleted' WHERE repo_id=${repos[1]}::uuid`;
    time = TRENDING_FRESHNESS_MS - 1;
    assert.equal(await service.get(), first, 'partial removal/counter changes obey the documented bounded freshness');
    time++;
    const fresh = await service.get();
    assert.deepEqual(unpack(fresh).items.map(row => row.repo_id), [repos[0]]);
    assert.equal(unpack(fresh).items[0].likes_count, 4);
    assert.notEqual(fresh.etag, first.etag);

    await sqlClient.begin(async tx => {
      await tx`UPDATE app.trending_snapshots SET active=false WHERE snapshot_id=${snapshots[0]}::uuid`;
      await tx`UPDATE app.trending_snapshots SET active=true,activated_at=now() WHERE snapshot_id=${snapshots[1]}::uuid`;
    });
    const weekly = await service.get('daily');
    assert.equal(unpack(weekly).period, 'weekly');
    assert.deepEqual(unpack(weekly).available_periods, ['weekly']);
    assert.equal(unpack(weekly).items[0].position, 3);

    await sqlClient`UPDATE app.trending_snapshots SET active=true,activated_at=now() WHERE snapshot_id=${snapshots[0]}::uuid`;
    const recovered = await service.get('monthly');
    assert.equal(unpack(recovered).period, 'daily');
    assert.deepEqual(unpack(recovered).available_periods, ['daily', 'weekly']);
    assert.notEqual(recovered.etag, fresh.etag, 'available-period metadata invalidates the response');

    await sqlClient.begin(async tx => {
      await tx`UPDATE app.trending_snapshots SET active=false WHERE snapshot_id=${snapshots[0]}::uuid`;
      await tx`INSERT INTO app.trending_snapshots(snapshot_id,period,source,computed_at,activated_at,complete,active)
        VALUES (${snapshots[2]}::uuid,'daily','trending-test','2026-10-23T00:00:00Z',now(),true,true)`;
      await tx`INSERT INTO app.trending_snapshot_items(snapshot_id,position,repo_id,score,features)
        VALUES (${snapshots[2]}::uuid,5,${repos[0]}::uuid,0.95,'{}')`;
    });
    const activated = await service.get();
    assert.equal(unpack(activated).items[0].position, 5);
    assert.equal(unpack(activated).captured_at, '2026-10-23T00:00:00.000Z');
    await sqlClient.begin(async tx => {
      await tx`UPDATE app.trending_snapshot_items SET position=9 WHERE snapshot_id=${snapshots[2]}::uuid`;
      await tx`UPDATE app.trending_snapshots SET activated_at=activated_at+interval '1 microsecond' WHERE snapshot_id=${snapshots[2]}::uuid`;
    });
    assert.equal(unpack(await service.get()).items[0].position, 9, 'same-ID snapshot replay invalidates before TTL expiry');

    await sqlClient`UPDATE app.repos SET status='deleted' WHERE repo_id=${repos[0]}::uuid`;
    assert.deepEqual(unpack(await service.get()), { period: 'daily', available_periods: [], captured_at: null, items: [] });
    await sqlClient`UPDATE app.repos SET status='active' WHERE repo_id=${repos[0]}::uuid`;
    assert.deepEqual(unpack(await service.get()).items.map(row => row.repo_id), [repos[0]], 'empty periods recover without waiting for a negative-cache expiry');
  } finally {
    await sqlClient`DELETE FROM app.trending_snapshots WHERE snapshot_id=ANY(${snapshots}::uuid[])`;
    await sqlClient`DELETE FROM app.repos WHERE repo_id=ANY(${repos}::uuid[])`;
  }
});
