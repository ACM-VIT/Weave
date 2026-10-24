/** Disposable process-death fixture. Provider packets are codec fixtures;
 * actual trained-provider equality is covered by scoringCaptureCrossRepo. */
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const owner=process.env.CAPTURE_FIXTURE_USER!,repo=process.env.CAPTURE_FIXTURE_REPO!;
const fixture=JSON.parse(await readFile(new URL('./scoring-capture-v1.json',import.meta.url),'utf8'));
const provider=createServer(async(request,response)=>{
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
  const input=JSON.parse(Buffer.concat(chunks).toString());
  const context={...fixture.context,user_id:owner,generation_id:input.generation_id,feed_version:String(input.feed_version)};
  const packet=structuredClone(fixture.packet);packet.snapshot.repo_id=repo;
  const canonical=(value:object)=>JSON.stringify(value,Object.keys(value).sort());
  packet.binding_sha256=crypto.createHash('sha256').update(Buffer.concat([
    Buffer.from('{"context":'+canonical(context)+',"snapshot":'+canonical(packet.snapshot)+'}'),Buffer.from(packet.input_base64,'base64')])).digest('hex');
  response.setHeader('content-type','application/json');response.end(JSON.stringify({schema_version:2,
    generation_id:input.generation_id,user_id:owner,feed_version:input.feed_version,model_version:context.model_version,
    embedding_version:'fixture-repository-v1',embedding_versions:['fixture-repository-v1'],served_ranker:'heavy',
    heavy_ranker_selected:true,ranker_applied:true,fallback_code:null,fallback_reason:null,retrieval_mode:'personalized',
    context_status:{cold_start_applied:false,locale:'not_provided'},scoring_capture:{schema_version:1,status:'captured'},
    scoring_context:context,scoring_metadata_complete:false,
    items:[{repo_id:repo,score:0.3,raw_heavy_score:0.2,source:'semantic',scored_input:packet}]}));
});
await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
const address=provider.address();if(!address || typeof address==='string')throw new Error('No fixture origin');
process.env.ML_SERVICE_URL=`http://127.0.0.1:${address.port}`;
const [{default:app},{getApplicationRuntime},{default:redis},{sqlClient}]=await Promise.all([
  import('../../app.js'),import('../../runtime/applicationRuntime.js'),import('../../config/redis.js'),import('../../db/index.js')]);
const runtime=getApplicationRuntime();
const pause=async(stage:string,identity:object)=>{
  process.send?.({stage,...identity});await new Promise<never>(()=>undefined);
};
if(process.env.CAPTURE_CRASH_STAGE==='sql') {
  const original=runtime.privateScoring!.port.persist.bind(runtime.privateScoring!.port);
  runtime.privateScoring!.port.persist=async(...args)=>{
    const result=await original(...args);await pause('sql',{generation_id:result.generationId});return result;
  };
} else if(process.env.CAPTURE_CRASH_STAGE==='redis') {
  const original=runtime.queue.publishGeneration.bind(runtime.queue);
  runtime.queue.publishGeneration=async(...args)=>{
    const result=await original(...args);await pause('redis',{published:result});return result;
  };
} else if(process.env.CAPTURE_CRASH_STAGE==='serve') {
  const original=runtime.persistence.createServe.bind(runtime.persistence);
  runtime.persistence.createServe=async(...args)=>{
    const result=await original(...args);await pause('serve',{serve_id:result.serve_id,exposure_id:result.items[0].exposure_id});return result;
  };
}
const server=app.listen(0,'127.0.0.1',()=>{
  const bound=server.address();if(bound && typeof bound!=='string')process.send?.({stage:'ready',port:bound.port});
});
process.once('SIGTERM',()=>{
  void(async()=>{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));
    await runtime.supervisor.stop();redis.disconnect();await sqlClient.end({timeout:1});process.exit(0);
  })();
});
