import assert from 'node:assert/strict';
import test from 'node:test';

import { updatePasswordFromRecoverySession } from '../../services/passwordRecoveryService.js';

const recoveryUserId = '11111111-1111-4111-8111-111111111111';
const tokens = {
  access_token: 'recovery-access-token',
  refresh_token: 'recovery-refresh-token',
};

test('password recovery establishes the recovery session before updating', async () => {
  const calls: string[] = [];
  const auth = {
    async setSession(received: typeof tokens) {
      calls.push('set-session');
      assert.deepEqual(received, tokens);
      return { data: { session: { access_token: received.access_token, user: { id: recoveryUserId } } }, error: null };
    },
    async updateUser(attributes: { password: string }) {
      calls.push('update-user');
      assert.deepEqual(attributes, { password: 'a-secure-new-password' });
      return { error: null };
    },
  };

  const result = await updatePasswordFromRecoverySession(
    auth,
    tokens,
    'a-secure-new-password',
    async () => undefined,
  );

  assert.equal(result, 'updated');
  assert.deepEqual(calls, ['set-session', 'update-user']);
});

test('password recovery never updates through an invalid session', async () => {
  let updateCalled = false;
  const auth = {
    async setSession() {
      return { data: { session: null }, error: Object.assign(new Error('expired'),{status:400}) };
    },
    async updateUser() {
      updateCalled = true;
      return { error: null };
    },
  };

  const result = await updatePasswordFromRecoverySession(
    auth,
    tokens,
    'a-secure-new-password',
    async () => undefined,
  );

  assert.equal(result, 'invalid-session');
  assert.equal(updateCalled, false);
});


async function controllerFixture(recoveryAuth?: Parameters<typeof updatePasswordFromRecoverySession>[0], signupSuccess: boolean | 'session' = false, revokeSessions: (id: string) => Promise<void> = async()=>undefined,
  refresh?: {db: unknown; getUserById: (id: string) => Promise<unknown>; rotate: (id: string, hash: string) => Promise<string>; rotatedError: new () => Error}) {
  const {readFileSync}=await import('node:fs');
  const {createRequire}=await import('node:module');
  const {fileURLToPath}=await import('node:url');
  const ts=await import('typescript');
  const filename=fileURLToPath(new URL('../../controllers/authController.ts',import.meta.url));
  const require=createRequire(filename);
  let providerCalls=0;
  const exports={};const module={exports};
  const signupRequests: unknown[] = [];
  const signup = async (attributes: unknown) => { providerCalls++; signupRequests.push(attributes); return signupSuccess ? { data: {user:{id:recoveryUserId},session:signupSuccess==='session'?{user:{id:recoveryUserId}}:null}, error:null } : {data:null,error:{message:'Controlled provider boundary'}}; };
  const auth={admin:{createUser:signup,getUserById:refresh?.getUserById},signUp:signup,signInWithPassword:async()=>({data:{user:{id:recoveryUserId,email_confirmed_at:null}},error:null})};
  const javascript=ts.transpileModule(readFileSync(filename,'utf8'),{
    fileName:filename,compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true},
  }).outputText;
  new Function('require','module','exports','process',javascript)((specifier:string)=>{
    if(specifier==='../config/supabase.js')return {requireEmailConfirmation:async()=>undefined,supabaseAdmin:{auth},createRecoverySupabaseClient:()=>({auth:recoveryAuth}),createEmailAuthSupabaseClient:()=>({auth})};
    if(specifier==='../services/oauthPkceService.js')return {OAuthPkceCoordinator:class{},RedisOAuthAttemptStore:class{}};
    if(specifier==='../services/authSessionService.js')return {revokeRefreshSessions:revokeSessions,authAttemptStartedAt:async()=>new Date().toISOString(),rotateRefreshToken:refresh?.rotate,RefreshTokenRotatedError:refresh?.rotatedError};
    if(specifier==='../db/index.js')return {db:refresh?.db};
    if(specifier==='../db/v2Schema.js')return require(specifier.replace(/\.js$/,'.ts'));
    if(specifier==='../services/refreshUserLookup.js')return require(specifier.replace(/\.js$/,'.ts'));
    if(specifier==='../services/passwordRecoveryService.js')return {updatePasswordFromRecoverySession};
    if(specifier.startsWith('../utils/')||specifier==='../contracts/passwordPolicy.js')return require(specifier.replace(/\.js$/,'.ts'));
    if(specifier.startsWith('.'))return {};
    return require(specifier);
  },module,exports,{env:{CLIENT_URL:'http://fixture.invalid',BACKEND_URL:'http://fixture.invalid',JWT_SECRET:'test-only'}});
  return {...module.exports as {signUp:(req:unknown,res:unknown)=>Promise<void>;login:(req:unknown,res:unknown)=>Promise<void>;confirmPasswordReset:(req:unknown,res:unknown)=>Promise<void>;refreshToken:(req:unknown,res:unknown)=>Promise<void>},providerCalls:()=>providerCalls,signupRequests};
}

