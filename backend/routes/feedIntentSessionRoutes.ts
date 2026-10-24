import { sqlClient } from '../db/index.js';
import { Router } from 'express';
import type { AuthRequest } from '../middlewares/authMiddleware.js';
import { getApplicationRuntime } from '../runtime/applicationRuntime.js';
import { FeedIntentSessionService,type SessionControl } from '../services/feedIntentSessionService.js';
import { ModelOperationError,decimalInt64 } from '../contracts/modelOperations.js';
import { isValidUuid } from '../utils/validators.js';
const sessions=new FeedIntentSessionService();
export function createFeedIntentSessionRouter(){
 const router=Router();
 router.get('/:sessionId',async(req:AuthRequest,res)=>{
  const userId=req.user?.userId;const sessionId=req.params.sessionId;
  if(!userId){res.status(401).json({error:'Authentication required.'});return;}
  if(typeof sessionId!=='string'||!isValidUuid(sessionId)){res.status(400).json({error:'Invalid feed session.'});return;}
  try{
   const runtime=getApplicationRuntime();
   if(!runtime.orderedProfiles||!await runtime.orderedProfiles.isEnabled(userId)){res.json({success:true,data:{mode:'legacy'}});return;}
   const [row]=await sqlClient`SELECT session_id,intent_epoch,epoch_started_ms,status FROM telemetry.feed_intent_sessions
     WHERE session_id=${sessionId}::uuid AND user_id=${userId}::uuid`;
   if(!row){res.status(404).json({error:'Feed session not found.'});return;}
   res.json({success:true,data:{mode:'ordered',session:{session_id:String(row.session_id),epoch:String(row.intent_epoch),
    epoch_started_ms:String(row.epoch_started_ms),status:String(row.status)}}});
  }catch{res.status(503).json({error:'Feed session is temporarily unavailable.'});}
 });
 router.post('/',async(req:AuthRequest,res)=>{
  const userId=req.user?.userId;if(!userId){res.status(401).json({error:'Authentication required.'});return;}
  const body=req.body as Record<string,unknown>;
  if(!body||!['begin','reset','end'].includes(String(body.kind))||typeof body.request_id!=='string'||typeof body.session_id!=='string'||!isValidUuid(body.request_id)||!isValidUuid(body.session_id)
   ||Object.keys(body).some(key=>!['kind','request_id','session_id','expected_epoch'].includes(key))){res.status(400).json({error:'Invalid feed session control.'});return;}
  const runtime=getApplicationRuntime();
  try{
   if(!runtime.orderedProfiles||!await runtime.orderedProfiles.isEnabled(userId)){
    res.status(200).json({success:true,data:{mode:'legacy'}});return;
   }
   let input:SessionControl;
   if(body.kind==='begin'){
    if(body.expected_epoch!==undefined)throw new ModelOperationError('MODEL_CONTROL_INVALID',400);
    await runtime.orderedProfiles.ensureProfileReady(userId);
    input={kind:'begin',request_id:String(body.request_id).toLowerCase(),session_id:String(body.session_id).toLowerCase()};
   }else{
    if(typeof body.expected_epoch!=='string')throw new ModelOperationError('MODEL_CONTROL_INVALID',400);
    try{decimalInt64(body.expected_epoch,true);}catch{throw new ModelOperationError('MODEL_CONTROL_INVALID',400);}
    input={kind:body.kind==='reset'?'reset':'end',request_id:String(body.request_id).toLowerCase(),session_id:String(body.session_id).toLowerCase(),expected_epoch:body.expected_epoch};
   }
   const result=await sessions.control(userId,input);
   res.status(200).json({success:true,data:{mode:'ordered',session:{session_id:result.session.sessionId,epoch:result.session.epoch,
     epoch_started_ms:result.session.epochStartedMs,status:result.session.status},operation_version:result.operation.version,delivery:'pending'}});
  }catch(error){
   const failure=error instanceof ModelOperationError?error:new ModelOperationError();
   res.setHeader('Retry-After','1');res.status(failure.statusCode).json({error:failure.message,code:failure.code,retryable:failure.statusCode>=409});
  }
 });
 return router;
}
