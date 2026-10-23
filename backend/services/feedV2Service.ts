import { FeedExposureChangedError, FeedPreferenceChangedError } from '../ports/feedPersistencePort.js';
import crypto from 'node:crypto';

import type { FeedRequestV2, FeedResponseV2, FeedSource, RecommendationEntry, RepositoryProjection } from '../contracts/feed.v2.js';
import type { FeedPersistencePort } from '../ports/feedPersistencePort.js';
import type { FeedQueuePort } from '../redis/feedQueue.js';
import { ReservationOwnedError } from '../redis/feedQueue.js';
import { incrementMetric } from '../observability/metrics.js';
import { FeedCursorCodec } from './feedCursor.js';
import type { FeedGenerationOutcome } from './feedGenerationService.js';
import { FeedWaitCoordinator } from './feedWaitCoordinator.js';
import { FeedRefillScheduler } from './feedRefillScheduler.js';

interface FeedRefillOptions {
  lowWatermark: number;
  generate: (userId: string, version: bigint, sessionId: string) => Promise<unknown>;
}

const MAX_FOREGROUND_FEED_OPERATIONS = 256;

export class FeedRequestInProgressError extends Error {
  constructor() {
    super('A feed request with this id is still being prepared.');
    this.name = 'FeedRequestInProgressError';
  }
}

export class PersonalizedFeedUnavailableError extends Error {
  readonly code = 'PERSONALIZED_FEED_UNAVAILABLE';

  constructor(readonly cause?: unknown) {
    super('Your personalized recommendations are still being prepared.');
    this.name = 'PersonalizedFeedUnavailableError';
  }
}

function responseFromServe(serve: Awaited<ReturnType<FeedPersistencePort['createServe']>>): FeedResponseV2 {
  return {
    serve_id: serve.serve_id,
    session_id: serve.session_id,
    feed_version: serve.feed_version.toString(),
    source: serve.source,
    model_version: serve.model_version,
    items: serve.items,
    next_cursor: serve.next_cursor,
  };
}

export class FeedV2Service {
  constructor(
    private readonly persistence: FeedPersistencePort,
    private readonly queue: FeedQueuePort,
    private readonly generateOnMiss?: (userId: string, limit: number, excludeRepoIds: string[], sessionId?: string) => Promise<FeedGenerationOutcome>,
    private readonly fallbackEnabled = false,
    private readonly reservationWaitMs = 1_500,
    private readonly reservationPollMs = 25,
    cursorSecret?: string,
    private readonly generationWaitMs = 5_000,
    refill?: FeedRefillOptions,
  ) {
    this.cursorCodec = new FeedCursorCodec(cursorSecret);
    this.serveWaits = new FeedWaitCoordinator(reservationPollMs, () => new FeedRequestInProgressError());
    this.generationWaits = new FeedWaitCoordinator(reservationPollMs, () => new FeedRequestInProgressError());
    if (refill) {
      this.refillScheduler = new FeedRefillScheduler(refill.lowWatermark, async job => {
        try { await refill.generate(job.userId, job.version, job.sessionId); }
        finally { this.generationWaits.notify(this.generationKey(job.userId, job.version)); }
      });
    }
  }

  private readonly cursorCodec: FeedCursorCodec;
  private readonly serveWaits: FeedWaitCoordinator<FeedResponseV2>;
  private readonly generationWaits: FeedWaitCoordinator<true>;
  private readonly refillScheduler?: FeedRefillScheduler;
  private readonly foreground = new Set<Promise<FeedResponseV2>>();
  private stopping = false;

  async stop(): Promise<void> {
    this.stopping = true;
    // Drain actual operations, not the caller promises that may have aborted.
    await Promise.allSettled([
      ...this.foreground,
      ...(this.refillScheduler ? [this.refillScheduler.stop()] : []),
    ]);
    // Aborted/expired observers can leave their shared physical probes running.
    await Promise.allSettled([this.serveWaits.drain(), this.generationWaits.drain()]);
  }

  private requestKey(userId: string, requestId: string): string {
    return JSON.stringify([userId, requestId]);
  }

  private generationKey(userId: string, version: bigint): string {
    return JSON.stringify([userId, version.toString()]);
  }

