import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Opt in: RUN_PROFILE_BROWSER=1 npx tsx --test tests/profile-browser.test.ts
// Requires Chromium (or CHROMIUM_BIN) and Node 22+ for native WebSocket.
test('rendered profile windows, lazy sheets, paging retry and scroll retention', {
  skip: process.env.RUN_PROFILE_BROWSER !== '1', timeout: 60_000,
}, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const fixture = path.join(root, 'tests/browser/profile');
  const output = await mkdtemp(path.join(tmpdir(), 'weave-profile-browser-'));
  let closeSocket = () => {};
  let closeBrowser = async () => {};
  let closeServer = async () => {};
  t.after(async () => {
    closeSocket();
    await closeBrowser();
    await closeServer();
    // Chromium child processes can finish profile writes just after the parent exits.
    await rm(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { build } = await import('esbuild');
  await build({
    entryPoints: [path.join(fixture, 'entry.tsx')], outfile: path.join(output, 'bundle.js'),
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', jsxImportSource: 'nativewind',
    alias: {
      'react-native': 'react-native-web',
      // The package barrel exports an unavailable LucideProvider; use real icons directly.
      'lucide-react-native': path.join(root, 'node_modules/lucide-react-native/dist/esm/icons/index.mjs'),
      'expo-router': path.join(fixture, 'router.ts'),
    },
    plugins: [{ name: 'fixture-transport', setup(builder) {
      builder.onResolve({ filter: /^@\/api\/client$/ }, () => ({ path: path.join(fixture, 'client.ts') }));
      builder.onResolve({ filter: /^@\/utils\/storage$/ }, () => ({ path: path.join(fixture, 'storage.ts') }));
    } }],
    loader: { '.css': 'empty' }, tsconfig: path.join(root, 'tsconfig.json'),
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.json'],
    define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
  });
  execFileSync(process.execPath, [path.join(root, 'node_modules/tailwindcss/lib/cli.js'),
    '-i', 'src/global.css', '-o', path.join(output, 'global.css')], { cwd: root, stdio: 'pipe' });
  const server = createServer(async (req, res) => {
    const files: Record<string, [string, string]> = {
      '/': [path.join(fixture, 'index.html'), 'text/html'],
      '/bundle.js': [path.join(output, 'bundle.js'), 'application/javascript'],
      '/global.css': [path.join(output, 'global.css'), 'text/css'],
    };
    const file = files[req.url ?? '/'];
    if (!file) { res.writeHead(404).end(); return; }
    try { res.setHeader('Content-Type', file[1]); res.end(await readFile(file[0])); }
    catch { res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closeServer = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const chrome = spawn(process.env.CHROMIUM_BIN ?? 'chromium', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${path.join(output, 'chrome')}`, 'about:blank',
  ], { stdio: 'ignore' });
  let spawnError: Error | undefined;
  chrome.on('error', error => { spawnError = error; });
  closeBrowser = async () => {
    if (chrome.exitCode !== null || spawnError) return;
    const exited = new Promise<void>(resolve => chrome.once('exit', () => resolve()));
    chrome.kill(); await exited;
  };
  let port: string | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    try { port = (await readFile(path.join(output, 'chrome/DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(port, 'Chromium did not start its debugging endpoint');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  closeSocket = () => socket.close();
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: any) => void }>();
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      if (message.error) request.reject(message.error);
      else request.resolve(message.result);
    }
  };
  const send = (method: string, params = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${address.port}` });
  const result = await send('Runtime.evaluate', {
    expression: `new Promise(resolve => {
      const timer = setInterval(() => {
        const element = document.getElementById('profile-check-result');
        if (element) { clearInterval(timer); resolve({ status: element.dataset.status, result: JSON.parse(element.textContent) }); }
      }, 100);
      setTimeout(() => { clearInterval(timer); resolve({ status: 'timeout' }); }, 30000);
    })`, awaitPromise: true, returnByValue: true,
  });
  t.diagnostic(JSON.stringify(result.result?.value ?? result));
  assert.equal(result.result?.value?.status, 'passed');
});
