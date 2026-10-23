import type { FeedRequestV2,FeedResponseV2 } from '../contracts/feed.v2.js';
import type { FeedIntentScope } from '../contracts/feedIntent.js';
import { ModelOperationError } from '../contracts/modelOperations.js';
import type { FeedPersistencePort } from '../ports/feedPersistencePort.js';
import { FeedV2Service } from './feedV2Service.js';
import { FeedIntentScopeService } from './feedIntentScopeService.js';
interface ScopedFeed { scope:FeedIntentScope; service:Pick<FeedV2Service,'getFeed'|'stop'>; active:number }
/** Each bounded slot owns its queue namespace, coalescing, refill and observers. */
export class IntentFeedGateway {
 private readonly slots=new Map<string,ScopedFeed>();
 private stopping=false;
 private readonly inFlight=new Set<Promise<FeedResponseV2>>();
 constructor(private readonly legacy:Pick<FeedV2Service,'getFeed'|'stop'>,private readonly persistence:Pick<FeedPersistencePort,'getServeByRequest'>,
  private readonly scopes:Pick<FeedIntentScopeService,'snapshot'|'resolve'>,private readonly create:(scope:FeedIntentScope)=>Pick<FeedV2Service,'getFeed'|'stop'>){}
 getFeed(userId:string,request:FeedRequestV2,signal?:AbortSignal):Promise<FeedResponseV2>{
  if(this.stopping||this.inFlight.size>=256)return Promise.reject(new ModelOperationError());
  const operation=this.getFeedInternal(userId,request,signal);this.inFlight.add(operation);
  void operation.finally(()=>this.inFlight.delete(operation)).catch(()=>{});return operation;
 }
 private scopeKey(scope:Pick<FeedIntentScope,'userId'|'sessionId'|'feedVersion'|'profileVersion'|'acceptedOperationVersion'|'epoch'|'policySha256'|'witnessSha256'>):string{
  return JSON.stringify([scope.userId,scope.sessionId,scope.feedVersion,scope.profileVersion,scope.acceptedOperationVersion,scope.epoch,scope.policySha256,scope.witnessSha256]);
 }
 private async getFeedInternal(userId:string,request:FeedRequestV2,signal?:AbortSignal):Promise<FeedResponseV2>{
  if(this.stopping)throw new ModelOperationError();
  // Durable authenticated replays retain their original epoch and inputs, including after End.
  if(await this.persistence.getServeByRequest(userId,request.feed_request_id))return this.legacy.getFeed(userId,request,signal);
  const snapshot=await this.scopes.snapshot(userId,request.session_id);
  if(!snapshot)return this.legacy.getFeed(userId,request,signal);
  for(const [key,slot] of this.slots){
   if(slot.active===0 && BigInt(slot.scope.applied.valid_until_ms)<=BigInt(Date.now())){this.slots.delete(key);await slot.service.stop();}
  }
  const key=this.scopeKey(snapshot);
  let slot=this.slots.get(key);
  const scope=await this.scopes.resolve(userId,request.session_id,slot?.scope.context.as_of_ms);
  if(!scope||this.stopping)throw new ModelOperationError();
  // Another request may have installed a slot while authority I/O was pending.
  const resolvedKey=this.scopeKey(scope);
  slot=this.slots.get(resolvedKey);
  if(slot && (slot.scope.applied.head!==scope.applied.head||slot.scope.applied.state_sha256!==scope.applied.state_sha256
    ||BigInt(slot.scope.applied.valid_until_ms)<=BigInt(Date.now())))throw new ModelOperationError('MODEL_SESSION_PENDING',409);
  if(!slot){
   if(this.slots.size>=128)throw new ModelOperationError('MODEL_FEED_CAPACITY',503);
   slot={scope,service:this.create(scope),active:0};this.slots.set(resolvedKey,slot);
  }
  slot.active++;
  try{return await slot.service.getFeed(userId,request,signal);}finally{slot.active--;}
 }
 async stop():Promise<void>{
  this.stopping=true;await Promise.allSettled([...this.inFlight]);await Promise.allSettled([this.legacy.stop(),...[...this.slots.values()].map(slot=>slot.service.stop())]);this.slots.clear();
 }
}
