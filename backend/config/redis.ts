import { Redis } from 'ioredis';

// Ensure the application doesn't crash on boot if environment keys are missing
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  connectTimeout: 5000,
  retryStrategy() {
    return 500; // Simpler retry loop for local Docker instances
  }
});

// Operational Event Listeners for telemetry monitoring
redisClient.on('connect', () => {
  console.log('🚀 [Redis] System connected successfully to cache cluster instance.');
});

redisClient.on('error', (err) => {
  console.error('❌ [Redis] Critical Telemetry Error Detected:', err);
});

export default redisClient;