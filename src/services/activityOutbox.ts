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
};

type ActivityListener = (result: ActivityFlushResult) => void | Promise<void>;

export class DurableActivityOutbox {
  private events: QueuedActivity[] = [];
  private ready: Promise<void> | undefined;
  private mutationTail: Promise<unknown> = Promise.resolve();
  private queuedIds = new Set<string>();
  private readonly undurable = new Map<string, QueuedActivity>();
  private flushPromise: Promise<ActivityFlushResult> | null = null;
  private readonly listeners = new Set<ActivityListener>();
  private retryDelayMs = 1_000;
  private retryNotBefore = 0;
  private feedResetGeneration = 0;
  private acknowledgedFeedResetGeneration = 0;
  private lastFeedVersion: string | undefined;

  constructor(private readonly dependencies: ActivityOutboxDependencies) {
    void this.restore().catch(() => undefined);
  }

  private restore(): Promise<void> {
    if (this.ready) return this.ready;
    const restoration = this.dependencies.load().then(stored => {
      this.events = [...new Map(stored.map(event => [event.event_id, event])).values()];
      this.queuedIds = new Set(this.events.map(event => event.event_id));
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

  async enqueue(input: ActivityInput): Promise<QueuedActivity> {
    const event = this.dependencies.prepare(input);
    await this.restore();
    await this.mutate(async () => {
      if (!this.queuedIds.has(event.event_id)) {
        this.events.push(event);
        this.queuedIds.add(event.event_id);
        this.undurable.set(event.event_id, event);
      }
      // Keep failed appends in memory and retry before any later delivery.
      await this.ensureDurable();
    });
    return event;
  }

  async pendingCount(): Promise<number> {
    await this.restore();
    await this.mutationTail.catch(() => undefined);
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
    await this.restore();
    await this.mutationTail.catch(() => undefined);
    if (this.events.length === 0) {
      return { delivered: 0, invalidatedFeed: false, deferred: false };
    }

    const now = this.dependencies.now ?? Date.now;
    if (now() < this.retryNotBefore) {
      return { delivered: 0, invalidatedFeed: false, deferred: true };
    }

    let delivered = 0;
    let invalidatedFeed = false;
    let snapshot: QueuedActivity[];
    try {
      snapshot = await this.mutate(async () => {
        await this.ensureDurable();
        return [...this.events];
      });
      while (snapshot.length > 0) {
        const batch = nextActivityBatch(snapshot);
        const result = await this.dependencies.send(batch, token);
        if (!result) throw new Error('The activity service did not acknowledge the batch.');
        this.lastFeedVersion = result.feed_version;
        const confirmed = applyActivityAcknowledgement([], batch, result);
        if (confirmed.acknowledgedIds.size === 0) {
          throw new Error('The activity service did not acknowledge any queued events.');
        }
        // Server-confirmed feed changes must notify/retain their reset even if local cleanup fails.
        delivered += confirmed.acknowledgedIds.size;
        invalidatedFeed ||= confirmed.invalidatesFeed;

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