test('signup enforces password policy before provider admission', async () => {
  const {signUp,providerCalls}=await controllerFixture();
  for(const password of [undefined,123456789012,'a'.repeat(11),'a'.repeat(129),'a'.repeat(12),'a'.repeat(128)]){
    let status=0,payload:any;
    const res={status(value:number){status=value;return this;},json(value:unknown){payload=value;return this;}};
    const before=providerCalls();
    await signUp({body:{email:'tarun@example.test',full_name:'Tarun',date_of_birth:'2005-01-01',password}},res);
    const allowed=typeof password==='string'&&[12,128].includes(password.length);
    assert.equal(providerCalls()-before,allowed?1:0,'Rejected passwords must never reach account creation');
    assert.equal(status,400);
    assert.equal(payload.success,false);
    assert.match(payload.error,allowed?/Controlled provider boundary/:/password|characters/);
  }
});


test('recovery HTTP distinguishes terminal tokens from temporary session and update failures',async()=>{
  for(const status of [400,429,503,undefined]){
    let updateCalled=false;
    const {confirmPasswordReset}=await controllerFixture({
      setSession:async()=>({data:{session:null},error:Object.assign(new Error('Provider session failure'),status?{status}:{})}),
      updateUser:async()=>{updateCalled=true;return {error:null};},
    });
    let responseStatus=0,payload:any;
    const res={status(value:number){responseStatus=value;return this;},json(value:unknown){payload=value;return this;}};
    await confirmPasswordReset({body:{...tokens,password:'a-secure-new-password'}},res);
    assert.equal(responseStatus,status===400?400:503);
    assert.equal(payload.code,status===400?'PASSWORD_RESET_SESSION_INVALID':undefined);
    assert.equal(updateCalled,false);
  }
  const {confirmPasswordReset}=await controllerFixture({setSession:async()=>({data:{session:{user:{id:recoveryUserId}}},error:null}),updateUser:async()=>({error:{status:503}})});
  let payload:any;const res={status(value:number){assert.equal(value,400);return this;},json(value:unknown){payload=value;return this;}};
  await confirmPasswordReset({body:{...tokens,password:'a-secure-new-password'}},res);
  assert.equal(payload.code,undefined,'A failed update does not invalidate the established recovery session');
});


test('password signup requests mailbox confirmation and returns no app credentials', async () => {
  const fixture = await controllerFixture(undefined, true);
  let status = 0, payload: any, cookies = 0;
  const res = {status(value: number){status=value;return this;},json(value: unknown){payload=value;return this;},cookie(){cookies++;}};
  await fixture.signUp({body:{email:'tarun@example.test',password:'a-secure-new-password',full_name:'Tarun',date_of_birth:'2005-01-01'}}, res);
  assert.equal((fixture.signupRequests[0] as any)?.email_confirm, undefined, 'public signup must never auto-confirm an arbitrary email');
  assert.equal(status, 202);
  assert.equal(payload.data.requiresEmailConfirmation, true);
  assert.equal(payload.data.accessToken, undefined);
  assert.equal(payload.data.user, undefined);
  assert.equal(cookies, 0);
});

test('recovery revokes owner sessions before changing the password and after success', async () => {
  const calls: string[] = [];
  const auth = {
    async setSession(){return {data:{session:{user:{id:recoveryUserId}}},error:null};},
    async updateUser(){calls.push('password');return {error:null};},
  };
  const result = await updatePasswordFromRecoverySession(auth,tokens,'a-secure-new-password',async userId => {
    assert.equal(userId,recoveryUserId); calls.push('revoke');
  });
  assert.equal(result,'updated');
  assert.deepEqual(calls,['revoke','password','revoke']);
});

