import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('keyset fixture rejects connection options before connecting or selecting tests', () => {
  const database = 'postgresql://fixture@127.0.0.1/weave_keyset';
  const redis = 'redis://127.0.0.1:6379/15';
  for (const [databaseUrl,redisUrl,nodeEnv,allowed] of [
    [database,redis,'test',true],
    [database+'?host=db.invalid',redis,'test',false],
    [database+'#fragment',redis,'test',false],
    [database,redis+'?db=0','test',false],
    [database,redis+'#fragment','test',false],
    [database,redis,'production',false],
    ['https://127.0.0.1/weave_keyset',redis,'test',false],
  ] as const) {
    const env:NodeJS.ProcessEnv={...process.env,RUN_PRODUCT_KEYSET_INTEGRATION:'1',DATABASE_URL:databaseUrl,REDIS_URL:redisUrl,NODE_ENV:nodeEnv};
    delete env.NODE_TEST_CONTEXT;
    const result=spawnSync(process.execPath,['--import','tsx','--test','--test-name-pattern=guard-only',
      fileURLToPath(new URL('./productKeyset.integration.test.ts',import.meta.url))],{env,encoding:'utf8',timeout:10_000});
    assert.equal(result.status,allowed?0:1,`fixture destination: allowed=${allowed}`);
    if(!allowed) assert.match(result.stdout+result.stderr,/plain disposable loopback/i);
  }
});
