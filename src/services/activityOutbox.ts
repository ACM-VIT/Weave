import type {
  ActivityInput,
  InteractionBatchResultV2,
  QueuedActivity,
} from '../api/activity';
import { applyActivityAcknowledgement, nextActivityBatch } from './activityQueue';

const ACTIVITY_RETRY_MAX_MS = 60_000;

export type ActivityFlushResult = {
  delivered: number;
  invalidatedFeed: boolean;
  deferred: boolean;
  feedVersion?: string;
};

export type ActivityOutboxDependencies = {
  load: () => Promise<QueuedActivity[]>;
  persist: (events: readonly QueuedActivity[]) => Promise<void>;
  send: (events: QueuedActivity[], token: string) => Promise<InteractionBatchResultV2 | undefined>;
  prepare: (input: ActivityInput) => QueuedActivity;
  now?: () => number;
};

type ActivityListener = (result: ActivityFlushResult) => void | Promise<void>;

export class DurableActivityOutbox {
  private events: QueuedActivity[] = [];
  private readonly ready: Promise<void>;
  private flushPromise: Promise<ActivityFlushResult> | null = null;
  private readonly listeners = new Set<ActivityListener>();
  private retryDelayMs = 1_000;
  private retryNotBefore = 0;
  private feedResetGeneration = 0;
  private acknowledgedFeedResetGeneration = 0;
  private lastFeedVersion: string | undefined;

  constructor(private readonly dependencies: ActivityOutboxDependencies) {
    this.ready = dependencies.load().then((stored) => {
      this.events = stored;
    });
  }

  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    if (this.acknowledgedFeedResetGeneration < this.feedResetGeneration) {
      void this.deliverFeedReset(listener, this.feedResetGeneration, {
        delivered: 0,
        invalidatedFeed: true,
        deferred: false,
        feedVersion: this.lastFeedVersion,
      });
    }
    return () => this.listeners.delete(listener);
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
    } catch {
      // A later subscriber receives the retained reset when this listener fails.
    }
  }

  async enqueue(input: ActivityInput): Promise<QueuedActivity> {
    const event = this.dependencies.prepare(input);
    await this.ready;
    if (!this.events.some((queued) => queued.event_id === event.event_id)) {
      this.events.push(event);
      await this.dependencies.persist(this.events);
    }
    return event;
  }

  async pendingCount(): Promise<number> {
    await this.ready;
    return this.events.length;
  }

  flush(token: string): Promise<ActivityFlushResult> {
    if (this.flushPromise) return this.flushPromise;
    const operation = this.flushInternal(token);
    this.flushPromise = operation;
    void operation.finally(() => {
      if (this.flushPromise === operation) this.flushPromise = null;
    }).catch(() => undefined);
    return operation;
  }

  private async flushInternal(token: string): Promise<ActivityFlushResult> {
    await this.ready;
    if (this.events.length === 0) {
      return { delivered: 0, invalidatedFeed: false, deferred: false };
    }

    const now = this.dependencies.now ?? Date.now;
    if (now() < this.retryNotBefore) {
      return { delivered: 0, invalidatedFeed: false, deferred: true };
    }

    let delivered = 0;
    let invalidatedFeed = false;
    let snapshot = [...this.events];
    try {
      while (snapshot.length > 0) {
        await this.dependencies.persist(this.events);
        const batch = nextActivityBatch(snapshot);
        const result = await this.dependencies.send(batch, token);
        if (!result) throw new Error('The activity service did not acknowledge the batch.');
        this.lastFeedVersion = result.feed_version;

        const acknowledgement = applyActivityAcknowledgement(this.events, batch, result);
        if (acknowledgement.acknowledgedIds.size === 0) {
          throw new Error('The activity service did not acknowledge any queued events.');
        }

        this.events = acknowledgement.remaining;
        snapshot = snapshot.filter((event) => !acknowledgement.acknowledgedIds.has(event.event_id));
        delivered += acknowledgement.acknowledgedIds.size;
        invalidatedFeed ||= acknowledgement.invalidatesFeed;
        await this.dependencies.persist(this.events);

        if (acknowledgement.acknowledgedIds.size !== batch.length) {
          throw new Error('The activity service only acknowledged part of the batch.');
        }
      }
      this.retryDelayMs = 1_000;
      this.retryNotBefore = 0;
    } catch (error) {
      this.retryNotBefore = now() + this.retryDelayMs;
      this.retryDelayMs = Math.min(ACTIVITY_RETRY_MAX_MS, this.retryDelayMs * 2);
      throw error;
    } finally {
      if (delivered > 0) {
        const outcome = { delivered, invalidatedFeed, deferred: false, feedVersion: this.lastFeedVersion };
        if (invalidatedFeed) {
          this.feedResetGeneration += 1;
          const generation = this.feedResetGeneration;
          await Promise.all(
            [...this.listeners].map((listener) => this.deliverFeedReset(listener, generation, outcome)),
          );
        } else {
          await Promise.allSettled([...this.listeners].map((listener) => listener(outcome)));
        }
      }
    }

    return { delivered, invalidatedFeed, deferred: false, feedVersion: this.lastFeedVersion };
  }
}
