import { useCallback } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useFocusEffect } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { exploreBrowseQueryOptions } from '../api/explore';

/** Warm only two browse pages, serially, after Home is visible and queries idle. */
export function useBrowsePrefetch(viewer: string | undefined, ready: boolean) {
  const client = useQueryClient();
  useFocusEffect(useCallback(() => {
    if (!viewer || !ready) return;
    let stopped = false;
    let online = false;
    let attempts = 0;
    let stage = 0;
    let running = false;
    let currentKey: readonly unknown[] | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelUnobserved = () => {
      if (!currentKey) return;
      const query = client.getQueryCache().find({queryKey:currentKey, exact:true});
      // A selected Explore screen owns its request, even if Home loses focus.
      if (query && query.getObserversCount() === 0) void client.cancelQueries({queryKey:currentKey, exact:true});
    };
    const schedule = () => {
      if (!stopped && !running && stage < 2 && attempts < 30) timer = setTimeout(run, 1000);
    };
    const run = async () => {
      timer = undefined;
      if (stopped || running) return;
      attempts++;
      if (!online || AppState.currentState === 'background' || AppState.currentState === 'inactive' || client.isFetching() > 0) {
        schedule(); return;
      }
      const options = exploreBrowseQueryOptions(viewer, stage === 0 ? 'Latest' : 'Trending');
      currentKey = options.queryKey;
      running = true;
      try { await client.prefetchInfiniteQuery({...options, retry:false}); }
      finally { running = false; stage++; currentKey = undefined; schedule(); }
    };
    const unsubscribeNetwork = NetInfo.addEventListener(state => {
      online = state.isConnected !== false && state.isInternetReachable !== false;
      if (!online) cancelUnobserved();
    });
    const app = AppState.addEventListener('change', state => {
      if (state !== 'active') cancelUnobserved();
    });
    schedule();
    return () => { stopped = true; clearTimeout(timer); unsubscribeNetwork(); app.remove(); cancelUnobserved(); };
  }, [client, ready, viewer]));
}
