import crypto from 'node:crypto';

import type { FeedRequestV2, FeedResponseV2, FeedSource, RecommendationEntry } from '../contracts/feed.v2.js';
import type { FeedPersistencePort } from '../ports/feedPersistencePort.js';
import type { FeedQueuePort } from '../redis/feedQueue.js';
import { ReservationOwnedError } from '../redis/feedQueue.js';
import { incrementMetric } from '../observability/metrics.js';
import { FeedCursorCodec } from './feedCursor.js';

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
    private readonly generateOnMiss?: (userId: string, limit: number, excludeRepoIds: string[]) => Promise<unknown>,
    private readonly reservationWaitMs = 1_500,
    private readonly reservationPollMs = 25,
    cursorSecret?: string,
    private readonly generationWaitMs = 5_000,
  ) {
    this.cursorCodec = new FeedCursorCodec(cursorSecret);
  }

  private readonly cursorCodec: FeedCursorCodec;

  private async waitForGeneratedReservation(
    userId: string,
    version: bigint,
    requestId: string,
    limit: number,
    token: string,
  ) {
    const deadline = Date.now() + this.generationWaitMs;
    let reservation = { requestId, token, items: [] as RecommendationEntry[] };
    do {
      reservation = await this.queue.refill(userId, version, requestId, limit, token);
      if (reservation.items.length > 0 || Date.now() >= deadline) return reservation;
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, this.reservationPollMs)));
    } while (true);
  }

  private async waitForServe(userId: string, requestId: string): Promise<FeedResponseV2> {
    const deadline = Date.now() + this.reservationWaitMs;
    do {
      const replay = await this.persistence.getServeByRequest(userId, requestId);
      if (replay) {
        incrementMetric('feed_v2_duplicate_requests_total');
        return responseFromServe(replay);
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, this.reservationPollMs));
    } while (true);
    throw new FeedRequestInProgressError();
  }

  async getFeed(userId: string, request: FeedRequestV2): Promise<FeedResponseV2> {
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
    const token = crypto.randomUUID();
    let queueAvailable = true;
    let reservation;
    try {
      reservation = await this.queue.reserve(
        userId, version, request.feed_request_id, request.limit, token,
      );
    } catch (error) {
      if (error instanceof ReservationOwnedError) {
        return this.waitForServe(userId, request.feed_request_id);
      }
      queueAvailable = false;
      reservation = { token, requestId: request.feed_request_id, items: [] };
      incrementMetric('feed_v2_redis_failures_total');
      console.error('[FeedV2Service] Redis unavailable; evaluating durable personalized recovery:', error);
    }

    let generationError: unknown;
    if (queueAvailable && reservation.items.length === 0 && this.generateOnMiss) {
      try {
        const outcome = await this.generateOnMiss(userId, request.limit, []);
        reservation = outcome === 'coalesced'
          ? await this.waitForGeneratedReservation(
            userId, version, request.feed_request_id, request.limit, token,
          )
          : await this.queue.refill(
            userId, version, request.feed_request_id, request.limit, token,
          );
      } catch (error) {
        if (error instanceof ReservationOwnedError) {
          return this.waitForServe(userId, request.feed_request_id);
        }
        console.error('[FeedV2Service] Generation failed; evaluating durable personalized recovery:', error);
        generationError = error;
        reservation = { token, requestId: request.feed_request_id, items: [] };
      }
    }

    let entries = reservation.items;
    incrementMetric(entries.length > 0 ? 'feed_v2_cache_hits_total' : 'feed_v2_cache_misses_total');
    const source: FeedSource = 'personalized';
    if (entries.length === 0 && request.cursor === null
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
      throw new PersonalizedFeedUnavailableError(generationError);
    }

    const projections = await this.persistence.listActiveRepositories(
      entries.map((entry) => entry.repo_id),
      userId,
    );
    const byId = new Map(projections.map((repo) => [repo.repo_id, repo]));
    const usable = entries.filter((entry) => byId.has(entry.repo_id));
    if (usable.length === 0 && entries.length > 0) {
      if (queueAvailable) await this.queue.commit(userId, version, request.feed_request_id, token);
      throw new Error('Feed contained no active canonical repositories.');
    }

    try {
      let nextCursor: string | null = null;
      if (queueAvailable && source === 'personalized' && usable.length > 0) {
        try {
          if (await this.queue.depth(userId, version) > 0) {
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
        items: usable.map((entry, position) => ({
          ...entry, position: pageOffset + position, repository: byId.get(entry.repo_id)!,
        })),
      });
      if (queueAvailable) await this.queue.commit(userId, version, request.feed_request_id, token);
      return responseFromServe(stored);
    } catch (error) {
      const replayAfterFailure = await this.persistence.getServeByRequest(userId, request.feed_request_id);
      if (replayAfterFailure) {
        if (queueAvailable) await this.queue.commit(userId, version, request.feed_request_id, token);
        return responseFromServe(replayAfterFailure);
      }
      if (queueAvailable) await this.queue.release(userId, version, request.feed_request_id, token);
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
