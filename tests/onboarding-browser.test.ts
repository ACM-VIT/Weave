import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// RUN_ONBOARDING_BROWSER=1 node --import tsx --test tests/onboarding-browser.test.ts
// Real React Native Web controls/context/routes; only router, image, keyboard
// controller and auth/storage transport boundaries are supplied by the fixture.
test('onboarding selections survive Back/Continue and expose operable selected states', {
  skip: process.env.RUN_ONBOARDING_BROWSER !== '1', timeout: 45_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'weave-onboarding-browser-'));
  const { build } = await import('esbuild');
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';
    import{OnboardingProvider,useOnboarding}from'./src/store/OnboardingContext';
    import Step2 from './src/app/onboarding/step2';import Step3 from './src/app/onboarding/step3';
    import SkillCard from './src/components/onboarding/SkillCard';
    window.fixture={};
    function Flow(){const[screen,setScreen]=useState(3);const{data,updateData}=useOnboarding();
      useEffect(()=>updateData({skills:['web'],tech_stack:['TypeScript']}),[]);
      window.fixture.navigate=()=>setScreen(3);window.fixture.data=data;
      return <><SkillCard title='Web development' image={null} selected={(data.skills??[]).includes('web')}
        onPress={()=>updateData({skills:(data.skills??[]).includes('web')?[]:['web']})}/>
        <button aria-label='Back to technologies' onClick={()=>setScreen(2)}>Back</button>
        {screen===3?<Step3/>:<Step2/>}</>;}
    createRoot(document.getElementById('root')).render(<OnboardingProvider><Flow/></OnboardingProvider>);
  ` }, outfile: path.join(directory, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { 'react-native': 'react-native-web', 'lucide-react-native': path.resolve('node_modules/lucide-react-native/dist/esm/icons/index.mjs') },
    plugins: [{ name: 'native-and-transport-boundaries', setup(builder) {
      builder.onResolve({ filter: /^@\/assets\// }, args => ({ path: args.path, namespace: 'image' }));
      builder.onLoad({ filter: /.*/, namespace: 'image' }, () => ({ contents: 'export default function Image(){return null;}' }));
      builder.onResolve({ filter: /keyboard\/keyboard-layout$/ }, () => ({ path: 'keyboard', namespace: 'boundary' }));
      builder.onResolve({ filter: /store\/AuthContext$/ }, () => ({ path: 'auth', namespace: 'boundary' }));
      builder.onResolve({ filter: /utils\/storage$/ }, () => ({ path: 'storage', namespace: 'boundary' }));
      builder.onResolve({ filter: /api\/onboarding$/ }, () => ({ path: 'onboarding', namespace: 'boundary' }));
      builder.onResolve({ filter: /^expo-router$/ }, () => ({ path: 'router', namespace: 'boundary' }));
      builder.onResolve({ filter: /^react-native-safe-area-context$/ }, () => ({ path: 'safearea', namespace: 'boundary' }));
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ loader: 'tsx', resolveDir: process.cwd(), contents: {
        keyboard: "export {ScrollView as KeyboardForm} from 'react-native-web';",
        auth: "export const useAuth=()=>({checkOnboardingStatus:async()=>{},completeOnboarding:async()=>{},reconcileOnboarding:async()=>{},onboardingSave:{status:'idle',message:null}});",
        storage: "export const getItemAsync=async()=> 'fixture-token';",
        onboarding: 'export const setupOnboarding=async()=>({completed:true});',
        router: 'export const router={push:()=>window.fixture.navigate()};',
        safearea: "export {View as SafeAreaView} from 'react-native-web';",
      }[args.path]! }));
    } }], loader: { '.png': 'dataurl', '.css': 'empty' },
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.json'],
    define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'false' },
  });
  const server = createServer(async (req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(await readFile(path.join(directory, 'bundle.js'))); return; }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;background:black;color:white}#root{max-width:450px;margin:auto}</style><div id="root"></div><script src="/bundle.js"></script>');
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
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${address.port}` });
  await until('document.body.innerText.includes("CHOOSE YOUR INTERESTS")');
  await until('window.fixture.data.skills?.includes("web")');
  await t.test('skill and technology chips expose checked state and respond to Enter/Space', async () => {
    for (const label of ['Web development', 'react']) {
      const selector = `[aria-label="${label}"]`;
      assert.equal(await evaluate(`document.querySelector('${selector}')?.getAttribute('role')`), 'checkbox');
      const before = await evaluate(`document.querySelector('${selector}').getAttribute('aria-checked')`);
      await evaluate(`document.querySelector('${selector}').focus()`);
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: label === 'react' ? ' ' : 'Enter', code: label === 'react' ? 'Space' : 'Enter', windowsVirtualKeyCode: label === 'react' ? 32 : 13 });
      await until(`document.querySelector('${selector}')?.getAttribute('aria-checked')==='${before === 'true' ? 'false' : 'true'}'`);
      // Restore the category so the actual interest page stays visible.
      await evaluate(`document.querySelector('${selector}').click()`);
      await until(`document.querySelector('${selector}')?.getAttribute('aria-checked')==='${before}'`);
    }
  });
  await t.test('step3 Back to step2 then Continue retains the context-backed interest selection', async () => {
    // Find the existing control by its text even before accessible labels exist.
    await evaluate(`Array.from(document.querySelectorAll('[tabindex]')).find(el=>el.textContent.replace(/\\s/g,'')==='react+').click()`);
    await until('document.body.innerText.includes("react")');
    await evaluate(`document.querySelector('[aria-label="Back to technologies"]').click()`);
    await until('document.body.innerText.includes("do you use?")');
    await evaluate(`Array.from(document.querySelectorAll('[role="button"]')).find(el=>el.textContent==='Continue').click()`);
    await until('document.body.innerText.includes("CHOOSE YOUR INTERESTS")');
    assert.equal(await evaluate(`window.fixture.data.interests?.includes('react')`), true, 'interest is saved into the per-user draft before navigation');
    assert.equal(await evaluate(`document.querySelector('[aria-label="react"]')?.getAttribute('aria-checked')`), 'true');
  });
});
