import type { RecommendationEntry } from '../contracts/feed.v2.js';
import type { Redis } from 'ioredis';

import {
  APPEND_FEED_LUA,
  COMMIT_FEED_LUA,
  RENEW_GENERATION_LOCK_LUA,
  PUBLISH_GENERATION_LUA,
  FEED_GENERATION_STATE_LUA,
  REFILL_FEED_LUA,
  RELEASE_FEED_LUA,
  RELEASE_LOCK_LUA,
  RESERVE_FEED_LUA,
} from './feedReservationScripts.js';

export interface FeedReservation {
  token: string;
  requestId: string;
  items: RecommendationEntry[];
  // Production Redis reservations always supply this atomically. Optional for
  // existing custom ports that still use the depth() compatibility fallback.
  remainingDepth?: number;
}

export interface FeedGenerationState {
  remainingDepth: number;
  excludedRepoIds: string[];
  occupiedCount: number;
}

export type FeedAppendOutcome =
  | { status: 'published'; count: number }
  | { status: 'capacity' | 'satisfied'; count: 0 };

export class ReservationOwnedError extends Error {
  constructor() {
    super('Feed request already has an active reservation.');
    this.name = 'ReservationOwnedError';
  }
}

export interface FeedQueuePort {
  reserve(userId: string, version: bigint, requestId: string, limit: number, token: string): Promise<FeedReservation>;
  refill(userId: string, version: bigint, requestId: string, limit: number, token: string): Promise<FeedReservation>;
  commit(userId: string, version: bigint, requestId: string, token: string): Promise<boolean>;
  release(userId: string, version: bigint, requestId: string, token: string): Promise<boolean>;
  replace(userId: string, version: bigint, items: RecommendationEntry[], ttlSeconds: number): Promise<void>;
  renewGenerationLock(userId: string, version: bigint, token: string, ttlMs: number): Promise<boolean>;
  hasPublishedGeneration(userId: string, version: bigint): Promise<boolean>;
  publishGeneration(userId: string, version: bigint, token: string, items: RecommendationEntry[], ttlSeconds: number, onlyIfUnpublished?: boolean): Promise<boolean>;
  depth(userId: string, version: bigint): Promise<number>;
  acquireGenerationLock(userId: string, version: bigint, token: string, ttlMs: number): Promise<boolean>;
  releaseGenerationLock(userId: string, version: bigint, token: string): Promise<void>;
  scanReservations(): Promise<Array<{ userId: string; version: bigint; requestId: string; token: string; ttlMs: number }>>;
  deleteStaleVersions(userId: string, keepVersion: bigint): Promise<number>;
  generationState?(userId: string, version: bigint, token: string): Promise<FeedGenerationState | null>;
  append?(userId: string, version: bigint, token: string, items: RecommendationEntry[], ttlSeconds: number, maxDepth: number, onlyIfUnpublished?: boolean): Promise<FeedAppendOutcome | null>;
}

export class RedisFeedQueue implements FeedQueuePort {
  constructor(private readonly redis: Redis, private readonly reservationTtlMs = 60_000) {}

  private queueKey(userId: string, version: bigint): string {
    return `feed:v2:${userId}:${version}`;
  }

  private reservationKeys(userId: string, version: bigint, requestId: string): [string, string] {
    const base = `feed:v2:reservation:${userId}:${version}:${requestId}`;
    return [`${base}:meta`, `${base}:items`];
  }

  private lockKey(userId: string, version: bigint): string {
    return `feed:v2:generation-lock:${userId}:${version}`;
  }

  // Shared tracking contract for feed refill/reconciliation. Members are meta
  // keys and scores are Redis-clock reservation lease deadlines in milliseconds.
  private reservationIndexKey(userId: string, version: bigint): string {
    return `feed:v2:reservation-index:${userId}:${version}`;
  }

  async reserve(userId: string, version: bigint, requestId: string, limit: number, token: string): Promise<FeedReservation> {
    const [meta, items] = this.reservationKeys(userId, version, requestId);
    let result: [number, string[]];
    try {
      result = await this.redis.eval(
        RESERVE_FEED_LUA,
        4,
        this.queueKey(userId, version), meta, items, this.reservationIndexKey(userId, version),
        token, requestId, String(limit), String(this.reservationTtlMs),
      ) as [number, string[]];
    } catch (error) {
      if (error instanceof Error && error.message.includes('RESERVATION_OWNED')) {
        throw new ReservationOwnedError();
      }
      throw error;
    }
    return { token, requestId, remainingDepth: Number(result[0]),
      items: result[1].map((item) => JSON.parse(item) as RecommendationEntry) };
  }

  async commit(userId: string, version: bigint, requestId: string, token: string): Promise<boolean> {
    const [meta, items] = this.reservationKeys(userId, version, requestId);
    return Number(await this.redis.eval(
      COMMIT_FEED_LUA, 3, meta, items, this.reservationIndexKey(userId, version), token,
    )) === 1;
  }

  async refill(userId: string, version: bigint, requestId: string, limit: number, token: string): Promise<FeedReservation> {
    const [meta, items] = this.reservationKeys(userId, version, requestId);
    let result: [number, string[]];
    try {
      result = await this.redis.eval(
        REFILL_FEED_LUA,
        4,
        this.queueKey(userId, version), meta, items, this.reservationIndexKey(userId, version),
        token, String(limit), String(this.reservationTtlMs),
      ) as [number, string[]];
    } catch (error) {
      if (error instanceof Error && error.message.includes('RESERVATION_OWNED')) {
        throw new ReservationOwnedError();
      }
      throw error;
    }
    return { token, requestId, remainingDepth: Number(result[0]),
      items: result[1].map((item) => JSON.parse(item) as RecommendationEntry) };
  }

