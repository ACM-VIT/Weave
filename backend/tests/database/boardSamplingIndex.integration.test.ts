import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { sqlClient as sql } from '../../db/index.js';
import { PUBLIC_SOCIAL_NEIGHBORHOODS_SQL } from '../../services/socialNeighborhoodProjection.js';
import { PostgresFeedPersistence } from '../../adapters/postgresFeedPersistence.js';

const enabled = process.env.RUN_SOCIAL_BOARD_INDEX_INTEGRATION === '1';
if (enabled) {
  const target = new URL(process.env.DATABASE_URL ?? '');
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.equal(target.pathname, '/weave_social_board_index_test');
  assert.equal(target.search + target.hash, '');
}
test.after(async () => { if (enabled) await sql.end({ timeout: 1 }); });

test('recent board index preserves the real social query while bounding large-board sampling work', {
  skip: !enabled, timeout: 180_000,
}, async t => {
  const [existing] = await sql`SELECT (SELECT count(*) FROM app.repos)+(SELECT count(*) FROM app.users) AS count`;
  assert.equal(Number(existing.count), 0, 'Use a fresh dedicated index fixture; existing data is never cleared.');
  const users: string[] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const boards: string[] = [crypto.randomUUID(), crypto.randomUUID()];
  const viewer = users[0]!;
  const migration = await readFile(new URL('../../../database/migrations/0039_social_board_sampling_index.sql', import.meta.url), 'utf8');
  const query = () => sql.unsafe(PUBLIC_SOCIAL_NEIGHBORHOODS_SQL, [viewer, '[]']);
  const explain = async () => {
    const rows = await sql.unsafe('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + PUBLIC_SOCIAL_NEIGHBORHOODS_SQL, [viewer, '[]']);
    return rows[0]!['QUERY PLAN'][0] as { Plan: Record<string, any>; 'Execution Time': number };
  };
  const scanWork = (root: Record<string, any>): number => {
    const own = root['Relation Name'] === 'board_repos' ? Number(root['Actual Rows']) * Number(root['Actual Loops']) : 0;
    return Math.max(own, ...(root.Plans ?? []).map(scanWork));
  };
  try {
    await sql.begin(async tx => {
      await tx`INSERT INTO auth.users(id) SELECT unnest(${users}::uuid[])`;
      await tx`INSERT INTO app.users(user_id,username,status)
        SELECT id,'board_index_'||replace(id::text,'-',''),'active' FROM unnest(${users}::uuid[]) id`;
      await tx`INSERT INTO app.repos(repo_id,github_id,owner_github_id,full_name,owner,name,url,status)
        SELECT md5('board-index-'||n)::uuid,31000000000+n,41000000000+n,'board-index/repo-'||n,'board-index','repo-'||n,
          'https://github.com/board-index/repo-'||n,'active' FROM generate_series(0,100000) n`;
      await tx`INSERT INTO app.repo_stat_snapshots(repo_id,star_count,observed_at)
        SELECT repo_id,10,now() FROM app.repos WHERE owner='board-index'`;
      await tx`INSERT INTO app.boards(board_id,user_id,name,visibility)
        VALUES(${boards[0]!}::uuid,${users[1]!}::uuid,'First public fixture','public'),
          (${boards[1]!}::uuid,${users[2]!}::uuid,'Second public fixture','public')`;
      await tx`INSERT INTO app.board_repos(board_id,repo_id,added_by,added_at)
        SELECT board.board_id,repo.repo_id,board.user_id,'2026-10-01'::timestamptz+(repo.github_id-31000000000)*interval '1 second'
        FROM app.boards board CROSS JOIN app.repos repo
        WHERE board.board_id=ANY(${boards}::uuid[]) AND repo.owner='board-index'`;
      await tx`INSERT INTO app.reactions(user_id,repo_id,reaction)
        SELECT ${viewer}::uuid,repo_id,'like' FROM app.repos WHERE github_id=31000000000`;
    });
    await sql.unsafe('ANALYZE app.repos; ANALYZE app.boards; ANALYZE app.board_repos; ANALYZE app.reactions; ANALYZE app.repo_stat_snapshots').simple();
    await sql.unsafe('DROP INDEX app.app_board_repos_recent_idx');
    const beforeRows = [...await query()];
    const before = await explain();
    assert.equal(beforeRows.length, 40, 'Two distinct public owners contribute the same bounded twenty repositories.');
    assert.ok(!JSON.stringify(before.Plan).includes('app_board_repos_recent_idx'));
    await sql.unsafe(migration).simple();
    await sql.unsafe(migration).simple(); // The additive migration is safe to replay.
    const afterRows = [...await query()];
    const after = await explain();
    assert.deepEqual(afterRows, beforeRows, 'The index cannot change ordering, visibility, supporter identity or candidates.');
    assert.ok(JSON.stringify(after.Plan).includes('app_board_repos_recent_idx'), 'The actual full query must use its ordered membership index.');
    assert.ok(scanWork(before.Plan) >= 100000, 'The fixture must reproduce a large full membership scan before the index.');
    assert.ok(scanWork(after.Plan) < 1000, 'Ordered sampling must avoid scanning the full board after the index.');
    const projected = await new PostgresFeedPersistence().listSocialRepositoryCandidates(viewer, 100);
    assert.equal(projected.length, 20);
    assert.ok(projected.every(candidate => candidate.source === 'board_topic' && candidate.support === 2));
    t.diagnostic('BOARD_INDEX_EVIDENCE ' + JSON.stringify({ synthetic_only: true, production_latency_claim: false,
      repositories: 100001, board_memberships: 200002, candidates: projected.length,
      before: { elapsed_ms: before['Execution Time'], max_board_scan_rows: scanWork(before.Plan), shared_hits: before.Plan['Shared Hit Blocks'] },
      after: { elapsed_ms: after['Execution Time'], max_board_scan_rows: scanWork(after.Plan), shared_hits: after.Plan['Shared Hit Blocks'] } }));
  } finally {
    await sql.unsafe(migration).simple();
    await sql`DELETE FROM app.boards WHERE board_id=ANY(${boards}::uuid[])`;
    await sql`DELETE FROM app.repos WHERE owner='board-index' AND github_id BETWEEN 31000000000 AND 31000100000`;
    await sql`DELETE FROM app.users WHERE user_id=ANY(${users}::uuid[])`;
    await sql`DELETE FROM auth.users WHERE id=ANY(${users}::uuid[])`;
  }
});
