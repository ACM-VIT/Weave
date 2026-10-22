interface Waiter<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
  cleanup(): void;
}

interface WaitGroup<T> {
  probe: () => Promise<T | undefined>;
  waiters: Set<Waiter<T>>;
  checking: boolean;
  wakePending: boolean;
  delayMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Notifications only accelerate durable probes; they never supply completion data. */
export class FeedWaitCoordinator<T> {
  private readonly groups = new Map<string, WaitGroup<T>>();
  private subscriberCount = 0;

  constructor(
    private readonly pollMs: number,
    private readonly unavailable: () => Error,
    private readonly maxKeys = 256,
    private readonly maxSubscribersPerKey = 128,
    private readonly maxSubscribers = 2_048,
  ) {}

  wait(key: string, probe: () => Promise<T | undefined>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let group = this.groups.get(key);
    if ((!group && this.groups.size >= this.maxKeys)
      || (group?.waiters.size ?? 0) >= this.maxSubscribersPerKey
      || this.subscriberCount >= this.maxSubscribers
      || timeoutMs <= 0) return Promise.reject(this.unavailable());
    if (!group) {
      group = {
        probe, waiters: new Set(), checking: false, wakePending: false,
        delayMs: Math.max(1, this.pollMs),
      };
      this.groups.set(key, group);
    }
    const owned = group;
    return new Promise<T>((resolve, reject) => {
      const leave = (error: unknown) => {
        if (!owned.waiters.delete(waiter)) return;
        waiter.cleanup();
        reject(error);
        this.removeIfIdle(key, owned);
      };
      const cancel = () => leave(signal?.reason);
      const timer = setTimeout(() => leave(this.unavailable()), timeoutMs);
      const waiter: Waiter<T> = {
        resolve, reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          this.subscriberCount--;
        },
      };
      owned.waiters.add(waiter);
      this.subscriberCount++;
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      if (owned.waiters.size > 0 && !owned.checking && !owned.timer) void this.check(key, owned);
    });
  }

  notify(key: string): void {
    const group = this.groups.get(key);
    if (!group || group.waiters.size === 0) return;
    if (group.checking) { group.wakePending = true; return; }
    if (group.timer) clearTimeout(group.timer);
    group.timer = undefined;
    void this.check(key, group);
  }

  private removeIfIdle(key: string, group: WaitGroup<T>): void {
    if (group.waiters.size > 0) return;
    if (group.timer) clearTimeout(group.timer);
    group.timer = undefined;
    // Keep ownership of an unfinished probe, even with no subscribers. A new
    // subscriber joins it instead of starting a duplicate outstanding read.
    if (!group.checking && this.groups.get(key) === group) this.groups.delete(key);
  }

  private async check(key: string, group: WaitGroup<T>): Promise<void> {
    if (group.checking || group.waiters.size === 0) return;
    group.checking = true;
    try {
      const result = await group.probe();
      if (result !== undefined) {
        for (const waiter of group.waiters) { waiter.cleanup(); waiter.resolve(result); }
        group.waiters.clear();
      }
    } catch (error) {
      for (const waiter of group.waiters) { waiter.cleanup(); waiter.reject(error); }
      group.waiters.clear();
    } finally {
      group.checking = false;
      this.removeIfIdle(key, group);
      if (group.waiters.size > 0) {
        // Jitter/backoff bounds cross-process/lost-signal polling without making
        // correctness depend on this process having observed a completion.
        const delay = group.wakePending ? 0 : Math.max(1,
          Math.min(250, Math.floor(group.delayMs * (0.8 + Math.random() * 0.4))));
        group.wakePending = false;
        group.delayMs = Math.min(250, group.delayMs * 2);
        group.timer = setTimeout(() => {
          group.timer = undefined;
          void this.check(key, group);
        }, delay);
      }
    }
  }
}
