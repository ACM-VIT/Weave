import crypto from 'crypto';
import redisClient from '../config/redis.js';
import { db } from '../db/index.js';
import { repos, users } from '../db/schema.js';
import { desc, inArray, eq } from 'drizzle-orm';
export class FeedService {
  private SESSION_TTL = 600; // 10 minutes cache lifetime
  /** How long the in-flight lock is held before auto-expiring (ms). */
  private LOCK_TTL_MS = 30_000;
  /** Max time a waiter will poll for the lock to be released (ms). */
  private LOCK_WAIT_TIMEOUT_MS = 35_000;

  private getQueueKey(userId: string): string {
    return `user:${userId}:delivery_queue`;
  }

  private getLockKey(userId: string): string {
    return `user:${userId}:feed_generating`;
  }

  private getVersionKey(userId: string): string {
    return `user:${userId}:feed_version`;
  }

  private async recordMetric(name: string): Promise<void> {
    try {
      await redisClient.incr(`metrics:feed:${name}`);
    } catch {
      // best effort
    }
  }

  private async getFeedVersion(userId: string): Promise<number> {
    try {
      const raw = await redisClient.get(this.getVersionKey(userId));
      return raw ? Number(raw) || 0 : 0;
    } catch {
      return 0;
    }
  }

  private async bumpFeedVersion(userId: string): Promise<number> {
    try {
      return await redisClient.incr(this.getVersionKey(userId));
    } catch {
      return 0;
    }
  }

  private async replaceQueueIfVersionMatches(
    userId: string,
    serializedRecommendations: string[],
    expectedVersion?: number,
  ): Promise<boolean> {
    const script = `
      if ARGV[1] ~= '' then
        local current_version = redis.call('get', KEYS[1]) or '0'
        if current_version ~= ARGV[1] then
          return 0
        end
      end

      redis.call('del', KEYS[2])
      if #ARGV == 2 then
        redis.call('set', KEYS[2], '__empty__', 'EX', ARGV[2])
      else
        for i = 3, #ARGV do
          redis.call('rpush', KEYS[2], ARGV[i])
        end
        redis.call('expire', KEYS[2], ARGV[2])
      end
      return 1
    `;

    const result = await redisClient.eval(
      script,
      2,
      this.getVersionKey(userId),
      this.getQueueKey(userId),
      expectedVersion?.toString() ?? '',
      this.SESSION_TTL.toString(),
      ...serializedRecommendations,
    );
    return Number(result) === 1;
  }

  private async appendQueueIfVersionMatches(
    userId: string,
    serializedRecommendations: string[],
    expectedVersion?: number,
  ): Promise<boolean> {
    const script = `
      if ARGV[1] ~= '' then
        local current_version = redis.call('get', KEYS[1]) or '0'
        if current_version ~= ARGV[1] then
          return 0
        end
      end

      for i = 3, #ARGV do
        redis.call('rpush', KEYS[2], ARGV[i])
      end
      redis.call('expire', KEYS[2], ARGV[2])
      return 1
    `;

    const result = await redisClient.eval(
      script,
      2,
      this.getVersionKey(userId),
      this.getQueueKey(userId),
      expectedVersion?.toString() ?? '',
      this.SESSION_TTL.toString(),
      ...serializedRecommendations,
    );
    return Number(result) === 1;
  }

  private async enrichRecommendations(recommendations: any[]): Promise<any[]> {
    if (recommendations.length === 0) return [];

    const fullNames = recommendations
      .map((recommendation) => recommendation.full_name || recommendation.github_repo)
      .filter(Boolean);
    if (fullNames.length === 0) return recommendations;

    try {
      const repoData = await db.select().from(repos).where(inArray(repos.full_name, fullNames));
      const repoMap = new Map();
      repoData.forEach(r => repoMap.set(r.full_name, r));

      return recommendations.map(r => {
        const fullName = r.full_name || r.github_repo;
        const dbRepo = repoMap.get(fullName);
        if (!dbRepo) return r;

        let languages = r.languages || [];
        if (dbRepo.language_used && typeof dbRepo.language_used === 'object') {
          languages = Object.keys(dbRepo.language_used);
        }

        return {
          ...r,
          full_name: fullName,
          repo_id: dbRepo.repo_id,
          description: dbRepo.description || r.description,
          readme_summary: dbRepo.readme_summary || r.readme_summary,
          readme_md: dbRepo.readme_md || r.readme_md,
          languages,
          topics: dbRepo.topics || r.topics,
          star_count: dbRepo.star_count || r.star_count,
          fork_count: dbRepo.forks_count || r.fork_count,
        };
      });
    } catch (err) {
      console.error('[FeedService] Error enriching recommendations:', err);
      return recommendations;
    }
  }

