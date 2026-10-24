import { createUuid } from '../utils/uuid';
import { apiV2 } from './client';
import { accessTokenOwner } from './access-token-owner';
import { authSessionLifecycle } from './session-lifecycle';
import { getStorageItemStrict,setStorageItem } from '../utils/storage';
import { FeedIntentLifecycle,parseFeedSessionResult } from '../services/feedIntentLifecycle';
const storageWrites=new Map<string,Promise<void>>();
let tabId:string|undefined;
const clients=new Map<string,{generation:number;client:FeedIntentLifecycle;setToken:(token:string)=>void}>();
export function feedSessions(token:string):FeedIntentLifecycle{
 const owner=accessTokenOwner(token);if(!owner)throw new Error('Your session needs to be restored.');
 const generation=authSessionLifecycle.currentGeneration();
 const existing=clients.get(owner);if(existing?.generation===generation){existing.setToken(token);return existing.client;}
 let currentToken=token;
 if(!tabId){
  if(typeof sessionStorage!=='undefined'){
   const saved=sessionStorage.getItem('weave.feed-intent.tab.v1');
   tabId=saved&&/^[a-f0-9-]{36}$/.test(saved)?saved:createUuid();sessionStorage.setItem('weave.feed-intent.tab.v1',tabId);
  }else tabId='native';
 }
 const key=`weave.feed-intent.v1.${owner}.${tabId}`;
 const write=(value:string)=>{
  const operation=(storageWrites.get(key)??Promise.resolve()).catch(()=>{}).then(()=>{
   authSessionLifecycle.assertCurrent(generation);return setStorageItem(key,value);
  });
  storageWrites.set(key,operation);void operation.finally(()=>{if(storageWrites.get(key)===operation)storageWrites.delete(key);}).catch(()=>{});return operation;
 };
 const call=async(path:string,options:RequestInit={})=>{
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);
  try{return parseFeedSessionResult(await apiV2<unknown>(path,{...options,signal:controller.signal},currentToken));}finally{clearTimeout(timer);}
 };
 const client=new FeedIntentLifecycle(owner,{
  read:async()=>{await storageWrites.get(key)?.catch(()=>{});authSessionLifecycle.assertCurrent(generation);return getStorageItemStrict(key);},write,assertCurrent:()=>authSessionLifecycle.assertCurrent(generation),
  inspect:async sessionId=>{try{return await call(`/feed-sessions/${sessionId}`);}
   catch(error){if((error as {status?:number}).status===404)return null;throw error;}},
  send:control=>call('/feed-sessions',{method:'POST',body:JSON.stringify(control),keepalive:true}),
 });
 clients.clear();clients.set(owner,{generation,client,setToken:value=>{currentToken=value;}});return client;
}
