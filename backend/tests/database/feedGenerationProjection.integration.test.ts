import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

const enabled = process.env.RUN_FEED_GENERATION_PROJECTION_TEST === '1';

test('generation projection filters inactive repos and reads only current summary identities', {
  skip: !enabled,
}, async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use a loopback disposable database.');
  assert.match(url.pathname, /^\/weave_feed_projection_test(?:_[a-z0-9_]+)?$/, 'Use a dedicated projection test database.');

  const { sqlClient } = await import('../../db/index.js');
  const { PostgresFeedPersistence } = await import('../../adapters/postgresFeedPersistence.js');
  const persistence = new PostgresFeedPersistence();
  const repoIds = Array.from({ length: 3 }, () => crypto.randomUUID());
  const [activeId, noSummaryId, inactiveId] = repoIds;
  const missingId = crypto.randomUUID();
  const oldSummaryId = crypto.randomUUID();
  const currentSummaryId = crypto.randomUUID();
  const nextSummaryId = crypto.randomUUID();
  const statements: string[] = [];
  const previousDebug = sqlClient.options.debug;

  try {
    for (const [index, repoId] of repoIds.entries()) {
      await sqlClient`
        INSERT INTO app.repos (repo_id,github_id,full_name,owner,name,url,status)
        VALUES (${repoId}::uuid,${String(BigInt(`0x${repoId.replaceAll('-', '').slice(0, 13)}`))}::bigint,
          ${`projection/${repoId}`},'projection',${repoId},${`https://github.com/projection/${repoId}`},
          ${index === 2 ? 'archived' : 'active'})
      `;
    }
    for (const [summaryId, repoId, active, version] of [
      [oldSummaryId, activeId, false, 1],
      [currentSummaryId, activeId, true, 2],
      [crypto.randomUUID(), inactiveId, true, 1],
    ] as const) {
      await sqlClient`
        INSERT INTO app.repo_card_summaries (summary_id,repo_id,content_version,model_version,summary,active)
        VALUES (${summaryId}::uuid,${repoId}::uuid,${version},'projection-test','Not hydrated.',${active})
      `;
    }

    sqlClient.options.debug = (_connection, query) => { statements.push(query); };
    assert.deepEqual(await persistence.listActiveRepositoryIdentities([]), []);
    assert.equal(statements.length, 0, 'Empty validation should not issue SQL.');
    const identities = await persistence.listActiveRepositoryIdentities([...repoIds, missingId]);
    assert.deepEqual(new Map(identities.map(row => [row.repo_id, row.summary_id])), new Map([
      [activeId, currentSummaryId], [noSummaryId, null],
    ]));
    assert.ok(identities.every(row => Object.keys(row).sort().join(',') === 'repo_id,summary_id'));

    const statement = statements[0].replace(/\s+/g, ' ').trim();
    assert.match(statement, /^SELECT repo\.repo_id, summary\.summary_id FROM app\.repos repo /);
    assert.match(statement, /summary\.repo_id\s*=\s*repo\.repo_id AND summary\.active/);
    assert.match(statement, /repo\.status\s*=\s*'active'/);
    assert.doesNotMatch(statement, /readme|repo_content|social_profiles|app\.users|follows|repo_topics|repo_stat_snapshots|repo_engagement|reactions|saves/i);
    sqlClient.options.debug = previousDebug;

    await sqlClient`UPDATE app.repo_card_summaries SET active=false WHERE summary_id=${currentSummaryId}::uuid`;
    await sqlClient`
      INSERT INTO app.repo_card_summaries (summary_id,repo_id,content_version,model_version,summary,active)
      VALUES (${nextSummaryId}::uuid,${activeId}::uuid,3,'projection-test','New identity.',true)
    `;
    assert.deepEqual(await persistence.listActiveRepositoryIdentities([activeId]), [
      { repo_id: activeId, summary_id: nextSummaryId },
    ]);
  } finally {
    sqlClient.options.debug = previousDebug;
    try {
      await sqlClient`DELETE FROM app.repo_card_summaries WHERE repo_id=ANY(${repoIds}::uuid[])`;
      await sqlClient`DELETE FROM app.repos WHERE repo_id=ANY(${repoIds}::uuid[])`;
    } finally {
      await sqlClient.end({ timeout: 1 });
    }
  }
});
