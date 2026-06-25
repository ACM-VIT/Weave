import redisClient from '../config/redis.js';
import { db } from '../db/index.js';
import { repos } from '../db/schema.js';
import { inArray } from 'drizzle-orm';
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
   * Task --> Pulls the pre-stitched feed from the Redis queue for the mobile client
   */
  async getCachedFeed(userId: string): Promise<any[]> {
    const queueKey = `user:${userId}:delivery_queue`;

    try {
      // Pull all stringified objects currently stored in the Redis List
      const rawFeedItems = await redisClient.lrange(queueKey, 0, -1);

      if (!rawFeedItems || rawFeedItems.length === 0) {
        return []; // Return empty array if nothing is pushed yet or cache expired
      }

      // Parse the JSON strings back into readable JavaScript objects for the mobile app
      return rawFeedItems.map(item => JSON.parse(item));
    } catch (error) {
      console.error('[FeedService] Failed to retrieve cached feed:', error);
      throw error;
    }
  }
}