  private async waitForGeneratedReservation(
    userId: string,
    version: bigint,
    requestId: string,
    limit: number,
    token: string,
    signal?: AbortSignal,
  ) {
    const deadline = Date.now() + this.generationWaitMs;
    do {
      signal?.throwIfAborted();
      const reservation = await this.queue.refill(userId, version, requestId, limit, token);
      if (reservation.items.length > 0) return reservation;
      await this.generationWaits.wait(this.generationKey(userId, version), async () => {
        // A fast failure must not release the shared key while its sibling
        // operation is still running. Wrap synchronous port throws as well.
        const [currentVersion, depth] = await Promise.allSettled([
          Promise.resolve().then(() => this.persistence.getFeedVersion(userId)),
          Promise.resolve().then(() => this.queue.depth(userId, version)),
        ]);
        if (currentVersion.status === 'rejected') throw currentVersion.reason;
        if (depth.status === 'rejected') throw depth.reason;
        if (currentVersion.value !== version) throw new FeedRequestInProgressError();
        return depth.value > 0 ? true : undefined;
      }, deadline - Date.now(), signal);
      // Each owner refills its own reservation. A concurrent consumer may win
      // the available items, so rejoin the shared probe with the same deadline.
    } while (Date.now() < deadline);
    throw new FeedRequestInProgressError();
  }

  private async waitForServe(userId: string, requestId: string, signal?: AbortSignal): Promise<FeedResponseV2> {
    const response = await this.serveWaits.wait(this.requestKey(userId, requestId), async () => {
      const replay = await this.persistence.getServeByRequest(userId, requestId);
      return replay ? responseFromServe(replay) : undefined;
    }, this.reservationWaitMs, signal);
    incrementMetric('feed_v2_duplicate_requests_total');
    return response;
  }

