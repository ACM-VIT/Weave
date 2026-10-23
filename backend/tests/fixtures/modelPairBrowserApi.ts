import {readFile,writeFile} from 'node:fs/promises';
import {assertDisposableDatabase} from '../database/disposableDatabase.js';
assertDisposableDatabase();
const fixture=JSON.parse(await readFile(process.env.MODEL_PAIR_BROWSER_INPUT!,'utf8')) as {
 owners:string[];tokens:string[];writerUrl:string;provider:string;ml:string;secret:string;capability:string;
};
const redisTarget=new URL(process.env.REDIS_TEST_URL!);
if(!['127.0.0.1','localhost'].includes(redisTarget.hostname)||redisTarget.pathname!=='/15'||!fixture.ml.startsWith('http://127.0.0.1:'))throw new Error('Owned model fixture endpoints required.');
Object.assign(process.env,{REDIS_URL:redisTarget.toString(),ML_SERVICE_URL:fixture.ml,INTERNAL_API_SECRET:fixture.secret,ML_GENERATION_TIMEOUT_MS:'30000',
 ML_DELIVERY_TIMEOUT_MS:'30000',FEED_FOREGROUND_WAIT_MS:'30000',FEED_REFILL_INDEX_READY:'true',TRENDING_INGESTION:'false',
 SCORING_CAPTURE_ENABLED:'true',SCORING_CAPTURE_POLICY_ID:'model35-paired',SCORING_CAPTURE_POLICY_VERSION:'fixture-v1',
 SCORING_CAPTURE_RETENTION_DAYS:'1',SCORING_CAPTURE_USER_IDS:fixture.owners.join(','),SCORING_CAPTURE_DATABASE_URL:fixture.writerUrl,
 SCORING_CAPTURE_CAPABILITY:fixture.capability,JWT_SECRET:'model35-owned-fixture-jwt-secret'});
const [{default:app},{getApplicationRuntime},{default:redis},{sqlClient},{OutboxWorker}]=await Promise.all([
 import('../../app.js'),import('../../runtime/applicationRuntime.js'),import('../../config/redis.js'),import('../../db/index.js'),import('../../workers/outboxWorker.js')]);
const runtime=getApplicationRuntime();if(!runtime.ml)throw new Error('Owned model provider required.');
const worker=new OutboxWorker(runtime.outbox,runtime.ml);let pending:Promise<void>|undefined;
const interval=setInterval(()=>{if(pending)return;pending=worker.runOnce(4).then(()=>{}).catch(()=>{}).finally(()=>{pending=undefined;});},100);
const server=app.listen(0,'127.0.0.1',()=>{void(async()=>{
 const address=server.address();if(!address||typeof address==='string')throw new Error('Missing fixture API address.');
 await writeFile(process.env.MODEL_PAIR_BROWSER_OUTPUT!,JSON.stringify({...fixture,api:`http://127.0.0.1:${address.port}/api`}),{mode:0o600});
 console.log('MODEL_BROWSER_API_READY');
})();});
process.once('SIGTERM',()=>void(async()=>{
 clearInterval(interval);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
 await pending;await runtime.supervisor.stop();redis.disconnect();await sqlClient.end({timeout:1});process.exit(0);
})());
