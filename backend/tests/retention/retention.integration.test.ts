import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {sqlClient} from '../../db/index.js';
import {RetentionWorker} from '../../workers/retentionWorker.js';
import {OutboxService} from '../../services/outboxService.js';

const integration=process.env.RUN_RETENTION_INTEGRATION==='1'?test:test.skip;
integration('retention preserves the last delivered repository index so future refreshes remain claimable',async()=>{
  const target=new URL(process.env.DATABASE_URL!);
  assert.ok(['127.0.0.1','localhost'].includes(target.hostname)&&target.pathname==='/weave_review');
  const aggregate=crypto.randomUUID();const [older,checkpoint,feedback,refresh]=Array.from({length:4},()=>crypto.randomUUID());
  try{
    for(const [id,kind,days] of [[older,'repo_index',50],[checkpoint,'repo_index',40],[feedback,'feedback',40]] as const){
      await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload,status,created_at,delivered_at)
        VALUES(${id}::uuid,${kind},${aggregate}::uuid,${id},'{}','delivered',now()-${days}*interval '1 day',now()-${days}*interval '1 day')`;
    }
    await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload)
      VALUES(${refresh}::uuid,'repo_refresh',${aggregate}::uuid,${refresh},'{}')`;
    // The highest content version must survive an adverse UUID order at one
    // transaction timestamp, even when a later malformed/legacy row exists.
    const numericAggregate=crypto.randomUUID();
    const [highest,lower]=[crypto.randomUUID(),crypto.randomUUID()].sort();
    const malformed=crypto.randomUUID();
    try {
      await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload,status,created_at,delivered_at)
        VALUES
        (${highest}::uuid,'repo_index',${numericAggregate}::uuid,${highest},'{"content_version":10}','delivered',now()-interval '50 days',now()-interval '50 days'),
        (${lower}::uuid,'repo_index',${numericAggregate}::uuid,${lower},'{"content_version":9}','delivered',now()-interval '50 days',now()-interval '50 days'),
        (${malformed}::uuid,'repo_index',${numericAggregate}::uuid,${malformed},'{"content_version":"999999999999999999999999999999"}','delivered',now()-interval '40 days',now()-interval '40 days')`;
      for (let pass=0;pass<2;pass++) {
        await new RetentionWorker().runOnce(30,30);
        const witnesses=await sqlClient`SELECT outbox_id FROM telemetry.ml_outbox WHERE aggregate_id=${numericAggregate}::uuid`;
        assert.deepEqual(new Set(witnesses.map(row=>String(row.outbox_id))),new Set([highest,malformed]));
      }
    } finally { await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${numericAggregate}::uuid`; }
    await new RetentionWorker().runOnce(30,30);
    const remaining=await sqlClient`SELECT outbox_id FROM telemetry.ml_outbox WHERE aggregate_id=${aggregate}::uuid`;
    assert.deepEqual(new Set(remaining.map(row=>String(row.outbox_id))),new Set([checkpoint,refresh]));
    assert.ok((await new OutboxService().claim(10)).some(row=>row.outbox_id===refresh));
    await new RetentionWorker().runOnce(30,30);
    assert.equal((await sqlClient`SELECT count(*)::int AS n FROM telemetry.ml_outbox WHERE outbox_id=${checkpoint}::uuid`)[0].n,1);
  }finally{await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${aggregate}::uuid`;await sqlClient.end({timeout:1});}
});
