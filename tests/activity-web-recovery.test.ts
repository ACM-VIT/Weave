import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('browser localStorage survives reload and lifecycle recovery drains acknowledged events', {
  skip: process.env.RUN_ACTIVITY_BROWSER !== '1', timeout: 30_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'weave-activity-browser-'));
  const { build } = await import('esbuild');
  const received: Array<{ event_id: string; client_occurred_at: string }> = [];
  await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import {DurableActivityOutbox} from './src/services/activityOutbox';
    import {startActivityOutboxLifecycle} from './src/services/activityOutboxLifecycle';
    import {loadActivityOutbox,appendActivityOutboxEvent,acknowledgeActivityOutboxEvents} from './src/services/activityOutboxStorage';
    const owner='00000000-0000-4000-8000-000000000001';let online=false,failures=0;
    const event=n=>({event_id:'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),session_id:owner,
      repo_id:'10000000-0000-4000-8000-000000000001',action:'like',client_occurred_at:'2026-10-23T00:00:00Z',serve_id:null,position:null});
    const queue=new DurableActivityOutbox({load:()=>loadActivityOutbox(owner),append:e=>appendActivityOutboxEvent(owner,e),
      acknowledge:ids=>acknowledgeActivityOutboxEvents(owner,ids),prepare:e=>e,send:async events=>{
        if(!online){failures++;throw new Error('offline fixture transport');}
        const response=await fetch('/ack',{method:'POST',body:JSON.stringify(events)});return response.json();}});
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const until=async fn=>{for(let n=0;n<100;n++){if(await fn())return;await wait(20);}throw new Error('Recovery timed out');};
    const check=(ok,message)=>{if(!ok)throw new Error(message);};
    const output=(status,value)=>{const result=document.createElement('pre');result.id='activity-result';result.dataset.status=status;result.textContent=JSON.stringify(value);document.body.append(result);};
    async function run(){
      if(!sessionStorage.getItem('activity-test-phase')){
        await queue.enqueue(event(1));try{await queue.flush('fixture');}catch{}
        sessionStorage.setItem('activity-test-phase','restarted');location.reload();return;
      }
      const restored=await loadActivityOutbox(owner);check(restored.length===1&&restored[0].event_id===event(1).event_id,'Reload lost pending identity');
      let appState,network;
      const stop=startActivityOutboxLifecycle({flush:()=>queue.flush('fixture'),intervalMs:8000,
        subscribeAppState:fn=>{appState=fn;return()=>{};},subscribeConnectivity:fn=>{network=fn;return()=>{};}});
      await until(()=>failures===1);await wait(1100);online=true;appState('active');
      await until(async()=>await queue.pendingCount()===0);
      await queue.enqueue(event(2));online=false;appState('background');await until(()=>failures===2);
      await wait(1100);online=true;network({isConnected:false,isInternetReachable:false});network({isConnected:true,isInternetReachable:true});
      await until(async()=>await queue.pendingCount()===0);
      await queue.enqueue(event(3));stop();await until(async()=>await queue.pendingCount()===0);
      check((await loadActivityOutbox(owner)).length===0,'Acknowledged records retained');
      check((await loadActivityOutbox('00000000-0000-4000-8000-000000000099')).length===0,'Account storage leaked');
      appState('active');network({isConnected:true,isInternetReachable:true});
      output('passed',{reloaded:true,foreground:true,connectivity:true,unmount:true,pending:await queue.pendingCount()});
    }
    run().catch(error=>output('failed',{message:error.message,stack:error.stack}));
  ` }, outfile: path.join(directory, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife',
    external: ['expo-file-system'], plugins: [{ name: 'web-platform', setup(builder) {
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'web-platform', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const Platform={OS:"web"};' }));
    } }],
  });
  const server = createServer(async (req, res) => {
    if (req.url === '/ack') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const events = JSON.parse(Buffer.concat(chunks).toString('utf8')); received.push(...events);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ accepted: events.length, duplicates: 0,
        feed_version: '2', results: events.map((event: { event_id: string }) => ({ event_id: event.event_id, status: 'accepted' })) })); return;
    }
    if (req.url === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(await readFile(path.join(directory, 'bundle.js'))); return; }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Activity recovery fixture</title><body><p>Checking durable activity recovery</p><script src="/bundle.js"></script></body>');
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
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let port: string | undefined;
  for (let n = 0; n < 100; n++) {
    if (spawnError) throw spawnError;
    try { port = (await readFile(path.join(directory, 'chrome/DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.ok(port);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject; });
  let sequence = 0;
  const pending = new Map<number, (value: any) => void>();
  socket.onmessage = message => { const value = JSON.parse(String(message.data)); pending.get(value.id)?.(value); pending.delete(value.id); };
  const send = (method: string, params = {}) => new Promise<any>(resolve => {
    const id = ++sequence; pending.set(id, resolve); socket!.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable'); await send('Page.navigate', { url: `http://127.0.0.1:${address.port}` });
  let result: any;
  // Reload deliberately destroys the first JS context; poll the current context
  // rather than awaiting a promise owned by the page being terminated.
  for (let n = 0; n < 300; n++) {
    const response = await send('Runtime.evaluate', { expression: `(()=>{const element=document.getElementById('activity-result');
      return element?{status:element.dataset.status,data:JSON.parse(element.textContent)}:null;})()`, returnByValue: true });
    result = response.result?.result?.value;
    if (result) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(result?.status, 'passed', JSON.stringify(result));
  assert.equal(received.length, 3); assert.equal(new Set(received.map(event => event.event_id)).size, 3);
  assert.ok(received.every(event => event.client_occurred_at === '2026-10-23T00:00:00Z'));
  t.diagnostic(JSON.stringify(result));
});
