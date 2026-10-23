import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sqlClient } from '../../db/index.js';
import { assertDisposableDatabase } from './disposableDatabase.js';

const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;
const migration = readFileSync(new URL('../../../database/migrations/0041_feed_serves_session_lookup.sql', import.meta.url), 'utf8');
test.after(async () => { if (enabled) await sqlClient.end({ timeout: 1 }); });

type Plan = {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: Plan[];
};
function nodes(plan: Plan): Plan[] { return [plan, ...(plan.Plans ?? []).flatMap(nodes)]; }

integration('session lookup migration reapplies and eliminates filtering unrelated viewer sessions', { timeout: 15_000 }, async () => {
  const user = crypto.randomUUID();
  const session = crypto.randomUUID();
  const repo = crypto.randomUUID();
  const unrelatedServes = 12_000;
  await sqlClient.begin(async tx => {
    await tx`SET LOCAL statement_timeout='10000ms'`;
    await tx`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
    await tx`INSERT INTO app.users(user_id,username,status) VALUES(${user}::uuid,${`session_index_${user.replaceAll('-', '')}`},'active')`;
    await tx`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url,status)
      VALUES(${repo}::uuid,${String(BigInt(`0x${repo.replaceAll('-', '').slice(0, 13)}`))}::bigint,
        ${`session-index/${repo}`},'session-index',${repo},${`https://github.com/session-index/${repo}`},'active')`;
    await tx`
      WITH inserted AS (
        INSERT INTO telemetry.feed_serves(serve_id,feed_request_id,user_id,session_id,feed_version,source)
        SELECT gen_random_uuid(),gen_random_uuid(),${user}::uuid,
          CASE WHEN n<=3 THEN ${session}::uuid ELSE gen_random_uuid() END,1,'personalized'
        FROM generate_series(1,${unrelatedServes + 3}) AS fixture(n)
        RETURNING serve_id
      )
      INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source,model_version)
      SELECT serve_id,0,${repo}::uuid,1,'semantic','session-index-test' FROM inserted
    `;
    await tx`ANALYZE telemetry.feed_serves`;
    await tx`ANALYZE telemetry.feed_serve_items`;
    // This suite is restricted to the disposable database. Compare the prior
    // physical design in the same transaction and restore the additive index.
    await tx`DROP INDEX IF EXISTS telemetry.feed_serves_user_session_idx`;
    const explain = async () => {
      const result = await tx`
        EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
        SELECT DISTINCT item.repo_id FROM telemetry.feed_serves serve
        JOIN telemetry.feed_serve_items item ON item.serve_id=serve.serve_id
        WHERE serve.user_id=${user}::uuid AND serve.session_id=${session}::uuid
          AND item.repo_id=ANY(${[repo]}::uuid[])
      `;
      return (result[0]['QUERY PLAN'] as Array<{ Plan: Plan }>)[0].Plan;
    };
    const before = await explain();
    await tx.unsafe(migration).simple();
    const [original] = await tx`SELECT oid,indexdef FROM pg_indexes
      JOIN pg_class ON relname=indexname AND relnamespace='telemetry'::regnamespace
      WHERE schemaname='telemetry' AND indexname='feed_serves_user_session_idx'`;
    await tx.unsafe(migration).simple();
    const [reapplied] = await tx`SELECT oid FROM pg_class
      WHERE relnamespace='telemetry'::regnamespace AND relname='feed_serves_user_session_idx'`;
    assert.equal(reapplied.oid, original.oid, 'reapplication must preserve the existing index');
    assert.match(original.indexdef, /USING btree \(user_id, session_id\)/);
    const after = await explain();
    const lookup = nodes(after).find(plan => plan['Index Name'] === 'feed_serves_user_session_idx');
    assert.ok(lookup, 'the normal planner must choose the session index without forcing planner flags');
    assert.match(lookup['Index Cond'] ?? '', /user_id/);
    assert.match(lookup['Index Cond'] ?? '', /session_id/);
    const filtered = (plan: Plan) => nodes(plan).reduce((sum, node) => sum + (node['Rows Removed by Filter'] ?? 0), 0);
    const buffers = (plan: Plan) => (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0);
    assert.ok(filtered(before) >= unrelatedServes);
    assert.equal(filtered(after), 0, 'unrelated sessions must not become post-scan filters');
    assert.ok(buffers(after) < buffers(before));
    console.log('SESSION_LOOKUP_PLAN ' + JSON.stringify({ fixture_prior_sessions: unrelatedServes,
      before_filtered_rows: filtered(before), after_filtered_rows: filtered(after),
      before_shared_buffers: buffers(before), after_shared_buffers: buffers(after),
      chosen_index: lookup['Index Name'],
    }));
    await tx`DELETE FROM app.users WHERE user_id=${user}::uuid`;
    await tx`DELETE FROM auth.users WHERE id=${user}::uuid`;
    await tx`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;
  });
});
