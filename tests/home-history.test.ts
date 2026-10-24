import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act, useEffect, useImperativeHandle, useRef } from 'react';
import { create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import ts from 'typescript';
import type { FeedPage } from '../src/services/feedPagination';

// Render the real Home hooks, mapper, pagination and query cache. Replace the
// native list and expensive card body to inspect row mounts and scroll commands.
for (const discovery of [false, true]) for (const scenario of ['steady', 'backscroll', 'resize']) {
  const backscroll = scenario !== 'steady', resize = scenario === 'resize';
  test(`actual Home eviction preserves visible row state, attribution and scroll (discovery=${discovery}, scenario=${scenario})`, async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const key = ['feed', 'viewer'];
    const page = (start: number): FeedPage => ({
      items: Array.from({ length: 10 }, (_, offset) => ({ repo_id: String(start + offset), full_name: `owner/repo-${start + offset}`,
        ...(discovery ? {} : { serve_id: `serve-${start}`, position: start + offset }) })),
      feedVersion: '1', sessionId: 'session', mode: discovery ? 'discovery' : 'personalized',
      nextCursor: String(start + 10), requestCursor: start === 0 ? null : String(start),
    });
    const pages = Array.from({ length: 50 }, (_, index) => page(index * 10));
    client.setQueryData(key, { pages, pageParams: pages.map(value => value.requestCursor) });
    let list: any, calls = 0;
    const preparedSessions: string[] = [], resetSessions: string[] = [];
    let resolveNext!: () => void;
    const response = new Promise<void>(resolve => { resolveNext = resolve; });
    const scrolls: any[] = [], mounts = new Map<string, number>(), impressions: string[] = [];
    const FlatList = React.forwardRef((props: any, ref) => {
      list = props;
      useImperativeHandle(ref, () => ({ scrollToOffset: (value: any) => scrolls.push(value) }));
      return React.createElement('FlatList', null, props.data.map((item: any, index: number) =>
        React.createElement(React.Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item, index }))));
    });
    function Card(props: any) {
      const sent = useRef(false), id = props.repository.id;
      useEffect(() => { mounts.set(id, (mounts.get(id) ?? 0) + 1); }, []);
      useEffect(() => { if (props.isViewable && !sent.current) { sent.current = true; impressions.push(id); } }, [props.isViewable]);
      return React.createElement('Card', props);
    }
    const native = { FlatList, View: 'View', Text: 'Text', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator',
      AppState: { addEventListener: () => ({ remove() {} }) }, Platform: { OS: 'web' },
      StyleSheet: { create: (styles: unknown) => styles }, useWindowDimensions: () => ({ width: 400, height: 800 }) };
    const filename = resolve('src/app/(tabs)/home.tsx'), nativeRequire = createRequire(filename);
    const mocks: Record<string, unknown> = {
      'react-native': native, '@/components/responsive-layout': { getResponsiveContentWidth: () => 400 },
      '@/components/home/RepositoryFeedItem': { RepositoryFeedItem: Card }, '@/components/home/FeedHeader': { FeedHeader: () => null },
      '@/constants/theme': { REFERENCE_THEME: {} }, 'expo-router': { router: { push() {} } },
      '../../utils/storage': { getItemAsync: async () => 'token' },
      '@/api/feed-sessions': { feedSessions: () => ({ prepare: async (session: string) => { preparedSessions.push(session); return session; }, reset: async (session: string) => { resetSessions.push(session); return true; } }) },
      '@/api/home-feed': { fetchHomeFeed: async (_token: string, cursor: string | null) => { calls++; if (backscroll && cursor === '500') await response; return page(Number(cursor)); } },
      '@/store/AuthContext': { useAuth: () => ({ user: { user_id: 'viewer' }, checkOnboardingStatus: async () => {}, adjustLikesGivenCount() {}, settleLikesGivenCountAdjustments() {} }) },
      '@/services/activityOutboxClient': { getActivityOutbox: () => null },
      '@react-native-community/netinfo': { addEventListener: () => () => {} },
    };
    const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), { fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const module: { exports: any } = { exports: {} };
    new Function('require', 'module', 'exports', javascript)((specifier: string) => specifier in mocks ? mocks[specifier] : nativeRequire(specifier), module, module.exports);
    let renderer!: ReturnType<typeof create>;
    try {
      await act(async () => { renderer = create(React.createElement(QueryClientProvider, { client }, React.createElement(module.exports.default))); });
      const anchor = list.data[480];
      await act(async () => {
        list.onScroll({ nativeEvent: { contentOffset: { y: 480 * 800 + 35 } } });
        list.onViewableItemsChanged({ viewableItems: [{ item: anchor, isViewable: true }] });
      });
      assert.deepEqual(impressions, ['480']);
      await act(async () => { list.onEndReached(); await new Promise(resolve => setTimeout(resolve, 25)); });
      let threatened: any;
      if (backscroll) {
        assert.equal(calls, 1);
        assert.equal(list.data[0].repository.id, '0', 'the response is still deferred');
        threatened = list.data[resize ? 0 : 4];
        if (resize) {
          const host = renderer.root.findAllByType('View' as any).find(node => node.props.onLayout)!;
          await act(async () => { host.props.onLayout({ nativeEvent: { layout: { width: 380, height: 800 } } }); });
        } else await act(async () => {
          // Card 4 is 40% visible; only card 5 qualifies for an impression.
          list.onScroll({ nativeEvent: { contentOffset: { y: 4 * 800 + 480 } } });
          list.onViewableItemsChanged({ viewableItems: [{ item: list.data[5], isViewable: true }] });
        });
        await act(async () => { resolveNext(); await new Promise(resolve => setTimeout(resolve, 25)); });
      }
      const cached = client.getQueryData<InfiniteData<FeedPage>>(key)!;
      assert.equal(calls, 1);
      assert.equal(cached.pages.flatMap(value => value.items).length, 500);
      assert.equal(list.data.length, 500);
      if (backscroll) {
        assert.equal(list.data[0].feedId, threatened.feedId, 'partly visible row must be pinned by the actual Home wiring');
        if (resize) {
          assert.equal(mounts.get('0'), 2, 'width-only resize remounts the native list');
          assert.deepEqual(scrolls.at(-1), { offset: 0, animated: false }, 'replacement list starts with matching scroll tracking');
        } else {
          assert.equal(list.data[1].repository.id, '5');
          assert.equal(mounts.get('4'), 1);
          assert.equal(mounts.get('5'), 1);
          assert.deepEqual(impressions, ['480', '5'], 'retention pins do not relax impression visibility');
          assert.deepEqual(scrolls.at(-1), { offset: 480, animated: false }, 'preserve both partial rows at the same screen coordinates');
        }
      } else {
        assert.equal(list.data[470].feedId, anchor.feedId);
        assert.equal(mounts.get('480'), 1, 'visible card instance survives prefix eviction');
        assert.deepEqual(impressions, ['480'], 'preserved per-row state must not emit another impression on eviction');
        assert.deepEqual(scrolls.at(-1), { offset: 470 * 800 + 35, animated: false });
        if (!discovery) {
          assert.equal(list.data[470].repository.serveId, 'serve-480');
          assert.equal(list.data[470].repository.feedPosition, 480);
        }
      }
      assert.equal(cached.pages.at(-1)!.nextCursor, '510');
      await act(async () => { await list.onRefresh(); await new Promise(resolve => setTimeout(resolve, 25)); });
      assert.deepEqual(resetSessions, ['session']);
      assert.equal(preparedSessions.at(-1), 'session', 'refresh retains the canonical reset session');
      assert.equal(scrolls.at(-1).offset, 0);
      assert.equal(client.getQueryData<InfiniteData<FeedPage>>(key)!.pages[0].items[0].repo_id, '0');
    } finally {
      await act(async () => renderer?.unmount()); client.clear();
      delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    }
  });
}