  async release(userId: string, version: bigint, requestId: string, token: string): Promise<boolean> {
    const [meta, items] = this.reservationKeys(userId, version, requestId);
    return Number(await this.redis.eval(
      RELEASE_FEED_LUA, 4, this.queueKey(userId, version), meta, items,
      this.reservationIndexKey(userId, version), token,
    )) === 1;
  }

  async replace(userId: string, version: bigint, items: RecommendationEntry[], ttlSeconds: number): Promise<void> {
    const key = this.queueKey(userId, version);
    const pipeline = this.redis.multi().del(key);
    for (const item of items) pipeline.rpush(key, JSON.stringify(item));
    pipeline.expire(key, ttlSeconds);
    await pipeline.exec();
  }

  async renewGenerationLock(userId: string, version: bigint, token: string, ttlMs: number): Promise<boolean> {
    return Number(await this.redis.eval(RENEW_GENERATION_LOCK_LUA, 1,
      this.lockKey(userId, version), token, ttlMs)) === 1;
  }

  private publicationKey(userId: string, version: bigint): string {
    return `feed:v2:published:${userId}:${version}`;
  }

  async hasPublishedGeneration(userId: string, version: bigint): Promise<boolean> {
    return await this.redis.exists(this.publicationKey(userId, version)) === 1;
  }

  async publishGeneration(userId: string, version: bigint, token: string, items: RecommendationEntry[], ttlSeconds: number, onlyIfUnpublished = false): Promise<boolean> {
    return Number(await this.redis.eval(PUBLISH_GENERATION_LUA, 3,
      this.lockKey(userId, version), this.queueKey(userId, version), this.publicationKey(userId, version),
      token, ttlSeconds, onlyIfUnpublished ? '1' : '0',
      ...items.map(item => JSON.stringify(item)))) === 1;
  }

  async depth(userId: string, version: bigint): Promise<number> {
    return this.redis.llen(this.queueKey(userId, version));
  }

  async generationState(userId: string, version: bigint, token: string): Promise<FeedGenerationState | null> {
    const result = await this.redis.eval(
      FEED_GENERATION_STATE_LUA, 3, this.queueKey(userId, version),
      this.lockKey(userId, version), this.reservationIndexKey(userId, version), token,
    ) as [number, string[], number];
    return Number(result[0]) < 0 ? null : {
      remainingDepth: Number(result[0]), excludedRepoIds: result[1], occupiedCount: Number(result[2]),
    };
  }

  async append(userId: string, version: bigint, token: string, items: RecommendationEntry[], ttlSeconds: number, maxDepth: number, onlyIfUnpublished = false): Promise<FeedAppendOutcome | null> {
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 100 || items.length > 100) {
      throw new Error('Indexed feed append exceeds its bounded queue capacity.');
    }
    const [status, rawCount] = await this.redis.eval(
      APPEND_FEED_LUA, 4, this.queueKey(userId, version),
      this.lockKey(userId, version), this.reservationIndexKey(userId, version), this.publicationKey(userId, version),
      token, String(ttlSeconds), String(maxDepth), onlyIfUnpublished ? '1' : '0',
      ...items.map(item => JSON.stringify(item)),
    ) as [string, number];
    if (status === 'fenced') return null;
    if (status === 'capacity' || status === 'satisfied') return { status, count: 0 };
    const count = Number(rawCount);
    if (status !== 'published' || !Number.isInteger(count) || count < 0 || count > items.length) {
      throw new Error('Invalid indexed feed publication outcome.');
    }
    return { status, count };
  }

  async acquireGenerationLock(userId: string, version: bigint, token: string, ttlMs: number): Promise<boolean> {
    return await this.redis.set(this.lockKey(userId, version), token, 'PX', ttlMs, 'NX') === 'OK';
  }

  async releaseGenerationLock(userId: string, version: bigint, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK_LUA, 1, this.lockKey(userId, version), token);
  }

  async scanReservations(): Promise<Array<{ userId: string; version: bigint; requestId: string; token: string; ttlMs: number }>> {
    let cursor = '0';
    const reservations: Array<{ userId: string; version: bigint; requestId: string; token: string; ttlMs: number }> = [];
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'feed:v2:reservation:*:meta', 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const match = /^feed:v2:reservation:([^:]+):(\d+):([^:]+):meta$/.exec(key);
        if (!match) continue;
        const [token, ttlMs] = await Promise.all([this.redis.hget(key, 'token'), this.redis.pttl(key)]);
        if (token && ttlMs >= 0) reservations.push({
          userId: match[1], version: BigInt(match[2]), requestId: match[3], token, ttlMs,
        });
      }
    } while (cursor !== '0');
    return reservations;
  }

  async deleteStaleVersions(userId: string, keepVersion: bigint): Promise<number> {
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `feed:v2:${userId}:*`, 'COUNT', 100);
      cursor = next;
      const stale = keys.filter((key) => key !== this.queueKey(userId, keepVersion));
      if (stale.length > 0) deleted += await this.redis.del(...stale);
    } while (cursor !== '0');
    return deleted;
  }
}
