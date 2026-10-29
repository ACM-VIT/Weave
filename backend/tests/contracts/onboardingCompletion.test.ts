import assert from 'node:assert/strict';
import test from 'node:test';

Object.assign(process.env, {
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
});

const [{ hasCompletedOnboarding }, { sqlClient }] = await Promise.all([
  import('../../controllers/productV2Controller.js'),
  import('../../db/index.js'),
]);

test.after(async () => {
  await sqlClient.end({ timeout: 0 });
});

test('onboarding completion uses only the explicit durable flag', () => {
  assert.equal(hasCompletedOnboarding(true), true);
  assert.equal(hasCompletedOnboarding(false), false);
});

test('missing completion state fails closed', () => {
  assert.equal(hasCompletedOnboarding(undefined), false);
  assert.equal(hasCompletedOnboarding(null), false);
});

// The SQL boundary records real handler executions and parameter bindings. This
// is statement-count/validation coverage, not a claim of database durability;
// rollback/uniqueness are exercised separately in the opt-in PostgreSQL suite.
const completeProfile = { username: 'chosen', full_name: 'Chosen Name', date_of_birth: '2000-01-01' };

async function completionRequest(body: unknown, atomic = true, storedVersion = '2') {
  const { completeOnboarding, completeOnboardingWithProfile } = await import('../../controllers/productV2Controller.js');
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const profile = { user_id: '00000000-0000-4000-8000-000000000001', username: 'persisted', full_name: 'Persisted Name',
    date_of_birth: '2000-01-01', bio: 'server bio', avatar_url: 'https://fixture.invalid/avatar.png', github_handle: 'fixture', profile_version: storedVersion, onboarding_completed: true };
  let topicId = 0;
  const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim(); queries.push({ sql, values });
    if (sql.startsWith('SELECT') && sql.includes('FROM app.users')) return [profile];
    if (sql.startsWith('UPDATE app.users')) return [profile];
    if (sql.startsWith('INSERT INTO app.topics')) {
      const slugs = values.find(Array.isArray) as unknown[] | undefined;
      return (slugs ?? [0]).map(() => ({ topic_id: String(++topicId) }));
    }
    // Keep the real durable outbox service but model its uninitialized lane at
    // the DB boundary; no queue/network implementation is replaced.
    if (sql.includes('SELECT model_policy_sha256')) return [{ model_policy_sha256: null }];
    return [];
  };
  const original = sqlClient.begin;
  (sqlClient as any).begin = async (work: (transaction: unknown) => Promise<unknown>) => work(tx);
  let status = 0, output: any;
  const response = { status(code: number) { status = code; return this; }, json(value: unknown) { output = value; return this; } };
  try { await (atomic ? completeOnboardingWithProfile : completeOnboarding)({ user: { userId: profile.user_id }, body } as any, response as any); }
  finally { sqlClient.begin = original; }
  return { status, output, queries };
}

test('atomic completion validates nested profile fields before opening the transaction', async () => {
  for (const fields of [{ username: 'not valid!' }, { full_name: 'x'.repeat(101) }, { date_of_birth: '2999-01-01' }, { avatar_url: 'x'.repeat(2049) }]) {
    const result = await completionRequest({ interests: ['react'], profile: { ...completeProfile, ...fields } });
    assert.equal(result.status, 400, 'invalid profile input cannot be ignored during completion');
    assert.equal(result.queries.length, 0);
  }
});

test('100 unique topics use bounded bulk SQL and return authoritative persisted profile fields', async () => {
  const result = await completionRequest({ profile: completeProfile,
    interests: Array.from({ length: 50 }, (_, index) => `interest-${index}`),
    tech_stack: Array.from({ length: 50 }, (_, index) => `technology-${index}`) });
  assert.equal(result.status, 200);
  assert.equal(result.output.data.topics.length, 100);
  const topicQueries = result.queries.filter(query => /^(?:DELETE FROM|INSERT INTO) app\.(?:topics|user_topics)\b/.test(query.sql));
  assert.equal(topicQueries.length, 3, 'delete, bulk topic upsert, bulk association: independent of topic count');
  assert.equal(topicQueries.filter(query => query.values.some(value => Array.isArray(value) && value.length === 100)).length, 2);
  assert.equal(result.output.data.completed, true);
  assert.equal(result.output.data.viewer.user_id, '00000000-0000-4000-8000-000000000001');
  assert.equal(result.output.data.viewer.username, 'persisted', 'return the database row, not the submitted draft');
  assert.equal(result.output.data.viewer.full_name, 'Persisted Name');
  assert.equal(result.output.data.viewer.date_of_birth, '2000-01-01');
  assert.equal(result.output.data.viewer.onboarding_completed, true);
  assert.equal(result.output.data.viewer.avatar_url, 'https://fixture.invalid/avatar.png');
  const profileUpdate = result.queries.find(query => query.sql.startsWith('UPDATE app.users'))!;
  assert.doesNotMatch(profileUpdate.sql, /avatar_url\s*=/, 'onboarding never writes the server-managed avatar');
});

