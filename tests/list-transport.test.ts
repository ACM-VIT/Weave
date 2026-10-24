import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

function listsTransport(api: (path: string, options: RequestInit, token: string) => Promise<unknown>) {
  const filename = resolve('src/api/lists.ts');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} as any };
  const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {fileName: filename, compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText;
  new Function('require', 'module', 'exports', javascript)((name: string) => {
    if (name === '@/api/client') return {apiV2: api};
    if (name === '@/models/list') return nativeRequire('../models/list.ts');
    return nativeRequire(name);
  }, module, module.exports);
  return module.exports;
}

test('current Lists load without consulting the unavailable legacy boards endpoint', async () => {
  const calls: string[] = [];
  const api = listsTransport(async (path, _options, token) => {
    assert.equal(token, 'viewer-token');
    calls.push(path);
    if (path.startsWith('/boards')) throw new Error('Legacy boards unavailable');
    return {items:[{collection_id:'list',name:'Read later',selected:true,repo_count:1}]};
  });
  const lists = await api.getRepositoryLists('repo', 'viewer-token');
  assert.deepEqual(lists.map((list: any) => [list.id, list.source, list.selected]), [['list','collection',true]]);
  assert.deepEqual(calls, ['/collections?repository_id=repo']);
});

test('current List saves omit legacy membership edits and return only current selections', async () => {
  const api = listsTransport(async (path, options) => {
    assert.equal(path, '/collections/save');
    const body = JSON.parse(String(options.body));
    assert.equal(Object.hasOwn(body, 'boardIds'), false, 'omission preserves old data; [] would delete it');
    assert.deepEqual(body.collectionIds, ['list']);
    return {repository_id:'repo',collection_ids:['list'],board_ids:['retained-board'],selected_list_ids:['collection:list','legacy-board:retained-board'],saved:true,save_state_changed:true};
  });
  const result = await api.syncRepositoryLists('repo', ['collection:list'], 'token', {event_type:'save'});
  assert.deepEqual(result.selectedListIds, ['collection:list']);
});
