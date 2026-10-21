export const AUTH_TRANSITION_REFRESH_WAIT_MS = 15_000;

/** Retryable UI failure: the old response still owns the cookie-rotation flight. */
export class SessionRefreshPendingError extends Error {
  readonly code = 'SESSION_REFRESH_PENDING';
  readonly retryable = true;

  constructor() {
    super('Your previous session is still finishing. Please try signing in again shortly.');
    this.name = 'SessionRefreshPendingError';
  }
}

export class SessionChangedError extends Error {
  readonly code = 'SESSION_CHANGED';

  constructor() {
    super('The authentication session changed while this request was in progress.');
    this.name = 'SessionChangedError';
  }
}

export type SessionLease = {
  readonly generation: number;
  isCurrent: () => boolean;
  assertCurrent: () => void;
};

type RefreshFlight = {
  generation: number;
  promise: Promise<unknown>;
};

/**
 * Coordinates requests that can mutate authentication state.
 *
 * Refreshes share one flight inside a generation. Login, signup, OAuth exchange,
 * and logout advance the generation immediately, wait for the old refresh
 * response to settle, and then run serially so their Set-Cookie response wins.
 */
export class SessionLifecycle {
  private generation = 0;
  private refreshFlight: RefreshFlight | null = null;
  private transitionTail: Promise<void> = Promise.resolve();
  private pendingTransitions = 0;
  private generationListeners = new Set<(generation: number) => void>();

  private advanceGeneration(): number {
    this.generation += 1;
    for (const listener of this.generationListeners) {
      try { listener(this.generation); }
      catch { /* State observers must not break authentication transitions. */ }
    }
    return this.generation;
  }

  currentGeneration(): number {
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  assertCurrent(generation: number): void {
    if (!this.isCurrent(generation)) throw new SessionChangedError();
  }

  retire(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.advanceGeneration();
    return true;
  }

  subscribe(listener: (generation: number) => void): () => void {
    this.generationListeners.add(listener);
    return () => this.generationListeners.delete(listener);
  }

  private lease(generation: number): SessionLease {
    return {
      generation,
      isCurrent: () => this.isCurrent(generation),
      assertCurrent: () => this.assertCurrent(generation),
    };
  }

  runRefresh<T>(operation: (lease: SessionLease) => Promise<T>): Promise<T> {
    const generation = this.generation;
    if (this.pendingTransitions > 0) return Promise.reject(new SessionChangedError());

    if (this.refreshFlight) {
      if (this.refreshFlight.generation === generation) return this.refreshFlight.promise as Promise<T>;
      // A timed-out auth wait can retire a generation before its response arrives.
      // Never start another one-use rotation alongside that older flight.
      return Promise.reject(new SessionRefreshPendingError());
    }

    const flight: RefreshFlight = { generation, promise: Promise.resolve() };
    const promise = (async () => {
      try {
        const value = await operation(this.lease(generation));
        this.assertCurrent(generation);
        return value;
      } finally {
        if (this.refreshFlight === flight) this.refreshFlight = null;
      }
    })();

    flight.promise = promise;
    this.refreshFlight = flight;
    return promise;
  }

  private async waitForRefresh(refresh: Promise<unknown> | undefined): Promise<void> {
    if (!refresh) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SessionRefreshPendingError()), AUTH_TRANSITION_REFRESH_WAIT_MS);
    });
    try {
      // Bound the caller's wait, never the rotation itself. A timeout skips the
      // auth request; retaining the flight prevents stale Set-Cookie reordering.
      await Promise.race([refresh.catch(() => undefined), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  runTransition<T, TPreparation = undefined>(
    operation: (lease: SessionLease, preparation: TPreparation) => Promise<T>,
    prepare?: (lease: SessionLease) => Promise<TPreparation>,
  ): Promise<T> {
    const generation = this.advanceGeneration();
    const lease = this.lease(generation);
    const previousTransition = this.transitionTail;
    const refreshToSettle = this.refreshFlight?.promise;
    const preparation = prepare
      ? prepare(lease)
      : Promise.resolve(undefined as TPreparation);
    // A timed-out wait may leave preparation unconsumed; observe its rejection
    // immediately while still propagating it normally when this attempt runs.
    void preparation.catch(() => undefined);
    this.pendingTransitions += 1;

    let releaseTransition!: () => void;
    const transitionCompleted = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    this.transitionTail = previousTransition
      .catch(() => undefined)
      .then(() => transitionCompleted);

    return (async () => {
      try {
        await previousTransition.catch(() => undefined);
        await this.waitForRefresh(refreshToSettle);
        const prepared = await preparation;
        lease.assertCurrent();
        const value = await operation(lease, prepared);
        lease.assertCurrent();
        return value;
      } finally {
        this.pendingTransitions -= 1;
        releaseTransition();
      }
    })();
  }
}

export const authSessionLifecycle = new SessionLifecycle();
