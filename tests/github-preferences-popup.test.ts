import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import ts from 'typescript';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
function fixture() {
  const filename = resolve('src/components/profile/GitHubPreferencesPopup.tsx');
  const nativeRequire = createRequire(filename);
  const module = {exports:{} as any};
  const reads: string[] = [], retired: string[] = [];
  const panel = (kind: string) => (props: any) => {
    React.useEffect(() => {reads.push(`${kind}:${props.userId}`); return () => {retired.push(`${kind}:${props.userId}`);};}, [props.userId]);
    return React.createElement(kind, props);
  };
  const mocks: Record<string, unknown> = {
    'react-native': {Modal:'Modal', View:'View', Text:'Text', Pressable:'Pressable', ScrollView:'ScrollView', StyleSheet:{create:(styles: unknown)=>styles}, useWindowDimensions:()=>({width:412,height:915})},
    'react-native-safe-area-context': {useSafeAreaInsets:()=>({top:24,bottom:24})},
    'react-native-reanimated': {useReducedMotion:()=>true},
    '@/assets/icons/github.svg': {__esModule:true,default:'GitHubIcon'},
    'lucide-react-native': {Github:'Github', X:'X'},
    '../../constants/theme': {APP_THEME:{primary:'#63E08A'},REFERENCE_THEME:{canvas:'#0A0A0C',surface:'#1C1C1E',surfaceElevated:'#2C2C2E',border:'rgba(255,255,255,0.12)',text:'#FFFFFF',textSecondary:'rgba(235,235,245,0.60)'}},
    '../../hooks/use-modal-scroll-lock': {useModalScrollLock:()=>undefined},
    '../onboarding/GitHubImportPanel': {GitHubImportPanel:panel('ImportPanel')},
    '../onboarding/GitHubUnlinkPanel': {GitHubUnlinkPanel:panel('UnlinkPanel')},
  };
  const js = ts.transpileModule(readFileSync(filename,'utf8'), {fileName:filename, compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  new Function('require','module','exports',js)((name:string)=>name in mocks?mocks[name]:nativeRequire(name), module, module.exports);
  return {Popup:module.exports.GitHubPreferencesPopup, reads, retired};
}

test('GitHub preferences open in a scrollable modal and close without hidden requests', async () => {
  const {Popup,reads,retired}=fixture();let closes=0;let root!:ReturnType<typeof create>;
  const props={visible:false,userId:'alice',onSaved:async()=>undefined,onClose:()=>{closes++;}};
  await act(async()=>{root=create(React.createElement(Popup,props));});
  try {
    assert.deepEqual(reads,[]);
    await act(async()=>{root.update(React.createElement(Popup,{...props,visible:true}));});
    const modals=root.root.findAllByType('Modal');
    assert.equal(modals.length,1,'preferences belong in a popup, not the profile layout');
    assert.equal(root.root.findAllByType('ScrollView').length,1);
    assert.deepEqual(reads,['ImportPanel:alice','UnlinkPanel:alice']);
    await act(async()=>{modals[0].props.onRequestClose();});
    const close=root.root.findAllByType('Pressable').find(node=>node.props.accessibilityLabel==='Close GitHub preferences')!;
    await act(async()=>{close.props.onPress();});
    assert.equal(closes,2);
    await act(async()=>{root.update(React.createElement(Popup,props));});
    assert.deepEqual(retired,['ImportPanel:alice','UnlinkPanel:alice']);
    assert.equal(root.root.findAllByType('Modal').length,0);
  } finally {await act(async()=>root.unmount());}
});

test('switching accounts retires old GitHub controls before mounting the new owner', async()=>{
  const {Popup,reads,retired}=fixture();let root!:ReturnType<typeof create>;
  const props={visible:true,userId:'alice',onSaved:async()=>undefined,onClose:()=>undefined};
  await act(async()=>{root=create(React.createElement(Popup,props));});
  try {
    await act(async()=>{root.update(React.createElement(Popup,{...props,userId:'bob'}));});
    assert.deepEqual(retired,['ImportPanel:alice','UnlinkPanel:alice']);
    assert.deepEqual(reads.slice(-2),['ImportPanel:bob','UnlinkPanel:bob']);
  }finally{await act(async()=>root.unmount());}
});
