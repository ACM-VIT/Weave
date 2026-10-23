import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const enabled = process.env.RUN_SOCIAL_CANDIDATES_INTEGRATION === '1';
test('real SQL social candidates preserve immutable identity, viewer scope, active follows and bounded owners', { skip: !enabled }, async () => {
  const target = new URL(process.env.DATABASE_URL ?? '');
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.equal(target.pathname, '/weave_social_candidates_test');
  assert.equal(target.search, ''); assert.equal(target.hash, '');
  const { sqlClient: sql } = await import('../../db/index.js');
  const { PostgresFeedPersistence } = await import('../../adapters/postgresFeedPersistence.js');
  const users = Array.from({ length: 5 }, () => randomUUID());
  const repos: string[] = []; const profiles: string[] = [];
  const [viewer, stranger, verified, unverified, suspended] = users;
  async function repository(owner: string | null, status = 'active', stats = true) {
    const repo = randomUUID(); repos.push(repo);
    await sql`INSERT INTO app.repos(repo_id,github_id,owner_github_id,full_name,owner,name,url,status)
      VALUES(${repo}::uuid,${String(BigInt('0x'+repo.replaceAll('-','').slice(0,13)))}::bigint,
      ${owner}::bigint,${'same-handle/'+repo},'same-handle',${repo},${'https://github.com/same-handle/'+repo},${status})`;
    if (stats) await sql`INSERT INTO app.repo_stat_snapshots(repo_id,star_count,observed_at) VALUES(${repo}::uuid,10,now())`;
    return repo;
  }
  async function profile(subject: string | null, status = 'active', claimed: string | null = null) {
    const id = randomUUID(); profiles.push(id);
    await sql`INSERT INTO app.social_profiles(profile_id,provider,provider_subject,handle,status,claimed_by_user_id)
      VALUES(${id}::uuid,'github',${subject},${'p'+id.replaceAll('-','').slice(0,20)},${status},${claimed}::uuid)`;
    await sql`INSERT INTO app.social_profile_follows(follower_id,profile_id) VALUES(${viewer}::uuid,${id}::uuid)`;
    return id;
  }
  try {
    for (const [i,user] of users.entries()) {
      await sql`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
      await sql`INSERT INTO app.users(user_id,username,github_id,github_identity_verified_at,status)
        VALUES(${user}::uuid,${'social_'+user.replaceAll('-','')},${String(101+i)},
          ${i === 2 || i === 4 ? new Date().toISOString() : null}::timestamptz,${i === 4 ? 'suspended' : 'active'})`;
    }
    for (const followed of [verified,unverified,suspended]) await sql`INSERT INTO app.follows(follower_id,following_id) VALUES(${viewer}::uuid,${followed}::uuid)`;
    const expectedRegistered: string[] = [await repository('103'),await repository('103'),await repository('103')];
    await repository('104'); await repository('105'); await repository('103','blocked');
    await repository(null); await repository('999'); await repository('103','active',false);
    await profile('201'); const external = await repository('201');
    await profile('202','blocked'); await repository('202');
    await profile('203','active',stranger); await repository('203');
    await profile(null); await profile('999999999999999999999999999999');
    const persistence = new PostgresFeedPersistence();
    const result = await persistence.listSocialRepositoryCandidates(viewer!, 100);
    assert.equal(result.length, 3);
    assert.equal(result.filter(row => expectedRegistered.includes(row.repo_id)).length, 2);
    assert.ok(result.some(row => row.repo_id === external));
    assert.ok(result.every(row => row.source === 'followed_owner' && row.support === 1 && row.source_score > 0));
    assert.ok(result.every(row => Object.keys(row).sort().join(',') === 'owner_github_id,repo_id,source,source_score,support'));
    assert.deepEqual(await persistence.listSocialRepositoryCandidates(stranger!,100), []);
    await sql`UPDATE app.users SET github_handle='renamed',username=${'renamed_'+verified!.replaceAll('-','')} WHERE user_id=${verified!}::uuid`;
    assert.deepEqual(await persistence.listSocialRepositoryCandidates(viewer!,100), result, 'Handle rename cannot change immutable ownership.');
    await sql`DELETE FROM app.follows WHERE follower_id=${viewer!}::uuid AND following_id=${verified!}::uuid`;
    assert.deepEqual((await persistence.listSocialRepositoryCandidates(viewer!,100)).map(row => row.repo_id), [external]);
    await sql`UPDATE app.users SET status='suspended' WHERE user_id=${viewer!}::uuid`;
    assert.deepEqual(await persistence.listSocialRepositoryCandidates(viewer!,100), []);
    await sql`UPDATE app.users SET status='active' WHERE user_id=${viewer!}::uuid`;
    await sql`UPDATE app.social_profiles SET status='blocked' WHERE profile_id=${profiles[0]!}::uuid`;
    assert.deepEqual(await persistence.listSocialRepositoryCandidates(viewer!,100), []);
    await assert.rejects(persistence.listSocialRepositoryCandidates(viewer!,101), /limit/);
  } finally {
    try {
      await sql`DELETE FROM app.repos WHERE repo_id=ANY(${repos}::uuid[])`;
      await sql`DELETE FROM app.social_profiles WHERE profile_id=ANY(${profiles}::uuid[])`;
      await sql`DELETE FROM app.users WHERE user_id=ANY(${users}::uuid[])`;
      await sql`DELETE FROM auth.users WHERE id=ANY(${users}::uuid[])`;
    } finally { await sql.end({ timeout: 1 }); }
  }
});
