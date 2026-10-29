import { createUuid } from '../utils/uuid';
export type FeedSessionState={session_id:string;epoch:string;status:'active'|'retired'};
export type FeedSessionResult={mode:'legacy'}|{mode:'ordered';session:FeedSessionState};
export type FeedSessionControl={kind:'begin';request_id:string;session_id:string}|{kind:'reset'|'end';request_id:string;session_id:string;expected_epoch:string};
export interface FeedIntentDependencies{
 read:()=>Promise<string|null>;write:(value:string)=>Promise<void>;
 inspect:(sessionId:string)=>Promise<FeedSessionResult|null>;
 send:(control:FeedSessionControl)=>Promise<FeedSessionResult>;
 assertCurrent:()=>void;
}
type Entry={sessionId:string;epoch:string;status:'active'|'retired';pending:FeedSessionControl[]};
type Inspection={sessionId:string;result:FeedSessionResult|null};
/** Source controls are persisted before I/O; uncertain results retry the same UUID. */
export class FeedIntentLifecycle{
 private entries:Entry[]=[];private loaded=false;private legacy=false;private flight:Promise<unknown>=Promise.resolve();
 private verified=new Set<string>();
 private persistedValue:string|undefined;
 constructor(private readonly ownerId:string,private readonly deps:FeedIntentDependencies){}
 private serial<T>(operation:()=>Promise<T>):Promise<T>{const next=this.flight.catch(()=>{}).then(operation);this.flight=next;return next;}
 private async load(){
  if(this.loaded)return;const raw=await this.deps.read();this.deps.assertCurrent();
  if(raw){if(raw.length>65536)throw new Error('Saved feed session needs recovery.');const value=JSON.parse(raw) as {schema?:number;ownerId?:string;entries?:Entry[]};
   if(value.schema!==1||value.ownerId!==this.ownerId||!Array.isArray(value.entries)||value.entries.length>16)throw new Error('Saved feed session needs recovery.');
   for(const entry of value.entries){
    if(typeof entry.sessionId!=='string'||!/^[0-9a-f-]{36}$/.test(entry.sessionId)||!(/^[1-9][0-9]*$/).test(entry.epoch)
      ||!['active','retired'].includes(entry.status)||!Array.isArray(entry.pending)||entry.pending.length>16
      ||entry.pending.some(control=>control.session_id!==entry.sessionId||typeof control.request_id!=='string'||!['begin','reset','end'].includes(control.kind)))throw new Error('Saved feed session needs recovery.');
   }this.entries=value.entries;
  }this.loaded=true;
  // Absence is an empty queue; only successful reads/writes establish this baseline.
  this.persistedValue=this.snapshot();
 }
 private snapshot(){return JSON.stringify({schema:1,ownerId:this.ownerId,entries:this.entries});}
 private async persist(){
  this.deps.assertCurrent();const value=this.snapshot();if(value===this.persistedValue)return;
  await this.deps.write(value);this.deps.assertCurrent();this.persistedValue=value;
 }
 private async inspect(sessionId:string){
  const result=await this.deps.inspect(sessionId);this.deps.assertCurrent();
  if(result?.mode==='ordered'&&result.session.session_id!==sessionId)throw new Error('Feed session response does not match.');
  return result;
 }
 private async initialize(sessionId:string):Promise<Inspection|undefined>{
  let inspection:Inspection|undefined;
  if(!this.loaded){
   inspection={sessionId,result:await this.inspect(sessionId)};
   if(inspection.result?.mode==='legacy'){this.legacy=true;return inspection;}
  }
  await this.load();const hadPending=this.entries.some(entry=>entry.pending.length>0);await this.drain();
  // Controls may change the inspected epoch/status. Never reuse a pre-drain result.
  return hadPending?undefined:inspection;
 }
 private async drain(){
  await this.persist();
  for(const entry of this.entries){
   let reconciled=false;
   while(entry.pending.length){
    const control=entry.pending[0];let result:FeedSessionResult;
    try{result=await this.deps.send(control);}
    catch(error){
     const failure=error as {status?:unknown;code?:unknown};
     if(reconciled||control.kind==='begin'||failure.status!==409||failure.code!=='MODEL_SESSION_STALE')throw error;
     // The server rejects this control BEFORE allocating any operation. A lost
     // response does not enter this path and retains its exact durable request.
     const current=await this.deps.inspect(entry.sessionId);this.deps.assertCurrent();
     if(current?.mode!=='ordered'||current.session.session_id!==entry.sessionId)throw error;
     entry.epoch=current.session.epoch;entry.status=current.session.status;
     if(entry.status==='retired')entry.pending=[];
     else{
      let epoch=entry.epoch;
      entry.pending=entry.pending.map(queued=>{
       if(queued.kind==='begin')throw error;
       const replacement={...queued,request_id:createUuid(),expected_epoch:epoch};
       if(queued.kind==='reset')epoch=(BigInt(epoch)+1n).toString();return replacement;
      });
     }
     reconciled=true;await this.persist();continue;
    }
    this.deps.assertCurrent();
    if(result.mode==='legacy'){this.legacy=true;entry.pending=[];break;}
    if(result.session.session_id!==entry.sessionId)throw new Error('Feed session response does not match.');
    entry.epoch=result.session.epoch;entry.status=result.session.status;entry.pending.shift();await this.persist();
   }
  }
  this.entries=this.entries.filter(entry=>entry.status!=='retired'||entry.pending.length>0);await this.persist();
 }
 prepare(requestedSessionId:string):Promise<string>{return this.serial(async()=>{
  this.deps.assertCurrent();if(this.legacy)return requestedSessionId;
  const initial=await this.initialize(requestedSessionId);if(this.legacy)return requestedSessionId;
  const inspect=(id:string)=>initial?.sessionId===id?Promise.resolve(initial.result):this.inspect(id);
  const active=this.entries.find(entry=>entry.sessionId===requestedSessionId&&entry.status==='active')??this.entries.find(entry=>entry.status==='active');
  let sessionId=requestedSessionId,inspection:FeedSessionResult|null|undefined;
  if(active){
   inspection=await inspect(active.sessionId);
   if(inspection?.mode==='legacy'){this.legacy=true;return requestedSessionId;}
   if(inspection?.mode==='ordered'&&inspection.session.status==='active'){
    sessionId=active.sessionId;active.epoch=inspection.session.epoch;await this.persist();
   }else{
    this.entries=this.entries.filter(entry=>entry!==active);await this.persist();
    sessionId=createUuid();inspection=undefined;
   }
  }else{
   inspection=await inspect(requestedSessionId);
   if(inspection?.mode==='ordered'&&inspection.session.status==='retired'){sessionId=createUuid();inspection=undefined;}
  }
  await this.ensureEntry(sessionId,inspection);return sessionId;
 });}
 private async ensureEntry(sessionId:string,inspection?:FeedSessionResult|null):Promise<boolean>{
  if(this.legacy)return false;
  let entry=this.entries.find(entry=>entry.sessionId===sessionId);
  if(inspection!==undefined||!this.verified.has(sessionId)){
   const result=inspection===undefined?await this.inspect(sessionId):inspection;
   if(result?.mode==='legacy'){this.legacy=true;return false;}
   if(result?.mode==='ordered'){
    if(result.session.session_id!==sessionId||result.session.status==='retired')throw new Error('This browsing session ended. Refresh Home to start again.');
    if(!entry){entry={sessionId,epoch:result.session.epoch,status:'active',pending:[]};this.entries.push(entry);}else entry.epoch=result.session.epoch;
    await this.persist();
   }
   this.verified.add(sessionId);
  }
  if(!entry){
   if(this.entries.length>=16)throw new Error('Reconnect to finish earlier browsing sessions.');
   entry={sessionId,epoch:'1',status:'active',pending:[{kind:'begin',request_id:createUuid(),session_id:sessionId}]};
   this.entries.push(entry);await this.persist();await this.drain();
  }
  return !this.legacy;
 }
 ensure(sessionId:string):Promise<boolean>{return this.serial(async()=>{
  this.deps.assertCurrent();if(this.legacy)return false;
  const inspection=await this.initialize(sessionId);return this.ensureEntry(sessionId,inspection?.result);
 });}
 reset(sessionId:string):Promise<boolean>{return this.serial(async()=>{
  if(this.legacy)return false;
  if(!this.loaded){const initial=await this.deps.inspect(sessionId);this.deps.assertCurrent();if(initial?.mode==='legacy'){this.legacy=true;return false;}if(initial?.mode==='ordered'&&initial.session.status==='retired')return false;}
  await this.load();await this.drain();if(this.legacy)return false;
  const entry=this.entries.find(entry=>entry.sessionId===sessionId);if(!entry)return false;
  if(entry.status==='retired')return false;
  entry.pending.push({kind:'reset',request_id:createUuid(),session_id:sessionId,expected_epoch:entry.epoch});
  await this.persist();await this.drain();return true;
 });}
 endAll():Promise<void>{return this.serial(async()=>{
  await this.load();if(this.legacy)return;
  for(const entry of this.entries){
   if(entry.status==='active'&&!entry.pending.some(control=>control.kind==='end')){
    // Resets queued earlier determine the epoch at which End will be accepted.
    const epoch=(BigInt(entry.epoch)+BigInt(entry.pending.filter(control=>control.kind==='reset').length)).toString();
    entry.pending.push({kind:'end',request_id:createUuid(),session_id:entry.sessionId,expected_epoch:epoch});
   }
  }
  await this.persist();await this.drain();
 });}
}

export function parseFeedSessionResult(value:unknown):FeedSessionResult{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid feed session response.');
 const row=value as {mode?:unknown;session?:unknown};
 if(row.mode==='legacy')return {mode:'legacy'};
 if(row.mode!=='ordered'||!row.session||typeof row.session!=='object'||Array.isArray(row.session))throw new Error('Invalid feed session response.');
 const session=row.session as {session_id?:unknown;epoch?:unknown;status?:unknown};
 if(typeof session.session_id!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).test(session.session_id)
  ||typeof session.epoch!=='string'||!(/^[1-9][0-9]{0,18}$/).test(session.epoch)||BigInt(session.epoch)>9223372036854775807n
  ||(session.status!=='active'&&session.status!=='retired'))throw new Error('Invalid feed session response.');
 return {mode:'ordered',session:{session_id:session.session_id,epoch:session.epoch,status:session.status}};
}
