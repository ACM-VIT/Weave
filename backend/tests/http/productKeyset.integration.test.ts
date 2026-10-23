import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import test from 'node:test';
import jwt from 'jsonwebtoken';

// Validate before importing any clients, even when test-name filtering skips execution.
if (process.env.RUN_PRODUCT_KEYSET_INTEGRATION === '1') {
  const fail = () => { throw new Error('Use plain disposable loopback weave_keyset PostgreSQL and Redis /15 URLs outside production.'); };
  if (process.env.NODE_ENV === 'production') fail();
  for (const [raw, protocols, path] of [
    [process.env.DATABASE_URL, ['postgres:', 'postgresql:'], '/weave_keyset'],
    [process.env.REDIS_URL, ['redis:'], '/15'],
  ] as const) {
    let target: URL;
    try { target = new URL(raw ?? ''); } catch { fail(); continue; }
    if (!protocols.some(protocol => protocol === target.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      || target.pathname !== path || raw!.includes('?') || raw!.includes('#')) fail();
  }
}

const integration = process.env.RUN_PRODUCT_KEYSET_INTEGRATION === '1' ? test : test.skip;

integration('product keysets paginate large tied portfolios beyond the legacy offset ceiling', { timeout: 180_000 }, async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', JWT_SECRET: 'keyset-disposable-fixture-jwt-secret',
    SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_KEY: 'fixture-anon', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service',
    DB_SCHEMA_V2_READS: 'true', DB_SCHEMA_V2_WRITES: 'true', FEED_V2: 'true', FEED_RESERVATIONS: 'true',
    ML_V2_RECOMMENDATIONS: 'false', ML_FEEDBACK_OUTBOX: 'false', ML_QDRANT_ONLY: 'true', TRENDING_FALLBACK: 'true',
    ML_SERVICE_URL: 'http://127.0.0.1:9', INTERNAL_API_SECRET: 'keyset-disposable-internal-secret',
  });
  const [{ sqlClient }, { default: app }, { default: redis }, { getApplicationRuntime }] = await Promise.all([
    import('../../db/index.js'), import('../../app.js'), import('../../config/redis.js'), import('../../runtime/applicationRuntime.js'),
  ]);
  let server: Server | undefined;
  const priorDebug = sqlClient.options.debug;
  const viewer = '00000000-0000-4000-8000-000000000401';
  const count = 10_050;
  const timestamp = '2026-01-01T00:00:00.123456Z';
  const plans: Record<string, unknown>[] = [];
  try {
    await sqlClient`TRUNCATE app.social_profiles,app.users,app.repos,app.trending_snapshots,
      telemetry.ml_outbox,telemetry.generation_attempts CASCADE`;
    await redis.flushdb();
    await sqlClient`INSERT INTO auth.users(id) VALUES (${viewer}::uuid) ON CONFLICT DO NOTHING`;
    await sqlClient`INSERT INTO auth.users(id) SELECT md5('keyset-user-' || n)::uuid FROM generate_series(1,${count}) n ON CONFLICT DO NOTHING`;
    await sqlClient`INSERT INTO app.users(user_id,username,status) VALUES (${viewer}::uuid,'keyset_viewer','active')`;
    await sqlClient`INSERT INTO app.users(user_id,username,status)
      SELECT md5('keyset-user-' || n)::uuid,'keyset_' || n,'active' FROM generate_series(1,${count}) n`;
    await sqlClient`INSERT INTO app.follows(follower_id,following_id,created_at)
      SELECT ${viewer}::uuid,md5('keyset-user-' || n)::uuid,${timestamp}::text::timestamptz FROM generate_series(1,${count}) n`;
    await sqlClient`INSERT INTO app.follows(follower_id,following_id,created_at)
      SELECT md5('keyset-user-' || n)::uuid,${viewer}::uuid,${timestamp}::text::timestamptz FROM generate_series(1,${count}) n`;
    const collision = String((await sqlClient`SELECT following_id FROM app.follows WHERE follower_id=${viewer}::uuid ORDER BY following_id LIMIT 1`)[0]!.following_id);
    await sqlClient`INSERT INTO app.social_profiles(profile_id,provider,handle,profile_kind,status)
      VALUES (${collision}::uuid,'github','keyset-external','organization','active')`;
    await sqlClient`INSERT INTO app.social_profile_follows(follower_id,profile_id,created_at)
      VALUES (${viewer}::uuid,${collision}::uuid,${timestamp}::text::timestamptz)`;
    await sqlClient`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url,status)
      SELECT md5('keyset-repo-' || n)::uuid,10000000+n,'keyset/repo' || n,'keyset','repo' || n,
        'https://github.com/keyset/repo' || n,'active' FROM generate_series(1,${count}) n`;
    await sqlClient`INSERT INTO app.repo_content(repo_id,content_hash,description)
      SELECT repo_id,repo_id::text,'Synthetic keyset fixture' FROM app.repos`;
    await sqlClient`INSERT INTO app.repo_engagement(repo_id) SELECT repo_id FROM app.repos`;
    await sqlClient`INSERT INTO app.saves(user_id,repo_id,created_at)
      SELECT ${viewer}::uuid,repo_id,${timestamp}::text::timestamptz FROM app.repos`;
    await sqlClient`INSERT INTO app.reactions(user_id,repo_id,reaction,updated_at)
      SELECT ${viewer}::uuid,repo_id,'like',${timestamp}::text::timestamptz FROM app.repos`;
    const firstRepo = String((await sqlClient`SELECT repo_id FROM app.repos ORDER BY repo_id LIMIT 1`)[0]!.repo_id);
    await sqlClient`INSERT INTO app.comments(comment_id,repo_id,user_id,body,created_at)
      SELECT md5('keyset-comment-' || n)::uuid,${firstRepo}::uuid,${viewer}::uuid,'Fixture comment ' || n,
        ${timestamp}::text::timestamptz FROM generate_series(1,${count}) n`;
    await sqlClient`ANALYZE app.users`; await sqlClient`ANALYZE app.follows`;
    await sqlClient`ANALYZE app.repos`; await sqlClient`ANALYZE app.saves`;
    await sqlClient`ANALYZE app.reactions`; await sqlClient`ANALYZE app.comments`;
    server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/v2`;
    const headers = { authorization: `Bearer ${jwt.sign({ userId: viewer }, process.env.JWT_SECRET!)}` };
    type Row = Record<string, unknown>;
    type Page = { items: Row[]; has_more: boolean; next_cursor: string | null };
    let captured: { query: string; values: unknown[] } | undefined;
    sqlClient.options.debug = (_connection, query, values) => {
      if (query.includes('__page_timestamp') && !query.startsWith('EXPLAIN')) captured = { query, values: [...values] };
    };
    const read = async (path: string, query: string): Promise<{ page: Page; bytes: number }> => {
      const response = await fetch(`${base}${path}?${query}`, { headers });
      const text = await response.text(); assert.equal(response.status, 200, text);
      const data = (JSON.parse(text) as { data: Page & { repositories?: Row[] } }).data;
      return { page: data.repositories ? { ...data, items: data.repositories } : data, bytes: Buffer.byteLength(text) };
    };
    const userIds = (await sqlClient`SELECT following_id FROM app.follows WHERE follower_id=${viewer}::uuid ORDER BY following_id`).map(r => String(r.following_id));
    const repoIds = (await sqlClient`SELECT repo_id FROM app.repos ORDER BY repo_id`).map(r => String(r.repo_id));
    const commentIds = (await sqlClient`SELECT comment_id FROM app.comments ORDER BY comment_id`).map(r => String(r.comment_id));
    // Existing additive endpoints also need large/deep acceptance, not just
    // the two-row contract fixtures from their original implementation.
    const portfolio = '00000000-0000-4000-8000-000000000405';
    await sqlClient`INSERT INTO app.social_profiles(profile_id,provider,handle,profile_kind,status)
      VALUES (${portfolio}::uuid,'github','keyset','organization','active')`;
    await sqlClient`UPDATE app.repos SET updated_at=${timestamp}::text::timestamptz`;
    await sqlClient`INSERT INTO app.board_collections(collection_id,user_id,name,created_at,updated_at)
      SELECT md5('keyset-collection-' || n)::uuid,${viewer}::uuid,'Fixture collection ' || n,
        ${timestamp}::text::timestamptz,${timestamp}::text::timestamptz FROM generate_series(1,1000) n`;
    await sqlClient`INSERT INTO app.boards(board_id,user_id,name,created_at)
      SELECT md5('keyset-board-' || n)::uuid,${viewer}::uuid,'Fixture board ' || n,
        ${timestamp}::text::timestamptz FROM generate_series(1,1000) n`;
    const collections = (await sqlClient`SELECT collection_id FROM app.board_collections ORDER BY collection_id DESC`).map(row => String(row.collection_id));
    const boards = (await sqlClient`SELECT board_id FROM app.boards ORDER BY board_id DESC`).map(row => String(row.board_id));
    const members = repoIds.slice(0,1000).reverse();
    await sqlClient`INSERT INTO app.collection_repos(collection_id,repo_id,added_by,added_at)
      SELECT ${collections[0]!}::uuid,repo_id,${viewer}::uuid,${timestamp}::text::timestamptz
      FROM (SELECT repo_id FROM app.repos ORDER BY repo_id LIMIT 1000) r`;
    await sqlClient`INSERT INTO app.board_repos(board_id,repo_id,added_by,added_at)
      SELECT ${boards[0]!}::uuid,repo_id,${viewer}::uuid,${timestamp}::text::timestamptz
      FROM (SELECT repo_id FROM app.repos ORDER BY repo_id LIMIT 1000) r`;
    await sqlClient`ANALYZE app.boards`; await sqlClient`ANALYZE app.board_collections`;
    const endpoints: {path:string;expected:string[];id:(row:Row)=>string;legacyComplete?:boolean}[] = [
      { path: `/users/${viewer}/followers`, expected: userIds, id: (r: Row) => String(r.user_id) },
      { path: `/users/${viewer}/following`, expected: [...userIds.map(id => `user:${id}`), `profile:${collision}`], id: (r: Row) => r.user_id ? `user:${r.user_id}` : `profile:${r.profile_id}` },
      { path: `/users/${viewer}/likes-given`, expected: repoIds, id: (r: Row) => String(r.repo_id) },
      { path: '/repositories/saved', expected: repoIds, id: (r: Row) => String(r.repo_id) },
      { path: `/repositories/${firstRepo}/comments`, expected: commentIds, id: (r: Row) => String(r.comment_id) },
      { path: `/profiles/${portfolio}`, expected: [...repoIds].reverse(), id: row => String(row.repo_id), legacyComplete:true },
      { path: '/collections', expected: collections, id: row => String(row.collection_id), legacyComplete:true },
      { path: '/boards', expected: boards, id: row => String(row.board_id), legacyComplete:true },
      { path: `/collections/${collections[0]}/repositories`, expected: members, id: row => String(row.repo_id), legacyComplete:true },
      { path: `/boards/${boards[0]}/repositories`, expected: members, id: row => String(row.repo_id), legacyComplete:true },
    ];
    let followingCursor = '';
    let followingTailCursor = '';
    let savesCursor = '';
    let likesCursor = '';
    let commentsCursor = '';
    for (const endpoint of endpoints) {
      const ids: string[] = []; let cursor: string | null = null; let pageNumber = 0;
      let maxBytes = 0;
      do {
        if (pageNumber === 100 && endpoint.path.endsWith('/following')) followingTailCursor = cursor!;
        const { page, bytes } = await read(endpoint.path, `pagination=keyset&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        maxBytes = Math.max(maxBytes, bytes);
        assert.ok(page.items.length <= 100);
        assert.ok(page.items.every(row => !Object.keys(row).some(key => key.startsWith('__page_'))));
        ids.push(...page.items.map(endpoint.id));
        assert.equal(page.has_more, page.next_cursor !== null);
        if (pageNumber === 0) {
          if (endpoint.path.endsWith('/following')) followingCursor = page.next_cursor!;
          if (endpoint.path.endsWith('/likes-given')) likesCursor = page.next_cursor!;
          if (endpoint.path.endsWith('/saved')) savesCursor = page.next_cursor!;
          if (endpoint.path.endsWith('/comments')) commentsCursor = page.next_cursor!;
        }
        if ([0, Math.floor((endpoint.expected.length - 1) / 200), Math.floor((endpoint.expected.length - 1) / 100)].includes(pageNumber) && captured) {
          const query = captured;
          const explained = await sqlClient.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query.query}`, query.values as Parameters<typeof sqlClient.unsafe>[1]);
          plans.push({ path: endpoint.path, page: pageNumber, response_bytes: bytes, plan: explained[0]!['QUERY PLAN'] });
        }
        cursor = page.next_cursor; pageNumber++;
        assert.ok(pageNumber <= 102, 'pagination must terminate');
      } while (cursor);
      assert.deepEqual(ids, endpoint.expected, endpoint.path);
      assert.equal(new Set(ids).size, ids.length);
      const legacy = await read(endpoint.path, 'limit=100&offset=0');
      assert.deepEqual(legacy.page.items.map(endpoint.id), endpoint.legacyComplete ? endpoint.expected : endpoint.expected.slice(0,100));
      if (endpoint.legacyComplete) {
        assert.equal(Object.hasOwn(legacy.page, 'has_more'), false, 'legacy selection reads remain complete');
        assert.equal(Object.hasOwn(legacy.page, 'next_cursor'), false);
      }
      console.log(JSON.stringify({ path: endpoint.path, records: ids.length, pages: pageNumber, max_page_bytes: maxBytes }));
    }
    for (const path of [`/users/${viewer}/followers`, `/users/${userIds[0]}/following`]) {
      const response = await fetch(`${base}${path}?pagination=keyset&cursor=${encodeURIComponent(followingCursor)}`, { headers });
      assert.equal(response.status, 400, 'cursor endpoint/resource binding');
    }
    await sqlClient`UPDATE app.social_profiles SET status='deleted' WHERE profile_id=${collision}::uuid`;
    const tail = (await read(`/users/${viewer}/following`, `pagination=keyset&limit=100&cursor=${encodeURIComponent(followingTailCursor)}`)).page;
    assert.equal(tail.items.length, 50, 'the external profile from the old 51-item tail is no longer visible');
    assert.ok(tail.items.every(row => row.profile_id !== collision));

    await sqlClient`UPDATE app.comments SET user_id=${userIds[100]!}::uuid WHERE comment_id=${commentIds[100]!}::uuid`;
    await sqlClient`UPDATE app.users SET status='deleted' WHERE user_id=${userIds[100]!}::uuid`;
    const followingVisible = (await read(`/users/${viewer}/following`, `pagination=keyset&limit=100&cursor=${encodeURIComponent(followingCursor)}`)).page;
    assert.deepEqual(followingVisible.items.map(row => String(row.user_id)), userIds.slice(101,201));
    const visibleComments = (await read(`/repositories/${firstRepo}/comments`, `pagination=keyset&limit=100&cursor=${encodeURIComponent(commentsCursor)}`)).page;
    assert.deepEqual(visibleComments.items.map(row => String(row.comment_id)), commentIds.slice(101,201));

    await sqlClient`UPDATE app.repos SET status='deleted' WHERE repo_id=${repoIds[100]!}::uuid`;
    for (const [path, cursor] of [['/repositories/saved', savesCursor], [`/users/${viewer}/likes-given`, likesCursor]]) {
      const page = (await read(path!, `pagination=keyset&limit=100&cursor=${encodeURIComponent(cursor!)}`)).page;
      assert.deepEqual(page.items.map(row => String(row.repo_id)), repoIds.slice(101,201));
    }

    const newer = '00000000-0000-4000-8000-000000000403';
    const older = '00000000-0000-4000-8000-000000000404';
    await sqlClient`INSERT INTO auth.users(id) VALUES (${newer}::uuid),(${older}::uuid) ON CONFLICT DO NOTHING`;
    await sqlClient`INSERT INTO app.users(user_id,username,status)
      VALUES (${newer}::uuid,'keyset_newer','active'),(${older}::uuid,'keyset_older','active')`;
    await sqlClient`INSERT INTO app.follows(follower_id,following_id,created_at)
      VALUES (${viewer}::uuid,${newer}::uuid,'2027-01-01T00:00:00Z'),(${viewer}::uuid,${older}::uuid,'2025-01-01T00:00:00Z')`;
    const afterInsert: string[] = [];
    let next: string | null = followingCursor;
    while (next) {
      const page: Page = (await read(`/users/${viewer}/following`, `pagination=keyset&limit=100&cursor=${encodeURIComponent(next)}`)).page;
      afterInsert.push(...page.items.map(row => String(row.user_id)));
      next = page.next_cursor;
      assert.ok(afterInsert.length <= count + 1, 'concurrent-write traversal must terminate');
    }
    assert.deepEqual(afterInsert, [...userIds.slice(101), older], 'new rows behind the cursor appear; rows ahead require refresh');
    const refreshed = (await read(`/users/${viewer}/following`, 'pagination=keyset&limit=1')).page;
    assert.equal(refreshed.items[0]!.user_id, newer, 'refresh sees a concurrent insert ahead of the cursor');
    console.log('KEYSET_PLANS ' + JSON.stringify(plans));
  } finally {
    sqlClient.options.debug = priorDebug;
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await getApplicationRuntime().supervisor.stop();
    await Promise.allSettled([redis.quit(), sqlClient.end({ timeout: 1 })]);
  }
});
