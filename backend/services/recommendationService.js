const Redis = require("ioredis");
const { v5: uuidv5 } = require("uuid");
const supabase = require("../config/supabase");

const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://localhost:8000";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const BATCH_SIZE = 15;

let redis = null;
let isRedisConnected = false;

try {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      // Retry connection every 5 seconds, up to 3 times, then disable Redis fallback
      if (times > 3) {
        console.warn("⚠️ Redis connection failed. Proceeding with caching disabled.");
        isRedisConnected = false;
        return null; // Stop retrying
      }
      return 5000;
    }
  });

  redis.on("connect", () => {
    console.log("🚀 Connected to Redis for recommendation delivery queue");
    isRedisConnected = true;
  });

  redis.on("error", (err) => {
    console.warn("⚠️ Redis client error:", err.message);
    isRedisConnected = false;
  });
} catch (err) {
  console.warn("⚠️ Could not initialize Redis client. Caching is disabled:", err.message);
}

const getUserUuid = (userId) => {
  return uuidv5(`user:${userId}`, NAMESPACE_URL);
};

/**
 * Fetch fallback repositories from Supabase if ML service or Redis is down.
 */
const getFallbackRepositories = async (limit = 15) => {
  try {
    const { data, error } = await supabase
      .from("Repo")
      .select("repo_id, github_repo_url, repo_name, full_name, description, primary_language, star_count, topics")
      .order("star_count", { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data || []).map(r => ({
      repo_id: r.repo_id,
      cosine_score: 0.0,
      category: "Trending",
      primary_language: r.primary_language || "Unknown",
      description: r.description || "",
      star_count: r.star_count || 0,
      topics: r.topics || [],
      html_url: r.github_repo_url || ""
    }));
  } catch (err) {
    console.error("❌ Fallback repository retrieval failed:", err.message);
    return [];
  }
};

/**
 * Request recommendation batches from Python FastAPI microservice.
 */
const fetchFromMLService = async (userId) => {
  try {
    const response = await fetch(`${ML_SERVICE_URL}/api/v1/recommendations/${userId}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });

    if (!response.ok) {
      throw new Error(`ML service returned status ${response.status}`);
    }

    const result = await response.json();
    return result; // Expected: { batch_1: [...], batch_2: [...], batch_3: [...] }
  } catch (err) {
    console.warn(`⚠️ ML Service retrieval failed for user ${userId}:`, err.message);
    return null;
  }
};

/**
 * Replenishes user feed queue in Redis from FastAPI.
 */
const replenishFeed = async (userId) => {
  if (!redis || !isRedisConnected) return false;

  const batches = await fetchFromMLService(userId);
  if (!batches) return false;

  // Flatten the batches: batch_1, batch_2, batch_3 (15 items each)
  const items = [];
  const requiredBatches = ["batch_1", "batch_2", "batch_3"];
  for (const b of requiredBatches) {
    if (Array.isArray(batches[b])) {
      items.push(...batches[b]);
    }
  }

  if (items.length === 0) return false;

  const key = `user:feed:${userId}`;
  try {
    // Clear any existing queue
    await redis.del(key);

    // Push new items
    const stringifiedItems = items.map(item => JSON.stringify(item));
    await redis.rpush(key, ...stringifiedItems);

    // Set 24 hour expiration
    await redis.expire(key, 24 * 3600);
    console.log(`✅ Replenished Redis feed queue for user ${userId} with ${items.length} items`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to push items to Redis for user ${userId}:`, err.message);
    return false;
  }
};

/**
 * Retrieve recommendation feed (up to 15 items).
 */
const getFeed = async (userId) => {
  const key = `user:feed:${userId}`;

  if (redis && isRedisConnected) {
    try {
      let queueLen = await redis.llen(key);

      // If queue is empty or running low (< 15 items), replenish
      if (queueLen < BATCH_SIZE) {
        const replenished = await replenishFeed(userId);
        if (replenished) {
          queueLen = await redis.llen(key);
        }
      }

      // Pop up to 15 items
      let popped = [];
      try {
        popped = await redis.lpop(key, BATCH_SIZE);
        if (popped && !Array.isArray(popped)) {
          // Fallback if Redis returned a single string (older Redis versions)
          popped = [popped];
          for (let i = 1; i < BATCH_SIZE; i++) {
            const nextItem = await redis.lpop(key);
            if (!nextItem) break;
            popped.push(nextItem);
          }
        }
      } catch (lpopErr) {
        // Fallback for command compatibility
        popped = [];
        for (let i = 0; i < BATCH_SIZE; i++) {
          const nextItem = await redis.lpop(key);
          if (!nextItem) break;
          popped.push(nextItem);
        }
      }

      if (popped && popped.length > 0) {
        return popped.map(p => JSON.parse(p));
      }
    } catch (redisErr) {
      console.warn("⚠️ Redis operation failed inside getFeed, falling back to direct API:", redisErr.message);
    }
  }

  // Fallback 1: Direct fetch from FastAPI
  console.log(`ℹ️ Fetching recommendations directly from ML service for ${userId}`);
  const batches = await fetchFromMLService(userId);
  if (batches && Array.isArray(batches.batch_1) && batches.batch_1.length > 0) {
    return batches.batch_1;
  }

  // Fallback 2: Fetch trending repositories from Supabase
  console.log(`ℹ️ Serving fallback repositories from Supabase for ${userId}`);
  return getFallbackRepositories(BATCH_SIZE);
};

/**
 * Proxy user swipe interaction to FastAPI.
 */
const sendFeedback = async (userId, repoId, action) => {
  try {
    const response = await fetch(`${ML_SERVICE_URL}/api/v1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        repo_id: repoId,
        action: action
      })
    });

    if (!response.ok) {
      throw new Error(`ML service returned status ${response.status}`);
    }

    // Invalidate local Redis cache immediately
    await invalidateFeedCache(userId);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send feedback to ML service for user ${userId}:`, err.message);
    // Even if ML feedback fails, we still invalidate local cache to keep it clean
    await invalidateFeedCache(userId).catch(() => {});
    return false;
  }
};

/**
 * Invalidate Redis delivery queue cache.
 */
const invalidateFeedCache = async (userId) => {
  if (redis && isRedisConnected) {
    const key = `user:feed:${userId}`;
    try {
      await redis.del(key);
      console.log(`🧹 Invalidated Redis feed queue cache for user ${userId}`);
    } catch (err) {
      console.warn(`⚠️ Failed to invalidate Redis cache for user ${userId}:`, err.message);
    }
  }
};

module.exports = {
  getUserUuid,
  getFeed,
  sendFeedback,
  invalidateFeedCache,
  getFallbackRepositories
};
