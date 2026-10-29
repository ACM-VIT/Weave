import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

export async function buildExploreBrowser(directory: string) {
  const {build}=await import('esbuild');
  await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
    import React from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
    import {AppNavigationStack} from'./src/components/app-navigation-stack';
    import {TestNavigation} from'expo-router';
    window.fixture={owner:'A',offline:false,mode:'normal',abortedQueries:[],settledQueries:[]};
    window.fixture.change=(values)=>{Object.assign(window.fixture,values);window.dispatchEvent(new Event('fixture-change'));};
    createRoot(document.getElementById('panel-frame')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><TestNavigation><AppNavigationStack/></TestNavigation></QueryClientProvider>);
  `},outfile:path.join(directory,'bundle.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',
    alias:{'react-native':'react-native-web','lucide-react-native':path.resolve('node_modules/lucide-react-native/dist/esm/icons/index.mjs')},loader:{'.css':'empty','.png':'dataurl'},
    resolveExtensions:['.web.tsx','.tsx','.web.ts','.ts','.web.js','.js','.json'],define:{'process.env.NODE_ENV':'"development"',global:'globalThis',__DEV__:'true'},
    plugins:[{name:'explicit-search-platform-transport',setup(builder){
      const stubs={
        auth:"import{useEffect,useState}from'react';export function useAuth(){const[,update]=useState(0);useEffect(()=>{const event=()=>update(x=>x+1);window.addEventListener('fixture-change',event);return()=>window.removeEventListener('fixture-change',event);},[]);return{user:{user_id:window.fixture.owner}};}",
        net:"import{useEffect,useState}from'react';export function useNetInfo(){const[,update]=useState(0);useEffect(()=>{const event=()=>update(x=>x+1);window.addEventListener('fixture-change',event);return()=>window.removeEventListener('fixture-change',event);},[]);return{isConnected:!window.fixture.offline,isInternetReachable:!window.fixture.offline};}",
        router:`import React from'react';import{View,Text,Pressable}from'react-native';
          import{NavigationContainer,createNavigationContainerRef,useFocusEffect}from${JSON.stringify(path.resolve('node_modules/expo-router/build/react-navigation/native/index.js'))};
          import{createNativeStackNavigator}from${JSON.stringify(path.resolve('node_modules/expo-router/build/react-navigation/native-stack/index.js'))};
          import Explore from'./src/app/(tabs)/explore';
          export{useFocusEffect};const navigation=createNavigationContainerRef();const NativeStack=createNativeStackNavigator();
          export const router={push:value=>{window.fixture.route=value;navigation.navigate(value.pathname.startsWith('/')?value.pathname.slice(1):value.pathname,value.params);}};
          function Detail(){return <View style={{flex:1,backgroundColor:'#000'}}><Text>Repository detail</Text><Pressable accessibilityRole="button" accessibilityLabel="Back to Explore" onPress={()=>navigation.goBack()}><Text>Back to Explore</Text></Pressable></View>;}
          export function TestNavigation({children}){return <NavigationContainer ref={navigation}>{children}</NavigationContainer>;}
          export function Stack(props){return <NativeStack.Navigator initialRouteName="(tabs)" {...props}><NativeStack.Screen name="(tabs)" component={Explore}/><NativeStack.Screen name="repository/[repoId]" component={Detail}/></NativeStack.Navigator>;}`,
        keyboard:"import React from'react';import{View}from'react-native';export const KeyboardSurface=props=><View {...props}/>;",
        crypto:"export const randomUUID=()=>window.crypto.randomUUID();",
        client:"export async function apiV2(path,options={}){if(!options.body){const url=new URL('/fixture'+path,location.origin);url.searchParams.set('owner',window.fixture.owner);url.searchParams.set('mode',window.fixture.mode);const response=await fetch(url,options);if(!response.ok)throw Error('Controlled browse failure');return response.json();}const query=JSON.parse(options.body).query;window.fixture.lastSent=query;options.signal?.addEventListener('abort',()=>window.fixture.abortedQueries.push(query),{once:true});try{const response=await fetch('/fixture/search?owner='+window.fixture.owner+'&mode='+window.fixture.mode,options);if(!response.ok)throw Error('Controlled transport failure');return await response.json();}finally{window.fixture.settledQueries.push(query);}}",
        storage:"export async function getStorageItem(){return 'fixture-backend-token';}"
      };
      const route=(filter,key)=>builder.onResolve({filter},()=>({path:key,namespace:'fixture'}));
      route(/^@\/store\/AuthContext$/,'auth');route(/^@react-native-community\/netinfo$/,'net');route(/^expo-router$/,'router');
      route(/^@\/components\/keyboard\/keyboard-layout$/,'keyboard');route(/^expo-crypto$/,'crypto');
      route(/api\/client$|^\.\/client$/,'client');route(/utils\/storage$/,'storage');
      builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],resolveDir:process.cwd(),loader:args.path==='keyboard'||args.path==='router'?'tsx':'js'}));
    }}]
  });
  execFileSync(process.execPath, [path.resolve('node_modules/tailwindcss/lib/cli.js'),
    '-i', 'src/global.css', '-o', path.join(directory, 'global.css')], { cwd: process.cwd(), stdio: 'pipe' });
}

test('actual Explore retains Latest continuation, original Trending cards and broad search isolation', {
  skip: process.env.RUN_SEARCH_BROAD_BROWSER !== '1', timeout: 45_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(),'weave-search-broad-browser-'));
  await buildExploreBrowser(directory);
  const requests:Array<{query:string;owner:string;group:string;time:number;cursor:string|null}>=[];
  const browseRequests: Array<{ path: string; offset: number; period: string }> = [];
  let releaseTrending!: () => void;
  const heldTrending = new Promise<void>(resolve => { releaseTrending = resolve; });
  let releaseLate!: () => void;
  const lateResponse = new Promise<void>(resolve => { releaseLate = resolve; });
  let lateResponseFinished = false;
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url!,'http://localhost');
    if (url.pathname === '/fixture/repositories' || url.pathname === '/fixture/repositories/trending') {
      const trending = url.pathname.endsWith('/trending');
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const period = url.searchParams.get('period') ?? 'daily';
      browseRequests.push({ path: url.pathname, offset, period });
      if (trending && url.searchParams.get('mode') === 'pending') await heldTrending;
      if (trending && url.searchParams.get('mode') === 'error') { res.writeHead(503); res.end(); return; }
      const items = Array.from({ length: trending || offset === 0 ? 24 : 1 }, (_, index) =>
        !trending && offset === 0 && index === 7 ? {} : {
          repo_id: `${trending ? period : 'latest'}-${offset + index}`,
          full_name: `fixture/${trending ? period : 'latest'}-${offset + index}`,
          description: 'A repository with clear boundaries and a readable summary.',
          primary_language: 'TypeScript', star_count: 1200, fork_count: 12,
          ...(trending ? { position: index, score: 0.75, features: { trend_velocity: 12 } } : {}),
        });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ items, ...(trending ? { period, available_periods: ['daily', 'weekly'] } : { limit: 24, offset }) }));
      return;
    }
    if(url.pathname==='/fixture/search'){
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());
      const owner=url.searchParams.get('owner')!,mode=url.searchParams.get('mode');requests.push({query:body.query,owner,group:body.group,time:Date.now(),cursor:body.cursor});
      if(mode==='late')await lateResponse;
      const page=body.cursor?2:1;const all=[
        {type:'repository',id:'11800000-0000-4000-8000-000000000001',data:{repo_id:'11800000-0000-4000-8000-000000000001',name:owner+' neutral repository '+page,owner:'fixture',full_name:'fixture/neutral',url:'https://github.com/fixture/neutral',description:'Description-only '+body.query,primary_language:'TypeScript'}},
        {type:'person',id:'person-'+owner+'-'+page,data:{user_id:'owner-'+owner,profile_id:null,username:'neutral',display_name:owner+' neutral person '+page,bio:'Bio-only '+body.query,github_handle:null,avatar_url:null}},
        {type:'list',id:'list-'+owner+'-'+page,data:{id:'list-'+owner+'-'+page,name:owner+' neutral List '+page,description:'Description-only '+body.query,repositoryCount:7,source:'collection',nestedListCount:2}}
      ];
      const items=body.group==='all'?all:all.filter(x=>body.group==='repositories'?x.type==='repository':body.group==='people'?x.type==='person':x.type==='list');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({items,next_cursor:page===1?'page-two':null,mode:'hybrid'}));if(mode==='late')lateResponseFinished=true;return;
    }
    if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(await readFile(path.join(directory,'bundle.js')));return;}
    if(url.pathname==='/global.css'){res.setHeader('Content-Type','text/css');res.end(await readFile(path.join(directory,'global.css')));return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/global.css"><style>html,body,#panel-frame{height:100%;margin:0;background:#000;color:#fff}#panel-frame{display:flex;flex-direction:column}</style><main id="panel-frame"></main><script src="/bundle.js"></script>');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
  const chrome = spawn(process.env.CHROMIUM_BIN ?? 'chromium', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${path.join(directory, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
  let spawnError: Error | undefined; chrome.on('error', error => { spawnError = error; });
  let socket: WebSocket | undefined;
  t.after(async () => {
    releaseLate();
    releaseTrending();
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
  const browserErrors: unknown[] = [];
  const pending = new Map<number, (value: any) => void>();
  socket.onmessage = message => { const value = JSON.parse(String(message.data)); if(value.method==='Runtime.exceptionThrown')browserErrors.push(value.params.exceptionDetails.exception?.description??value.params.exceptionDetails.text); pending.get(value.id)?.(value); pending.delete(value.id); };
  const send = (method: string, params = {}) => new Promise<any>(resolve => {
    const id = ++sequence; pending.set(id, resolve); socket!.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.result?.exceptionDetails, JSON.stringify(result));
    return result.result?.result?.value;
  };
  const until = async (expression: string) => {
    for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.fail(`Browser state did not settle: ${expression}\n${await evaluate('document.body.innerText')}\nBrowse requests: ${JSON.stringify(browseRequests)}\nErrors: ${JSON.stringify(browserErrors)}`);
  };
  const click = async (label:string) => {
    const selector = `Array.from(document.querySelectorAll('[role="button"],[role="tab"],[tabindex="0"]')).find(node=>node.innerText.trim().toLowerCase()===${JSON.stringify(label.toLowerCase())})`;
    await until(`Boolean(${selector})`); await evaluate(`(${selector}).click()`);
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `http://127.0.0.1:${address.port}` });
  await until('Boolean(document.querySelector("input"))');
  const type=async(value:string)=>{await evaluate(`(()=>{const input=document.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
  await until('document.body.innerText.includes("latest-0") && document.body.innerText.includes("latest-1")');
  const latestGeometry = await evaluate(`['latest-0','latest-1'].map(name=>{const box=document.querySelector('[aria-label="Open '+name+' by fixture"]').getBoundingClientRect();return {left:box.left,right:box.right,top:box.top};})`);
  assert.ok(latestGeometry[0].right <= latestGeometry[1].left, 'Latest keeps its two-column masonry');
  // Exercise the production Stack configuration and FlashList together. A
  // no-op router or fake list cannot detect display:none collapsing the cards.
  await evaluate(`(()=>{let node=document.querySelector('[aria-label="Open latest-0 by fixture"]');while(node&&getComputedStyle(node).overflowY!=='auto')node=node.parentElement;node.scrollTop=420;})()`);
  await until(`Array.from(document.querySelectorAll('[role="link"][aria-label^="Open latest-"]')).some(node=>{const r=node.getBoundingClientRect();return r.top>220&&r.bottom<700;})`);
  const returningCard = await evaluate(`(()=>{const node=Array.from(document.querySelectorAll('[role="link"][aria-label^="Open latest-"]')).find(node=>{const r=node.getBoundingClientRect();return r.top>220&&r.bottom<700;});let scroller=node.parentElement;while(getComputedStyle(scroller).overflowY!=='auto')scroller=scroller.parentElement;const r=node.getBoundingClientRect();return{label:node.getAttribute('aria-label'),width:r.width,height:r.height,top:r.top,offset:scroller.scrollTop};})()`);
  assert.ok(returningCard.offset>0);
  const returningSelector=JSON.stringify(`[aria-label="${returningCard.label}"]`);
  await evaluate(`document.querySelector(${returningSelector}).click()`);
  await until(`Boolean(document.querySelector('[aria-label="Back to Explore"]'))`);
  const coveredCard=await evaluate(`(()=>{const r=document.querySelector(${returningSelector}).getBoundingClientRect();return{width:r.width,height:r.height};})()`);
  assert.equal(coveredCard.width,returningCard.width,'the real covered Stack must retain the masonry width');
  assert.equal(coveredCard.height,returningCard.height,'covered cards must not collapse and rebuild on Back');
  await click('Back to Explore');
  await until(`!document.querySelector('[aria-label="Back to Explore"]')`);
  const returnedCard=await evaluate(`(()=>{const node=document.querySelector(${returningSelector});let scroller=node.parentElement;while(getComputedStyle(scroller).overflowY!=='auto')scroller=scroller.parentElement;const r=node.getBoundingClientRect();return{width:r.width,height:r.height,top:r.top,offset:scroller.scrollTop};})()`);
  assert.deepEqual(returnedCard,{width:returningCard.width,height:returningCard.height,top:returningCard.top,offset:returningCard.offset},'Back preserves card geometry and the scrolled position');
  const scrollToEnd = async () => evaluate(`(()=>{for(const node of document.querySelectorAll('div')){if(node.scrollHeight>node.clientHeight&&['auto','scroll'].includes(getComputedStyle(node).overflowY))node.scrollTop=node.scrollHeight;}})()`);
  await scrollToEnd();
  await until(`Array.from(document.querySelectorAll('[role="button"]')).some(node=>node.innerText.trim()==='Load more')`);
  assert.deepEqual(browseRequests.map(request => request.offset), [0], 'scrolling alone does not fetch another page');
  await click('Load more');
  await until(`!Array.from(document.querySelectorAll('[role="button"]')).some(node=>node.innerText.trim()==='Load more')`);
  await scrollToEnd();
  await until('document.body.innerText.includes("latest-24")');
  assert.deepEqual(browseRequests.map(request => request.offset), [0, 24]);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('[role="button"]')).some(node=>node.innerText.trim()==='Load more')`), false, 'the short second raw page ends continuation');
  await evaluate('window.fixture.change({mode:"pending"})');
  await click('Trending');
  await until('Boolean(document.querySelector(\'[aria-label="Loading results"]\'))');
  await evaluate('window.fixture.change({mode:"normal"})'); releaseTrending();
  await until('document.body.innerText.includes("fixture/daily-0")');
  for (const width of [320, 820]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 568, deviceScaleFactor: 1, mobile: true });
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const cards = await evaluate(`Array.from(document.querySelectorAll('[role="button"][aria-label^="Rank "]')).slice(0,4).map(node=>{const box=node.getBoundingClientRect(),style=getComputedStyle(node);return{left:box.left,right:box.right,top:box.top,bottom:box.bottom,background:style.backgroundColor,border:parseFloat(style.borderTopWidth)};})`);
    assert.equal(cards.length, 4);
    for (const [index, card] of cards.entries()) {
      assert.ok(card.left >= 19 && card.right <= width - 19, 'Trending cards retain the original horizontal inset');
      assert.ok(card.right - card.left >= width - 42, 'Trending cards span one column');
      assert.notEqual(card.background, 'rgb(0, 0, 0)', 'repository boxes remain distinct from the page');
      assert.ok(card.border >= 1, 'ordinary cards have a visible boundary too');
      if (index > 0) assert.ok(card.top >= cards[index - 1].bottom + 9, 'repository boxes cannot overlap');
    }
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  }
  await evaluate('window.fixture.change({mode:"error"})');
  await click('weekly');
  await until('document.body.innerText.includes("Could not load results")');
  await evaluate('window.fixture.change({mode:"normal"})');
  await click('Try again');
  await until('document.body.innerText.includes("fixture/weekly-0")');
  await evaluate(`document.querySelector('[aria-label="Rank 1, fixture/weekly-0"]').click()`);
  assert.deepEqual(await evaluate('window.fixture.route'), { pathname: '/repository/[repoId]', params: { repoId: 'weekly-0' } });
  await click('Back to Explore');
  await until(`!document.querySelector('[aria-label="Back to Explore"]')`);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
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
  await evaluate(`window.fixture.obsoleteFlashes=[];window.fixture.observer=new MutationObserver(()=>{if(document.body.innerText.includes("Description-only late"))window.fixture.obsoleteFlashes.push(true);});window.fixture.observer.observe(document.body,{subtree:true,childList:true,characterData:true});`);
  await evaluate('window.fixture.change({mode:"normal"})');await type('newquery');
  await until('document.body.innerText.includes("Description-only newquery")');
  await until('window.fixture.abortedQueries.includes("late") && window.fixture.settledQueries.includes("late")');
  assert.equal(lateResponseFinished,false,'old response must remain held until new results are visible');
  releaseLate();
  for(let n=0;n<100&&!lateResponseFinished;n++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(lateResponseFinished,true);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(await evaluate('document.body.innerText.includes("Description-only newquery")'),true);
  assert.equal(await evaluate('window.fixture.obsoleteFlashes.length'),0,'obsolete results must never flash after the latest query');
  assert.equal(await evaluate('document.body.innerText.includes("Description-only late")'),false,'late obsolete response cannot replace the active query');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  t.diagnostic('Actual app Stack options, Expo React Navigation native-stack web renderer, FlashList, Explore/cards/SearchBar/ReactQuery/API mapping; controlled HTTP/auth/network and detail-screen content. Covered/returned card geometry, scroll position, Latest continuation and Trending geometry are browser checks, not native proof. SQL semantics are exercised separately by the real database parity suite.');
});
