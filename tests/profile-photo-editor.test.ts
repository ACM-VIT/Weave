import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { createProfilePhotoFlow, profilePhotoRecovery } from '../src/services/profilePhotoFlow';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
test('photo editor requires explicit Save, announces public links and cancels without upload', async () => {
    const filename = path.resolve('src/components/profile/ProfilePhotoEditor.tsx'), nativeRequire = createRequire(filename), module = { exports: {} as any };
    let uploads = 0;
    const lifecycle = { currentGeneration: () => 1, isCurrent: () => true, subscribe: () => () => { } };
    const api = { uploadProfileAvatar: async () => { uploads++; return { avatar_url: 'https://fixture.invalid/a.webp', profile_version: '2' }; } };
    const boundaries: any = { 'react-native': { View: 'View', ScrollView: 'ScrollView', Text: 'Text', Image: 'Image', Pressable: 'Pressable', Modal: 'Modal', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (s: any) => s } },
        '@/api/session-lifecycle': { authSessionLifecycle: lifecycle }, '@/api/profile-avatar': api, '@/services/profilePhotoFlow': { createProfilePhotoFlow, profilePhotoRecovery },
        '@/services/profilePhotoPicker': { pickProfilePhoto: async () => ({ uri: 'file://fixture' }), readProfilePhoto: async () => new Uint8Array([255, 216, 255, 1]).buffer },
        '@/store/AuthContext': { useAuth: () => ({ applySavedAvatar() { }, checkOnboardingStatus: async () => { } }) } };
    const js = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    new Function('require', 'module', 'exports', js)((name: string) => name in boundaries ? boundaries[name] : nativeRequire(name), module, module.exports);
    let closed = 0, root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(module.exports.ProfilePhotoEditor, { owner: 'owner', onClose: () => closed++ })); });
    const button = (label: string) => root.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === label)!;
    assert.ok(root.root.findAllByType('Text').some(node => String(node.props.children).includes('Anyone with the image link')));
    await act(async () => button('Choose profile photo').props.onPress());
    assert.equal(uploads, 0);
    assert.ok(button('Save profile photo'));
    await act(async () => button('Cancel photo change').props.onPress());
    assert.equal(uploads, 0);
    assert.equal(closed, 1);
    const staleCancel=button('Cancel photo change').props.onPress;
    await act(async () => root.unmount());
    await act(async()=>staleCancel());
    assert.equal(closed,1,'retained Cancel cannot close a replacement editor after unmount');
});
