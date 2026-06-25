import redisClient from '../config/redis.js';
import { db } from '../db/index.js';
import { repos, activities } from '../db/schema.js';
import { inArray, desc, eq, sql } from 'drizzle-orm';
import axios from 'axios';

export class FeedService {
  private SESSION_TTL = 600; // 10 minutes cache lifetime

  /**
   * Task --> Routes scoring IDs through the Python ML microservice to apply
   * freshness and exploration injections, then stitches relational metadata
   * from PostgreSQL and caches the final layout sequence into Redis.
   */
  async processAndCacheBatch(userId: string, mlRepoIds: string[]): Promise<void> {
    const fallbackIds = mlRepoIds.slice(0, 15); // Safeguard to guarantee exactly 15 elements
    const queueKey = `user:${userId}:delivery_queue`;

    try {
      // 1. Initialize our tracking array with the base machine learning ranking order
      let finalRankedIds: string[] = fallbackIds;
      
      try {
        // Map the flat ID strings into the structured candidates array the Python API expects
        const candidatePayload = fallbackIds.map(id => ({ repo_id: id }));
        
        // Fire HTTP POST request to your live background FastAPI application process
        const mlResponse = await axios.post(`${process.env.ML_SERVICE_URL}/api/internal/ml/assemble-feed`, {
          candidates: candidatePayload
        });
        
        if (mlResponse.data && Array.isArray(mlResponse.data.rankedRepoIds)) {
          finalRankedIds = mlResponse.data.rankedRepoIds;
        }
      } catch (mlError) {
        // Failsafe: If the Python server is offline, log it and fall back gracefully to the original ML order
        console.error('[FeedService] ML injection service unavailable, using fallback standard rank:', mlError);
      }

      // 2. Fetching metadata in a single batch query using real Drizzle ORM syntax
      const dbRepos = await db
        .select()
        .from(repos)
        .where(inArray(repos.repo_id, finalRankedIds));

      // 3. Format the database payload into a clean structure optimized json file for the frontend layout
      // CRITICAL: We map over finalRankedIds here to guarantee we preserve the precise sorted order calculated by Python!
      const formattedPosts = finalRankedIds.map(id => {
        const repo = dbRepos.find(r => r.repo_id === id);
        if (!repo) return null;

        return {
          id: repo.repo_id,
          url: repo.github_repo_url,
          title: repo.repo_name,
          owner: repo.owner_id || 'Unknown',
          description: repo.description,
          // Since language_used and topics are JSONB arrays in your schema, we ensure type safety with fallback arrays
          tags: [
            ...(Array.isArray(repo.language_used) ? repo.language_used : []),
            ...(Array.isArray(repo.topics) ? repo.topics : [])
          ],
          readmePreview: repo.readme_summary,
          engagement: {
            likes: repo.likes_count ?? 0,
            comments: repo.comments_count ?? 0,
            saves: repo.saves_count ?? 0,
            views: repo.views_count ?? 0
          }
        };
      }).filter(Boolean); // Clears out any null mapping items cleanly

      // 4. Store directly into your running Redis cache pipeline
      const pipeline = redisClient.pipeline();
      
      // Clear out any old expired delivery queue data snapshots first
      pipeline.del(queueKey); 

      for (const post of formattedPosts) {
        pipeline.rpush(queueKey, JSON.stringify(post));
      }

      // Automatically expire the queue if the user closes the app
      pipeline.expire(queueKey, this.SESSION_TTL);
      await pipeline.exec();

      console.log(`[FeedService] Successfully stitched and cached ${formattedPosts.length} posts for User: ${userId}`);
    } catch (error) {
      console.error('[FeedService] Error processing data batch:', error);
      throw error;
    }
  }

  /**
   * Task --> Replenishes the feed for a user from the ML service or database fallback
   */
  async replenishFeed(userId: string): Promise<void> {
    const mlServiceUrl = process.env.ML_SERVICE_URL;
    let repoIds: string[] = [];

    if (mlServiceUrl) {
      try {
        console.log(`[FeedService] Fetching recommendations from ML service for user ${userId}`);
        const response = await axios.get(`${mlServiceUrl}/api/v1/recommendations/${userId}`);
        const data = response.data;
        
        // Extract repo IDs from batch_1, batch_2, batch_3
        const idsSet = new Set<string>();
        for (const batchKey of ['batch_1', 'batch_2', 'batch_3']) {
          if (data && Array.isArray(data[batchKey])) {
            for (const item of data[batchKey]) {
              if (item && item.repo_id) {
                idsSet.add(item.repo_id);
              }
            }
          }
        }
        repoIds = Array.from(idsSet);
        console.log(`[FeedService] Extracted ${repoIds.length} recommendation IDs from ML service.`);
      } catch (error) {
        console.error('[FeedService] ML service recommendations fetch failed:', error instanceof Error ? error.message : error);
      }
    } else {
      console.warn('[FeedService] ML_SERVICE_URL is not defined in environment variables.');
    }

    // Fallback if ML service failed or was unconfigured or returned no IDs
    if (repoIds.length === 0) {
      try {
        console.log('[FeedService] Falling back to database trending repos for feed...');
        const dbRepos = await db
          .select({ repo_id: repos.repo_id })
          .from(repos)
          .orderBy(desc(repos.likes_count))
          .limit(15);
        repoIds = dbRepos.map(r => r.repo_id);
        console.log(`[FeedService] Fetched ${repoIds.length} fallback repo IDs from DB.`);
      } catch (dbError) {
        console.error('[FeedService] Fallback database query failed:', dbError);
      }
    }

    if (repoIds.length > 0) {
      await this.processAndCacheBatch(userId, repoIds);
    } else {
      console.warn('[FeedService] No repository IDs available to populate feed.');
    }
  }

