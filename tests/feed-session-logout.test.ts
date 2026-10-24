import assert from 'node:assert/strict';
import test from 'node:test';
import {retireFeedBeforeLogout} from '../src/services/feedSessionLogout';
test('retirement bounds a stalled refresh and catches token-storage errors before logout',async()=>{
 const calls:string[]=[];
 const failed=await retireFeedBeforeLogout({readToken:async()=>{throw new Error('SecureStore unavailable');},retire:async()=>{calls.push('end');},isCurrent:()=>true},20);
 assert.equal(failed,false);calls.push('logout');assert.deepEqual(calls,['logout']);
 const start=Date.now();assert.equal(await retireFeedBeforeLogout({readToken:async()=>'owner-token',retire:async()=>new Promise(()=>{}),isCurrent:()=>true},20),false);
 calls.push('logout-after-refresh-timeout');assert.ok(Date.now()-start<1000);assert.equal(calls.at(-1),'logout-after-refresh-timeout');
});
test('late credential reads cannot start retirement after logout or into a changed account',async()=>{
 let resolve!:(value:string)=>void,ends=0;
 const token=new Promise<string>(r=>resolve=r);
 assert.equal(await retireFeedBeforeLogout({readToken:()=>token,retire:async()=>{ends++;},isCurrent:()=>true},20),false);
 resolve('old-token');await new Promise(r=>setImmediate(r));assert.equal(ends,0);
 await retireFeedBeforeLogout({readToken:async()=>'old-token',retire:async()=>{ends++;},isCurrent:()=>false});assert.equal(ends,0);
});
test('successful retirement completes before the caller starts logout',async()=>{
 const order:string[]=[];assert.equal(await retireFeedBeforeLogout({readToken:async()=>'owner-token',retire:async token=>{assert.equal(token,'owner-token');order.push('end');},isCurrent:()=>true}),true);
 order.push('logout');assert.deepEqual(order,['end','logout']);
});
