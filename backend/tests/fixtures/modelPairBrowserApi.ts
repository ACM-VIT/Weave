import jwt from 'jsonwebtoken';
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {assertDisposableDatabase} from '../database/disposableDatabase.js';
assertDisposableDatabase();
const fixture=JSON.parse(await readFile(process.env.MODEL_PAIR_BROWSER_INPUT!,'utf8')) as {
 owners:string[];tokens:string[];writerUrl:string;provider:string;ml:string;secret:string;capability:string;
};
fixture.tokens=fixture.owners.map(userId=>jwt.sign({userId,email:'fixture@example.test'},'model35-owned-fixture-jwt-secret',{expiresIn:'30m'}));
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
if(process.env.MODEL_PAIR_CAPTURE_REQUESTS){
 const authorityByContext=new Map<string,Awaited<ReturnType<typeof runtime.ml.modelAuthority>>>();
 const authority=runtime.ml.modelAuthority.bind(runtime.ml),generate=runtime.ml.generate.bind(runtime.ml);
 runtime.ml.modelAuthority=async input=>{const response=await authority(input);authorityByContext.set(JSON.stringify(input.model_context),response);return response;};
 runtime.ml.generate=async(input,work)=>{
  await appendFile(process.env.MODEL_PAIR_CAPTURE_REQUESTS!,JSON.stringify({request:input,authority:authorityByContext.get(JSON.stringify(input.model_context))})+'\n',{mode:0o600});
  return generate(input,work);
 };
}
const worker=new OutboxWorker(runtime.outbox,runtime.ml);let pending:Promise<void>|undefined;
const interval=setInterval(()=>{if(pending)return;pending=(async()=>{for(let i=0;i<4;i++){const [row]=await runtime.outbox.claim(1,undefined,{jobTypes:['model_operation']});if(!row)return;await worker.deliverClaimed(row);}})().catch(()=>{}).finally(()=>{pending=undefined;});},100);
const selectedPort=process.env.MODEL_PAIR_BROWSER_PORT?Number(process.env.MODEL_PAIR_BROWSER_PORT):0;
if(!Number.isInteger(selectedPort)||selectedPort<0||selectedPort>65535)throw new Error('Invalid owned fixture port.');
const server=app.listen(selectedPort,'127.0.0.1',()=>{void(async()=>{
 const address=server.address();if(!address||typeof address==='string')throw new Error('Missing fixture API address.');
 await writeFile(process.env.MODEL_PAIR_BROWSER_OUTPUT!,JSON.stringify({...fixture,api:`http://127.0.0.1:${address.port}/api`}),{mode:0o600});
 console.log('MODEL_BROWSER_API_READY');
})();});
process.once('SIGTERM',()=>void(async()=>{
 clearInterval(interval);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
 await pending;await runtime.supervisor.stop();redis.disconnect();await sqlClient.end({timeout:1});process.exit(0);
})());
