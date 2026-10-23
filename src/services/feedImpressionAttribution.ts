import type {QueryClient} from '@tanstack/react-query';
import type {RepositoryData} from '../data/repositories';
import {createUuid} from '../utils/uuid';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type OriginalFeedImpression={eventId:string;occurredAt:string};
export type FeedAttribution={ownerId:string;repoId:string;serveId:string;sessionId:string;position:number};
type CachedPages={pages:readonly{items:readonly Record<string,unknown>[]}[]};
export function parseOriginalFeedImpression(value:unknown):OriginalFeedImpression|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const row=value as Record<string,unknown>;
 return typeof row.eventId==='string'&&uuid.test(row.eventId)&&typeof row.occurredAt==='string'&&Number.isFinite(Date.parse(row.occurredAt))
  ?{eventId:row.eventId,occurredAt:row.occurredAt}:null;
}
export function feedAttribution(ownerId:string|undefined,repository:RepositoryData):FeedAttribution|null {
 const {id,serveId,feedSessionId,feedPosition}=repository;
 if(!ownerId||![ownerId,id,serveId,feedSessionId].every(value=>typeof value==='string'&&uuid.test(value))
  ||!Number.isInteger(feedPosition)||Number(feedPosition)<0)return null;
 return{ownerId,repoId:id,serveId:serveId!,sessionId:feedSessionId!,position:feedPosition!};
}
function matches(value:Record<string,unknown>,target:FeedAttribution):boolean {
 return value.repo_id===target.repoId&&value.serve_id===target.serveId&&value.feed_session_id===target.sessionId&&value.position===target.position;
}
/** This is presentation metadata on the existing owner-scoped feed cache.
 * No separate global registry outlives discarded pages or an account cache. */
export function rememberOriginalFeedImpression(client:QueryClient,target:FeedAttribution,observed:OriginalFeedImpression):OriginalFeedImpression {
 const key=['feed',target.ownerId]as const;
 let original=observed;
 const current=client.getQueryData<CachedPages>(key);
 for(const page of current?.pages??[])for(const item of page.items)if(matches(item,target)){
  original=parseOriginalFeedImpression(item.client_original_impression)??original;
 }
 if(!current)return original;
 let changed=false;
 const pages=current.pages.map(page=>{
  let pageChanged=false;
  const items=page.items.map(item=>{
   if(!matches(item,target))return item;
   const existing=parseOriginalFeedImpression(item.client_original_impression);
   if(existing?.eventId===original.eventId&&existing.occurredAt===original.occurredAt)return item;
   changed=true;pageChanged=true;return{...item,client_original_impression:original};
  });
  return pageChanged?{...page,items}:page;
 });
 if(changed)client.setQueryData(key,{...current,pages});
 return original;
}
export type FeedNavigationAttribution=FeedAttribution&{generation:number;original:OriginalFeedImpression|null};
/** Only an opaque one-use token travels in internal navigation. Shared links
 * continue to be generated solely from canonical repository identity. */
export function rememberFeedNavigation(client:QueryClient,attribution:FeedNavigationAttribution):string {
 const token=createUuid();client.setQueryData(['feed',attribution.ownerId,'navigation',token],attribution);return token;
}
export function takeFeedNavigation(client:QueryClient,ownerId:string,repoId:string,token:string|undefined,generation:number):FeedNavigationAttribution|null {
 if(!token||!uuid.test(token))return null;
 const key=['feed',ownerId,'navigation',token]as const;
 const value=client.getQueryData<FeedNavigationAttribution>(key);client.removeQueries({queryKey:key,exact:true});
 return value?.ownerId===ownerId&&value.repoId===repoId&&value.generation===generation?value:null;
}
