import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const enabled = process.env.RUN_SEARCH_TLS_INTEGRATION === '1';

function assertTlsFixture() {
  const target = new URL(process.env.DATABASE_URL!);
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
  assert.equal(target.pathname, '/weave_scroll');
  assert.equal(target.search, '?sslmode=verify-full');
  assert.ok(process.env.NODE_EXTRA_CA_CERTS, 'use a trusted disposable test CA');
}

test('TLS search clients dispose after success and cancellation without delayed socket errors', { skip: !enabled, timeout: 20_000 }, () => {
  assertTlsFixture();
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {setTimeout as delay} from 'node:timers/promises';
    import {performance} from 'node:perf_hooks';
    import {sqlClient,createSearchSqlClient} from './db/index.ts';
    import {searchSql,closeSearchSql} from './db/searchSqlLane.ts';
    import {createSearchWork} from './services/searchWork.ts';
    const client=createSearchSqlClient();
    assert.equal((await client.sql\`SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()\`)[0].ssl,true);
    await client.destroy(); await client.destroy();
    await delay(50);
    const controller=new AbortController();
    let pid;
    let started; const ready=new Promise(resolve=>{started=resolve;});
    const running=searchSql(createSearchWork(controller.signal),async sql=>{
      const [row]=await sql\`SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS budget\`;
      pid=Number(row.pid);assert.equal(row.budget,'1800ms','timeout must precede the first query');
      started(); await sql\`SELECT pg_sleep(10)\`;
    });
    const rejected=assert.rejects(running);
    await Promise.race([ready,running]);
    const visibleBy=performance.now()+1000;
    for (;;) {
      const [row]=await sqlClient\`SELECT state,query FROM pg_stat_activity WHERE pid=\${pid}\`;
      if(row?.state==='active'&&row.query.includes('pg_sleep'))break;
      assert.ok(performance.now()<visibleBy,'must cancel actual executing TLS SQL'); await delay(5);
    }
    const independent=searchSql(createSearchWork(),async sql=>Number((await sql\`SELECT 7 AS result\`)[0].result));
    const cancelledAt=performance.now();
    controller.abort(); await rejected;
    assert.ok(performance.now()-cancelledAt<500,'TLS cancellation must release its real transport promptly');
    assert.equal(await independent,7);
    assert.equal(await searchSql(createSearchWork(),async sql=>Number((await sql\`SELECT 11 AS result\`)[0].result)),11);
    await closeSearchSql(); await sqlClient.end({timeout:1}); await delay(100);
  `], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
});

test('TLS search rejects an untrusted certificate', { skip: !enabled, timeout: 10_000 }, () => {
  assertTlsFixture();
  const childEnv = { ...process.env };
  delete childEnv.NODE_EXTRA_CA_CERTS;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {createSearchSqlClient} from './db/index.ts';
    const client=createSearchSqlClient();
    try {
      await assert.rejects(client.sql\`SELECT 1\`,error=>
        /SELF_SIGNED_CERT|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER_CERT/.test(error.code));
    } finally {await client.destroy();}
  `], { cwd: process.cwd(), env: childEnv, encoding: 'utf8', timeout: 5_000 });
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
});

test('cancelling a pending connection clears its factory deadline', { skip: !enabled, timeout: 10_000 }, () => {
  assertTlsFixture();
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {Socket} from 'node:net';
    import {setTimeout as delay} from 'node:timers/promises';
    import {createSearchSqlClient} from './db/index.ts';
    const baseline=process.getActiveResourcesInfo().filter(name=>name==='Timeout').length;
    const original=Socket.prototype.connect;
    // Delay the actual network establishment, then cancel its real owned socket.
    Socket.prototype.connect=function(...args){
      setTimeout(()=>{if(!this.destroyed)original.apply(this,args);},150);return this;
    };
    const client=createSearchSqlClient();
    const pending=client.sql\`SELECT 1\`.execute();
    const rejected=assert.rejects(pending);
    await delay(20);await client.destroy();await rejected;await delay(200);
    assert.ok(process.getActiveResourcesInfo().filter(name=>name==='Timeout').length<=baseline,
      'a retired connection must not retain its connect deadline');
  `], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 5_000 });
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
});
