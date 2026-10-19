import type { SearchSnapshot, SearchSnapshotStore } from '../services/searchService.js';

export interface SearchSnapshotRedis {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
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
}
