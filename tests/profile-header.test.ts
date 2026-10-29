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
    if (name === 'react-native') return { View: 'View', Text: 'Text', Image: 'Image', Pressable: 'Pressable', StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} } };
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
    onGitHubPreferences: () => actions.push('github'), githubPreferencesVisible: false, githubIcon: React.createElement('GitHubIcon'),
    stats: ['likes given', 'saved', 'followers', 'following'].map(label => ({label, value: '10.2K', onPress: () => actions.push(label)})),
  }));});
  try {
    const text = root.root.findAllByType('Text').find(node => React.Children.toArray(node.props.children).join('') === `@${username}`)!;
    assert.ok(text, 'the complete username remains available');
    assert.ok(text.props.style.fontSize >= 16, 'long usernames must not shrink into unreadable text');
    assert.equal(text.props.adjustsFontSizeToFit, undefined);
    const texts = root.root.findAllByType('Text');
    const nameText = texts.find(node => node.props.children === 'Krishang Zinzuwadia')!;
    assert.ok(nameText.props.style.fontSize > text.props.style.fontSize, 'display name is the primary identity');
    assert.ok(texts.indexOf(nameText) < texts.indexOf(text), 'the name precedes the secondary handle');
    const buttons = root.root.findAllByType('Pressable');
    assert.equal(buttons.length, 7);
    const edit = buttons.find(button => button.props.accessibilityLabel === 'Edit profile')!;
    const logout = buttons.find(button => button.props.accessibilityLabel === 'Log out')!;
    const github = buttons.find(button => button.props.accessibilityLabel === 'GitHub activity preferences')!;
    assert.equal(github.findAllByType('GitHubIcon').length,1);
    assert.equal(github.parent, logout.parent);
    assert.ok(buttons.indexOf(github) < buttons.indexOf(logout), 'the compact GitHub action is immediately before logout');
    assert.ok(logout.parent!.findAllByType('Text').includes(nameText), 'logout shares the identity row instead of reserving an empty row above it');
    assert.ok(edit.findAllByType('Text').some(node => node.props.children === 'Edit Profile'), 'Edit Profile must be visibly labeled, not an unexplained icon');
    assert.ok(texts.indexOf(edit.findByType('Text')) > texts.findIndex(node => node.props.children === 'following'), 'Edit Profile follows the complete stats row');
    for (const button of buttons) await act(async () => {button.props.onPress();});
    assert.deepEqual(actions, ['github', 'logout', 'likes given', 'saved', 'followers', 'following', 'edit']);
  } finally {await act(async () => root.unmount());}
});

test('another developer profile also presents the display name before its readable username',async()=>{
  const {loadSource}=await import('./support/startup-harness');
  const theme=loadSource('src/constants/theme.ts',{'@/global.css':{},'react-native':{Platform:{select:(options:any)=>options.default}}});
  class Value {interpolate(){return 0;}}
  const animation=()=>({start(){},stop(){}});
  const {OtherUserProfile}=loadSource('src/components/other-user-profile.tsx',{
    'react-native':{ActivityIndicator:'ActivityIndicator',Image:'Image',Pressable:'Pressable',ScrollView:'ScrollView',Text:'Text',View:'View',StyleSheet:{create:(s:unknown)=>s,hairlineWidth:.5,absoluteFill:{}},useWindowDimensions:()=>({width:350}),Animated:{Value,View:'AnimatedView',timing:animation,stagger:animation},Easing:{out:()=>0,cubic:0}},
    'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:0,bottom:0})},
    'lucide-react-native':{ArrowLeft:'ArrowLeft',List:'ListIcon',Pin:'Pin'},
    '@/components/explore/RepoCard':{__esModule:true,default:'RepoCard'},
    '@/components/follow-button':{FollowButton:'FollowButton'},
    '@/components/profile/BoardListCard':{BoardListCard:'BoardListCard'},
    '@/constants/theme':theme,'@/utils/avatar-color':{getAvatarColor:()=> '#333'},'@/utils/format-count':{formatCompactCount:String},
  });
  let root!:ReturnType<typeof create>;
  await act(async()=>{root=create(React.createElement(OtherUserProfile,{profile:{userId:'other',username:'krishang-zinzuwadia-long-handle',displayName:'Krishang Zinzuwadia',bio:'Building apps',isFollowing:false,stats:{likes:0,followers:0,following:0},lists:[],pinnedRepositories:[]},onBack(){},onListPress(){},onRepositoryPress(){}}));});
  try {
    const texts=root.root.findAllByType('Text');
    const name=texts.find(node=>node.props.children==='Krishang Zinzuwadia')!;
    const handle=texts.find(node=>React.Children.toArray(node.props.children).join('')==='@krishang-zinzuwadia-long-handle')!;
    const style=(node:any)=>Object.assign({},...node.props.style.flat());
    assert.ok(texts.indexOf(name)<texts.indexOf(handle));
    assert.ok(style(name).fontSize>style(handle).fontSize);
    assert.equal(handle.props.adjustsFontSizeToFit,undefined);
    assert.equal(root.root.findByType('FollowButton').props.targetUserId,'other');
  }finally{await act(async()=>root.unmount());}
});