  /**
   * Stores ML recommendation objects in the Redis delivery queue.
   * Returns false when the generation became stale before it could be cached,
   * allowing request paths to retry against the latest feed version.
   */
  async processAndCacheBatch(userId: string, recommendations: any[], expectedVersion?: number): Promise<boolean> {
    try {
      if (recommendations.length === 0) {
        const cached = await this.replaceQueueIfVersionMatches(userId, [], expectedVersion);
        if (!cached) {
          await this.recordMetric('stale_drop');
          console.log(`[FeedService] Dropped stale feed batch for User: ${userId}`);
        }
        return cached;
      }

      const enriched = await this.enrichRecommendations(recommendations);
      const cached = await this.replaceQueueIfVersionMatches(
        userId,
        enriched.map((post) => JSON.stringify(post)),
        expectedVersion,
      );
      if (!cached) {
        await this.recordMetric('stale_drop');
        console.log(`[FeedService] Dropped stale feed batch for User: ${userId}`);
        return false;
      }

      await this.recordMetric('cache_populate');
      console.log(`[FeedService] Cached ${enriched.length} ML recommendations for User: ${userId}`);
      return true;
    } catch (error) {
      console.error('[FeedService] Error caching feed batch:', error);
      throw error;
    }
  }

  async appendBatch(userId: string, recommendations: any[], expectedVersion?: number): Promise<void> {
    try {
      if (recommendations.length === 0) return;

      const enriched = await this.enrichRecommendations(recommendations);
      const appended = await this.appendQueueIfVersionMatches(
        userId,
        enriched.map((post) => JSON.stringify(post)),
        expectedVersion,
      );
      if (!appended) {
        await this.recordMetric('stale_drop');
        console.log(`[FeedService] Dropped stale replenishment batch for User: ${userId}`);
        return;
      }

      await this.recordMetric('cache_append');
      console.log(`[FeedService] Appended ${enriched.length} ML recommendations for User: ${userId}`);
    } catch (error) {
      console.error('[FeedService] Error appending feed batch:', error);
    }
  }

  private async isColdStartUser(userId: string): Promise<boolean> {
    try {
      const result = await db
        .select({ likes: users.likes_given_count, saves: users.saved_repos_count })
        .from(users)
        .where(eq(users.user_id, userId))
        .limit(1);

      if (result.length === 0) return true; // unknown user = cold start
      return (result[0].likes ?? 0) === 0 && (result[0].saves ?? 0) === 0;
    } catch (err) {
      console.error('[FeedService] Cold-start check failed:', err);
      return false; // fail open → use standard pipeline
    }
  }

  /**
   * Keeps the home feed useful while Redis or ML is unavailable. The fallback
   * uses repository data already stored in Postgres and does not replace the
   * personalized Redis queue, so ML recommendations take over automatically
   * when the dependent services recover.
   */
  private async getDatabaseFallback(limit: number): Promise<any[]> {
    try {
      const fallback = await db
        .select()
        .from(repos)
        .orderBy(desc(repos.star_count), desc(repos.created_at))
        .limit(limit);

      await this.recordMetric('database_fallback');
      return fallback.map((repository) => ({
        ...repository,
        fork_count: repository.forks_count,
      }));
    } catch (error) {
      console.error('[FeedService] Database fallback failed:', error);
      throw error;
    }
  }

  private async replenishFeedBackground(userId: string): Promise<void> {
    const lockKey = this.getLockKey(userId);
    const lockToken = crypto.randomUUID();
    
    // Non-blocking try-lock. If we don't get it, someone else is replenishing.
    const acquired = await redisClient.set(lockKey, lockToken, 'PX', this.LOCK_TTL_MS, 'NX');
    
    if (acquired === 'OK') {
      try {
        const feedVersion = await this.getFeedVersion(userId);
        const recommendations = await this.getDatabaseFallback(45);
        await this.appendBatch(userId, recommendations, feedVersion);
      } catch (error) {
        console.error('[FeedService] Background replenishment failed:', error);
      } finally {
        const releaseScript = `
          if redis.call("get",KEYS[1]) == ARGV[1] then
              return redis.call("del",KEYS[1])
          else
              return 0
          end
        `;
        await redisClient.eval(releaseScript, 1, lockKey, lockToken).catch(() => {});
      }
    }
  }

