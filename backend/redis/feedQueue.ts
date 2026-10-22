import type { RecommendationEntry } from '../contracts/feed.v2.js';
import type { Redis } from 'ioredis';
import { isValidUuid } from '../utils/validators.js';
import { DELETE_STALE_FEED_VERSIONS_LUA, READ_FEED_RESERVATION_LUA, TRACK_FEED_VERSION_LUA } from './feedMaintenanceScripts.js';

import {
  APPEND_FEED_LUA,
  COMMIT_FEED_LUA,
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
  depth(userId: string, version: bigint): Promise<number>;
  acquireGenerationLock(userId: string, version: bigint, token: string, ttlMs: number): Promise<boolean>;
  releaseGenerationLock(userId: string, version: bigint, token: string): Promise<void>;
  scanReservations(): Promise<Array<{ userId: string; version: bigint; requestId: string; token: string; ttlMs: number }>>;
  deleteStaleVersions(userId: string, keepVersion: bigint): Promise<number>;
  generationState?(userId: string, version: bigint, token: string): Promise<FeedGenerationState | null>;
  append?(userId: string, version: bigint, token: string, items: RecommendationEntry[], ttlSeconds: number, maxDepth: number): Promise<number | null>;
}

// COUNT is a Redis hint, not a processing bound. Revisit an oversized reply at
// the same cursor with an offset, rather than dropping its tail or retaining an
// unbounded pending array. SCAN is best-effort under mutation; repeated complete
// passes repair missing entries without a keyspace traversal in any one cycle.
interface RepairCursor { cursor: string; offset: number }
type ReservationCandidate = { userId: string; version: bigint; requestId: string; token: string; ttlMs: number };

export class RedisFeedQueue implements FeedQueuePort {
  private readonly reservationCursor: RepairCursor = { cursor: '0', offset: 0 };
  private readonly legacyCursor: RepairCursor = { cursor: '0', offset: 0 };
  private reservationScan: Promise<ReservationCandidate[]> | undefined;
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

  private versionIndexKey(userId: string): string {
    return `feed:v2:version-index:${userId}`;
  }

  async reserve(userId: string, version: bigint, requestId: string, limit: number, token: string): Promise<FeedReservation> {
    const [meta, items] = this.reservationKeys(userId, version, requestId);
    let result: [number, string[]];
    try {
      result = await this.redis.eval(
        RESERVE_FEED_LUA,
        5,
        this.queueKey(userId, version), meta, items, this.reservationIndexKey(userId, version), this.versionIndexKey(userId),
        token, requestId, String(limit), String(this.reservationTtlMs), String(version),
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
        5,
        this.queueKey(userId, version), meta, items, this.reservationIndexKey(userId, version), this.versionIndexKey(userId),
        token, String(limit), String(this.reservationTtlMs), String(version),
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
      RELEASE_FEED_LUA, 5, this.queueKey(userId, version), meta, items,
      this.reservationIndexKey(userId, version), this.versionIndexKey(userId), token, String(version),
    )) === 1;
  }

  async replace(userId: string, version: bigint, items: RecommendationEntry[], ttlSeconds: number): Promise<void> {
    const key = this.queueKey(userId, version);
    const pipeline = this.redis.multi().del(key);
    for (const item of items) pipeline.rpush(key, JSON.stringify(item));
    pipeline.expire(key, ttlSeconds);
    pipeline.eval(TRACK_FEED_VERSION_LUA, 1, this.versionIndexKey(userId), String(version));
    const results = await pipeline.exec();
    if (!results) throw new Error('Feed replacement transaction did not complete.');
    for (const [error] of results) if (error) throw error;
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

  async append(userId: string, version: bigint, token: string, items: RecommendationEntry[], ttlSeconds: number, maxDepth: number): Promise<number | null> {
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 100 || items.length > 100) {
      throw new Error('Indexed feed append exceeds its bounded queue capacity.');
    }
    const result = Number(await this.redis.eval(
      APPEND_FEED_LUA, 4, this.queueKey(userId, version),
      this.lockKey(userId, version), this.reservationIndexKey(userId, version), this.versionIndexKey(userId),
      token, String(ttlSeconds), String(maxDepth), String(version), ...items.map(item => JSON.stringify(item)),
    ));
    return result < 0 ? null : result;
  }

  async acquireGenerationLock(userId: string, version: bigint, token: string, ttlMs: number): Promise<boolean> {
    return await this.redis.set(this.lockKey(userId, version), token, 'PX', ttlMs, 'NX') === 'OK';
  }

