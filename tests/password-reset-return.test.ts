import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import ts from 'typescript';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function fixture(platform: 'web' | 'ios' | 'android', options: { updateFails?: boolean; blocked?: boolean; invalid?: boolean } = {}) {
  const events: string[] = [];
  const calls: string[][] = [];
  const filename = resolve('src/app/(auth)/reset-password.tsx');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} as any };
  const mocks: Record<string, any> = {
    '@/components/keyboard/keyboard-layout': { KeyboardForm: 'KeyboardForm' },
    '@/components/Auth/LoginInput': { default: 'LoginInput', __esModule: true },
    '@/components/Auth/PrimaryButton': { default: 'PrimaryButton', __esModule: true },
    '@/api/auth': { confirmPasswordReset: async (...args: string[]) => {
      calls.push(args);
      if (options.updateFails) throw new Error('Reset expired');
      events.push('updated');
      return 'Password updated successfully.';
    } },
    'react-native': { Platform: { OS: platform }, Pressable: 'Pressable', Text: 'Text', View: 'View' },
    'expo-router': {
      useLocalSearchParams: () => options.invalid ? {} : { access_token: 'recovery-access', refresh_token: 'recovery-refresh' },
      useRouter: () => ({ replace: (path: string) => events.push(path) }),
    },

  };
  const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', 'window', javascript)(
    (name: string) => name in mocks ? mocks[name] : nativeRequire(name), module, module.exports,
    { location: { href: 'https://weave.example/reset-password', hash: '', assign: (url: string) => {
      events.push(url);
      if (options.blocked) throw new Error('Browser blocked scheme');
    } }, history: { replaceState: () => undefined } },
  );
  return { Screen: module.exports.default, events, calls };
}

for (const platform of ['web', 'ios', 'android'] as const) {
  test(`successful ${platform} reset returns to the app only after the update`, async () => {
    const f = fixture(platform);
    let screen!: ReturnType<typeof create>;
    await act(async () => { screen = create(React.createElement(f.Screen)); });
    assert.deepEqual(f.events, []);
    await act(async () => {
      for (const input of screen.root.findAllByType('LoginInput')) input.props.onChangeText('a-new-password-123');
    });
    await act(async () => { screen.root.findByType('PrimaryButton').props.onPress(); });
    assert.deepEqual(f.calls, [['recovery-access', 'recovery-refresh', 'a-new-password-123']]);
    assert.deepEqual(f.events, ['updated', platform === 'web' ? 'ghsocial://login' : '/(auth)/login']);
    assert.equal(screen.root.findAllByType('LoginInput').length, 0);
    assert.equal(screen.root.findByType('PrimaryButton').props.label, 'Open Weave');
    assert.equal(JSON.stringify(screen.toJSON()).includes('a-new-password-123'), false);
    await act(async () => screen.unmount());
  });
}

test('a browser-blocked handoff preserves success, supports retry, and offers browser login', async () => {
  const f = fixture('web', { blocked: true });
  let screen!: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(f.Screen)); });
  await act(async () => {
    for (const input of screen.root.findAllByType('LoginInput')) input.props.onChangeText('a-new-password-123');
  });
  await act(async () => { screen.root.findByType('PrimaryButton').props.onPress(); });
  assert.match(JSON.stringify(screen.toJSON()), /Password updated successfully/);
  assert.match(JSON.stringify(screen.toJSON()), /Unable to open Weave/);
  assert.match(JSON.stringify(screen.toJSON()), /Continue in browser/);
  await act(async () => { screen.root.findByType('PrimaryButton').props.onPress(); });
  assert.equal(f.events.filter(event => event === 'ghsocial://login').length, 2);
  assert.equal(f.calls.length, 1, 'retry must not submit the password again');
  await act(async () => { screen.root.findByType('Pressable').props.onPress(); });
  assert.equal(f.events.at(-1), '/(auth)/login');
  await act(async () => screen.unmount());
});

for (const options of [{ updateFails: true }, { invalid: true }]) {
  test(`unsuccessful reset does not open the app (${JSON.stringify(options)})`, async () => {
    const f = fixture('web', options);
    let screen!: ReturnType<typeof create>;
    await act(async () => { screen = create(React.createElement(f.Screen)); });
    await act(async () => {
      for (const input of screen.root.findAllByType('LoginInput')) input.props.onChangeText('a-new-password-123');
    });
    await act(async () => { screen.root.findByType('PrimaryButton').props.onPress(); });
    assert.deepEqual(f.events, []);
    assert.equal(screen.root.findAllByType('LoginInput').length, 2);
    if (options.invalid) assert.equal(f.calls.length, 0);
    else assert.match(JSON.stringify(screen.toJSON()), /Reset expired/);
    await act(async () => screen.unmount());
  });
}

test('return scheme matches the installed application configuration', () => {
  const config = JSON.parse(readFileSync('app.json', 'utf8'));
  assert.equal(config.expo.scheme, 'ghsocial');
});
