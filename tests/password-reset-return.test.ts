import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import ts from 'typescript';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function fixture(platform: 'web' | 'ios' | 'android', options: { updateFails?: boolean; blocked?: boolean; invalid?: boolean; reply?: Promise<void> } = {}) {
  const events: string[] = [];
  const calls: string[][] = [];
  const filename = resolve('src/app/(auth)/reset-password.tsx');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} as any };
  const mocks: Record<string, any> = {
    '@/utils/password-policy': nativeRequire('../../utils/password-policy'),
    '@/components/keyboard/keyboard-layout': { KeyboardForm: 'KeyboardForm' },
    '@/components/Auth/LoginInput': { default: 'LoginInput', __esModule: true },
    '@/components/Auth/PrimaryButton': { default: 'PrimaryButton', __esModule: true },
    '@/api/auth': { confirmPasswordReset: async (...args: string[]) => {
      calls.push(args);
      await options.reply;
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

for (const platform of ['web', 'ios', 'android'] as const) {
  for (const updateFails of [false, true]) {
    test(`late ${platform} reset response after unmount has no navigation side effects (failure=${updateFails})`, async () => {
      let finish!: () => void;
      const reply = new Promise<void>(resolve => { finish = resolve; });
      const f = fixture(platform, { reply, updateFails });
      let screen!: ReturnType<typeof create>;
      await act(async () => { screen = create(React.createElement(f.Screen)); });
      await act(async () => {
        for (const input of screen.root.findAllByType('LoginInput')) input.props.onChangeText('a-new-password-123');
      });
      await act(async () => { screen.root.findByType('PrimaryButton').props.onPress(); });
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.events, []);
      await act(async () => screen.unmount());
      await act(async () => { finish(); });
      assert.deepEqual(f.events, updateFails ? [] : ['updated']);
    });
  }
}

test('choosing browser login suppresses handoff even before navigation unmounts the screen', async () => {
  let finish!: () => void;
  const reply = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture('web', { reply });
  let screen!: ReturnType<typeof create>;
  await act(async () => { screen = create(React.createElement(f.Screen)); });
  await act(async () => {
    for (const input of screen.root.findAllByType('LoginInput')) input.props.onChangeText('a-new-password-123');
  });
  await act(async () => { screen.root.findByType('PrimaryButton').props.onPress(); });
  await act(async () => { screen.root.findByType('Pressable').props.onPress(); });
  await act(async () => { finish(); });
  assert.deepEqual(f.events, ['/(auth)/login', 'updated']);
  assert.equal(screen.root.findByType('PrimaryButton').props.label, 'Updating…');
  await act(async () => screen.unmount());
});


test('signup and reset share the server password bounds and explicit unmet-rule messages', async () => {
  const {passwordPolicyError,PASSWORD_REQUIREMENTS}=await import('../src/utils/password-policy');
  assert.equal(PASSWORD_REQUIREMENTS,'Use 12–128 characters.');
  assert.equal(passwordPolicyError('a'.repeat(11)),'Use at least 12 characters.');
  assert.equal(passwordPolicyError('a'.repeat(12)),null);
  assert.equal(passwordPolicyError('a'.repeat(128)),null);
  assert.equal(passwordPolicyError('a'.repeat(129)),'Use no more than 128 characters.');
});

test('signup blocks the former eight-character rule and accepts the same policy as recovery', async () => {
  const {loadSource}=await import('./support/startup-harness');
  const {passwordPolicyError}=await import('../src/utils/password-policy');
  const submissions:unknown[]=[];
  const mocks:Record<string,any>={
    'react-native':{Text:'Text',View:'View'},'expo-router':{useRouter:()=>({})},
    '../../store/AuthContext':{useAuth:()=>({setSession:async()=>{}})},
    '../../api/auth':{register:async(...args:unknown[])=>{submissions.push(args);throw Error('fixture stopped after validation');}},
    '../../hooks/useOAuth':{useOAuth:()=>({})},
    '@/components/keyboard/keyboard-layout':{KeyboardForm:'KeyboardForm'},
    '@/utils/password-policy':{passwordPolicyError},
  };
  for(const component of ['AuthFooter','AuthInput','BrandWord','EmailTab','LogoCircle','OrDivider','PasswordRules','PrimaryButton','SectionLabel','SocialButton','date-of-birth-field']) {
    mocks[`@/components/Auth/${component}`]={__esModule:true,default:component};
  }
  mocks['@/components/Auth/icons']={GithubIcon:'GithubIcon',GoogleIcon:'GoogleIcon'};
  const {default:Screen}=loadSource('src/app/(auth)/sign-up-email.tsx',mocks);
  let screen!:ReturnType<typeof create>;
  await act(async()=>{screen=create(React.createElement(Screen));});
  try {
    const inputs=screen.root.findAllByType('AuthInput');
    await act(async()=>{for(const [i,value] of ['Tarun','tarun','tarun@example.test','Strong12'].entries())inputs[i].props.onChangeText(value);
      screen.root.findByType('date-of-birth-field').props.onChange('2005-01-01');});
    await act(async()=>{screen.root.findByType('PrimaryButton').props.onPress();});
    assert.equal(submissions.length,0);
    assert.ok(screen.root.findAllByType('Text').some(node=>node.props.children==='Use at least 12 characters.'));
    await act(async()=>{screen.root.findAllByType('AuthInput')[3].props.onChangeText('a'.repeat(12));});
    await act(async()=>{await screen.root.findByType('PrimaryButton').props.onPress();});
    assert.equal(submissions.length,1);
  } finally {await act(async()=>screen.unmount());}
});
