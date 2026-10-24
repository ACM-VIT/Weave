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
/** Source controls are persisted before I/O; uncertain results retry the same UUID. */
export class FeedIntentLifecycle{
 private entries:Entry[]=[];private loaded=false;private legacy=false;private flight:Promise<unknown>=Promise.resolve();
 private verified=new Set<string>();
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
 }
 private async persist(){this.deps.assertCurrent();await this.deps.write(JSON.stringify({schema:1,ownerId:this.ownerId,entries:this.entries}));this.deps.assertCurrent();}
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
 async prepare(requestedSessionId:string):Promise<string>{
  const sessionId=await this.serial(async()=>{
   if(this.legacy)return requestedSessionId;
   if(!this.loaded){const result=await this.deps.inspect(requestedSessionId);this.deps.assertCurrent();if(result?.mode==='legacy'){this.legacy=true;return requestedSessionId;}}
   await this.load();await this.drain();
   const active=this.entries.find(entry=>entry.sessionId===requestedSessionId&&entry.status==='active')??this.entries.find(entry=>entry.status==='active');
   if(active){
    const current=await this.deps.inspect(active.sessionId);this.deps.assertCurrent();
    if(current?.mode==='legacy'){this.legacy=true;return requestedSessionId;}
    if(current?.mode==='ordered'&&current.session.status==='active'){
     active.epoch=current.session.epoch;await this.persist();return active.sessionId;
    }
    active.status='retired';this.entries=this.entries.filter(entry=>entry!==active);await this.persist();return createUuid();
   }
   const remote=await this.deps.inspect(requestedSessionId);this.deps.assertCurrent();
   return remote?.mode==='ordered'&&remote.session.status==='retired'?createUuid():requestedSessionId;
  });
  await this.ensure(sessionId);return sessionId;
 }
 ensure(sessionId:string):Promise<boolean>{return this.serial(async()=>{
  if(this.legacy)return false;
  if(!this.loaded){const initial=await this.deps.inspect(sessionId);this.deps.assertCurrent();if(initial?.mode==='legacy'){this.legacy=true;return false;}}
  await this.load();await this.drain();if(this.legacy)return false;
  let entry=this.entries.find(entry=>entry.sessionId===sessionId);
  if(!this.verified.has(sessionId)){
   const result=await this.deps.inspect(sessionId);this.deps.assertCurrent();
   if(result?.mode==='legacy'){this.legacy=true;return false;}
   if(result?.mode==='ordered'){
    if(result.session.session_id!==sessionId||result.session.status==='retired')throw new Error('This browsing session ended. Refresh Home to start again.');
    if(!entry){entry={sessionId,epoch:result.session.epoch,status:'active',pending:[]};this.entries.push(entry);}else entry.epoch=result.session.epoch;
   }
   this.verified.add(sessionId);
  }
  if(!entry){
   if(this.entries.length>=16)throw new Error('Reconnect to finish earlier browsing sessions.');
   entry={sessionId,epoch:'1',status:'active',pending:[{kind:'begin',request_id:createUuid(),session_id:sessionId}]};
   this.entries.push(entry);await this.persist();await this.drain();
  }
  return !this.legacy;
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
