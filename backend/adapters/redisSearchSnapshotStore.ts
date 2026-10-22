import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SearchRateLimitError, type SearchSnapshot, type SearchSnapshotStore } from '../services/searchService.js';

export interface SearchSnapshotRedis {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  set?(key: string, value: string, expiry: 'PX', milliseconds: number, mode: 'NX'): Promise<unknown>;
  eval?(script: string, count: number, ...args: (string | number)[]): Promise<unknown>;
}

// Ownership is shared across API instances. Crashed waiters expire, while an
// active waiter renews its token when polling (or while leading the build).
const OWNERS = `
local now=redis.call('TIME'); local ms=now[1]*1000+math.floor(now[2]/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ms)
if ARGV[2]=='1' then redis.call('ZADD',KEYS[1],ms+10000,ARGV[1])
else redis.call('ZREM',KEYS[1],ARGV[1]) end
redis.call('PEXPIRE',KEYS[1],10000)
return redis.call('ZCARD',KEYS[1])`;
const RELEASE_OWNER = "return redis.call('ZREM',KEYS[1],ARGV[1])";

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

  async getOrCreate(binding: string, viewer: string, build: (signal?: AbortSignal) => Promise<SearchSnapshot>, signal?: AbortSignal) {
    if (!this.redis.set || !this.redis.eval) throw new Error('Shared search coordination requires Redis commands.');
    // Do not coalesce with older instances which do not register ownership.
    // Snapshot/cursor keys stay v2 so already-issued cursors remain readable.
    const cacheKey = `search:v3:first:${crypto.createHash('sha256').update(binding).digest('hex')}`;
    const lockKey = `${cacheKey}:lock`;
    const ownersKey = `${cacheKey}:owners`;
    const token = crypto.randomUUID();
    const owners = () => this.redis.eval!(OWNERS, 1, ownersKey, token, signal?.aborted ? '0' : '1');
    const cached = async () => {
      const key = await this.redis.get(cacheKey);
      const snapshot = key ? await this.get(key) : undefined;
      return key && snapshot && snapshot.expires > Date.now() ? { key, snapshot } : undefined;
    };
    try {
      for (let attempt = 0; attempt < 60; attempt++) {
        signal?.throwIfAborted();
        await owners();
        signal?.throwIfAborted();
        const hit = await cached();
        signal?.throwIfAborted();
        if (hit) return hit;
        if (await this.redis.set(lockKey, token, 'PX', 10_000, 'NX')) {
          try {
            const hitAfterLock = await cached();
            signal?.throwIfAborted();
            if (hitAfterLock) return hitAfterLock;
            const count = Number(await this.redis.eval(
              "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
              1, `search:v2:creates:${viewer}`,
            ));
            if (count > 20) throw new SearchRateLimitError('Too many new searches. Try again shortly.');
            const shared = new AbortController();
            const stopped = new AbortController();
            const observeOwners = async () => {
              try {
                while (!stopped.signal.aborted) {
                  if (Number(await owners()) === 0) {
                    shared.abort(new DOMException('Search has no remaining waiters.', 'AbortError'));
                    return;
                  }
                  await delay(250, undefined, { signal: stopped.signal });
                }
              } catch (error) {
                if (!stopped.signal.aborted) shared.abort(error);
              }
            };
            const observing = observeOwners();
            try {
              // The leader retains its request admission and Redis lease until
              // build settles, including SQL rollback after the last waiter leaves.
              const snapshot = await build(shared.signal);
              if (Number(await owners()) === 0) shared.abort(new DOMException('Search has no remaining waiters.', 'AbortError'));
              shared.signal.throwIfAborted();
              // A slow/crashed leader must not publish after another process takes over its lease.
              if (await this.redis.get(lockKey) !== token) throw new SearchRateLimitError('Search is busy. Try again shortly.');
              const key = crypto.randomUUID();
              await this.set(key, snapshot);
              await this.redis.setex(cacheKey, 120, key);
              signal?.throwIfAborted();
              return { key, snapshot };
            } finally {
              stopped.abort();
              await observing;
            }
          } finally {
            await this.redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0", 1, lockKey, token);
          }
        }
        await delay(50, undefined, { signal });
      }
      throw new SearchRateLimitError('Search is busy. Try again shortly.');
    } finally {
      await this.redis.eval(RELEASE_OWNER, 1, ownersKey, token);
    }
  }
}
