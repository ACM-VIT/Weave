import type {
  ActivityInput,
  InteractionBatchResultV2,
  QueuedActivity,
} from '../api/activity';
import { SessionChangedError } from '../api/session-lifecycle';
import { applyActivityAcknowledgement, nextActivityBatch } from './activityQueue';

const ACTIVITY_RETRY_MAX_MS = 60_000;

export type ActivityFlushResult = {
  delivered: number;
  invalidatedFeed: boolean;
  deferred: boolean;
  feedVersion?: string;
  acknowledgedActivities?: readonly QueuedActivity[];
};

type ActivityPersistence = {
  persist: (events: readonly QueuedActivity[]) => Promise<void>;
  append?: never;
  acknowledge?: never;
} | {
  append: (event: QueuedActivity) => Promise<void>;
  acknowledge: (eventIds: ReadonlySet<string>) => Promise<void>;
  persist?: never;
};

export type ActivityOutboxDependencies = ActivityPersistence & {
  load: () => Promise<QueuedActivity[]>;
  send: (events: QueuedActivity[], token: string) => Promise<InteractionBatchResultV2 | undefined>;
  prepare: (input: ActivityInput) => QueuedActivity;
  now?: () => number;
  session?: {
    capture: () => number;
    assertCurrent: (token: string, generation: number) => void;
  };
};

type ActivityListener = (result: ActivityFlushResult) => void | Promise<void>;
type PendingActivityListener = (events: readonly QueuedActivity[]) => void;

export class DurableActivityOutbox {
  private events: QueuedActivity[] = [];
  private ready: Promise<void> | undefined;
  private mutationTail: Promise<unknown> = Promise.resolve();
  private queuedIds = new Set<string>();
  private readonly undurable = new Map<string, QueuedActivity>();
  // Preparation can precede a failing initial read/import. Keep those exact
  // events separately so restoration never overwrites an accepted reference.
  private readonly prepared = new Map<string, QueuedActivity>();
  private flushPromise: Promise<ActivityFlushResult> | null = null;
  private readonly listeners = new Set<ActivityListener>();
  private readonly pendingListeners = new Set<PendingActivityListener>();
  private readonly pendingFeedback = new Map<string, QueuedActivity>();
  // Local acknowledgement cleanup can fail after the server confirmed an ID.
  // Keep it replayable on disk, without presenting it as an unconfirmed action.
  private readonly confirmedIds = new Set<string>();
  private retryDelayMs = 1_000;
  private retryNotBefore = 0;
  private feedResetGeneration = 0;
  private acknowledgedFeedResetGeneration = 0;
  private lastFeedVersion: string | undefined;
  private retainedAcknowledgedActivities: QueuedActivity[] = [];

  constructor(private readonly dependencies: ActivityOutboxDependencies) {
    void this.restore().catch(() => undefined);
  }

