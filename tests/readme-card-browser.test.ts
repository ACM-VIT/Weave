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
    import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import ReadmeCard from './src/components/home/ReadmeCard';
    window.fixture={status:'pending',error:false,compact:false,opens:0,summaries:0,retries:0};
    function Fixture(){const[,update]=useState(0);window.fixture.refresh=()=>update(x=>x+1);
      return <ReadmeCard repository={{id:'repo',name:'Books',fullName:'Tarun/Books',description:'Unverified description fallback',readmeSummary:'Unverified description fallback',summarySource:'description_fallback',readmeFull:'# Raw README sentinel',githubUrl:'https://github.com/Tarun/Books',readmeSourcePath:'README.md',readmeDefaultBranch:'main',readmeBaseUrl:null}}
        availableWidth={innerWidth-40} compact={window.fixture.compact} onReadFullPress={()=>window.fixture.summaries++} onOpenReadme={()=>window.fixture.opens++}/>;}
    createRoot(document.getElementById('card-frame')).render(<Fixture/>);
  `}, outfile:path.join(directory,'bundle.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',
    alias:{'react-native':'react-native-web'},define:{'process.env.NODE_ENV':'"development"'},
    plugins:[{name:'summary-transport-and-motion',setup(builder){
      builder.onResolve({filter:/use-repository-readme-summary$|use-typewriter-text$|^react-native-reanimated$|^lucide-react-native$|SafeReadmeImage$/},args=>({path:args.path,namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.includes('use-repository-readme-summary')?
        "export const useRepositoryReadmeSummary=()=>({digest:null,data:{status:window.fixture.status},isError:window.fixture.error,isLoading:window.fixture.status==='loading',refetch:()=>window.fixture.retries++});":
        args.path.includes('use-typewriter-text')?"export const useTypewriterText=text=>({text,isTyping:false});":
        args.path==='lucide-react-native'?"export const BookOpen=()=>null;export const ChevronRight=()=>null;":
        args.path==='react-native-reanimated'?"export const useReducedMotion=()=>true;":"export const SafeReadmeImage=()=>null;"}));
    }}]});
  const server=createServer(async(req,res)=>{
    if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(await readFile(path.join(directory,'bundle.js')));return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:black;color:white}#card-frame{height:360px;margin:20px;display:flex;flex-direction:column}</style><main id="card-frame"></main><script src="/bundle.js"></script>');
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
    for(const compact of [false,true])for(const status of ['pending','processing','failed','error']){
      await evaluate(`Object.assign(window.fixture,{compact:${compact},status:'${status}',error:${status==='error'}});window.fixture.refresh()`);
      await until('document.body.innerText.includes("README SUMMARY")');
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
  t.diagnostic('Actual RN Web ReadmeCard and CSS in isolated Chromium; explicit summary-network/motion doubles. The feed callback opens the original README separately from the summary; no external URL is opened by this fixture.');
});
