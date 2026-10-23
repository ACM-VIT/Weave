import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('actual import panel renders consent/error/revoke and ignores late account responses in Chromium', {
  skip: process.env.RUN_GITHUB_IMPORT_BROWSER !== '1', timeout: 30_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'weave-github-import-browser-'));
  const { build } = await import('esbuild');
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{GitHubImportPanel}from'./src/components/onboarding/GitHubImportPanel';
    window.fixture={mode:'normal',saved:[],manual:0,unmountManual:false,holdCleanup:false,cleanupSettled:false};
    const apis={};for(const actor of ['A','B']){
      const call=async(action,signal)=>{const response=await fetch('/fixture/'+action+'?actor='+actor+'&mode='+window.fixture.mode,{signal});
        const result=await response.json();if(!response.ok)throw new Error(result.error);return result;};
      apis[actor]={status:s=>call('status',s),preview:s=>call('preview',window.fixture.mode==='late'?undefined:s),
        accept:(id,s)=>call('accept',s),revoke:async s=>{if(window.fixture.holdCleanup){window.fixture.cleanupSignal=s;await new Promise(resolve=>{window.fixture.releaseCleanup=resolve;});}try{return await call('revoke',s);}finally{window.fixture.cleanupSettled=true;}},saveIdentity:(draft,s)=>call('identity',s)};
    }
    function Fixture(){const[actor,setActor]=useState('A'),[manual,setManual]=useState(false);window.fixture.switchAccount=()=>setActor('B');
      return manual?<p id='manual-view'>Manual preferences</p>:<GitHubImportPanel userId={actor} api={apis[actor]} identityDraft={{username:'Tarun',full_name:'Tarun',date_of_birth:'2005-01-01'}}
        onManual={()=>{window.fixture.manual++;if(window.fixture.unmountManual)setManual(true);}} onSaved={async()=>{if(window.fixture.mode==='refresh-error')throw new Error('Account refresh unavailable');window.fixture.saved.push(actor);}}/>;}
    createRoot(document.getElementById('panel-frame')).render(<Fixture/>);
  ` }, outfile: path.join(directory, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { 'react-native': 'react-native-web' }, define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'explicit-api-css-boundaries', setup(builder) {
      builder.onResolve({ filter: /api\/githubImport$/ }, () => ({ path: 'api-boundary', namespace: 'fixture' }));
      builder.onResolve({ filter: /global\.css$/ }, () => ({ path: 'css-boundary', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'api-boundary' ? 'export const githubImportApi={};' : '' }));
    } }],
  });
  let releaseCleanup!: () => void, cleanupArrived!: () => void;
  const cleanupHeld = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const cleanupStarted = new Promise<void>(resolve => { cleanupArrived = resolve; });
  const requests: Array<{ actor: string; action: string; mode: string }> = [];
  const active: Record<string, boolean> = { A: false, B: false };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname.startsWith('/fixture/')) {
      const actor = url.searchParams.get('actor')!, mode = url.searchParams.get('mode')!;
      const action = url.pathname.split('/').pop()!; requests.push({ actor, action, mode });
      res.setHeader('Content-Type', 'application/json');
      if (action === 'revoke' && mode === 'cleanup-error') { cleanupArrived(); await cleanupHeld; res.statusCode = 503; res.end(JSON.stringify({ error: 'Preview cleanup unavailable' })); return; }
      if (action === 'preview' && mode === 'error') { res.statusCode = 503; res.end(JSON.stringify({ error: 'Public activity is unavailable. Retry or choose preferences manually.' })); return; }
      if (action === 'preview' && mode === 'late') await new Promise(resolve => setTimeout(resolve, 200));
      if (action === 'accept') active[actor] = true;
      if (action === 'revoke') active[actor] = false;
      res.end(JSON.stringify(action === 'status' ? { linked: true, active: active[actor], provenance: {} }
        : action === 'preview' ? { snapshot_id: '00000000-0000-4000-8000-000000000001', collected_at: '2026-10-23T00:00:00Z', status: 'partial',
          sources: { owned: { status: 'complete', count: 2 }, starred: { status: 'unavailable', count: 0 } }, repository_count: 2,
          suggestions: { skills: ['Web / Frontend Frameworks'], interests: ['only-'+actor+'-topic'], tech_stack: ['TypeScript'] },
          expires_at: new Date(Date.now() + (mode === 'expired' ? -1_000 : 300_000)).toISOString() } : { profile_delivery: 'pending' })); return;
    }
    if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(await readFile(path.join(directory, 'bundle.js'))); return; }
    if (url.pathname === '/font.ttf') { res.setHeader('Content-Type', 'font/ttf'); res.end(await readFile('assets/fonts/NataSans-Regular.ttf')); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>GitHub import UI acceptance</title><style>@font-face{font-family:"Nata Sans";src:url(/font.ttf)}:root{--font-display:"Nata Sans",sans-serif}body{margin:0;background:#000;color:#fff}#panel-frame{box-sizing:border-box;max-width:450px;margin:0 auto;padding:20px}</style><main id="panel-frame"></main><script src="/bundle.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const chrome = spawn(process.env.CHROMIUM_BIN ?? 'chromium', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${path.join(directory, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
  let spawnError: Error | undefined; chrome.on('error', error => { spawnError = error; });
  let socket: WebSocket | undefined;
  t.after(async () => {
    releaseCleanup(); socket?.close();
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
  if (process.env.GITHUB_IMPORT_MANUAL_RETRY_ONLY !== '1') {
  await until('Boolean(document.querySelector(\'[aria-label="Preview public activity"]\'))');
  assert.equal(requests.filter(request => request.action === 'preview').length, 0);
  await evaluate('window.fixture.mode="error"'); await click('Preview public activity');
  await until('document.body.innerText.includes("Public activity is unavailable")');
  await evaluate('window.fixture.mode="normal"'); await click('Preview public activity');
  await until('document.body.innerText.includes("only-A-topic")');
  assert.equal(requests.filter(request => request.action === 'accept').length, 0, 'preview never applies suggestions');
  for (const [name, width, height] of [['mobile', 390, 844], ['desktop', 1280, 900]] as const) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: name === 'mobile' });
    await evaluate('document.fonts.ready');
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
    if (process.env.GITHUB_IMPORT_BROWSER_ARTIFACTS) {
      await mkdir(process.env.GITHUB_IMPORT_BROWSER_ARTIFACTS, { recursive: true });
      const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(path.join(process.env.GITHUB_IMPORT_BROWSER_ARTIFACTS, `${name}-preview.png`), Buffer.from(screenshot.result.data, 'base64'));
    }
  }
  await evaluate('window.fixture.mode="cleanup-error"');
  await click('Choose preferences myself'); await cleanupStarted;
  assert.equal(await evaluate('window.fixture.manual'), 0, 'cleanup host stays mounted until revocation acknowledgement');
  releaseCleanup(); await until('document.body.innerText.includes("Preview cleanup unavailable")');
  await evaluate('window.fixture.mode="normal"'); await click('Retry closing preview');
  await until(`!document.querySelector('[aria-label="Retry closing preview"]')`);
  await click('Show import option'); await click('Preview public activity'); await until('document.body.innerText.includes("only-A-topic")');
  await evaluate('window.fixture.mode="refresh-error"');
  await click('Use preferences and finish setup'); await until('document.body.innerText.includes("Account refresh unavailable")');
  await until('document.body.innerText.includes("prepared asynchronously")');
  await evaluate('window.fixture.mode="normal"'); await click('Retry account refresh');
  await until(`!document.querySelector('[aria-label="Retry account refresh"]')`);
  assert.equal(requests.filter(request => request.action === 'identity').length, 1);
  assert.equal(requests.filter(request => request.action === 'accept').length, 1);
  await click('Revoke activity import'); await until('document.body.innerText.includes("Show import option")');
  await click('Show import option'); await evaluate('window.fixture.mode="expired"'); await click('Preview public activity');
  await until('document.body.innerText.includes("only-A-topic")'); await click('Use preferences and finish setup');
  await until('document.body.innerText.includes("preview expired")');
  assert.equal(requests.filter(request => request.action === 'accept').length, 1);
  await click('Choose preferences myself'); await until('window.fixture.manual===2'); await click('Show import option');
  await evaluate('window.fixture.mode="late"'); await click('Preview public activity');
  await until('document.body.innerText.includes("Reading public activity")');
  await evaluate('window.fixture.switchAccount()');
  await until('Boolean(document.querySelector(\'[aria-label="Preview public activity"]\'))');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await evaluate('document.body.innerText.includes("only-A-topic")'), false);
  assert.equal(requests.filter(request => request.actor === 'B' && request.action === 'accept').length, 0);
  const saved = await evaluate('window.fixture.saved') as string[];
  assert.ok(saved.length >= 3 && saved.every(actor => actor === 'A'), 'only the current account refreshes after successful mutations');
  }
  // Match the actual parent, which unmounts this panel on onManual. A failed
  // DELETE must leave its cleanup host and retry state visible, not navigate.
  await send('Page.navigate',{url:`http://127.0.0.1:${address.port}`});
  await click('Preview public activity'); await until('document.body.innerText.includes("only-A-topic")');
  const cleanupBefore=requests.filter(row=>row.action==='revoke').length;
  active.A=true; // Model acceptance committed before its browser response settled.
  await evaluate('window.fixture.unmountManual=true;window.fixture.holdCleanup=true;window.fixture.mode="cleanup-error"');
  await click('Choose preferences myself');
  await until('Boolean(window.fixture.releaseCleanup)');
  assert.equal(await evaluate('window.fixture.cleanupSignal.aborted'),false);
  await evaluate('window.fixture.releaseCleanup()');
  await cleanupStarted; releaseCleanup();
  await until('window.fixture.cleanupSettled');
  await until('document.body.innerText.includes("Preview cleanup unavailable")');
  assert.equal(await evaluate('window.fixture.manual'),0,'failed cleanup cannot abandon the manual intent');
  assert.equal(await evaluate('Boolean(document.getElementById("manual-view"))'),false);
  assert.equal(active.A,true,'failed DELETE did not revoke the accepted server state');
  await evaluate('window.fixture.holdCleanup=false;window.fixture.mode="refresh-error"');
  await click('Retry closing preview');
  await until('document.body.innerText.includes("Account refresh unavailable")');
  assert.equal(active.A,false,'successful retry acknowledged the consent revocation');
  assert.equal(await evaluate('window.fixture.manual'),0,'refresh failure retains the same pending manual intent');
  await evaluate('window.fixture.mode="normal"'); await click('Retry account refresh');
  await until('Boolean(document.getElementById("manual-view"))');
  assert.equal(await evaluate('window.fixture.manual'),1,'successful retry continues manually exactly once');
  assert.equal(requests.filter(row=>row.action==='revoke').length,cleanupBefore+2);
  assert.deepEqual(await evaluate('window.fixture.saved'),['A']);
  // Empty manual setup has no preview/acceptance to retire and must not invent
  // a network dependency or populate any choices.
  await send('Page.navigate',{url:`http://127.0.0.1:${address.port}`});
  await until(`Boolean(document.querySelector('[aria-label="Preview public activity"]'))`);
  const emptyCleanupBefore=requests.filter(row=>row.action==='revoke').length;
  await evaluate('window.fixture.unmountManual=true'); await click('Choose preferences myself');
  await until('Boolean(document.getElementById("manual-view"))');
  assert.equal(await evaluate('window.fixture.manual'),1);
  assert.equal(requests.filter(row=>row.action==='revoke').length,emptyCleanupBefore);
  t.diagnostic('Actual React Native Web panel: explicit consent, error/retry, partial provenance, decline, expiry, revoke and late-account isolation pass; HTTP API is a controlled boundary.');
});
