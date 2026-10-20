import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = join(import.meta.dirname, '../src');
const source = (path: string) => readFileSync(join(root, path), 'utf8');
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
function elements(path: string, tag: string) {
  const result: ts.JsxAttributes[] = [];
  const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node: ts.Node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(file) === tag) result.push(node.attributes);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}
const has = (attrs: ts.JsxAttributes, name: string) => attrs.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText() === name);

test('every raw TextInput is in the audited inventory and has an accessible name', () => {
  const inventory = files(root).filter(path => /\.tsx$/.test(path) && /<TextInput\b/.test(readFileSync(path, 'utf8')))
    .map(path => relative(root, path)).sort();
  assert.deepEqual(inventory, [
    'app/(tabs)/profile.tsx', 'app/onboarding/step2.tsx',
    'components/Auth/AuthInput.tsx', 'components/Auth/LoginInput.tsx',
    'components/Auth/ProfileInput.tsx', 'components/Auth/ProfileTextArea.tsx',
    'components/InputField.tsx', 'components/connection-list.tsx',
    'components/explore/SearchBar.tsx', 'components/home/CommentSheet.tsx',
    'components/home/save-popup.tsx', 'components/profile-repository-list.tsx',
  ].sort(), 'New inputs must be added to the keyboard QA matrix.');
  for (const path of inventory) for (const attrs of elements(path, 'TextInput')) assert.ok(has(attrs, 'accessibilityLabel'), path);
});

test('all long forms use the focus-aware scroll owner without a second avoider', () => {
  for (const path of ['app/(auth)/login.tsx', 'app/(auth)/sign-up-email.tsx',
    'app/(auth)/forgot-password.tsx', 'app/(auth)/reset-password.tsx',
    'app/onboarding/create-profile.tsx', 'app/onboarding/step2.tsx', 'app/onboarding/step3.tsx', 'app/(tabs)/profile.tsx']) {
    assert.equal(elements(path, 'KeyboardForm').length, 1, path);
    assert.equal(elements(path, 'KeyboardAvoidingView').length, 0, path);
  }
});

test('search headers and editable sheets use a measured keyboard surface on both platforms', () => {
  for (const path of ['app/(tabs)/explore.tsx', 'components/connection-list-screen.tsx',
    'components/connection-sheet.tsx', 'components/home/CommentSheet.tsx', 'components/home/save-popup.tsx']) {
    assert.equal(elements(path, 'KeyboardSurface').length, 1, path);
  }
  const attrs = elements('components/keyboard/keyboard-layout.tsx', 'KeyboardAvoidingView')[0];
  assert.ok(has(attrs, 'automaticOffset'));
  assert.ok(has(attrs, 'behavior'));
  assert.ok(!has(attrs, 'enabled'), 'Android avoidance must not be disabled.');
  assert.equal(JSON.parse(readFileSync(join(root, '../app.json'), 'utf8')).expo.android.softwareKeyboardLayoutMode, 'resize');
});

test('keyboard scrolling keeps first-tap controls and drag dismissal and has a root provider', () => {
  const attrs = elements('components/keyboard/keyboard-layout.tsx', 'KeyboardAwareScrollView')[0];
  for (const name of ['keyboardShouldPersistTaps', 'keyboardDismissMode', 'automaticallyAdjustKeyboardInsets']) assert.ok(has(attrs, name));
  assert.equal(elements('app/_layout.tsx', 'KeyboardProvider').length, 1);
  for (const path of ['components/connection-sheet.tsx', 'components/home/CommentSheet.tsx', 'components/home/save-popup.tsx']) {
    assert.match(source(path), /flexShrink: 1, minHeight: 0/, path);
  }
});


test('keyboard tab hiding is scoped to Explore instead of resizing the feed behind modals', () => {
  const layout = source('app/(tabs)/_layout.tsx');
  const globalOptions = layout.slice(layout.indexOf('screenOptions='), layout.indexOf('<Tabs.Screen'));
  assert.doesNotMatch(globalOptions, /tabBarHideOnKeyboard/);
  assert.match(layout, /title: 'Explore',[\s\S]*?tabBarHideOnKeyboard: true/);
});
