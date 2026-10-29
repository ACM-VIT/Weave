import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/** Run the installed Android CSS interop renderer; only host OS bindings are replaced. */
export function nativeStyleRuntime() {
  const nativeRequire = createRequire(resolve('package.json'));
  const root = dirname(nativeRequire.resolve('react-native-css-interop/package.json'));
  const cache = new Map<string, {exports:any}>();
  const subscription = () => ({remove() {}});
  const native = {
    ...Object.fromEntries(['View','Text','Image','Pressable','Switch','TouchableHighlight','TouchableOpacity',
      'TouchableWithoutFeedback','ActivityIndicator','StatusBar','ScrollView','TextInput','FlatList',
      'ImageBackground','KeyboardAvoidingView','VirtualizedList'].map(name => [name,name])),
    Platform:{OS:'android', select:(values:any) => values.android ?? values.native ?? values.default},
    StyleSheet:{create:(styles:unknown) => styles, hairlineWidth:0.5},
    Appearance:{getColorScheme:() => 'dark', addChangeListener:subscription},
    AppState:{currentState:'active', addEventListener:subscription},
    Dimensions:{get:() => ({width:412,height:915}), addEventListener:subscription},
    AccessibilityInfo:{isReduceMotionEnabled:async () => false, addEventListener:subscription},
  };
  function load(filename:string):any {
    if (filename === resolve(root,'dist/runtime/api.js')) filename = resolve(root,'dist/runtime/native/api.js');
    const previous = cache.get(filename);
    if (previous) return previous.exports;
    const module = {exports:{}};
    cache.set(filename,module);
    const localRequire = createRequire(filename);
    new Function('require','module','exports','__DEV__',readFileSync(filename,'utf8'))((name:string) => {
      if (name === 'react-native') return native;
      if (name === 'react-native-safe-area-context') return {};
      const target = localRequire.resolve(name);
      return target.startsWith(root) ? load(target) : localRequire(name);
    },module,module.exports,true);
    return module.exports;
  }
  const api = load(resolve(root,'dist/runtime/native/api.js'));
  api.cssInterop(native.Pressable,{className:'style'});
  const wrap = load(resolve(root,'dist/runtime/wrap-jsx.js')).default;
  const runtime = nativeRequire('react/jsx-runtime');
  return {native, jsx:{...runtime,jsx:wrap(runtime.jsx),jsxs:wrap(runtime.jsxs)}};
}
