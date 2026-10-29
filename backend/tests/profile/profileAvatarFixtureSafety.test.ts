import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('photo SQL fixture refuses remote/production/non-disposable destinations before any imports or writes',()=>{
 for(const [databaseUrl,nodeEnv,allowed] of [
  ['postgres://fixture@db.invalid/weave_scroll','test',false],
  ['postgres://fixture@127.0.0.1/product','test',false],
  ['postgres://fixture@127.0.0.1/weave_scroll','production',false],
  ['postgres://fixture@127.0.0.1/weave_scroll','test',true],
 ] as const){
  const env:NodeJS.ProcessEnv={...process.env,RUN_DATABASE_INTEGRATION:'1',DATABASE_URL:databaseUrl,NODE_ENV:nodeEnv};delete env.NODE_TEST_CONTEXT;
  const child=spawnSync(process.execPath,['--import','tsx','--test','--test-name-pattern=guard-only',fileURLToPath(new URL('../database/profileAvatar.integration.test.ts',import.meta.url))],{env,encoding:'utf8',timeout:10000});
  assert.equal(child.status,allowed?0:1,child.stdout+child.stderr);
  if(!allowed)assert.match(child.stdout+child.stderr,/disposable.*weave_scroll/i);
 }
});
