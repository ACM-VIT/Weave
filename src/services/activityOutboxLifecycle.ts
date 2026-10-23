type Connectivity = { isConnected: boolean | null; isInternetReachable: boolean | null };

export interface ActivityOutboxLifecycle {
  flush: () => Promise<unknown>;
  subscribeAppState: (listener: (state: string) => void) => () => void;
  subscribeConnectivity: (listener: (state: Connectivity) => void) => () => void;
  intervalMs: number;
}

/** Wake the existing durable queue; its single-flight, owner and backoff guards remain authoritative. */
export function startActivityOutboxLifecycle(dependencies: ActivityOutboxLifecycle): () => void {
  let stopped = false;
  let connected: boolean | undefined;
  const flush = () => { void dependencies.flush().catch(() => undefined); };
  const wake = () => { if (!stopped) flush(); };
  wake();
  const timer = setInterval(wake, dependencies.intervalMs);
  const stopAppState = dependencies.subscribeAppState(wake);
  const stopConnectivity = dependencies.subscribeConnectivity(state => {
    if (stopped || state.isConnected === null) return;
    const available = state.isConnected && state.isInternetReachable !== false;
    if (available && connected !== true) wake();
    connected = available;
  });
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    stopAppState();
    stopConnectivity();
    // A retired account/session still fails the queue's existing ownership checks.
    flush();
  };
}
