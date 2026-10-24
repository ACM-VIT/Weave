import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

test('a delayed feed response keeps the exact request session after caller reset', async () => {
  const original = '00000000-0000-4000-8000-000000000001';
  const replacement = '00000000-0000-4000-8000-000000000002';
  let release!: () => void;
  const pending = new Promise<void>(yes => { release = yes; });
  const sent: any[] = [];
  const modules = new Map<string, any>();
  function load(filename: string): any {
    filename = resolve(filename);
    if (filename === resolve('src/api/client.ts')) return { apiV2Raw: async (_path: string, options: RequestInit) => {
      sent.push(JSON.parse(String(options.body)));
      await pending;
      return { data: { serve_id: original, feed_version: '1', next_cursor: null,
        items: [{ repo_id: replacement, position: 0, repository: { full_name: 'fixture/project' } }] }, response: new Response() };
    } };
    if (modules.has(filename)) return modules.get(filename);
    const module = { exports: {} };
    modules.set(filename, module.exports);
    const js = ts.transpileModule(readFileSync(filename, 'utf8'), {
      fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const nativeRequire = createRequire(filename);
    new Function('require', 'module', 'exports', js)((specifier: string) => specifier.startsWith('.')
      ? load(resolve(dirname(filename), `${specifier}.ts`)) : nativeRequire(specifier), module, module.exports);
    modules.set(filename, module.exports);
    return module.exports;
  }
  const { fetchFeed } = load('src/api/feed.ts');
  const options = { sessionId: original, requestId: original };
  const response = fetchFeed('fixture', null, options);
  options.sessionId = replacement;
  release();
  const page = await response;
  assert.equal(sent[0].session_id, original);
  assert.equal(page.items[0].feed_session_id, original);
});
