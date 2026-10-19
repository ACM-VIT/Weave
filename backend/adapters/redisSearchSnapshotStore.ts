import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SearchRateLimitError, type SearchSnapshot, type SearchSnapshotStore } from '../services/searchService.js';

export interface SearchSnapshotRedis {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  set?(key: string, value: string, expiry: 'PX', milliseconds: number, mode: 'NX'): Promise<unknown>;
  eval?(script: string, count: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Shared, short-lived ranking snapshots allow any API instance to serve the next page. */
export class RedisSearchSnapshotStore implements SearchSnapshotStore {
  constructor(private readonly redis: SearchSnapshotRedis) {}
  async get(key: string): Promise<SearchSnapshot | undefined> {
    const raw = await this.redis.get(`search:v2:snapshot:${key}`);
    return raw ? JSON.parse(raw) as SearchSnapshot : undefined;
  }
  async set(key: string, snapshot: SearchSnapshot): Promise<void> {
    await this.redis.setex(`search:v2:snapshot:${key}`, 120, JSON.stringify(snapshot));
  }

  async getOrCreate(binding: string, viewer: string, build: () => Promise<SearchSnapshot>) {
    if (!this.redis.set || !this.redis.eval) throw new Error('Shared search coordination requires Redis commands.');
    const cacheKey = `search:v2:first:${crypto.createHash('sha256').update(binding).digest('hex')}`;
    const lockKey = `${cacheKey}:lock`;
    const token = crypto.randomUUID();
    const cached = async () => {
      const key = await this.redis.get(cacheKey);
      const snapshot = key ? await this.get(key) : undefined;
      return key && snapshot && snapshot.expires > Date.now() ? { key, snapshot } : undefined;
    };
    for (let attempt = 0; attempt < 60; attempt++) {
      const hit = await cached();
      if (hit) return hit;
      if (await this.redis.set(lockKey, token, 'PX', 10_000, 'NX')) {
        try {
          const hitAfterLock = await cached();
          if (hitAfterLock) return hitAfterLock;
          const count = Number(await this.redis.eval(
            "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
            1, `search:v2:creates:${viewer}`,
          ));
          if (count > 20) throw new SearchRateLimitError('Too many new searches. Try again shortly.');
          const snapshot = await build();
          // A slow/crashed leader must not publish after another process takes over its lease.
          if (await this.redis.get(lockKey) !== token) throw new SearchRateLimitError('Search is busy. Try again shortly.');
          const key = crypto.randomUUID();
          await this.set(key, snapshot);
          await this.redis.setex(cacheKey, 120, key);
          return { key, snapshot };
        } finally {
          await this.redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0", 1, lockKey, token);
        }
      }
      await delay(50);
    }
    throw new SearchRateLimitError('Search is busy. Try again shortly.');
  }
}