  /**
   * Task --> Submits feedback to FastAPI ML service, invalidates user feed queue, and pops swiped repo
   */
  async submitFeedback(userId: string, repoId: string, action: string): Promise<void> {
    // 1. Record activity in Postgres
    try {
      const isLike = action.toLowerCase() === 'like';
      const isSave = action.toLowerCase() === 'save';

      await db.insert(activities)
        .values({
          user_id: userId,
          repo_id: repoId,
          likelihood_count: isLike ? 1 : 0,
          is_saved: isSave,
        })
        .onConflictDoUpdate({
          target: [activities.user_id, activities.repo_id],
          set: {
            likelihood_count: isLike ? 1 : sql`likelihood_count`,
            is_saved: isSave ? true : sql`is_saved`,
          }
        });
      console.log(`[FeedService] Recorded activity in DB for user ${userId}, repo ${repoId} (${action})`);
    } catch (dbError) {
      console.error('[FeedService] Failed to record activity in DB:', dbError);
    }

    // 2. Look up repo full_name from database if repoId is a UUID
    let repoName = repoId;
    try {
      const [repo] = await db
        .select({ full_name: repos.full_name })
        .from(repos)
        .where(eq(repos.repo_id, repoId))
        .limit(1);
      if (repo) {
        repoName = repo.full_name;
      }
    } catch (dbError) {
      console.warn('[FeedService] Failed to lookup repo full_name for feedback:', dbError);
    }

    // 3. Forward to FastAPI ML service if configured
    const mlServiceUrl = process.env.ML_SERVICE_URL;
    if (mlServiceUrl) {
      try {
        console.log(`[FeedService] Forwarding feedback to ML service: ${userId} -> ${repoName} (${action})`);
        await axios.post(`${mlServiceUrl}/api/v1/feedback`, {
          user_id: userId,
          repo_id: repoName,
          action: action.toLowerCase()
        });
      } catch (error) {
        console.error('[FeedService] Failed to forward feedback to ML service:', error instanceof Error ? error.message : error);
      }
    }

    // 4. Pop swiped repo from user's active Redis feed queue (delivery_queue)
    const queueKey = `user:${userId}:delivery_queue`;
    try {
      const rawFeedItems = await redisClient.lrange(queueKey, 0, -1);
      if (rawFeedItems && rawFeedItems.length > 0) {
        const filtered = rawFeedItems.filter(item => {
          const parsed = JSON.parse(item);
          return parsed.id !== repoId;
        });

        const pipeline = redisClient.pipeline();
        pipeline.del(queueKey);
        for (const item of filtered) {
          pipeline.rpush(queueKey, item);
        }
        pipeline.expire(queueKey, this.SESSION_TTL);
        await pipeline.exec();
        console.log(`[FeedService] Removed repo ${repoId} from delivery queue for user ${userId}`);
      }
    } catch (redisError) {
      console.error('[FeedService] Failed to update delivery queue in Redis:', redisError);
    }
  }

  /**
   * Task --> Pulls the pre-stitched feed from the Redis queue for the mobile client
   */
  async getCachedFeed(userId: string): Promise<any[]> {
    const queueKey = `user:${userId}:delivery_queue`;

    try {
      // Pull all stringified objects currently stored in the Redis List
      let rawFeedItems = await redisClient.lrange(queueKey, 0, -1);

      if (!rawFeedItems || rawFeedItems.length === 0) {
        console.log(`[FeedService] Cache miss for user ${userId}. Triggering replenishment...`);
        await this.replenishFeed(userId);
        rawFeedItems = await redisClient.lrange(queueKey, 0, -1);
      }

      // Parse the JSON strings back into readable JavaScript objects for the mobile app
      return rawFeedItems.map(item => JSON.parse(item));
    } catch (error) {
      console.error('[FeedService] Failed to retrieve cached feed:', error);
      throw error;
    }
  }
}