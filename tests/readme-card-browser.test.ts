import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('README card remains visible without a digest and opens canonical README separately', {
  skip: process.env.RUN_README_CARD_BROWSER !== '1', timeout: 30_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'weave-readme-card-'));
  const { build } = await import('esbuild');
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React,{useState,useLayoutEffect}from'react';import{createRoot}from'react-dom/client';
    import ReadmeCard from './src/components/home/ReadmeCard';
    import{RepositoryScreen}from'./src/components/home/RepositoryScreen';
    import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
    const client=new QueryClient();
    window.fixture={status:'pending',error:false,compact:false,opens:0,summaries:0,retries:0};
    function Fixture(){const[revision,update]=useState(0);window.fixture.refresh=()=>update(x=>x+1);useLayoutEffect(()=>{document.getElementById('card-frame').dataset.revision=String(revision);},[revision]);
      const repository={id:'repo',name:'Books',fullName:'Tarun/Books',description:'Unverified description fallback',readmeSummary:'Unverified description fallback',summarySource:'description_fallback',readmeFull:'# Raw README sentinel',githubUrl:'https://github.com/Tarun/Books',readmeSourcePath:'README.md',readmeDefaultBranch:'main',readmeBaseUrl:null,owner:'Tarun',stats:{stars:12,views:1,forks:0,likes:0,dislikes:0,comments:0,saves:0},languages:[],topics:[]};
      const actions={onReadFullPress:()=>window.fixture.summaries++,onOpenReadme:()=>window.fixture.opens++};
      return new URLSearchParams(location.search).has('parent')?<RepositoryScreen repository={repository} pageWidth={innerWidth} pageHeight={innerHeight-(64+12)} {...actions} onSavePress={()=>{}} onSharePress={()=>{}} onCommentPress={()=>{}}/>:<ReadmeCard repository={repository} availableWidth={innerWidth-40} compact={window.fixture.compact} {...actions}/>;}

    createRoot(document.getElementById('card-frame')).render(<QueryClientProvider client={client}><Fixture/></QueryClientProvider>);
  `}, outfile:path.join(directory,'bundle.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',resolveExtensions:['.web.tsx','.tsx','.web.ts','.ts','.web.js','.js','.json'],loader:{'.js':'jsx','.css':'empty'},
    alias:{'react-native':'react-native-web'},define:{'process.env.NODE_ENV':'"development"'},
    plugins:[{name:'summary-transport-and-motion',setup(builder){
      builder.onResolve({filter:/store\/AuthContext$|^react-native-safe-area-context$|\/follow-button$|^react-native-gesture-handler$|\/TechStackIcon$/},args=>({path:args.path,namespace:'parent-boundary'}));
      builder.onLoad({filter:/.*/,namespace:'parent-boundary'},args=>({contents:args.path.includes('AuthContext')?"export const useAuth=()=>({user:{user_id:'viewer'}});":args.path==='react-native-safe-area-context'?"export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});":args.path.includes('follow-button')?"export const FollowButton=()=>null;":args.path==='react-native-gesture-handler'?"const chain=new Proxy({},{get:()=>()=>chain});export const Gesture={Native:()=>chain};export const GestureDetector=({children})=>children;":"export const TechStackIcon=()=>null;"}));
      builder.onResolve({filter:/use-repository-readme-summary$|use-typewriter-text$|^react-native-reanimated$|^lucide-react-native$|SafeReadmeImage$/},args=>({path:args.path,namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.includes('use-repository-readme-summary')?
        "export const useRepositoryReadmeSummary=()=>({digest:null,data:{status:window.fixture.status},isError:window.fixture.error,isLoading:window.fixture.status==='loading',refetch:()=>window.fixture.retries++});":
        args.path.includes('use-typewriter-text')?"export const useTypewriterText=text=>({text,isTyping:false});":
        args.path==='lucide-react-native'?"export const BookOpen=()=>null;export const ChevronRight=()=>null;export const Layers=()=>null;export const Bookmark=()=>null;export const CircleAlert=()=>null;export const Eye=()=>null;export const ExternalLink=()=>null;export const GitFork=()=>null;export const MessageCircle=()=>null;export const Share=()=>null;export const Star=()=>null;export const ThumbsDown=()=>null;export const ThumbsUp=()=>null;":
        args.path==='react-native-reanimated'?"export const useReducedMotion=()=>true;":"export const SafeReadmeImage=()=>null;"}));
    }}]});
  const server=createServer(async(req,res)=>{
    if(req.url?.startsWith('/font-')){res.setHeader('Content-Type','font/ttf');res.end(await readFile('assets/fonts/NataSans-'+req.url.slice(6)+'.ttf'));return;}
    if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(await readFile(path.join(directory,'bundle.js')));return;}
    const parent=new URL(req.url??'/', 'http://fixture').searchParams.has('parent');
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>@font-face{font-family:NataSans-Regular;src:url(/font-Regular)}@font-face{font-family:NataSans-Bold;src:url(/font-Bold)}@font-face{font-family:NataSans-SemiBold;src:url(/font-SemiBold)}body{margin:0;background:black;color:white}#card-frame{height:360px;margin:20px;display:flex;flex-direction:column}</style><main id="card-frame" style="' + (parent ? 'height:calc(100dvh - 76px);margin:0' : '') + '"></main><script src="/bundle.js"></script>');
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
    assert.fail(`Browser state did not settle: ${expression}\n${await evaluate('document.body?.innerText')}`);
  };
  const click = async (label: string) => { await until(`Boolean(document.querySelector('[aria-label="${label}"]'))`); await evaluate(`document.querySelector('[aria-label="${label}"]').click()`); };

  await send('Page.enable');
  for(const [width,height]of[[412,915],[1280,900]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500});
    await send('Page.navigate',{url:`http://127.0.0.1:${address.port}`});
    await until('Boolean(window.fixture?.refresh)');
    await send('Runtime.evaluate',{expression:'document.fonts.ready',awaitPromise:true});
    for(const compact of [false,true])for(const status of ['pending','processing','failed','error']){
      const revision=await evaluate(`Number(document.getElementById('card-frame').dataset.revision)+1`);
      await evaluate(`Object.assign(window.fixture,{compact:${compact},status:'${status}',error:${status==='error'}});window.fixture.refresh()`);
      await until(`document.getElementById('card-frame').dataset.revision==='${revision}'`);
      const bounds=await evaluate(`(()=>{const card=document.getElementById('card-frame').firstElementChild,r=card.getBoundingClientRect();return{height:r.height,width:r.width,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
      assert.ok(bounds.height>100,`README header, status and action must fit: ${JSON.stringify({width,compact,status,bounds})}`);
      assert.equal(bounds.overflow,false);
      const action=await evaluate(`(()=>{const card=document.getElementById('card-frame').firstElementChild.getBoundingClientRect(),button=document.querySelector('[aria-label="Open README for Books"]')?.getBoundingClientRect();return button?{height:button.height,inside:button.top>=card.top&&button.bottom<=card.bottom}:null;})()`);
      assert.ok(action?.height>=44&&action.inside,'original README action is visible inside the card with a full touch target');
      if(status==='failed')assert.equal(await evaluate('document.body.innerText.includes("README summary unavailable.")'),true);
      assert.equal(await evaluate('document.body.innerText.includes("Raw README sentinel")'),false,'raw README is never presented as a summary');
      assert.equal(await evaluate('document.body.innerText.includes("Unverified description fallback")'),false);
      await click('Open README for Books');
      if(status==='failed'||status==='error')await click('Check README summary again');
    }
    assert.equal(await evaluate('window.fixture.opens'),8);
    assert.equal(await evaluate('window.fixture.summaries'),0,'canonical README action does not open summary popup');
    assert.equal(await evaluate('window.fixture.retries'),4);
  }
  // Match the web tab bar: 64px plus its 12px minimum bottom inset.
  // At zero safe-area insets, these short viewports allocate 492–644px to a feed page.
  for(const [width,height]of[[320,568],[360,640],[412,720]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
    await send('Page.navigate',{url:`http://127.0.0.1:${address.port}/?parent=1`});
    await until('Boolean(window.fixture?.refresh)');
    await send('Runtime.evaluate',{expression:'document.fonts.ready',awaitPromise:true});
    for(const status of ['failed','error']){
      const revision=await evaluate(`Number(document.getElementById('card-frame').dataset.revision)+1`);
      await evaluate(`Object.assign(window.fixture,{status:'${status}',error:${status==='error'}});window.fixture.refresh()`);
      await until(`document.getElementById('card-frame').dataset.revision==='${revision}'`);
      const bounds=await evaluate(`(()=>{const labels=['Open README for Books','Check README summary again'];return labels.map(label=>{const n=document.querySelector('[aria-label="'+label+'"]'),r=n?.getBoundingClientRect();let card=n?.parentElement;while(card&&getComputedStyle(card).overflow!=='hidden')card=card.parentElement;const c=card?.getBoundingClientRect();return{label,height:r?.height,top:r?.top,bottom:r?.bottom,cardTop:c?.top,cardBottom:c?.bottom,visible:r&&c&&r.top>=c.top&&r.bottom<=c.bottom&&r.bottom<=innerHeight-76&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[aria-label]')===n};});})()`);
      assert.ok(bounds.every(action=>action.height>=44&&action.visible),JSON.stringify({width,height,status,bounds}));
      await click('Open README for Books');await click('Check README summary again');
    }
    t.diagnostic(JSON.stringify({parent:'RepositoryScreen',width,height,pageHeight:height-76,failedAndErrorActions:'visible and clickable'}));
    assert.equal(await evaluate('window.fixture.opens'),2);assert.equal(await evaluate('window.fixture.retries'),2);
  }
  t.diagnostic('Actual RN Web ReadmeCard, RepositoryScreen and DescriptionCard with project fonts; safe-area insets are zero. CSS in isolated Chromium; explicit summary-network/motion doubles. The feed callback opens the original README separately from the summary; no external URL is opened by this fixture.');
});
