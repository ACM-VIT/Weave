import express, { type RequestHandler } from 'express';
import type { ScoringExportPort } from '../contracts/scoringExport.js';
import { ScoringExportError, validateScoringExportSelection } from '../adapters/postgresScoringExport.js';
type AuthRequest=express.Request&{user?:{userId:string;email:string}};

/** Product JWT identifies the caller; SQL's operator-owned registry grants scope.
 * Internal secrets, request roles and ordinary authenticated ownership grant none.
 */
export function createScoringExportRouter(providePort:ScoringExportPort|null|(()=>ScoringExportPort|null),authenticate:RequestHandler):express.Router {
  if(typeof authenticate!=='function')throw new Error('SCORING_EXPORT_AUTH_REQUIRED');
  const router=express.Router();
  const activeByPrincipal=new Map<string,number>(); let active=0;
  router.use((_request,response,next)=>{response.setHeader('Cache-Control','no-store');next();});
  router.use(authenticate);
  router.use(express.json({limit:'4kb',strict:true}));
  const work=(operation:(request:AuthRequest,port:ScoringExportPort)=>Promise<unknown>,status=200):RequestHandler=>async(request,response)=>{
    const principal=(request as AuthRequest).user?.userId;
    if(!principal||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(principal)) {
      response.status(401).json({error:'SCORING_EXPORT_UNAUTHORIZED'});return;
    }
    const owned=activeByPrincipal.get(principal)??0;
    if(active>=8||owned>=2){response.status(429).json({error:'SCORING_EXPORT_CAPACITY'});return;}
    active++;activeByPrincipal.set(principal,owned+1);
    try {
      const port=typeof providePort==='function'?providePort():providePort;
      if(!port){response.status(503).json({error:'SCORING_EXPORT_DISABLED'});return;}
      const result=await operation(request as AuthRequest,port);
      // A client disconnect does not release admission until SQL actually exits.
      if(!response.destroyed&&!response.writableEnded) {
        const wire=JSON.stringify(result);
        if(Buffer.byteLength(wire)>1_000_000) throw new ScoringExportError('bounds');
        response.status(status).type('application/json').send(wire);
      }
    } catch(error) {
      if(!response.destroyed&&!response.writableEnded) {
        const reason=error instanceof ScoringExportError?error.reason:'unavailable';
        const code={invalid:400,forbidden:403,expired:410,capacity:429,bounds:413,permission:503,unavailable:503}[reason];
        // Never log raw exceptions/DB DETAIL or serialize a packet in an error.
        response.status(code).json({error:`SCORING_EXPORT_${reason.toUpperCase()}`});
      }
    } finally {
      active--;const remaining=(activeByPrincipal.get(principal)??1)-1;
      if(remaining)activeByPrincipal.set(principal,remaining);else activeByPrincipal.delete(principal);
    }
  };
  router.post('/',work(async(request,port)=>{
    const body=request.body as Record<string,unknown>;
    if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='served_from,served_to,subject_user_id') throw new ScoringExportError('invalid');
    const selection={subjectUserId:body.subject_user_id as string,servedFrom:body.served_from as string,servedTo:body.served_to as string};
    validateScoringExportSelection(selection);
    return port.create(request.user!.userId,selection);
  },201));
  router.get('/:jobId',work(async(request,port)=>{
    if(Object.keys(request.query).some(key=>key!=='after'&&key!=='limit')
      ||(request.query.after!==undefined&&(typeof request.query.after!=='string'||!/^(0|[1-9][0-9]{0,2})$/.test(request.query.after)))
      ||(request.query.limit!==undefined&&(typeof request.query.limit!=='string'||!/^[1-9][0-9]{0,2}$/.test(request.query.limit)))) throw new ScoringExportError('invalid');
    return port.page(request.user!.userId,request.params.jobId as string,Number(request.query.after??0),Number(request.query.limit??50));
  }));
  router.post('/users/:subjectUserId/revoke',work(async(request,port)=>{
    if(request.body!==undefined&&(request.body===null||typeof request.body!=='object'||Array.isArray(request.body)||Object.keys(request.body).length))
      throw new ScoringExportError('invalid');
    return port.revoke(request.user!.userId,request.params.subjectUserId as string);
  }));
  router.use(((error, _request,response,_next)=>{
    if(!response.headersSent)response.status(error?.type==='entity.too.large'?413:400).json({error:'SCORING_EXPORT_INVALID'});
  }) as express.ErrorRequestHandler);
  const scoped=express.Router();scoped.use('/scoring-exports',router);return scoped;
}