  /**
   * Task --> Pulls a slice of the pre-stitched feed from the Redis queue for the mobile client
   */
  async getCachedFeed(userId: string, limit: number = 5): Promise<any[] | null> {
    const queueKey = this.getQueueKey(userId);

    try {
      const type = await redisClient.type(queueKey);
      if (type === 'string') {
        const val = await redisClient.get(queueKey);
        if (val === '__empty__') {
          await redisClient.del(queueKey);
          return null;
        }
      }

      // Pop the next `limit` items using an atomic transaction (MULTI/EXEC)
      const pipeline = redisClient.multi();
      pipeline.lrange(queueKey, 0, limit - 1);
      pipeline.ltrim(queueKey, limit, -1);
      pipeline.llen(queueKey);
      const results = await pipeline.exec();

      if (!results) return null;

      const rawFeedItems = results[0]?.[1] as string[] | undefined;
      const remaining = results[2]?.[1] as number | undefined;

      if (!rawFeedItems || rawFeedItems.length === 0) {
        await this.recordMetric('cache_miss');
        return null;
      }

      await this.recordMetric('cache_hit');

      // Just-In-Time Replenishment
      if (remaining !== undefined && remaining < 3) {
        void this.replenishFeedBackground(userId);
      }

      return rawFeedItems.map((item: string) => JSON.parse(item));
    } catch (error) {
      console.error('[FeedService] Failed to retrieve cached feed:', error);
      throw error;
    }
  }

  /**
   * Returns the cached feed if available. On a cache miss, acquires a short-lived
   * Redis lock (SET NX PX) so that only one concurrent request calls the ML service.
   * Other simultaneous requests poll with exponential back-off until the feed is
   * populated, then return the cached result — preventing duplicate ML calls.
   */
  async getOrGenerateFeed(userId: string, limit: number = 5): Promise<any[]> {
    let cachedFeed: any[] | null;
    try {
      cachedFeed = await this.getCachedFeed(userId, limit);
    } catch (error) {
      console.error('[FeedService] Redis unavailable; using database fallback:', error);
      return this.getDatabaseFallback(limit);
    }

    if (cachedFeed !== null) {
      return cachedFeed;
    }

    const lockKey = this.getLockKey(userId);
    const deadline = Date.now() + this.LOCK_WAIT_TIMEOUT_MS;
    let delay = 100; // start at 100 ms, doubles each iteration (cap 2 s)

    while (Date.now() < deadline) {
      const lockToken = crypto.randomUUID();
      let acquired: string | null;
      try {
        acquired = await redisClient.set(lockKey, lockToken, 'PX', this.LOCK_TTL_MS, 'NX');
      } catch (error) {
        console.error('[FeedService] Redis lock unavailable; using database fallback:', error);
        return this.getDatabaseFallback(limit);
      }

      if (acquired === 'OK') {
        try {
          const feedVersion = await this.getFeedVersion(userId);
          const recommendations = await this.getDatabaseFallback(Math.max(limit, 5));
          const cached = await this.processAndCacheBatch(userId, recommendations, feedVersion);

          if (!cached) {
            // An interaction invalidated this generation while ML was running.
            // Release the lock in finally and retry using the new feed version.
            continue;
          }
          
          // Re-fetch now that it's cached so we pop exactly `limit`
          return await this.getCachedFeed(userId, limit) || [];
        } catch (error) {
          console.error('[FeedService] ML generation unavailable; using database fallback:', error);
          return this.getDatabaseFallback(limit);
        } finally {
          const releaseScript = `
            if redis.call("get",KEYS[1]) == ARGV[1] then
                return redis.call("del",KEYS[1])
            else
                return 0
            end
          `;
          await redisClient.eval(releaseScript, 1, lockKey, lockToken).catch(() => {/* best-effort */});
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 2_000);

      let feed: any[] | null;
      try {
        feed = await this.getCachedFeed(userId, limit);
      } catch (error) {
        console.error('[FeedService] Redis polling unavailable; using database fallback:', error);
        return this.getDatabaseFallback(limit);
      }
      if (feed !== null) {
        return feed;
      }
    }

    console.warn(`[FeedService] Timed out waiting for ML feed for user ${userId}; using database fallback.`);
    return this.getDatabaseFallback(limit);
  }

  async invalidateUserFeed(userId: string): Promise<void> {
    try {
      await this.bumpFeedVersion(userId);
      await redisClient.del(this.getQueueKey(userId));
      await this.recordMetric('cache_invalidate');
    } catch (error) {
      console.error(`[FeedService] Failed to invalidate feed cache for ${userId}:`, error);
    }
  }
}

export { FeedV2Service } from './feedV2Service.js';
