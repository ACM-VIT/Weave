import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('actual disconnect UI and client flow preserve owner, cancellation and pending states in Chromium', {
  skip: process.env.RUN_GITHUB_UNLINK_BROWSER !== '1', timeout: 30_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'weave-github-unlink-browser-'));
  const { build } = await import('esbuild');
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import{GitHubUnlinkPanel}from'./src/components/onboarding/GitHubUnlinkPanel';
    import{GithubUnlinkCallback}from'./src/components/onboarding/GithubUnlinkCallback';
    import{saveGithubUnlinkProof,takeGithubUnlinkProof}from'./src/services/githubUnlinkProof';
    import{authSessionLifecycle}from'./src/api/session-lifecycle';
    window.fixture={mode:'none',owner:'A',saved:[],browserCalls:0,refreshes:0};
    function Fixture(){const[owner,setOwner]=useState('A'),[view,setView]=useState('panel'),[,rerender]=useState(0);window.fixture.rerender=()=>rerender(x=>x+1);window.fixture.callback=async()=>{await saveGithubUnlinkProof(owner,'v'.repeat(64));setView('callback');};window.fixture.take=takeGithubUnlinkProof;window.fixture.switchAccount=()=>{authSessionLifecycle.retire(authSessionLifecycle.currentGeneration());window.fixture.owner='B';setOwner('B');};
      if(view==='callback')return <GithubUnlinkCallback code='opaque-web-callback'/>;return <GitHubUnlinkPanel userId={owner} onSaved={async()=>{window.fixture.saved.push(owner);}}/>;}
    createRoot(document.getElementById('panel-frame')).render(<React.StrictMode><Fixture/></React.StrictMode>);
  ` }, outfile: path.join(directory,'bundle.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',
    alias:{'react-native':'react-native-web'},define:{'process.env.NODE_ENV':'"development"'},
    plugins:[{name:'explicit-platform-transport-boundaries',setup(builder){
      const stubs = {
        'auth': "const refresh=async()=>{window.fixture.refreshes++;window.fixture.rerender();};export const useAuth=()=>({user:{user_id:window.fixture.owner,onboarding_completed:true},isLoading:false,checkOnboardingStatus:refresh});",
        'expo-router':"export const useRouter=()=>({replace:route=>{window.fixture.route=route;}});",
        'expo-linking': "export const createURL=()=>location.origin+'/callback';export const parse=url=>({queryParams:Object.fromEntries(new URL(url).searchParams)});",
        'expo-web-browser': "export async function openAuthSessionAsync(){window.fixture.browserCalls++;const mode=window.fixture.mode;if(mode==='late')await new Promise(r=>setTimeout(r,200));if(mode==='cancel')return{type:'cancel'};return{type:'success',url:location.origin+'/callback?'+(mode==='last_identity'?'unlink_error=last_identity':'unlink_code=opaque-code')};}",
        'expo-secure-store': "export async function getItemAsync(){throw Error('Native storage not exercised in web fixture')};export async function setItemAsync(){};export async function deleteItemAsync(){};",
        'client': "export async function apiV2(path,options){const response=await fetch('/fixture/'+path.split('/').pop()+'?owner='+window.fixture.owner+'&mode='+window.fixture.mode,options);const result=await response.json();if(!response.ok)throw Error(result.error);return result;}",
        'storage': "export async function getStorageItem(){return 'a.'+btoa(JSON.stringify({userId:window.fixture.owner}))+'.b';}",
        'pkce': "export async function createOAuthClientPkce(){return{verifier:'v'.repeat(64),challenge:'challenge'};}"
      };
      builder.onResolve({filter:/^(expo-linking|expo-web-browser|expo-secure-store|expo-router)$/},args=>({path:args.path,namespace:'fixture'}));
      builder.onResolve({filter:/api\/client$|^\.\/client$/},()=>({path:'client',namespace:'fixture'}));
      builder.onResolve({filter:/utils\/storage$/},()=>({path:'storage',namespace:'fixture'}));
      builder.onResolve({filter:/store\/AuthContext$/},()=>({path:'auth',namespace:'fixture'}));
      builder.onResolve({filter:/oauthClientPkce$/},()=>({path:'pkce',namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path]}));
    }}]
  });
  const requests: Array<{owner:string;action:string;mode:string}> = [];
  const server = createServer(async(req,res)=>{
    const url=new URL(req.url!,'http://localhost');
    if(url.pathname.startsWith('/fixture/')){
      const action=url.pathname.split('/').pop()!,owner=url.searchParams.get('owner')!,mode=url.searchParams.get('mode')!;
      requests.push({owner,action,mode});res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify(action==='start'?{url:'http://provider.invalid/reauth'}:{status:action==='finish'?(mode==='pending'?'pending':mode==='refused'?'refused':'done'):'none'}));return;
    }
    if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(await readFile(path.join(directory,'bundle.js')));return;}
    if(url.pathname==='/font.ttf'){res.setHeader('Content-Type','font/ttf');res.end(await readFile('assets/fonts/NataSans-Regular.ttf'));return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>@font-face{font-family:"Nata Sans";src:url(/font.ttf)}:root{--font-display:"Nata Sans",sans-serif}body{margin:0;background:#000;color:#fff}#panel-frame{box-sizing:border-box;max-width:450px;margin:auto;padding:20px}</style><main id="panel-frame"></main><script src="/bundle.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const chrome = spawn(process.env.CHROMIUM_BIN ?? 'chromium', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${path.join(directory, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
  let spawnError: Error | undefined; chrome.on('error', error => { spawnError = error; });
  let socket: WebSocket | undefined;
  t.after(async () => {
    socket?.close();
    if (chrome.exitCode === null && chrome.signalCode === null && !spawnError) { const exited = once(chrome, 'exit'); chrome.kill('SIGKILL'); await exited; }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let port: string | undefined;
  for (let n = 0; n < 100; n++) {
    if (spawnError) throw spawnError;
    try { port = (await readFile(path.join(directory, 'chrome/DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.ok(port);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json() as { webSocketDebuggerUrl: string };
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject; });
  let sequence = 0;
  const pending = new Map<number, (value: any) => void>();
  socket.onmessage = message => { const value = JSON.parse(String(message.data)); pending.get(value.id)?.(value); pending.delete(value.id); };
  const send = (method: string, params = {}) => new Promise<any>(resolve => {
    const id = ++sequence; pending.set(id, resolve); socket!.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    assert.ok(!result.result?.exceptionDetails, JSON.stringify(result));
    return result.result?.result?.value;
  };
  const until = async (expression: string) => {
    for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.fail(`Browser state did not settle: ${expression}\n${await evaluate('document.body.innerText')}`);
  };
  const click = async (label: string) => { await until(`Boolean(document.querySelector('[aria-label="${label}"]'))`); await evaluate(`document.querySelector('[aria-label="${label}"]').click()`); };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `http://127.0.0.1:${address.port}` });
  await until('document.body.innerText.includes("Disconnect GitHub login")');
  assert.equal(requests.filter(x=>x.action==='start').length,0);
  await click('Disconnect GitHub login');
  assert.equal(requests.filter(x=>x.action==='start').length,0,'confirmation alone never starts OAuth');
  await evaluate('window.fixture.mode="last_identity"');await click('Reauthenticate and disconnect GitHub');
  await until('document.body.innerText.includes("only login identity")');
  assert.equal(requests.filter(x=>x.action==='finish').length,0);
  await evaluate('window.fixture.mode="cancel"');await click('Reauthenticate and disconnect GitHub');
  await until(`!document.querySelector('[aria-label="Verifying GitHub disconnect"]')`);
  assert.equal(await evaluate('sessionStorage.getItem("github_unlink_client_pkce_v1")'),null);
  await evaluate('window.fixture.mode="pending"');await click('Reauthenticate and disconnect GitHub');
  await until('document.body.innerText.includes("pending verification")');
  assert.equal(requests.filter(x=>x.action==='finish').length,1);
  for(const[name,width,height]of[['mobile',390,844],['desktop',1280,900]]as const){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:name==='mobile'});
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    if(process.env.GITHUB_UNLINK_BROWSER_ARTIFACTS){await mkdir(process.env.GITHUB_UNLINK_BROWSER_ARTIFACTS,{recursive:true});const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await writeFile(path.join(process.env.GITHUB_UNLINK_BROWSER_ARTIFACTS,name+'.png'),Buffer.from(screenshot.result.data,'base64'));}
  }
  await evaluate('window.fixture.mode="refused"');await click('Reauthenticate and disconnect GitHub');
  await until('document.body.innerText.includes("provider refused")');
  await evaluate('window.fixture.mode="late"');await click('Reauthenticate and disconnect GitHub');
  await until('window.fixture.browserCalls===5');await evaluate('window.fixture.switchAccount()');
  await until('document.body.innerText.includes("Disconnect GitHub login")');await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal(requests.filter(x=>x.action==='finish').length,2,'old account cannot finish after provider browser returns');
  assert.equal(await evaluate('sessionStorage.getItem("github_unlink_client_pkce_v1")'),null);
  await click('Disconnect GitHub login');await evaluate('window.fixture.mode="done"');await click('Reauthenticate and disconnect GitHub');
  await until('document.body.innerText.includes("GitHub login disconnected.")');
  assert.deepEqual(await evaluate('window.fixture.saved'),['B']);
  assert.deepEqual(requests.filter(x=>x.action==='finish').map(x=>x.owner),['A','A','B']);
  await evaluate('window.fixture.callback()');
  await until('document.body.innerText.includes("GitHub login disconnected.") && document.body.innerText.includes("Return to account")');
  assert.equal(requests.filter(x=>x.action==='finish').length,4,'StrictMode and profile refresh must not repeat one-shot completion');
  assert.equal(await evaluate('window.fixture.refreshes'),1);
  assert.equal(await evaluate('sessionStorage.getItem("github_unlink_client_pkce_v1")'),null);
  t.diagnostic('Actual RN Web component, owner-checked client orchestration and sessionStorage proof; explicit browser/crypto/HTTP transport doubles. Native device/provider configuration not exercised.');
});
