import assert from 'node:assert/strict';
import test from 'node:test';

import { updatePasswordFromRecoverySession } from '../../services/passwordRecoveryService.js';

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
      return { data: { session: { access_token: received.access_token } }, error: null };
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
  );

  assert.equal(result, 'updated');
  assert.deepEqual(calls, ['set-session', 'update-user']);
});

test('password recovery never updates through an invalid session', async () => {
  let updateCalled = false;
  const auth = {
    async setSession() {
      return { data: { session: null }, error: new Error('expired') };
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
  );

  assert.equal(result, 'invalid-session');
  assert.equal(updateCalled, false);
});


test('signup enforces password policy before provider admission', async () => {
  const {readFileSync}=await import('node:fs');
  const {createRequire}=await import('node:module');
  const {resolve}=await import('node:path');
  const ts=await import('typescript');
  const filename=resolve('controllers/authController.ts');
  const require=createRequire(filename);
  let providerCalls=0;
  const exports={};const module={exports};
  const auth={admin:{createUser:async()=>{providerCalls++;return {data:null,error:{message:'Controlled provider boundary'}};}}};
  const javascript=ts.transpileModule(readFileSync(filename,'utf8'),{
    fileName:filename,compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true},
  }).outputText;
  new Function('require','module','exports','process',javascript)((specifier:string)=>{
    if(specifier==='../config/supabase.js')return {supabaseAdmin:{auth}};
    if(specifier==='../services/oauthPkceService.js')return {OAuthPkceCoordinator:class{},RedisOAuthAttemptStore:class{}};
    if(specifier.startsWith('../utils/')||specifier==='../contracts/passwordPolicy.js')return require(specifier.replace(/\.js$/,'.ts'));
    if(specifier.startsWith('.'))return {};
    return require(specifier);
  },module,exports,{env:{CLIENT_URL:'http://fixture.invalid',BACKEND_URL:'http://fixture.invalid',JWT_SECRET:'test-only'}});
  const {signUp}=module.exports as {signUp:(req:unknown,res:unknown)=>Promise<void>};
  for(const password of [undefined,123456789012,'a'.repeat(11),'a'.repeat(129),'a'.repeat(12),'a'.repeat(128)]){
    let status=0,payload:any;
    const res={status(value:number){status=value;return this;},json(value:unknown){payload=value;return this;}};
    const before=providerCalls;
    await signUp({body:{email:'tarun@example.test',full_name:'Tarun',date_of_birth:'2005-01-01',password}},res);
    const allowed=typeof password==='string'&&[12,128].includes(password.length);
    assert.equal(providerCalls-before,allowed?1:0,'Rejected passwords must never reach account creation');
    assert.equal(status,400);
    assert.equal(payload.success,false);
    assert.match(payload.error,allowed?/Controlled provider boundary/:/password|characters/);
  }
});