test('recovery refuses password changes when durable session revocation fails', async () => {
  let updated = false;
  const auth = {
    async setSession(){return {data:{session:{user:{id:recoveryUserId}}},error:null};},
    async updateUser(){updated=true;return {error:null};},
  };
  await assert.rejects(updatePasswordFromRecoverySession(auth,tokens,'a-secure-new-password',async()=>{throw new Error('database unavailable');}),/database unavailable/);
  assert.equal(updated,false);
});

test('durable recovery fences old sessions and in-flight rotation without revoking another user', {
  skip: process.env.RUN_DATABASE_INTEGRATION !== '1', timeout: 30_000,
}, async () => {
  const {assertDisposableDatabase} = await import('../database/disposableDatabase.js'); assertDisposableDatabase();
  const {randomUUID,randomInt,createHash} = await import('node:crypto');
  const {setTimeout:delay} = await import('node:timers/promises');
  const {sqlClient:sql} = await import('../../db/index.js');
  const {authAttemptStartedAt,issueRefreshToken,rotateRefreshToken,revokeRefreshSessions,RefreshTokenRotatedError} = await import('../../services/authSessionService.js');
  const owner=randomUUID(), peer=randomUUID(), suffix=owner.replaceAll('-',''), name='auth_gate_'+suffix;
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  let releaseGate:(()=>void)|undefined, gate:Promise<unknown>|undefined, rotating:Promise<unknown>|undefined, revoking:Promise<unknown>|undefined;
  let triggerCreated=false;
  try {
    for(const id of [owner,peer]) {
      await sql`INSERT INTO auth.users(id) VALUES(${id}::uuid)`;
      await sql`INSERT INTO app.users(user_id,username) VALUES(${id}::uuid,${'auth_'+id})`;
    }
    const beforeReset=await authAttemptStartedAt();
    const original=await issueRefreshToken(owner,beforeReset);
    await issueRefreshToken(owner,beforeReset); await issueRefreshToken(peer,beforeReset);
    await sql`INSERT INTO app.oauth_codes(user_id,expires_at) VALUES(${owner}::uuid,now()+interval '1 minute')`;
    const controller=await controllerFixture({
      setSession:async()=>({data:{session:{user:{id:owner}}},error:null}),
      updateUser:async()=>({error:null}),
    },false,revokeRefreshSessions);
    let recoveredStatus=0;
    await controller.confirmPasswordReset({body:{...tokens,password:'a-secure-new-password'}},{status(value:number){recoveredStatus=value;return this;},json(){return this;}});
    assert.equal(recoveredStatus,200);
    assert.equal(Number((await sql`SELECT count(*) FROM app.refresh_tokens WHERE user_id=${owner}::uuid`)[0].count),0);
    assert.equal(Number((await sql`SELECT count(*) FROM app.refresh_tokens WHERE user_id=${peer}::uuid`)[0].count),1);

    // Two independent tabs read the same cookie before either rotates it.
    const {db}=await import('../../db/index.js');
    const shared=await issueRefreshToken(owner,await authAttemptStartedAt());
    let lookups=0, releaseLookups!:()=>void;
    const bothLookups=new Promise<void>(resolve=>{releaseLookups=resolve;});
    const refreshController=await controllerFixture(undefined,false,revokeRefreshSessions,{
      db,rotate:rotateRefreshToken,rotatedError:RefreshTokenRotatedError,getUserById:async(id)=>{
        assert.equal(id,owner);if(++lookups===2)releaseLookups();
        if(lookups<=2)await bothLookups;
        return {data:{user:{id:owner,email:'tarun@example.test'}},error:null};
      },
    });
    let cookie=shared, cleared=0;
    const response=()=>({code:0,payload:{} as Record<string,unknown>,
      status(value:number){this.code=value;return this;},json(value:Record<string,unknown>){this.payload=value;return this;},
      cookie(_name:string,value:string){cookie=value;return this;},clearCookie(){cleared++;cookie='';return this;},
    });
    const a=response(),b=response();
    await Promise.all([refreshController.refreshToken({cookies:{refresh_token:shared}},a),refreshController.refreshToken({cookies:{refresh_token:shared}},b)]);
    assert.deepEqual([a.code,b.code].sort(),[200,409]);
    assert.equal(cleared,0,'a concurrent loser cannot erase the winning cookie');
    const loser=a.code===409?a:b;
    assert.equal(loser.payload.code,'REFRESH_TOKEN_ROTATED');
    assert.ok(cookie&&cookie!==shared);
    assert.equal(Number((await sql`SELECT count(*) FROM app.refresh_tokens WHERE user_id=${owner}::uuid AND last_used_at IS NULL`)[0].count),1,'only one active replacement is issued');
    const followup=response();await refreshController.refreshToken({cookies:{refresh_token:cookie}},followup);
    assert.equal(followup.code,200,'the surviving browser cookie still renews the session');
    const validCookie=cookie;
    const consumed=response();await refreshController.refreshToken({cookies:{refresh_token:shared}},consumed);
    assert.equal(consumed.code,409);assert.equal(cookie,validCookie,'a consumed token cannot issue or clear a cookie');
    const stale=response();await refreshController.refreshToken({cookies:{refresh_token:'unknown-old-cookie'}},stale);
    assert.equal(stale.code,401);assert.equal(cookie,validCookie,'an invalid stale request cannot mutate a newer shared credential');
    assert.equal(Number((await sql`SELECT count(*) FROM app.oauth_codes WHERE user_id=${owner}::uuid`)[0].count),0);
    await assert.rejects(rotateRefreshToken(owner,hash(original)),/InvalidToken/);
    await assert.rejects(issueRefreshToken(owner,beforeReset),/session changed/,'a login/code admitted before reset cannot recreate the session');
    const current=await issueRefreshToken(owner,await authAttemptStartedAt());
    assert.ok(current);

    // Pause a real rotation after consumption, before its replacement INSERT.
    // Revocation must wait on the same owner lock, then delete the replacement.
    const lockKey=randomInt(1,2_000_000_000);
    await sql.unsafe(`CREATE FUNCTION app.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${owner}'::uuid THEN PERFORM pg_advisory_xact_lock(${lockKey}); END IF; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON app.refresh_tokens FOR EACH ROW EXECUTE FUNCTION app.${name}()`); triggerCreated=true;
    let gateReady!:()=>void;
    const ready=new Promise<void>(resolve=>{gateReady=resolve;});
    const release=new Promise<void>(resolve=>{releaseGate=resolve;});
    gate=sql.begin(async tx=>{await tx`SELECT pg_advisory_xact_lock(${lockKey})`;gateReady();await release;});
    await ready;
    rotating=rotateRefreshToken(owner,hash(current));
    const waitFor=async (condition:()=>Promise<boolean>)=>{
      const deadline=Date.now()+5_000;
      while(!await condition()){assert.ok(Date.now()<deadline,'SQL boundary did not become observable');await delay(10);}
    };
    await waitFor(async()=>Number((await sql`SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%INSERT INTO app.refresh_tokens%'`)[0].count)>0);
    let revocationFinished=false;
    revoking=revokeRefreshSessions(owner).then(()=>{revocationFinished=true;});
    await waitFor(async()=>revocationFinished || Number((await sql`SELECT count(*) FROM pg_stat_activity WHERE wait_event IN ('transactionid','tuple') AND query LIKE '%SELECT user_id FROM app.users%'`)[0].count)>0);
    assert.equal(revocationFinished,false,'revocation must not pass a rotation holding the owner lock');
    assert.ok(releaseGate);releaseGate();await gate;await rotating;await revoking;
    assert.equal(Number((await sql`SELECT count(*) FROM app.refresh_tokens WHERE user_id=${owner}::uuid`)[0].count),0);
    assert.equal(Number((await sql`SELECT count(*) FROM app.refresh_tokens WHERE user_id=${peer}::uuid`)[0].count),1);
  } finally {
    releaseGate?.();await Promise.allSettled([gate,rotating,revoking]);
    if(triggerCreated)await sql.unsafe(`DROP TRIGGER IF EXISTS ${name} ON app.refresh_tokens`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS app.${name}()`);
    for(const id of [owner,peer])await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
    await sql.end({timeout:1});
  }
});

test('email auth refuses an unavailable or auto-confirming provider configuration', async t => {
  for(const key of ['SUPABASE_URL','SUPABASE_KEY','SUPABASE_SERVICE_ROLE_KEY']) {
    const old=process.env[key];t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});
  }
  process.env.SUPABASE_URL='http://127.0.0.1:1';process.env.SUPABASE_KEY='fixture-anon';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-admin';
  let body: unknown={mailer_autoconfirm:true,external:{email:true}};
  t.mock.method(globalThis,'fetch',async (url: string | URL | Request)=>{assert.equal(String(url),'http://127.0.0.1:1/auth/v1/settings');return new Response(JSON.stringify(body));});
  const config=await import('../../config/supabase.js');
  await assert.rejects(config.requireEmailConfirmation(),{statusCode:503});
  body={mailer_autoconfirm:false,external:{email:true}};
  await config.requireEmailConfirmation();
  body={external:{email:true}};
  await assert.rejects(config.requireEmailConfirmation(),{statusCode:503});
});


test('password login rejects unconfirmed identities even if the provider returns one',async()=>{
  const controller=await controllerFixture();let status=0;
  await controller.login({body:{email:'tarun@example.test',password:'a-secure-new-password'}},{status(value:number){status=value;return this;},json(){return this;}});
  assert.equal(status,403);
});

test('password signup never exposes a session from an auto-confirming provider',async()=>{
  const controller=await controllerFixture(undefined,'session');let status=0,payload:any,cookies=0;
  await controller.signUp({body:{email:'tarun@example.test',password:'a-secure-new-password',date_of_birth:'2005-01-01'}},{status(value:number){status=value;return this;},json(value:unknown){payload=value;return this;},cookie(){cookies++;}});
  assert.equal(status,503);assert.equal(payload.data,undefined);assert.equal(cookies,0);
});

test('auth HTTP admission refuses Redis failure and invalid counters without reaching authentication', async t => {
  const [{default:express},{readFileSync},{createRequire},{fileURLToPath},ts]=await Promise.all([
    import('express'),import('node:fs'),import('node:module'),import('node:url'),import('typescript'),
  ]);
  const filename=fileURLToPath(new URL('../../middlewares/securityMiddleware.ts',import.meta.url));
  const require=createRequire(filename);
  let outcome: number | string | Error = 1, admitted=0;
  const redis={async eval(){if(outcome instanceof Error)throw outcome;return outcome;}};
  const box={exports:{}};
  const source=ts.transpileModule(readFileSync(filename,'utf8'),{fileName:filename,compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  new Function('require','module','exports',source)((name:string)=>name==='../config/redis.js'?redis:require(name),box,box.exports);
  const {authRateLimit}=box.exports as typeof import('../../middlewares/securityMiddleware.js');
  const app=express();app.use('/api/auth',authRateLimit);
  app.post('/api/auth/login',(_req,res)=>{admitted++;res.status(204).end();});
  app.get('/api/v2/probe',(_req,res)=>res.status(204).end());
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();assert.ok(address&&typeof address==='object');
  const base=`http://127.0.0.1:${address.port}`;
  t.mock.method(console,'error',()=>undefined);
  assert.equal((await fetch(base+'/api/auth/login',{method:'POST'})).status,204);
  outcome=21;
  assert.equal((await fetch(base+'/api/auth/login',{method:'POST'})).status,429);
  outcome=new Error('Redis connection lost');
  const refused=await fetch(base+'/api/auth/login',{method:'POST'});
  assert.equal(refused.status,503);
  assert.equal(refused.headers.get('set-cookie'),null);
  assert.equal(refused.headers.get('retry-after'),'5');
  assert.equal((await refused.json() as {code:string}).code,'AUTH_RATE_LIMIT_UNAVAILABLE');
  outcome='not-a-counter';
  assert.equal((await fetch(base+'/api/auth/login',{method:'POST'})).status,503);
  assert.equal(admitted,1,'neither dependency failures nor invalid counters can reach the auth handler');
  assert.equal((await fetch(base+'/api/v2/probe')).status,204,'the auth outage policy does not block unrelated product routes');
  outcome=1;
  assert.equal((await fetch(base+'/api/auth/login',{method:'POST'})).status,204,'admission recovers when Redis does');
});
