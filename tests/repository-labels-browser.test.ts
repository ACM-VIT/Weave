import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('feed labels keep padded metadata and README actions visible at narrow phone sizes', {
  skip: process.env.RUN_REPOSITORY_LABEL_BROWSER !== '1', timeout: 30_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'weave-repository-label-'));
  const { build } = await import('esbuild');
  // Import installed icon implementations individually; the package barrel currently
  // re-exports a missing LucideProvider under esbuild. Metro remains unchanged.
  const lucideIcons = ['BookOpen','ChevronRight','TrendingUp','Layers','Bookmark','CircleAlert','Eye',
    'ExternalLink','GitFork','MessageCircle','Share','Star','ThumbsDown','ThumbsUp'].map(name => {
      const slug=name.replace(/[A-Z]/g,(letter,index)=>(index?'-':'')+letter.toLowerCase());
      return `export {default as ${name}} from ${JSON.stringify(path.resolve('node_modules/lucide-react-native/dist/esm/icons',slug+'.mjs'))};`;
    }).join('');

  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React,{useState,useLayoutEffect}from'react';import{createRoot}from'react-dom/client';
    import{RepositoryScreen}from'./src/components/home/RepositoryScreen';
    import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
    const client=new QueryClient();
    window.fixture={status:'pending',error:false,compact:false,opens:0,summaries:0,retries:0,label:null,digest:null};
    function Fixture(){const[revision,update]=useState(0);window.fixture.refresh=()=>update(x=>x+1);useLayoutEffect(()=>{document.getElementById('card-frame').dataset.revision=String(revision);},[revision]);
      const repository={recommendationSource:'semantic',label:window.fixture.label,id:'repo',name:'Books',fullName:'Tarun/Books',description:'Unverified description fallback',readmeSummary:'Unverified description fallback',summarySource:'description_fallback',readmeFull:'# Raw README sentinel',githubUrl:'https://github.com/Tarun/Books',readmeSourcePath:'README.md',readmeDefaultBranch:'main',readmeBaseUrl:null,owner:'Tarun',stats:{stars:12,views:1,forks:0,likes:0,dislikes:0,comments:0,saves:0},languages:[],topics:[]};
      const actions={onReadFullPress:()=>window.fixture.summaries++,onOpenReadme:()=>window.fixture.opens++};
      return <RepositoryScreen isActive repository={repository} pageWidth={innerWidth} pageHeight={innerHeight-(64+12)} {...actions} onSavePress={()=>{}} onSharePress={()=>{}} onCommentPress={()=>{}}/>;}

    createRoot(document.getElementById('card-frame')).render(<QueryClientProvider client={client}><Fixture/></QueryClientProvider>);
  `}, outfile:path.join(directory,'bundle.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',resolveExtensions:['.web.tsx','.tsx','.web.ts','.ts','.web.js','.js','.json'],loader:{'.js':'jsx','.css':'empty'},
    alias:{'react-native':'react-native-web'},define:{'process.env.NODE_ENV':'"development"'},
    plugins:[{name:'summary-transport-and-motion',setup(builder){
      builder.onResolve({filter:/store\/AuthContext$|^react-native-safe-area-context$|\/follow-button$|^react-native-gesture-handler$|\/TechStackIcon$/},args=>({path:args.path,namespace:'parent-boundary'}));
      builder.onLoad({filter:/.*/,namespace:'parent-boundary'},args=>({resolveDir:process.cwd(),contents:args.path.includes('AuthContext')?"export const useAuth=()=>({user:{user_id:'viewer'}});":args.path==='react-native-safe-area-context'?"export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});":args.path.includes('follow-button')?"export const FollowButton=()=>null;":args.path==='react-native-gesture-handler'?"const chain=new Proxy({},{get:()=>()=>chain});export const Gesture={Native:()=>chain};export const GestureDetector=({children})=>children;":"export const TechStackIcon=()=>null;"}));
      builder.onResolve({filter:/use-repository-readme-summary$|use-typewriter-text$|^react-native-reanimated$|^lucide-react-native$|SafeReadmeImage$/},args=>({path:args.path,namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({resolveDir:process.cwd(),contents:args.path.includes('use-repository-readme-summary')?
        "export const useRepositoryReadmeSummary=()=>({digest:window.fixture.digest,data:{status:window.fixture.status},isError:window.fixture.error,isLoading:window.fixture.status==='loading',refetch:()=>window.fixture.retries++});":
        args.path.includes('use-typewriter-text')?"export const useTypewriterText=text=>({text,isTyping:false});":
        args.path==='lucide-react-native'?lucideIcons:
        args.path==='react-native-reanimated'?"export const useReducedMotion=()=>true;":"export const SafeReadmeImage=()=>null;"}));
    }}]});
  const server=createServer(async(req,res)=>{
    if(req.url?.startsWith('/font-')){res.setHeader('Content-Type','font/ttf');res.end(await readFile('assets/fonts/NataSans-'+req.url.slice(6)+'.ttf'));return;}
    if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(await readFile(path.join(directory,'bundle.js')));return;}
    const parent=new URL(req.url??'/', 'http://fixture').searchParams.has('parent');
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>@font-face{font-family:NataSans-Regular;src:url(/font-Regular)}@font-face{font-family:NataSans-Bold;src:url(/font-Bold)}@font-face{font-family:NataSans-SemiBold;src:url(/font-SemiBold)}@font-face{font-family:NataSans-Medium;src:url(/font-Medium)}body{margin:0;background:black;color:white}#card-frame{height:360px;margin:20px;display:flex;flex-direction:column}</style><main id="card-frame" style="' + (parent ? 'height:calc(100dvh - 76px);margin:0' : '') + '"></main><script src="/bundle.js"></script>');
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

    const freshness={observed_at:new Date(Date.now()-60_000).toISOString(),expires_at:new Date(Date.now()+60_000).toISOString()};
    const labels=[{...freshness,kind:'trending',rank:3,period:'daily',source:'github-trending'},
      {...freshness,kind:'recent_likes',rank:2,count:27,window_hours:168},
      {...freshness,kind:'popular',star_count:10_000}];
    for(const label of labels){
      await evaluate(`window.fixture.label=${JSON.stringify(label)};window.fixture.refresh()`);
      await until(`document.querySelector('[data-testid="repository-label"]')?.textContent.includes('${label.kind==='trending'?'Trending':label.kind==='recent_likes'?'Most liked':'Popular'}')`);
      const measured=await evaluate(`(()=>{const badge=document.querySelector('[data-testid="repository-label"]'),r=badge.getBoundingClientRect(),action=document.querySelector('[aria-label="Open README for Books"]'),a=action.getBoundingClientRect();let card=action.parentElement;while(card&&getComputedStyle(card).overflow!=='hidden')card=card.parentElement;return{actionInside:a.bottom<=card.getBoundingClientRect().bottom,badgeHeight:r.height,badgeRight:r.right,actionBottom:a.bottom,badgeTop:r.top,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
      assert.ok(measured.badgeHeight>=30&&measured.badgeRight<=width-50&&!measured.overflow,JSON.stringify({width,height,label:label.kind,measured}));
      assert.ok(measured.actionInside&&measured.actionBottom<=measured.badgeTop,JSON.stringify({width,height,label:label.kind,measured}));
    }
    // Approximate 200% native label text scaling in RN Web; actual native font scaling remains enabled.
    await evaluate(`document.querySelector('[data-testid="repository-label"]').lastElementChild.style.cssText+=';font-size:22px;line-height:32px'`);
    const scaled=await evaluate(`(()=>{const b=document.querySelector('[data-testid="repository-label"]'),r=b.getBoundingClientRect(),text=b.lastElementChild.getBoundingClientRect();return{right:r.right,height:r.height,textInside:text.right<=r.right&&text.bottom<=r.bottom,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
    assert.ok(scaled.height>=44&&scaled.textInside&&!scaled.overflow,JSON.stringify({width,height,scaled}));
    t.diagnostic(JSON.stringify({parent:'RepositoryScreen',width,height,pageHeight:height-76,failedAndErrorActions:'visible and clickable'}));
    assert.equal(await evaluate('window.fixture.opens'),2);assert.equal(await evaluate('window.fixture.retries'),2);
  }
  t.diagnostic('Actual RN Web ReadmeCard, RepositoryScreen, DescriptionCard and installed Lucide icon implementations with project fonts; safe-area insets are zero. CSS in isolated Chromium; explicit summary-network/motion doubles. Label metadata is the production renderer; summary transport, owner follow and gesture boundaries are isolated. Native device font scaling still requires device QA.');
});
