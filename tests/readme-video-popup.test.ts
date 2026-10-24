import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import test from 'node:test';
import React,{act,useEffect} from 'react';
import {create} from 'react-test-renderer';
import ts from 'typescript';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
for(const os of ['ios','web']) test(`video popup ${os} cleanup respects player ownership`,async()=>{
  let released=false,plays=0,pauses=0;
  const player={play(){assert.equal(released,false);plays++;},pause(){assert.equal(released,false,'cannot pause a released native player');pauses++;}};
  const file=resolve('src/components/home/ReadmeVideoPopup.tsx');
  const req=createRequire(file);
  const mocks:Record<string,unknown>={
    'react-native':{Modal:'Modal',Pressable:'Pressable',Text:'Text',View:'View',Platform:{OS:os},useWindowDimensions:()=>({width:400,height:850})},
    'expo':{useEvent:()=>({status:'readyToPlay'})},
    'expo-video':{VideoView:'VideoView',useVideoPlayer:()=>{
      useEffect(()=>()=>{if(os==='ios')released=true;},[]);return player;
    }},
    'lucide-react-native':{X:'X'},
    'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:0,bottom:0})},
    '@/constants/theme':{REFERENCE_THEME:{}},
    '@/utils/readme-external-link':{openReadmeExternalLink:()=>undefined},
  };
  const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const module={exports:{} as any};
  new Function('require','module','exports',code)((name:string)=>name in mocks?mocks[name]:req(name),module,module.exports);
  let root:ReturnType<typeof create>;
  await act(async()=>{root=create(React.createElement(module.exports.ReadmeVideoPopup,{url:'https://cdn.example.com/demo.mp4',onClose:()=>undefined}));});
  assert.equal(plays,1);
  await act(async()=>root.unmount());
  assert.equal(pauses,os==='web'?1:0);
  assert.equal(released,os==='ios');
});
