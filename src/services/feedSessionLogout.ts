/** Retirement is best effort; credential reads and refresh must not block logout. */
export async function retireFeedBeforeLogout(deps:{
 readToken:()=>Promise<string|null>;retire:(token:string)=>Promise<void>;isCurrent:()=>boolean;
},timeoutMs=5000):Promise<boolean>{
 let expired=false,timer:ReturnType<typeof setTimeout>|undefined;
 const work=(async()=>{
  const token=await deps.readToken();
  if(expired||!deps.isCurrent())return;
  if(token)await deps.retire(token);
 })();
 try{
  await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new Error('Feed retirement deadline exceeded.'));},timeoutMs);})]);
  return true;
 }catch{return false;}
 finally{expired=true;if(timer)clearTimeout(timer);}
}