test('duplicate topics are associated once and over-limit input does no SQL', async () => {
  const duplicate = await completionRequest({ profile: completeProfile, interests: ['react', 'react'], skills: ['react'], tech_stack: ['react'] });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.output.data.topics, ['react']);
  assert.equal(duplicate.queries.filter(query => /^(?:DELETE FROM|INSERT INTO) app\.(?:topics|user_topics)\b/.test(query.sql)).length, 3);
  const excessive = await completionRequest({ profile: completeProfile, interests: Array.from({ length: 50 }, (_, n) => `a-${n}`),
    skills: Array.from({ length: 50 }, (_, n) => `b-${n}`), tech_stack: ['one-more'] });
  assert.equal(excessive.status, 400);
  assert.equal(excessive.queries.length, 0);
});

test('avatar URLs are server-managed and generic onboarding cannot replace or clear one', async () => {
  for (const avatar_url of ['https://fixture.invalid/unsafe.svg', null]) {
    for (const atomic of [false, true]) {
      const result = await completionRequest({ profile: completeProfile, interests: ['react'], avatar_url }, atomic);
      assert.equal(result.status, 400);
      assert.equal(result.queries.length, 0);
    }
    const nested = await completionRequest({ interests: ['react'], profile: { ...completeProfile, avatar_url } });
    assert.equal(nested.status, 400);
    assert.equal(nested.queries.length, 0);
  }
});

test('generic PATCH cannot bypass image validation with an arbitrary avatar URL or null',async()=>{
 const {updateMe}=await import('../../controllers/productV2Controller.js');
 for(const avatar_url of ['https://fixture.invalid/unsafe.svg',null]){
  let status=0;
  const response={status(value:number){status=value;return this;},json(){return this;}};
  await updateMe({user:{userId:'00000000-0000-4000-8000-000000000001'},body:{avatar_url}} as any,response as any);
  assert.equal(status,400);
 }
});


test('conditional completion validates a canonical version and rejects stale writes under the row lock', async () => {
  for (const expected_version of [2, null, '', '02', '-1', '1.5', '9223372036854775808']) {
    const result = await completionRequest({ interests: ['react'], profile: { ...completeProfile, expected_version } });
    assert.equal(result.status, 400);
    assert.equal(result.queries.length, 0);
  }
  for (const [expected_version, actual] of [['1', '2'], ['9007199254740992', '9007199254740993']]) {
    const result = await completionRequest({ interests: ['react'], profile: { ...completeProfile, expected_version } }, true, actual);
    assert.equal(result.status, 412, 'stale completion is distinct from a username conflict');
    assert.equal(result.queries.length, 1, 'CAS fails before profile, feed, topic or outbox writes');
    assert.match(result.queries[0].sql, /profile_version/);
    assert.match(result.queries[0].sql, /FOR UPDATE/);
  }
  const accepted = await completionRequest({ interests: ['react'], profile: { ...completeProfile, expected_version: '2' } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.queries.filter(query => query.sql.startsWith('UPDATE app.users')).length, 1);
});

test('two row-serialized same-version handlers produce one transition and one delivery', async () => {
  const { completeOnboardingWithProfile } = await import('../../controllers/productV2Controller.js');
  const profile = { user_id: '00000000-0000-4000-8000-000000000001', username: 'persisted', full_name: 'Persisted Name',
    date_of_birth: '2000-01-01', bio: 'server bio', github_handle: null, avatar_url: null, profile_version: '2', onboarding_completed: false };
  const statements: string[] = [];
  let tail = Promise.resolve();
  const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join('?').replace(/\s+/g, ' ').trim(); statements.push(statement);
    if (statement.startsWith('SELECT') && statement.includes('FROM app.users')) return [{ ...profile }];
    if (statement.startsWith('UPDATE app.users')) {
      profile.profile_version = String(BigInt(profile.profile_version) + 1n); profile.onboarding_completed = true;
      return [{ ...profile }];
    }
    if (statement.startsWith('INSERT INTO app.topics')) return (values.find(Array.isArray) as unknown[]).map((_value, index) => ({ topic_id: String(index + 1) }));
    if (statement.includes('SELECT model_policy_sha256')) return [{ model_policy_sha256: null }];
    return [];
  };
  const original = sqlClient.begin;
  (sqlClient as any).begin = async (work: (transaction: unknown) => Promise<unknown>) => {
    const previous = tail; let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await work(tx); } finally { release(); }
  };
  const call = async () => {
    let status = 0;
    const res = { status(value: number) { status = value; return this; }, json() { return this; } };
    await completeOnboardingWithProfile({ user: { userId: profile.user_id }, body: {
      interests: ['react'], profile: { ...completeProfile, expected_version: '2' },
    } } as any, res as any);
    return status;
  };
  try {
    assert.deepEqual((await Promise.all([call(), call()])).sort(), [200, 412]);
    assert.equal(profile.profile_version, '3');
    assert.equal(statements.filter(query => query.startsWith('UPDATE app.users')).length, 1);
    assert.equal(statements.filter(query => query.startsWith('INSERT INTO app.user_feed_state')).length, 1);
    assert.equal(statements.filter(query => query.startsWith('INSERT INTO telemetry.ml_outbox')).length, 1);
    assert.equal(statements.filter(query => query.includes('FOR UPDATE') && query.includes('FROM app.users')).length, 2);
  } finally { sqlClient.begin = original; }
});