  private restore(): Promise<void> {
    if (this.ready) return this.ready;
    const restoration = this.dependencies.load().then(stored => {
      this.events = [...new Map(stored.map(event => [event.event_id, event])).values()];
      this.queuedIds = new Set(this.events.map(event => event.event_id));
      this.markPending(this.events);
    });
    this.ready = restoration;
    // A failed read/import blocks this operation, not every later attempt after storage recovers.
    void restoration.catch(() => {
      if (this.ready === restoration) this.ready = undefined;
    });
    return restoration;
  }

  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    if (this.acknowledgedFeedResetGeneration < this.feedResetGeneration) {
      void this.deliverFeedReset(listener, this.feedResetGeneration, {
        delivered: 0,
        invalidatedFeed: true,
        deferred: false,
        feedVersion: this.lastFeedVersion,
        acknowledgedActivities: [...this.retainedAcknowledgedActivities],
      });
    }
    return () => this.listeners.delete(listener);
  }

  /** Owner-bound recovery state replays on Home remount; only acknowledgement clears IDs. */
  subscribePending(listener: PendingActivityListener): () => void {
    this.pendingListeners.add(listener);
    this.deliverPending(listener);
    return () => this.pendingListeners.delete(listener);
  }

  private deliverPending(listener: PendingActivityListener): void {
    try { listener([...this.pendingFeedback.values()]); }
    catch { /* UI observers must not alter queue durability or delivery. */ }
  }

  private markPending(events: readonly QueuedActivity[]): void {
    let changed = false;
    for (const event of events) {
      if (!this.confirmedIds.has(event.event_id) && !this.pendingFeedback.has(event.event_id)) {
        this.pendingFeedback.set(event.event_id, event); changed = true;
      }
    }
    if (changed) for (const listener of this.pendingListeners) this.deliverPending(listener);
  }

  private confirmPending(ids: ReadonlySet<string>): void {
    let changed = false;
    for (const eventId of ids) {
      this.confirmedIds.add(eventId);
      changed = this.pendingFeedback.delete(eventId) || changed;
    }
    if (changed) for (const listener of this.pendingListeners) this.deliverPending(listener);
  }

  private async deliverFeedReset(
    listener: ActivityListener,
    generation: number,
    outcome: ActivityFlushResult,
  ): Promise<void> {
    try {
      await listener(outcome);
      this.acknowledgedFeedResetGeneration = Math.max(
        this.acknowledgedFeedResetGeneration,
        generation,
      );
      if (generation === this.feedResetGeneration) this.retainedAcknowledgedActivities = [];
    } catch {
      // A later subscriber receives the retained reset when this listener fails.
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.catch(() => undefined).then(operation);
    this.mutationTail = result;
    return result;
  }

  private async ensureDurable(): Promise<void> {
    if (this.undurable.size === 0) return;
    if (this.dependencies.append) {
      for (const [eventId, event] of this.undurable) {
        await this.dependencies.append(event);
        this.undurable.delete(eventId);
      }
    } else {
      await this.dependencies.persist(this.events);
      this.undurable.clear();
    }
  }

  private retainPrepared(): void {
    for (const [eventId, event] of this.prepared) {
      if (!this.queuedIds.has(eventId)) {
        this.events.push(event);
        this.queuedIds.add(eventId);
        this.undurable.set(eventId, event);
      }
      this.prepared.delete(eventId);
    }
  }

  async enqueue(
    input: ActivityInput,
    onPrepared?: (event: QueuedActivity) => void,
  ): Promise<QueuedActivity> {
    const event = this.dependencies.prepare(input);
    // Retain synchronously before exposing the prepared ID or awaiting storage.
    // A failed read remains a rejected write, but cannot lose the event needed
    // by already prepared actions. The next enqueue/count/flush retries it.
    if (!this.queuedIds.has(event.event_id) && !this.prepared.has(event.event_id)) {
      this.prepared.set(event.event_id, event);
    }
    onPrepared?.(event);
    try {
      await this.mutate(async () => {
        await this.restore();
        this.retainPrepared();
        // Keep failed appends in memory and retry before any later delivery.
        await this.ensureDurable();
      });
    } catch (error) {
      this.markPending([event]);
      throw error;
    }
    return event;
  }

  async pendingCount(): Promise<number> {
    await this.restore();
    return this.mutate(async () => {
      this.retainPrepared();
      return this.events.length;
    });
  }

  flush(token: string, generation = this.dependencies.session?.capture()): Promise<ActivityFlushResult> {
    // Reject a different owner/session even when another flush is in flight.
    try { this.assertSession(token, generation); }
    catch (error) { return Promise.reject(error); }
    if (this.flushPromise) return this.flushPromise;
    const operation = this.flushInternal(token, generation);
    this.flushPromise = operation;
    void operation.catch(error => {
      if (!(error instanceof SessionChangedError)) this.markPending([...this.events, ...this.prepared.values()]);
    });
    void operation.finally(() => {
      if (this.flushPromise === operation) this.flushPromise = null;
    }).catch(() => undefined);
    return operation;
  }

  private assertSession(token: string, generation: number | undefined): void {
    if (this.dependencies.session && generation !== undefined) {
      this.dependencies.session.assertCurrent(token, generation);
    }
  }

  private async flushInternal(token: string, generation: number | undefined): Promise<ActivityFlushResult> {
    this.assertSession(token, generation);
    await this.restore();
    this.assertSession(token, generation);
    await this.mutate(async () => {
      this.assertSession(token, generation);
      this.retainPrepared();
    });
    this.assertSession(token, generation);
    if (this.events.length === 0) {
      return { delivered: 0, invalidatedFeed: false, deferred: false };
    }

    const now = this.dependencies.now ?? Date.now;
    if (now() < this.retryNotBefore) {
      this.markPending(this.events);
      return { delivered: 0, invalidatedFeed: false, deferred: true };
    }

    let delivered = 0;
    let invalidatedFeed = false;
    const acknowledgedActivities: QueuedActivity[] = [];
    let snapshot: QueuedActivity[];
    try {
      snapshot = await this.mutate(async () => {
        this.assertSession(token, generation);
        await this.ensureDurable();
        this.assertSession(token, generation);
        return [...this.events];
      });
      while (snapshot.length > 0) {
        const batch = nextActivityBatch(snapshot);
        this.assertSession(token, generation);
        const result = await this.dependencies.send(batch, token);
        if (!result) throw new Error('The activity service did not acknowledge the batch.');
        this.lastFeedVersion = result.feed_version;
        const confirmed = applyActivityAcknowledgement([], batch, result);
        if (confirmed.acknowledgedIds.size === 0) {
          throw new Error('The activity service did not acknowledge any queued events.');
        }
        this.confirmPending(confirmed.acknowledgedIds);
        // Server-confirmed feed changes must notify/retain their reset even if local cleanup fails.
        delivered += confirmed.acknowledgedIds.size;
        invalidatedFeed ||= confirmed.invalidatesFeed;
        acknowledgedActivities.push(...batch.filter((event) => confirmed.acknowledgedIds.has(event.event_id)));

        const acknowledgement = await this.mutate(async () => {
          const acknowledgement = applyActivityAcknowledgement(this.events, batch, result);
          if (acknowledgement.acknowledgedIds.size === 0) {
            throw new Error('The activity service did not acknowledge any queued events.');
          }
          // Commit acknowledgement before removing memory state. An interrupted delete/write
          // leaves replayable IDs, which the server already deduplicates by event_id.
          if (this.dependencies.acknowledge) {
            await this.dependencies.acknowledge(acknowledgement.acknowledgedIds);
          } else {
            await this.dependencies.persist(acknowledgement.remaining);
          }
          this.events = acknowledgement.remaining;
          for (const eventId of acknowledgement.acknowledgedIds) {
            this.queuedIds.delete(eventId);
            this.undurable.delete(eventId);
            this.confirmedIds.delete(eventId);
          }
          return acknowledgement;
        });
        snapshot = snapshot.filter((event) => !acknowledgement.acknowledgedIds.has(event.event_id));

        if (acknowledgement.acknowledgedIds.size !== batch.length) {
          throw new Error('The activity service only acknowledged part of the batch.');
        }
      }
      this.retryDelayMs = 1_000;
      this.retryNotBefore = 0;
    } catch (error) {
      if (!(error instanceof SessionChangedError)) {
        this.retryNotBefore = now() + this.retryDelayMs;
        this.retryDelayMs = Math.min(ACTIVITY_RETRY_MAX_MS, this.retryDelayMs * 2);
      }
      throw error;
    } finally {
      if (delivered > 0) {
        const outcome = {
          delivered,
          invalidatedFeed,
          deferred: false,
          feedVersion: this.lastFeedVersion,
          acknowledgedActivities,
        };
        if (invalidatedFeed) {
          this.feedResetGeneration += 1;
          this.retainedAcknowledgedActivities.push(...acknowledgedActivities);
          const generation = this.feedResetGeneration;
          await Promise.all(
            [...this.listeners].map((listener) => this.deliverFeedReset(listener, generation, outcome)),
          );
        } else {
          await Promise.allSettled([...this.listeners].map((listener) => listener(outcome)));
        }
      }
    }

    return {
      delivered,
      invalidatedFeed,
      deferred: false,
      feedVersion: this.lastFeedVersion,
      acknowledgedActivities,
    };
  }
}