test('an empty profile omits empty identity rows and keeps an honest avatar fallback', async () => {
  const Header = header();
  let root!: ReturnType<typeof create>;
  await act(async () => {root = create(React.createElement(Header, {username: '', name: '', job: '', isCompact: false, isTablet: false, stats: [], onEdit() {}, onLogout() {}}));});
  try {assert.deepEqual(root.root.findAllByType('Text').map(node => node.props.children), ['?', 'Edit Profile']);}
  finally {await act(async () => root.unmount());}
});

test('profile avatar failures fall back honestly and a changed photo gets a new loading attempt', async () => {
  const Header = header();
  const props = { username: 'weaver', name: 'Weaver', job: '', isCompact: false, isTablet: false, stats: [], onEdit() {}, onLogout() {} };
  let root!: ReturnType<typeof create>;
  await act(async () => {root = create(React.createElement(Header, { ...props, avatarUrl: 'https://example.invalid/first.png' }));});
  try {
    const image = root.root.findAllByType('Image')[0];
    assert.ok(image, 'a saved avatar is rendered instead of always showing initials');
    assert.deepEqual(image.props.source, { uri: 'https://example.invalid/first.png' });
    await act(async () => image.props.onError({ nativeEvent: { error: 'Image unavailable' } }));
    assert.equal(root.root.findAllByType('Image').length, 0);
    assert.ok(root.root.findAllByType('Text').some(node => node.props.children === 'W'), 'failed images retain the identity fallback');
    await act(async () => root.update(React.createElement(Header, { ...props, avatarUrl: 'https://example.invalid/replacement.png' })));
    assert.deepEqual(root.root.findByType('Image').props.source, { uri: 'https://example.invalid/replacement.png' });
    await act(async () => root.update(React.createElement(Header, { ...props, avatarUrl: '  ' })));
    assert.equal(root.root.findAllByType('Image').length, 0, 'blank photo URLs use fallback without a broken request');
  } finally {await act(async () => root.unmount());}
});

test('Change photo is a separate accessible action and does not invoke Edit Profile',async()=>{
 const Header=header();let changed=0,edited=0,root!:ReturnType<typeof create>;
 await act(async()=>{root=create(React.createElement(Header,{username:'weaver',name:'Weaver',job:'',isCompact:true,isTablet:false,stats:[],onEdit:()=>edited++,onLogout(){},onChangePhoto:()=>changed++}));});
 try{const change=root.root.findAllByType('Pressable').find(node=>node.props.accessibilityLabel==='Change profile photo')!;
 assert.equal(change.props.accessibilityRole,'button');assert.ok(change.props.style.minHeight>=48);
 await act(async()=>change.props.onPress());assert.equal(changed,1);assert.equal(edited,0);
 }finally{await act(async()=>root.unmount());}
});

test('Android interop preserves Profile stat widths and Edit Profile button styling', async () => {
  const {nativeStyleRuntime} = await import('./support/native-style-runtime');
  const runtime = nativeStyleRuntime();
  const {loadSource} = await import('./support/startup-harness');
  const {ProfileHeader:Header} = loadSource('src/components/profile/ProfileHeader.tsx', {
    'react-native':runtime.native,
    'react/jsx-runtime':runtime.jsx,
    'lucide-react-native':{LogOut:'LogOut',SquarePen:'SquarePen'},
  });
  let root!:ReturnType<typeof create>;
  await act(async () => {root=create(React.createElement(Header,{
    username:'tarunram',name:'Tarun',job:'',isCompact:false,isTablet:false,onEdit(){},onLogout(){},
    stats:['likes given','saved','followers','following'].map(label => ({label,value:'3',onPress(){}})),
  }));});
  try {
    const buttons=root.root.findAllByType('Pressable');
    const styleOf=(label:string) => {
      const style=buttons.find(node => node.props.accessibilityLabel === label)!.props.style;
      return Object.assign({},...[typeof style === 'function' ? style({pressed:false}) : style].flat());
    };
    assert.equal(styleOf('3 saved').flex,1,'stats must each occupy an equal share of the row');
    assert.equal(styleOf('Edit profile').borderWidth,1);
    assert.equal(styleOf('Edit profile').flexDirection,'row');
    assert.equal(styleOf('Edit profile').minHeight,48);
  } finally {await act(async () => root.unmount());}
});
