import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import ts from 'typescript';
import { mapRepositoryDetail } from '../src/utils/repository-mapper';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
test('Trending cards visibly distinguish repositories with the same name', async () => {
  const filename=resolve('src/components/explore/TrendingRepoCard.tsx'), requireNative=createRequire(filename), module={exports:{} as any};
  const mocks:Record<string,unknown>={
    'react-native':{Pressable:'Pressable',Text:'Text',View:'View'},
    'react-native-svg':{__esModule:true,default:'Svg',Path:'Path'},
    '@/utils/format-count':requireNative('../../utils/format-count.ts'),
    '@/utils/readme':requireNative('../../utils/readme.ts'),
  };
  const js=ts.transpileModule(readFileSync(filename,'utf8'),{fileName:filename,compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  new Function('require','module','exports',js)((name:string)=>name in mocks?mocks[name]:requireNative(name),module,module.exports);
  const Card=module.exports.default, opens:string[]=[];let root!:ReturnType<typeof create>;
  const names=['original/project','contributor/project'];
  await act(async()=>{root=create(React.createElement(React.Fragment,null,...names.map((fullName,index)=>React.createElement(Card,{key:fullName,repo:mapRepositoryDetail({repo_id:`00000000-0000-4000-8000-00000000000${index+1}`,full_name:fullName}),onPress:()=>opens.push(fullName)}))));});
  try {
    const visible=root.root.findAllByType('Text').map(node=>node.props.children);
    for(const fullName of names)assert.ok(visible.includes(fullName),`${fullName} must be visible, not only an accessibility label`);
    for(const button of root.root.findAllByType('Pressable'))await act(async()=>button.props.onPress());
    assert.deepEqual(opens,names);
  } finally {await act(async()=>root.unmount());}
});
