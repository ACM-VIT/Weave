import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { assertDisposableDatabase } from './disposableDatabase.js';

const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();

(enabled ? test : test.skip)('real SQL uses global recent retained likes, active identities and actual daily snapshot rank', async () => {
  const [{ sqlClient: sql }, { createRepositoryLabelSource }] = await Promise.all([
    import('../../db/index.js'), import('../../adapters/postgresRepositoryLabels.js'),
  ]);
  const users = Array.from({ length: 31 }, () => randomUUID());
  const repos = Array.from({ length: 12 }, () => randomUUID());
  const snapshot = randomUUID();
  const reference = new Date();
  try {
    for (const user of users) {
      await sql`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
      await sql`INSERT INTO app.users(user_id,username,status) VALUES(${user}::uuid,${'label_'+user.replaceAll('-', '')},'active')`;
    }
    for (const [index, repo] of repos.entries()) {
      await sql`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url)
        VALUES(${repo}::uuid,${String(4_000_000_000 + Math.floor(Math.random() * 1_000_000_000))}::bigint,
          'labels',${repo},${'labels/'+repo},${'https://github.com/labels/'+repo})`;
      await sql`INSERT INTO app.reactions(user_id,repo_id,reaction,updated_at)
        SELECT user_id,${repo}::uuid,'like',${reference.toISOString()}::timestamptz
        FROM unnest(${users.slice(0, 20 + index)}::uuid[]) user_id`;
    }
    await sql`INSERT INTO app.trending_snapshots(snapshot_id,period,source,computed_at,complete,active)
      VALUES(${snapshot}::uuid,'daily','github-trending',${reference.toISOString()}::timestamptz,true,true)`;
    await sql`INSERT INTO app.trending_snapshot_items(snapshot_id,position,repo_id)
      VALUES(${snapshot}::uuid,3,${repos[0]}::uuid)`;
    await sql`INSERT INTO app.repo_stat_snapshots(repo_id,star_count,observed_at)
      VALUES(${repos[0]}::uuid,1200,${reference.toISOString()}::timestamptz)`;
    const source = createRepositoryLabelSource(sql);
    const rows = await source.repositories([repos[0]]);
    assert.equal(rows[0].trending_rank, 3);
    assert.equal(rows[0].star_count, 1200);
    let likes = await source.recentLikes(reference);
    assert.equal(likes.length, 10);
    assert.equal(likes[0].repo_id, repos[11]);
    assert.equal(likes[0].count, 31);
    assert.equal(likes.some(row => row.repo_id === repos[0]), false, 'top ten is global, not page-local');
    // Current-state reversal and staleness both remove users from the count.
    await sql`DELETE FROM app.reactions WHERE repo_id=${repos[11]}::uuid AND user_id=${users[0]}::uuid`;
    await sql`UPDATE app.reactions SET reaction='dislike' WHERE repo_id=${repos[11]}::uuid AND user_id=${users[1]}::uuid`;
    await sql`UPDATE app.reactions SET updated_at=${reference.toISOString()}::timestamptz-interval '169 hours'
      WHERE repo_id=${repos[11]}::uuid AND user_id=${users[2]}::uuid`;
    await sql`UPDATE app.users SET status='deleted' WHERE user_id=${users[3]}::uuid`;
    likes = await source.recentLikes(reference);
    assert.equal(likes.find(row => row.repo_id === repos[11])?.count, 27);
    await sql`UPDATE app.repos SET status='archived' WHERE repo_id=${repos[11]}::uuid`;
    assert.equal((await source.recentLikes(reference)).some(row => row.repo_id === repos[11]), false);
    await sql`UPDATE app.trending_snapshots SET active=false WHERE snapshot_id=${snapshot}::uuid`;
    assert.equal((await source.repositories([repos[0]]))[0].trending_rank, null);
  } finally {
    await sql`DELETE FROM app.trending_snapshots WHERE snapshot_id=${snapshot}::uuid`;
    await sql`DELETE FROM app.repos WHERE repo_id=ANY(${repos}::uuid[])`;
    await sql`DELETE FROM app.users WHERE user_id=ANY(${users}::uuid[])`;
    await sql`DELETE FROM auth.users WHERE id=ANY(${users}::uuid[])`;
    await sql.end({ timeout: 0 });
  }
});