  async getFeed(userId: string, request: FeedRequestV2, signal?: AbortSignal): Promise<FeedResponseV2> {
    signal?.throwIfAborted();
    if (this.stopping || this.foreground.size
      + this.serveWaits.unobservedProbeCount + this.generationWaits.unobservedProbeCount
      >= MAX_FOREGROUND_FEED_OPERATIONS) {
      throw new FeedRequestInProgressError();
    }
    // Register admission before starting any work; there is no pending queue.
    const operation = Promise.resolve().then(() => this.prepareFeed(userId, request, signal));
    this.foreground.add(operation);
    const finish = () => this.foreground.delete(operation);
    void operation.then(finish, finish);
    if (!signal) return operation;
    return new Promise<FeedResponseV2>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', cancel);
      const cancel = () => { cleanup(); reject(signal.reason); };
      signal.addEventListener('abort', cancel, { once: true });
      // Cancellation belongs to this observer, not to a writer that may own a
      // reservation for live same-ID waiters. Always handle its eventual error.
      void operation.then(
        response => { cleanup(); resolve(response); },
        error => { cleanup(); reject(error); },
      );
      if (signal.aborted) cancel();
    });
  }

  private async prepareFeed(userId: string, request: FeedRequestV2, signal?: AbortSignal): Promise<FeedResponseV2> {
    signal?.throwIfAborted();
    const replay = await this.persistence.getServeByRequest(userId, request.feed_request_id);
    if (replay) {
      incrementMetric('feed_v2_duplicate_requests_total');
      return responseFromServe(replay);
    }

    const version = await this.persistence.getFeedVersion(userId);
    const pageOffset = request.cursor === null ? 0 : this.cursorCodec.decode(request.cursor, {
      user_id: userId,
      session_id: request.session_id,
      feed_version: version.toString(),
    });
    // Before claiming ownership there is no shared writer to preserve.
    signal?.throwIfAborted();
    const token = crypto.randomUUID();
    const releaseReservation = async () => {
      try { await this.queue.release(userId, version, request.feed_request_id, token); }
      catch (error) { console.error('[FeedV2Service] Failed to release reservation:', error); }
    };
    let queueAvailable = true;
    let generationCompleted = false;
    let reservation;
    try {
      reservation = await this.queue.reserve(
        userId, version, request.feed_request_id, request.limit, token,
      );
    } catch (error) {
      if (error instanceof ReservationOwnedError) {
        return this.waitForServe(userId, request.feed_request_id, signal);
      }
      // A timed-out reserve may have succeeded remotely; only our token can release it.
      await releaseReservation();
      if (request.cursor !== null) throw error;
      queueAvailable = false;
      reservation = { token, requestId: request.feed_request_id, items: [] };
      incrementMetric('feed_v2_redis_failures_total');
      console.error('[FeedV2Service] Redis unavailable; evaluating durable personalized recovery:', error);
    }

    let generationError: unknown;
    if (queueAvailable && reservation.items.length === 0 && this.generateOnMiss) {
      try {
        const outcome = await this.generateOnMiss(userId, request.limit, [], request.session_id);
        if (outcome.status !== 'coalesced') this.generationWaits.notify(this.generationKey(userId, version));
        if (outcome.status === 'stale' || outcome.status === 'capacity'
          || outcome.feedVersion !== version) throw new FeedRequestInProgressError();
        reservation = outcome.status === 'coalesced'
          ? await this.waitForGeneratedReservation(
            userId, version, request.feed_request_id, request.limit, token,
          )
          : await this.queue.refill(
            userId, version, request.feed_request_id, request.limit, token,
          );
        if (reservation.items.length === 0 && (
          (outcome.status === 'generated' && outcome.count > 0)
          || await this.persistence.getFeedVersion(userId) !== version
        )) throw new FeedRequestInProgressError();
        generationCompleted = true;
      } catch (error) {
        this.generationWaits.notify(this.generationKey(userId, version));
        if (error instanceof ReservationOwnedError) {
          return this.waitForServe(userId, request.feed_request_id, signal);
        }
        await releaseReservation();
        if (error instanceof FeedRequestInProgressError || request.cursor !== null) throw error;
        generationError = error;
        reservation = { token, requestId: request.feed_request_id, items: [] };
      }
    }

    let entries = reservation.items;
    // Only this request's fresh, same-viewer fallback projections are reusable.
    const byId = new Map<string, RepositoryProjection>();
    incrementMetric(entries.length > 0 ? 'feed_v2_cache_hits_total' : 'feed_v2_cache_misses_total');
    let source: FeedSource = 'personalized';
    if (!generationCompleted && entries.length === 0 && request.cursor === null
      && this.persistence.getRecentPersonalizedEntries) {
      entries = await this.persistence.getRecentPersonalizedEntries(
        userId,
        version,
        request.limit,
        [],
      );
      if (entries.length > 0) incrementMetric('feed_v2_durable_personalized_reuse_total');
    }
    if (entries.length === 0 && request.cursor === null) {
      if (queueAvailable) {
        await this.queue.release(userId, version, request.feed_request_id, token);
      }
      if (this.fallbackEnabled && !generationCompleted) {
        const fallback = await this.persistence.getTrendingFallback(request.limit,
          await this.persistence.listExcludedRepositoryIds(userId, request.session_id, 500), userId);
        entries = fallback.map(repo => ({repo_id: repo.repo_id, score: 0, source: 'fallback', model_version: 'backend-fallback', summary_id: repo.summary_id}));
        for (const repository of fallback) {
          if (repository.status === 'active') byId.set(repository.repo_id, repository);
        }
        if (entries.length === 0) throw new PersonalizedFeedUnavailableError(generationError);
        source = 'fallback';
        incrementMetric('feed_v2_fallback_total');
      } else if (!generationCompleted) throw new PersonalizedFeedUnavailableError(generationError);
    }

    // Includes queued, durable recovery and fallback entries. Never apply this
    // to the immutable same-request replay returned above.
    try {
      const eligible = new Set(await this.persistence.listPreferenceEligibleRepositoryIds(userId, entries.map(entry => entry.repo_id)));
      const unexposed = this.persistence.listExposureEligibleRepositoryIds
        ? new Set(await this.persistence.listExposureEligibleRepositoryIds(userId, entries.map(entry => entry.repo_id)))
        : eligible;
      const seen = new Set<string>();
      const allowed = entries.filter(entry => {
        if (!eligible.has(entry.repo_id) || !unexposed.has(entry.repo_id) || seen.has(entry.repo_id)) return false;
        seen.add(entry.repo_id); return true;
      });
      if (entries.length > 0 && allowed.length === 0) {
        if (queueAvailable) await this.queue.commit(userId, version, request.feed_request_id, token);
        throw new FeedRequestInProgressError();
      }
      entries = allowed;
    } catch (error) {
      if (queueAvailable) await releaseReservation();
      throw error;
    }

    const missingRepoIds = [...new Set(entries.filter((entry) => {
      const repository = byId.get(entry.repo_id);
      return !repository || repository.summary_id !== entry.summary_id;
    }).map((entry) => entry.repo_id))];
    if (missingRepoIds.length > 0) {
      // A refresh that omits an ID must not retain its invalidated projection.
      for (const repoId of missingRepoIds) byId.delete(repoId);
      const projections = await this.persistence.listActiveRepositories(missingRepoIds, userId);
      for (const repository of projections) {
        if (repository.status === 'active') byId.set(repository.repo_id, repository);
      }
    }
    const usable = entries.filter((entry) => byId.has(entry.repo_id));
    if (usable.length === 0 && entries.length > 0) {
      if (queueAvailable) await this.queue.commit(userId, version, request.feed_request_id, token);
      throw new Error('Feed contained no active canonical repositories.');
    }

    try {
      let nextCursor: string | null = null;
      if (queueAvailable && source === 'personalized' && usable.length > 0) {
        try {
          if (this.generateOnMiss || (reservation.remainingDepth ?? await this.queue.depth(userId, version)) > 0) {
            nextCursor = this.cursorCodec.encode({
              user_id: userId,
              session_id: request.session_id,
              feed_version: version.toString(),
              offset: pageOffset + usable.length,
            });
          }
        } catch (error) {
          console.error('[FeedV2Service] Failed to determine next cursor:', error);
        }
      }
      const stored = await this.persistence.createServe({
        feed_request_id: request.feed_request_id,
        user_id: userId,
        session_id: request.session_id,
        feed_version: version,
        generation_id: usable[0]?.generation_id ?? null,
        source,
        model_version: usable[0]?.model_version ?? null,
        next_cursor: nextCursor,
        items: usable.map((entry, position) => {
          const repository = byId.get(entry.repo_id)!;
          return {
            ...entry,
            summary_id: repository.summary_id,
            position: pageOffset + position,
            repository,
          };
        }),
      });
      this.serveWaits.notify(this.requestKey(userId, request.feed_request_id));
      if (queueAvailable) await this.queue.commit(userId, version, request.feed_request_id, token);
      if (queueAvailable && stored.source === 'personalized' && stored.items.length > 0
        && this.refillScheduler && reservation.remainingDepth !== undefined
        && reservation.remainingDepth < this.refillScheduler.lowWatermark) {
        this.refillScheduler.schedule(userId, version, request.session_id);
      }
      return responseFromServe(stored);
    } catch (error) {
      const replayAfterFailure = await this.persistence.getServeByRequest(userId, request.feed_request_id);
      if (replayAfterFailure) {
        this.serveWaits.notify(this.requestKey(userId, request.feed_request_id));
        if (queueAvailable) await this.queue.commit(userId, version, request.feed_request_id, token);
        return responseFromServe(replayAfterFailure);
      }
      if (error instanceof FeedExposureChangedError) {
        // Returning this raced page to Redis would retry the same stale cards.
        if (queueAvailable) await this.queue.commit(userId, version, request.feed_request_id, token);
        throw new FeedRequestInProgressError();
      }
      if (queueAvailable) await this.queue.release(userId, version, request.feed_request_id, token);
      if (error instanceof FeedPreferenceChangedError) throw new FeedRequestInProgressError();
      throw error;
    }
  }
}

export function canonicalEntries(
  items: Array<{ repo_id: string; score: number; source: string }>,
  modelVersion: string,
  summaries: Map<string, string | null>,
  generationId?: string,
): RecommendationEntry[] {
  return items.map((item) => ({
    repo_id: item.repo_id,
    score: item.score,
    source: item.source,
    model_version: modelVersion,
    summary_id: summaries.get(item.repo_id) ?? null,
    ...(generationId ? { generation_id: generationId } : {}),
  }));
}
