import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import ts from 'typescript';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function header() {
  const filename = resolve('src/components/profile/ProfileHeader.tsx');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} as any };
  const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', javascript)((name: string) => {
    if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { create: (styles: unknown) => styles } };
    if (name === 'lucide-react-native') return { LogOut: 'LogOut', SquarePen: 'SquarePen' };
    return nativeRequire(name);
  }, module, module.exports);
  return module.exports.ProfileHeader;
}

test('long profile identity remains readable and every header action retains its own callback', async () => {
  const Header = header();
  const actions: string[] = [];
  const username = 'krishang-zinzuwadia-05782-long-username';
  let root!: ReturnType<typeof create>;
  await act(async () => {root = create(React.createElement(Header, {
    username, name: 'Krishang Zinzuwadia', job: 'Building open source projects with multiple teams.', isCompact: true, isTablet: false,
    onEdit: () => actions.push('edit'), onLogout: () => actions.push('logout'),
    stats: ['likes given', 'saved', 'followers', 'following'].map(label => ({label, value: '10.2K', onPress: () => actions.push(label)})),
  }));});
  try {
    const text = root.root.findAllByType('Text').find(node => React.Children.toArray(node.props.children).join('') === `@${username}`)!;
    assert.ok(text, 'the complete username remains available');
    assert.ok(text.props.style.fontSize >= 16, 'long usernames must not shrink into unreadable text');
    assert.equal(text.props.adjustsFontSizeToFit, undefined);
    const buttons = root.root.findAllByType('Pressable');
    assert.equal(buttons.length, 6);
    for (const button of buttons) await act(async () => {button.props.onPress();});
    assert.deepEqual(actions, ['edit', 'logout', 'likes given', 'saved', 'followers', 'following']);
  } finally {await act(async () => root.unmount());}
});

test('an empty profile omits empty identity rows and keeps an honest avatar fallback', async () => {
  const Header = header();
  let root!: ReturnType<typeof create>;
  await act(async () => {root = create(React.createElement(Header, {username: '', name: '', job: '', isCompact: false, isTablet: false, stats: [], onEdit() {}, onLogout() {}}));});
  try {assert.deepEqual(root.root.findAllByType('Text').map(node => node.props.children), ['?']);}
  finally {await act(async () => root.unmount());}
});
