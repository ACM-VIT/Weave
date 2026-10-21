import crypto from 'node:crypto';
import { SearchRateLimitError } from './searchService.js';

interface GuardRedis {
  eval(script: string, count: number, ...args: (string | number)[]): Promise<unknown>;
  zrem(key: string, token: string): Promise<unknown>;
}

const ACQUIRE = `
local now=redis.call('TIME'); local ms=now[1]*1000+math.floor(now[2]/1000)
local requests=redis.call('INCR',KEYS[1])
if requests==1 then redis.call('EXPIRE',KEYS[1],60) end
if requests>60 then return 0 end
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',ms)
if redis.call('ZCARD',KEYS[2])>=2 then return 0 end
redis.call('ZADD',KEYS[2],ms+120000,ARGV[1]); redis.call('PEXPIRE',KEYS[2],120000)
return 1`;

/** Limits apply across all API instances; expiring leases recover after crashed processes. */
export class SearchRequestGuard {
  constructor(private readonly redis: GuardRedis) {}
  async acquire(viewer: string): Promise<() => Promise<void>> {
    const token = crypto.randomUUID();
    const activeKey = `search:v2:active:${viewer}`;
    const allowed = Number(await this.redis.eval(ACQUIRE, 2, `search:v2:requests:${viewer}`, activeKey, token));
    if (!allowed) throw new SearchRateLimitError('Too many search requests. Try again shortly.');
    return async () => { await this.redis.zrem(activeKey, token); };
  }
}