  async releaseGenerationLock(userId: string, version: bigint, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK_LUA, 1, this.lockKey(userId, version), token);
  }

  private async scanBatch(state: RepairCursor, pattern: string, limit: number): Promise<string[]> {
    const [next, keys] = await this.redis.scan(state.cursor, 'MATCH', pattern, 'COUNT', 128);
    const batch = keys.slice(state.offset, state.offset + limit);
    if (state.offset + limit < keys.length) state.offset += limit;
    else { state.cursor = next; state.offset = 0; }
    return batch;
  }

  scanReservations(): Promise<ReservationCandidate[]> {
    // Concurrent runOnce callers must not race the cursor/offset continuation.
    if (this.reservationScan) return this.reservationScan;
    const scan = this.readReservations();
    this.reservationScan = scan;
    void scan.finally(() => { if (this.reservationScan === scan) this.reservationScan = undefined; }).catch(() => undefined);
    return scan;
  }

  private async readReservations(): Promise<ReservationCandidate[]> {
    // Exactly two SCAN calls, at most 16 indexed scopes * 8 members plus
    // 128 legacy keys. No per-reservation or per-user keyspace scan.
    const [scopes, legacy] = await Promise.all([
      this.scanBatch(this.reservationCursor, 'feed:v2:reservation-index:*', 16),
      this.scanBatch(this.legacyCursor, 'feed:v2:*', 128),
    ]);
    const indexes = scopes.filter(key => {
      const match = /^feed:v2:reservation-index:([^:]+):(0|[1-9]\d*)$/.exec(key);
      return match !== null && isValidUuid(match[1]);
    });
    const candidates = new Set<string>();
    const invalidMembers: Array<{ index: string; key: string }> = [];
    if (indexes.length > 0) {
      const pipeline = this.redis.pipeline();
      for (const index of indexes) pipeline.zrange(index, 0, 7);
      const results = await pipeline.exec();
      if (!results) throw new Error('Feed reservation index read did not complete.');
      for (let i = 0; i < results.length; i++) {
        const [error, value] = results[i];
        if (error) throw error;
        const prefix = indexes[i].replace('reservation-index:', 'reservation:') + ':';
        for (const key of value as string[]) {
          // An index member never authorizes reads outside its user/version.
          const match = /^feed:v2:reservation:([^:]+):(0|[1-9]\d*):([^:]+):meta$/.exec(key);
          if (key.startsWith(prefix) && match && isValidUuid(match[1]) && isValidUuid(match[3])) candidates.add(key);
          else invalidMembers.push({ index: indexes[i], key });
        }
      }
    }
    const pipeline = this.redis.pipeline();
    let commands = 0;
    for (const { index, key } of invalidMembers) {
      // Remove only malformed tracking membership, never the referenced key.
      pipeline.zrem(index, key);
      commands++;
    }
    for (const key of legacy) {
      if (key.startsWith('feed:v2:reservation:')) candidates.add(key);
      const match = /^feed:v2:([^:]+):(0|[1-9]\d*)$/.exec(key);
      if (!match || !isValidUuid(match[1])) continue;
      pipeline.eval(TRACK_FEED_VERSION_LUA, 1, this.versionIndexKey(match[1]), match[2]);
      commands++;
    }
    const metadata: Array<{ userId: string; version: bigint; requestId: string }> = [];
    for (const key of candidates) {
      const match = /^feed:v2:reservation:([^:]+):(0|[1-9]\d*):([^:]+):meta$/.exec(key);
      if (!match || !isValidUuid(match[1]) || !isValidUuid(match[3])) continue;
      const version = BigInt(match[2]);
      pipeline.eval(READ_FEED_RESERVATION_LUA, 3, key,
        this.reservationIndexKey(match[1], version), this.versionIndexKey(match[1]), match[2]);
      metadata.push({ userId: match[1], version, requestId: match[3] });
    }
    if (commands + metadata.length === 0) return [];
    const results = await pipeline.exec();
    if (!results) throw new Error('Feed reservation metadata read did not complete.');
    const reservations: ReservationCandidate[] = [];
    for (let i = 0; i < results.length; i++) {
      const [error, value] = results[i];
      if (error) throw error;
      if (i < commands) continue;
      const [token, ttl] = value as [string?, number?];
      if (token && typeof ttl === 'number' && ttl > 0) {
        reservations.push({ ...metadata[i - commands], token, ttlMs: ttl });
      }
    }
    return reservations;
  }

  async deleteStaleVersions(userId: string, keepVersion: bigint): Promise<number> {
    if (!isValidUuid(userId) || keepVersion < 0n) throw new Error('Invalid feed cleanup scope.');
    return Number(await this.redis.eval(DELETE_STALE_FEED_VERSIONS_LUA, 1,
      this.versionIndexKey(userId), String(keepVersion), `feed:v2:${userId}:`));
  }
}
