import { Redis } from 'ioredis';
import { resolveRedisUrl } from './runtimeConfig.js';

const REDIS_URL = resolveRedisUrl(process.env.REDIS_URL, process.env.NODE_ENV);

const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  connectTimeout: 5_000,
  retryStrategy: () => 500,
});

redisClient.on('connect', () => console.log('[Redis] Connected.'));
redisClient.on('error', (error: Error) => console.error('[Redis] Connection error:', error));

export default redisClient;
