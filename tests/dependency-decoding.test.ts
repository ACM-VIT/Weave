import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const queryString = require('query-string') as typeof import('query-string');
const { getStateFromPath } = require('expo-router/build/react-navigation/core/getStateFromPath');

test('the router query parser preserves query and malformed UTF-8 decoding', () => {
  const parsed = queryString.parse(
    'name=st%C3%A5le&space=a+b&plus=a%2Bb&tag=one&tag=two&flag&bad=%C3%5A%A5',
  );
  assert.deepEqual({ ...parsed }, {
    bad: '%C3Z%A5',
    flag: null,
    name: 'ståle',
    plus: 'a+b',
    space: 'a b',
    tag: ['one', 'two'],
  });
  assert.equal(queryString.stringify(parsed),
    'bad=%25C3Z%25A5&flag&name=st%C3%A5le&plus=a%2Bb&space=a%20b&tag=one&tag=two');
  const state = getStateFromPath('/profile/42?name=st%C3%A5le&space=a+b&plus=a%2Bb', {
    screens: { Profile: 'profile/:id' },
  });
  assert.deepEqual(state.routes[0].params, {
    id: '42', name: 'ståle', plus: 'a+b', space: 'a b',
  });
});

test('malformed router query input terminates without recursive decoding or byte recombination', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { getStateFromPath } = require(${JSON.stringify(require.resolve('expo-router/build/react-navigation/core/getStateFromPath'))});
    const parse = value => getStateFromPath('/profile?value=' + value).routes[0].params.value;
    const input = '%FF'.repeat(4096);
    assert.equal(parse(input), input);
    assert.equal(parse('%84%D7%25%88%90'), '%84%D7%%88%90');
  `], { timeout: 2000, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
