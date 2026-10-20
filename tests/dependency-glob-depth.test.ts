import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const braces = require('braces');
const nested = (open: string, close: string, depth: number) =>
  open.repeat(depth) + 'a,b' + close.repeat(depth);

test('glob parsing bounds braces and parentheses before recursive walkers run', () => {
  for (const [open, close] of [['{', '}'], ['(', ')']]) {
    for (const method of ['parse', 'compile', 'expand', 'stringify']) {
      assert.doesNotThrow(() => braces[method](nested(open, close, 100)));
      assert.throws(() => braces[method](nested(open, close, 101)), /Input depth/);
      assert.throws(() => braces[method](nested(open, close, 101), { maxDepth: 1000 }), /Input depth/);
      assert.doesNotThrow(() => braces[method](nested(open, close, 1), { maxDepth: 1.5 }));
      assert.throws(() => braces[method](nested(open, close, 2), { maxDepth: 1.5 }), /Input depth/);
    }
  }
  // This is below the existing 10,000-character limit but can overflow released 3.0.3.
  const hostile = nested('{', '}', 4998);
  assert.equal(hostile.length, 9999);
  assert.throws(() => braces.expand(hostile), /Input depth/);
});

test('each parser or direct AST walker reads and normalizes maxDepth once', () => {
  for (const method of ['parse', 'compile', 'expand', 'stringify']) {
    let reads = 0;
    const options = { get maxDepth() { return ++reads === 1 ? 1.5 : 1000; } };
    const input = method === 'parse' ? '{{a,b}}' : braces.parse('{{a,b}}');
    assert.throws(() => braces[method](input, options), /depth/);
    assert.equal(reads, 1);
    assert.throws(() => braces[method](method === 'parse' ? 'a,b' : braces.parse('a,b'), {
      maxDepth: -1,
    }), RangeError);
  }
});

test('direct AST depth, cycles and ancestor traversal are bounded', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const braces = require(${JSON.stringify(require.resolve('braces'))});
    const parentCycle = { type: 'paren' };
    parentCycle.parent = parentCycle;
    assert.throws(() => braces.expand({ type: 'paren', nodes: [], parent: parentCycle }), /cycle/);

    let ancestor = { type: 'root', queue: [] };
    for (let i = 0; i < 1000; i++) ancestor = { type: 'paren', parent: ancestor };
    assert.throws(() => braces.expand({ type: 'paren', nodes: [], parent: ancestor }), /AST parent depth/);

    const ast = depth => {
      const root = { type: 'root', nodes: [] };
      let parent = root;
      for (let i = 0; i < depth; i++) {
        const child = { type: 'paren', nodes: [], parent };
        parent.nodes.push(child);
        parent = child;
      }
      parent.nodes.push({ type: 'text', value: 'x', parent });
      return root;
    };
    for (const method of ['compile', 'expand', 'stringify']) {
      assert.doesNotThrow(() => braces[method](ast(100)));
      assert.throws(() => braces[method](ast(101)), /AST depth/);
      const cycle = { type: 'root', nodes: [] };
      cycle.nodes.push(cycle);
      assert.throws(() => braces[method](cycle), /AST depth/);
    }
  `], { timeout: 2000, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('the depth backport preserves expansion and escapeInvalid output', () => {
  assert.equal(braces.compile('a/{b,c}/d'), 'a/(b|c)/d');
  assert.deepEqual(braces.expand('a/{b,c}/d'), ['a/b/d', 'a/c/d']);
  assert.deepEqual(braces.expand('{01..03}'), ['01', '02', '03']);
  assert.deepEqual(braces.expand('{a,b}{c,d}'), ['ac', 'ad', 'bc', 'bd']);
  assert.deepEqual(braces.expand('x\\{a,b\\}'), ['x{a,b}']);
  for (const pattern of ['{{a}}', '{a,{b}}', '{{x}y}', '{a,{b,{c}}', '{}{a}', '{1..8}']) {
    assert.equal(braces.stringify(pattern, { escapeInvalid: true }), pattern);
  }
  assert.equal(braces.compile('{{a}}', { escapeInvalid: true }), '\\{\\{a\\}\\}');
  assert.equal(braces.compile('a/{b,c', { escapeInvalid: true }), 'a/\\{b,c');
});

test('installed glob and watcher parents consume the guarded implementation', { timeout: 5000 }, async () => {
  const fastGlob = require('fast-glob');
  const chokidar = require('chokidar');
  for (const parent of ['micromatch', 'chokidar']) {
    const parentRequire = createRequire(require.resolve(parent));
    assert.equal(parentRequire.resolve('braces'), require.resolve('braces'));
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'weave-glob-depth-'));
  let watcher;
  try {
    await writeFile(path.join(directory, 'existing.ts'), 'export {};\n');
    await writeFile(path.join(directory, 'ignored.txt'), 'fixture\n');
    assert.deepEqual(fastGlob.sync('*.{ts,tsx}', { cwd: directory }), ['existing.ts']);
    assert.throws(() => fastGlob.sync(nested('{', '}', 101), { cwd: directory }), /Input depth/);
    watcher = chokidar.watch(path.join(directory, '*.{ts,tsx}'), {
      ignoreInitial: true, usePolling: true, interval: 10,
    });
    await once(watcher, 'ready');
    const added = once(watcher, 'add');
    const filename = path.join(directory, 'new.tsx');
    await writeFile(filename, 'export {};\n');
    assert.equal((await added)[0], filename);
  } finally {
    await watcher?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
