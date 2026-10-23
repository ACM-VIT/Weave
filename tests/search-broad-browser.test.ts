import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('actual Explore retains broad two-character results, typing delay and account/offline isolation', {
  skip: process.env.RUN_SEARCH_BROAD_BROWSER !== '1', timeout: 30_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(),'weave-search-broad-browser-'));
  const {build}=await import('esbuild');
  await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
    import React from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
    import Explore from'./src/app/(tabs)/explore';
    window.fixture={owner:'A',offline:false,mode:'normal'};
    window.fixture.change=(values)=>{Object.assign(window.fixture,values);window.dispatchEvent(new Event('fixture-change'));};
    createRoot(document.getElementById('panel-frame')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Explore/></QueryClientProvider>);
  `},outfile:path.join(directory,'bundle.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',alias:{'react-native':'react-native-web'},
    resolveExtensions:['.web.tsx','.tsx','.web.ts','.ts','.web.js','.js','.json'],define:{'process.env.NODE_ENV':'"development"'},
    plugins:[{name:'explicit-search-platform-transport',setup(builder){
      const stubs={
        auth:"import{useEffect,useState}from'react';export function useAuth(){const[,update]=useState(0);useEffect(()=>{const event=()=>update(x=>x+1);window.addEventListener('fixture-change',event);return()=>window.removeEventListener('fixture-change',event);},[]);return{user:{user_id:window.fixture.owner}};}",
        net:"import{useEffect,useState}from'react';export function useNetInfo(){const[,update]=useState(0);useEffect(()=>{const event=()=>update(x=>x+1);window.addEventListener('fixture-change',event);return()=>window.removeEventListener('fixture-change',event);},[]);return{isConnected:!window.fixture.offline,isInternetReachable:!window.fixture.offline};}",
        router:"export const router={push:value=>{window.fixture.route=value;}};",
        safe:"export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});",
        keyboard:"import React from'react';import{View}from'react-native';export const KeyboardSurface=props=><View {...props}/>;",
        crypto:"export const randomUUID=()=>window.crypto.randomUUID();",
        client:"export async function apiV2(path,options){window.fixture.lastSent=JSON.parse(options.body).query;const response=await fetch('/fixture/search?owner='+window.fixture.owner+'&mode='+window.fixture.mode,options);if(!response.ok)throw Error('Controlled transport failure');return response.json();}",
        storage:"export async function getStorageItem(){return 'fixture-backend-token';}",
        browse:"export const fetchExploreRepos=async()=>({items:[],nextOffset:null});export const mergeExplorePages=()=>[];",
        card:"import React from'react';import{Pressable,Text}from'react-native';export default function Card({repo,onPress}){return <Pressable onPress={onPress}><Text>{repo.name}</Text><Text>{repo.description}</Text></Pressable>;}"
      };
      const route=(filter,key)=>builder.onResolve({filter},()=>({path:key,namespace:'fixture'}));
      route(/^@\/store\/AuthContext$/,'auth');route(/^@react-native-community\/netinfo$/,'net');route(/^expo-router$/,'router');
      route(/^react-native-safe-area-context$/,'safe');route(/^@\/components\/keyboard\/keyboard-layout$/,'keyboard');route(/^expo-crypto$/,'crypto');
      route(/api\/client$|^\.\/client$/,'client');route(/utils\/storage$/,'storage');route(/^@\/api\/explore$/,'browse');
      route(/^@\/components\/explore\/(TrendingRepoCard|RepoCard)$/,'card');
      builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],resolveDir:process.cwd(),loader:args.path==='card'||args.path==='keyboard'?'tsx':'js'}));
    }}]
  });
  const requests:Array<{query:string;owner:string;group:string;time:number;cursor:string|null}>=[];
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url!,'http://localhost');
    if(url.pathname==='/fixture/search'){
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());
      const owner=url.searchParams.get('owner')!,mode=url.searchParams.get('mode');requests.push({query:body.query,owner,group:body.group,time:Date.now(),cursor:body.cursor});
      if(mode==='late')await new Promise(resolve=>setTimeout(resolve,200));
      const page=body.cursor?2:1;const all=[
        {type:'repository',id:'11800000-0000-4000-8000-000000000001',data:{repo_id:'11800000-0000-4000-8000-000000000001',name:owner+' neutral repository '+page,owner:'fixture',full_name:'fixture/neutral',url:'https://github.com/fixture/neutral',description:'Description-only '+body.query,primary_language:'TypeScript'}},
        {type:'person',id:'person-'+owner+'-'+page,data:{user_id:'owner-'+owner,profile_id:null,username:'neutral',display_name:owner+' neutral person '+page,bio:'Bio-only '+body.query,github_handle:null,avatar_url:null}},
        {type:'list',id:'list-'+owner+'-'+page,data:{id:'list-'+owner+'-'+page,name:owner+' neutral List '+page,description:'Description-only '+body.query,repositoryCount:7,source:'collection',nestedListCount:2}}
      ];
      const items=body.group==='all'?all:all.filter(x=>body.group==='repositories'?x.type==='repository':body.group==='people'?x.type==='person':x.type==='list');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({items,next_cursor:page===1?'page-two':null,mode:'hybrid'}));return;
    }
    if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(await readFile(path.join(directory,'bundle.js')));return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#panel-frame{height:100%;margin:0;background:#000;color:#fff}</style><main id="panel-frame"></main><script src="/bundle.js"></script>');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
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
  const click = async (label:string) => {
    const selector = `Array.from(document.querySelectorAll('[role="button"],[role="tab"]')).find(node=>node.innerText.trim()===${JSON.stringify(label)})`;
    await until(`Boolean(${selector})`); await evaluate(`(${selector}).click()`);
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `http://127.0.0.1:${address.port}` });
  await until('Boolean(document.querySelector("input"))');
  const type=async(value:string)=>{await evaluate(`(()=>{const input=document.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
  await type('g');await new Promise(resolve=>setTimeout(resolve,350));assert.equal(requests.length,0);
  const typedAt=Date.now();await type('go');await new Promise(resolve=>setTimeout(resolve,100));assert.equal(requests.length,0);
  await until('document.body.innerText.includes("Bio-only go") && document.body.innerText.includes("Description-only go")');
  assert.ok(requests[0].time-typedAt>=250,'existing300ms typing delay is retained');
  await click('Lists');await until('document.body.innerText.includes("7 repositories")');
  await click('Load more');await until('document.body.innerText.includes("A neutral List 2")');assert.equal(requests.at(-1)!.cursor,'page-two');
  await evaluate('window.fixture.change({offline:true})');await until('document.body.innerText.includes("Showing previous results")');
  assert.equal(await evaluate('document.body.innerText.includes("A neutral List 1")'),true);
  await evaluate('window.fixture.change({offline:false,owner:"B"})');await until('document.body.innerText.includes("B neutral List 1")');
  assert.equal(await evaluate('document.body.innerText.includes("A neutral List")'),false);
  await type('gol');await until('document.body.innerText.includes("Description-only gol")');
  await type('数据');await until('document.body.innerText.includes("Description-only 数据")');
  await type('😀');await until('document.body.innerText.includes("Description-only 😀")');
  await evaluate('window.fixture.change({mode:"late"})');await type('late');
  await until('window.fixture.lastSent==="late"');
  await evaluate('window.fixture.change({mode:"normal"})');await type('newquery');
  await until('document.body.innerText.includes("Description-only newquery")');await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal(await evaluate('document.body.innerText.includes("Description-only late")'),false,'late obsolete response cannot replace the active query');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  t.diagnostic('Actual Explore/SearchBar/ReactQuery/API mapping; controlled HTTP/auth/network/card presentation boundaries. SQL semantics are exercised separately by the real database parity suite.');
});
