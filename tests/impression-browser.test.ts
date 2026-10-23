import assert from 'node:assert/strict';
import {spawn,type ChildProcess}from'node:child_process';
import {once}from'node:events';
import {createRequire}from'node:module';
import {mkdtemp,readFile,rm}from'node:fs/promises';
import {createServer}from'node:http';
import {tmpdir}from'node:os';
import path from'node:path';
import crypto from'node:crypto';
import test from'node:test';

test('rendered feed qualification, original IDs, durable retry/navigation and account leases reach real SQL',{
 skip:process.env.RUN_IMPRESSION_BROWSER!=='1',timeout:90_000,
},async t=>{
 const database=new URL(process.env.DATABASE_URL??''),redis=new URL(process.env.REDIS_TEST_URL??'');
 assert.ok(['127.0.0.1','localhost'].includes(database.hostname)&&database.pathname==='/weave_scroll'&&process.env.NODE_ENV!=='production');
 assert.ok(['127.0.0.1','localhost'].includes(redis.hostname)&&redis.pathname==='/15');
 const backendRequire=createRequire(path.resolve('backend/package.json')),postgres=backendRequire('postgres');
 const admin=postgres(database.toString(),{max:2,prepare:false});
 const owners=[crypto.randomUUID(),crypto.randomUUID()],repo=crypto.randomUUID(),serves=[crypto.randomUUID(),crypto.randomUUID()],sessions=[crypto.randomUUID(),crypto.randomUUID()],board=crypto.randomUUID();
 const jwt=backendRequire('jsonwebtoken'),secret='browser-impression-fixture-only',tokens=Object.fromEntries(owners.map(owner=>[owner,jwt.sign({userId:owner,email:'fixture@example.invalid'},secret,{expiresIn:180})]));
 const directory=await mkdtemp(path.join(tmpdir(),'weave-impression-browser-'));
 let child:ChildProcess|undefined,chrome:ChildProcess|undefined,socket:WebSocket|undefined,server:ReturnType<typeof createServer>|undefined;
 let cleaningUp=false;const proxyErrors:unknown[]=[];
 const captured:Array<{owner:string;body:any;status:number}>=[];
 const stop=async(process:ChildProcess|undefined)=>{if(!process||process.exitCode!==null||process.signalCode!==null)return;const exited=once(process,'exit');process.kill('SIGKILL');await exited;};
 t.after(async()=>{
  cleaningUp=true;socket?.close();await stop(chrome);await stop(child);
  if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
  try{await admin`DELETE FROM telemetry.interaction_events WHERE user_id=ANY(${owners}::uuid[])`;await admin`DELETE FROM auth.users WHERE id=ANY(${owners}::uuid[])`;await admin`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;}
  finally{await admin.end({timeout:1});await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
 });
 for(const owner of owners){await admin`INSERT INTO auth.users(id) VALUES(${owner}::uuid)`;await admin`INSERT INTO app.users(user_id,username,status) VALUES(${owner}::uuid,${'browser_'+owner.replaceAll('-','')},'active')`;await admin`INSERT INTO app.user_stats(user_id) VALUES(${owner}::uuid)`;}
 await admin`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url) VALUES(${repo}::uuid,${String(crypto.randomInt(1000000000,2000000000))}::bigint,'fixture','project','fixture/project','https://github.com/fixture/project')`;
 await admin`INSERT INTO app.repo_content(repo_id,content_version,content_hash,description,readme) VALUES(${repo}::uuid,1,'browser-fixture','Isolated browser attribution fixture','# Fixture README')`;
 await admin`INSERT INTO app.boards(board_id,user_id,name,visibility) VALUES(${board}::uuid,${owners[0]}::uuid,'Tarun linkage List','private')`;
 for(const [index,owner]of owners.entries()){
  await admin`INSERT INTO telemetry.feed_serves(serve_id,feed_request_id,user_id,session_id,feed_version,source) VALUES(${serves[index]}::uuid,${crypto.randomUUID()}::uuid,${owner}::uuid,${sessions[index]}::uuid,1,'fixture')`;
  await admin`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source) VALUES(${serves[index]}::uuid,0,${repo}::uuid,0.3,'semantic')`;
 }
 child=spawn(process.execPath,['--import','tsx',path.resolve('backend/tests/fixtures/impressionBrowserApi.ts')],{cwd:path.resolve('backend'),env:{...process.env,NODE_ENV:'test',DATABASE_URL:database.toString(),REDIS_URL:redis.toString(),JWT_SECRET:secret,SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_KEY:'fixture',ML_V2_RECOMMENDATIONS:'false',ML_FEEDBACK_OUTBOX:'false',TRENDING_INGESTION:'false',FEED_V2:'false',FEED_RESERVATIONS:'false',SCORING_CAPTURE_ENABLED:'false',SCORING_EXPORT_ENABLED:'false',SCORING_RETENTION_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
 child.stderr?.resume();
 const apiPort=await new Promise<string>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Owned API did not bind')),10000);child!.stdout!.on('data',chunk=>{output+=String(chunk);const match=/IMPRESSION_API_PORT=(\d+)/.exec(output);if(match){clearTimeout(timer);resolve(match[1]);}});child!.once('error',reject);child!.once('exit',()=>reject(new Error('Owned API exited')));});
 const {build}=await import('esbuild');
 await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
 import React,{useEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider,useQuery}from'@tanstack/react-query';
 import{Linking}from'react-native';import{RepositoryFeedItem}from'./src/components/home/RepositoryFeedItem';import RepositoryRoute from'./src/app/repository/[repoId]';
 import{mapBackendToFrontend}from'./src/utils/feed-items';import{repositoryHref,buildRepositoryShareContent}from'./src/utils/repository-links';import{getActivityOutbox}from'./src/services/activityOutboxClient';import{authSessionLifecycle}from'./src/api/session-lifecycle';
 const owners=${JSON.stringify(owners)},serves=${JSON.stringify(serves)},sessions=${JSON.stringify(sessions)},repo=${JSON.stringify(repo)},tokens=${JSON.stringify(tokens)};
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 window.fixture={owner:owners[0],tokens,offline:true,prepared:[],github:[],route:{params:{}},cache:client};Linking.openURL=async url=>{window.fixture.github.push(url);};
 const data=owner=>{const index=owners.indexOf(owner);return JSON.parse(localStorage.getItem('fixture-cache-'+owner)||'null')||{pages:[{items:[{repo_id:repo,full_name:'fixture/project',serve_id:serves[index],position:0,feed_session_id:sessions[index],viewer_reaction:null,description:'Isolated browser attribution fixture',readme_md:'# Fixture README',client_original_impression:null}]}],pageParams:[null]};};
 for(const owner of owners)client.setQueryData(['feed',owner],data(owner));
 function Fixture(){const[owner,setOwner]=useState(owners[0]),[mounted,setMounted]=useState(true),[view,setView]=useState('feed');const root=useRef(null),card=useRef(null),[visible,setVisible]=useState(false);
 const cached=useQuery({queryKey:['feed',owner],queryFn:async()=>data(owner),staleTime:Infinity}).data;const repository=mapBackendToFrontend(cached.pages[0].items[0]);
 useEffect(()=>{if(!root.current||!card.current||!mounted||view!=='feed')return;root.current.scrollTop=400;const observer=new IntersectionObserver(entries=>setVisible(entries[0].intersectionRatio>=.5),{root:root.current,threshold:[0,.5,1]});observer.observe(card.current);return()=>observer.disconnect();},[owner,mounted,view]);
 window.fixture.show=()=>{root.current.scrollTop=0;};window.fixture.hide=()=>{root.current.scrollTop=400;};window.fixture.unmount=()=>setMounted(false);window.fixture.mount=()=>setMounted(true);window.fixture.back=()=>setView('feed');
 window.fixture.navigate=route=>{window.fixture.route=route;setView('detail');};window.fixture.retireOnly=()=>authSessionLifecycle.retire(authSessionLifecycle.currentGeneration());
 window.fixture.switchAccount=()=>{authSessionLifecycle.retire(authSessionLifecycle.currentGeneration());window.fixture.owner=owners[1];setOwner(owners[1]);setView('feed');};
 window.fixture.pending=()=>getActivityOutbox(owner).pendingCount();window.fixture.flush=()=>getActivityOutbox(owner).flush(tokens[owner],authSessionLifecycle.currentGeneration());
 window.fixture.publicShare=()=>buildRepositoryShareContent('fixture/project','https://weave.test/repository/'+repo);
 const queue=(event,flushNow)=>{window.fixture.prepared.push({owner,...event});void getActivityOutbox(owner).enqueue(event).then(()=>{localStorage.setItem('fixture-cache-'+owner,JSON.stringify(client.getQueryData(['feed',owner])));return getActivityOutbox(owner).flush(tokens[owner],authSessionLifecycle.currentGeneration());}).catch(()=>{});};
 return <div>{view==='detail'?<RepositoryRoute/>:<div id='viewport' ref={root} style={{height:600,overflow:'auto'}}>{mounted?<div ref={card}><RepositoryFeedItem repository={repository} pageWidth={390} pageHeight={600} isViewable={visible} onQueueActivity={queue} onRepositoryPress={token=>window.fixture.navigate(repositoryHref(repo,token))}/></div>:null}<div style={{height:700}}/></div>}</div>;}
 createRoot(document.getElementById('app')).render(<QueryClientProvider client={client}><Fixture/></QueryClientProvider>);
 `},outfile:path.join(directory,'bundle.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',resolveExtensions:['.web.tsx','.tsx','.web.ts','.ts','.web.js','.js','.json'],loader:{'.js':'jsx','.css':'empty'},alias:{'react-native':'react-native-web'},define:{'process.env.NODE_ENV':'"development"','process.env.EXPO_OS':'"web"','__DEV__':'true'},banner:{js:'var process={env:{NODE_ENV:"development",EXPO_OS:"web"}};'},plugins:[{name:'native-platform-boundaries-real-http',setup(builder){
 const stubs:Record<string,string>={
 keyboard:"import{ScrollView,KeyboardAvoidingView}from'react-native';export const KeyboardAwareScrollView=ScrollView;export {KeyboardAvoidingView};",
 icons:`export * from '${path.resolve('node_modules/lucide-react-native/dist/esm/icons/index.mjs')}';export{CodeXml as Code2,CircleCheck as CheckCircle2}from'${path.resolve('node_modules/lucide-react-native/dist/esm/icons/index.mjs')}';`,
 image:"import{Image as NativeImage}from'react-native';export const Image=NativeImage;",
 svg:"import React from'react';export default function Asset(){return <svg aria-hidden='true'/>;}",
 auth:"export const useAuth=()=>({user:{user_id:window.fixture.owner,onboarding_completed:true},isLoading:false,checkOnboardingStatus:async()=>{}});",
 storage:"export async function getStorageItem(key){return key==='access_token'?window.fixture.tokens[window.fixture.owner]:null;}export const getItemAsync=getStorageItem;export async function setStorageItem(){};export async function removeStorageItem(){};",
 client:"export async function apiV2Raw(path,options={},token){const response=await fetch('/api/v2'+path,{...options,headers:{'content-type':'application/json',...(options.headers||{}),...(token?{authorization:'Bearer '+token}:{}),'x-fixture-offline':String(window.fixture.offline)}});const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'HTTP failed'),{status:response.status});return{data,response};}export async function apiV2(...args){const{data}=await apiV2Raw(...args);return data.success===true?data.data:data;}",
 safe:"import{View}from'react-native';export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});export const SafeAreaView=View;",
 gestures:"import React from'react';const chain=new Proxy({},{get:()=>()=>chain});export const Gesture={Pan:()=>chain,Native:()=>chain};export function GestureDetector({children}){return children;}export function GestureHandlerRootView({children}){return children;}",
 animated:"import{useRef}from'react';import{View,ScrollView}from'react-native';export default{View,ScrollView,createAnimatedComponent:component=>component};export const useReducedMotion=()=>true;export function useSharedValue(initial){return useRef({value:initial,get(){return this.value},set(value){this.value=typeof value==='function'?value(this.value):value;}}).current;}export const useAnimatedStyle=fn=>fn();export const withSpring=value=>value;export const withTiming=value=>value;export const runOnJS=fn=>fn;export const interpolate=(value)=>value;export const Extrapolation={CLAMP:'clamp'};",
 worklets:"export const scheduleOnRN=(fn,...args)=>fn(...args);",
 haptics:"export const AndroidHaptics={Segment_Tick:1};export async function performAndroidHapticsAsync(){}export async function selectionAsync(){};export const NotificationFeedbackType={Success:1};export async function notificationAsync(){};",
 blur:"import{View}from'react-native';export const BlurView=View;",
 router:"export const useLocalSearchParams=()=>window.fixture.route.params;export const router={push:route=>window.fixture.navigate(route),canGoBack:()=>true,back:()=>window.fixture.back(),replace:()=>window.fixture.back()};export const useRouter=()=>router;",
 popup:"export function ReadmePopup(){return null;}export function CommentSheet(){return null;}",
 share:"export function ShareRepositorySheet(){return null;}",
 filesystem:"export const Paths={document:'native-disabled'};export class File{constructor(){throw Error('Native file path reached in web test');}}export class Directory{constructor(){throw Error('Native file path reached in web test');}}",
 };
 const names:Record<string,string>={'react-native-safe-area-context':'safe','react-native-gesture-handler':'gestures','react-native-reanimated':'animated','react-native-worklets':'worklets','expo-haptics':'haptics','expo-blur':'blur','expo-router':'router','expo-file-system':'filesystem'};
 builder.onResolve({filter:/^(react-native-safe-area-context|react-native-gesture-handler|react-native-reanimated|react-native-worklets|expo-haptics|expo-blur|expo-router|expo-file-system)$/},args=>({path:names[args.path],namespace:'fixture'}));
 builder.onResolve({filter:/^react-native-keyboard-controller$/},()=>({path:'keyboard',namespace:'fixture'}));builder.onResolve({filter:/^lucide-react-native$/},()=>({path:'icons',namespace:'fixture'}));builder.onResolve({filter:/^expo-image$/},()=>({path:'image',namespace:'fixture'}));builder.onResolve({filter:/\.svg$/},()=>({path:'svg',namespace:'fixture'}));
 builder.onResolve({filter:/store\/AuthContext$/},()=>({path:'auth',namespace:'fixture'}));builder.onResolve({filter:/utils\/storage$/},()=>({path:'storage',namespace:'fixture'}));builder.onResolve({filter:/api\/client$|^\.\/client$/},()=>({path:'client',namespace:'fixture'}));
 builder.onResolve({filter:/\/ReadmePopup$|\/CommentSheet$/},()=>({path:'popup',namespace:'fixture'}));builder.onResolve({filter:/\/share-repository-sheet$/},()=>({path:'share',namespace:'fixture'}));
 builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],resolveDir:process.cwd(),loader:'tsx'}));
 }}]});
 server=createServer(async(req,res)=>{
  try {
  const url=new URL(req.url!,'http://localhost');
  if(url.pathname.startsWith('/api/')){
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>256000){res.writeHead(413);res.end();return;}}
   if(url.pathname==='/api/v2/interactions/batch'&&req.headers['x-fixture-offline']==='true'){res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"fixture network outage"}');return;}
   const response=await fetch(`http://127.0.0.1:${apiPort}`+url.pathname+url.search,{method:req.method,headers:{'content-type':'application/json',authorization:String(req.headers.authorization??'')},...(body?{body}:{})});
   if(body)captured.push({owner:String(req.headers.authorization),body:JSON.parse(body),status:response.status});
   res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json'});res.end(await response.text());return;
  }
  if(url.pathname==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(await readFile(path.join(directory,'bundle.js')));return;}
  if(url.pathname==='/font.ttf'){res.end(await readFile('assets/fonts/NataSans-Regular.ttf'));return;}
  res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>@font-face{font-family:NataSans-Regular;src:url(/font.ttf)}body{margin:0;background:#000;color:white}#app{max-width:390px;margin:auto}</style><main id="app"></main><script src="/bundle.js"></script>');
  }catch(error){if(!cleaningUp)proxyErrors.push(error);if(!res.destroyed){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:'Owned fixture upstream unavailable'}));}}
 });await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const bound=server.address();assert.ok(bound&&typeof bound==='object');
 chrome=spawn(process.env.CHROMIUM_BIN??'chromium',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${path.join(directory,'chrome')}`,'about:blank'],{stdio:'ignore'});
 let debugPort='';for(let i=0;i<100;i++){try{debugPort=(await readFile(path.join(directory,'chrome/DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}assert.ok(debugPort);
 const tab=await(await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`,{method:'PUT'})).json()as{webSocketDebuggerUrl:string};socket=new WebSocket(tab.webSocketDebuggerUrl);await new Promise<void>((resolve,reject)=>{socket!.onopen=()=>resolve();socket!.onerror=reject;});
 const runtimeErrors:any[]=[];let sequence=0;const pending=new Map<number,(value:any)=>void>();socket.onmessage=message=>{const value=JSON.parse(String(message.data));if(value.method==='Runtime.exceptionThrown')runtimeErrors.push(value.params?.exceptionDetails?.exception?.description??value.params?.exceptionDetails?.text);pending.get(value.id)?.(value);pending.delete(value.id);};
 const send=(method:string,params={})=>new Promise<any>((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},8000);pending.set(id,value=>{clearTimeout(timer);resolve(value);});socket!.send(JSON.stringify({id,method,params}));});
 const evaluate=async(expression:string)=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!result.result?.exceptionDetails,JSON.stringify(result));return result.result?.result?.value;};
 const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));const until=async(expression:string)=>{for(let i=0;i<150;i++){if(await evaluate('(async()=>Boolean(await ('+expression+')))()'))return;await wait(25);}assert.fail(`Browser did not settle ${expression}: ${await evaluate('document.body.innerText')} errors=${JSON.stringify(runtimeErrors)} labels=${await evaluate("JSON.stringify([...document.querySelectorAll('[aria-label]')].map(el=>el.getAttribute('aria-label')))")}`);};
 const click=async(label:string)=>{await until(`!!document.querySelector('[aria-label="${label}"]')`);await evaluate(`document.querySelector('[aria-label="${label}"]').click()`);};
 await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await send('Page.navigate',{url:`http://127.0.0.1:${bound.port}`});
 await until('!!window.fixture?.show&&document.body.innerText.includes("project")');await wait(1200);assert.equal(await evaluate('window.fixture.prepared.length'),0,'less than50percent stays neutral');
 await evaluate('window.fixture.show()');await click('Like repository');await wait(1200);
 const first=await evaluate('window.fixture.prepared.find(event=>event.action==="impression")');assert.ok(first);assert.equal(first.session_id,sessions[0]);
 assert.equal(await evaluate('window.fixture.prepared.find(event=>event.action==="like").impression_event_id'),undefined,'early click cannot invent a qualified impression');
 await click('Unlike repository');await evaluate('window.fixture.hide()');await wait(200);
 assert.equal(await evaluate('window.fixture.prepared.find(event=>event.action==="unlike").impression_event_id'),first.event_id);
 assert.equal(await evaluate('window.fixture.prepared.filter(event=>event.action==="dwell").length'),0,'quick passive dwell remains neutral');
 await evaluate('window.fixture.unmount()');await wait(50);await evaluate('window.fixture.mount()');await wait(80);await evaluate('window.fixture.show()');await wait(1200);await click('Dislike repository');
 assert.equal(await evaluate('window.fixture.prepared.find(event=>event.action==="dislike").impression_event_id'),first.event_id,'remount/repeated impression retains the first original UUID');
 await until('(localStorage.getItem("fixture-cache-"+window.fixture.owner)||"").includes("'+first.event_id+'")');
 await send('Page.reload');await until('!!window.fixture?.flush');await evaluate('window.fixture.offline=false;window.fixture.flush()');
 await until('window.fixture.pending().then(count=>count===0)');
 const persisted=await admin`SELECT event_id,event_type,session_id,impression_event_id FROM telemetry.interaction_events WHERE user_id=${owners[0]}::uuid`;
 assert.ok(persisted.some((event:any)=>event.event_id===first.event_id));for(const event of persisted)assert.equal(event.session_id,sessions[0]);
 assert.equal(persisted.find((event:any)=>event.event_type==='dislike').impression_event_id,first.event_id,'real durable snapshot reload keeps the reference');
 await evaluate('window.fixture.show()');await wait(1100);await click('View project repository details');await until('document.body.innerText.includes("Repository")||document.querySelector(\'[aria-label="Open fixture/project on GitHub"]\')');
 await click('Open fixture/project on GitHub');await until('window.fixture.pending().then(count=>count===0)');
 const detail=await admin`SELECT impression_event_id,session_id FROM telemetry.interaction_events WHERE user_id=${owners[0]}::uuid AND event_type='github_open' ORDER BY server_received_at DESC LIMIT 1`;
 assert.equal(detail[0].impression_event_id,first.event_id);assert.equal(detail[0].session_id,sessions[0]);
 await click('Save repository to Lists');await click('Tarun linkage List, 0 repositories');
 await click('Save repository to selected Lists');await until(`!document.querySelector('[aria-label="Save repository to selected Lists"]')`);
 const saved=await admin`SELECT impression_event_id,session_id FROM telemetry.interaction_events WHERE user_id=${owners[0]}::uuid AND event_type='save'`;
 assert.equal(saved[0].impression_event_id,first.event_id);assert.equal(saved[0].session_id,sessions[0]);
 await evaluate('window.fixture.back()');await until(`!!document.querySelector('[aria-label="Like repository"]')`);
 await evaluate('window.fixture.show();window.fixture.retireOnly()');const beforeRetire=await evaluate('window.fixture.prepared.length');await wait(1200);
 assert.equal(await evaluate('window.fixture.prepared.length'),beforeRetire,'retired owner timer cannot enqueue');
 await evaluate('window.fixture.switchAccount()');await wait(100);await evaluate('window.fixture.show()');await wait(1200);await click('Like repository');
 const other=await evaluate('window.fixture.prepared.filter(event=>event.owner===window.fixture.owner)');
 assert.ok(other.some((event:any)=>event.action==='impression'));assert.ok(other.every((event:any)=>event.session_id===sessions[1]&&event.impression_event_id!==first.event_id));
 await until('window.fixture.pending().then(count=>count===0)');assert.deepEqual(proxyErrors,[],'unexpected proxy failures remain fatal during the test');
 const share=await evaluate('window.fixture.publicShare()');assert.doesNotMatch(JSON.stringify(share),new RegExp([first.event_id,serves[0],sessions[0],'feedNavigation'].join('|')));
 assert.ok(captured.some(request=>request.body.events?.some((event:any)=>event.impression_event_id===first.event_id)));
 t.diagnostic('Actual RNWeb card/detail, measured IntersectionObserver50percent/real1s timer, durable localStorage outbox and registered Express/PostgreSQL. Explicit native gesture/OS-share/auth-presentation boundaries; full FlatList/native acceptance remains separate.');
});
