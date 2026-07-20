import 'dotenv/config';
import app from './app.js';
import redisClient from './config/redis.js';
import { sqlClient } from './db/index.js';
import { getApplicationRuntime } from './runtime/applicationRuntime.js';

const port: number = parseInt(process.env.PORT ?? '5000', 10);

const runtime = getApplicationRuntime();
// This validates feature dependencies; API processes intentionally register no workers.
runtime.start();

const server = app.listen(port, () => {
  console.log(`Backend running on port ${port}`);
});
const localOAuthServer = process.env.NODE_ENV !== 'production' && port !== 3000
  ? app.listen(3000, '127.0.0.1', () => {
      console.log('Local OAuth bridge running on port 3000');
    })
  : null;

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log('\nShutting down gracefully...');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (localOAuthServer) {
    await new Promise<void>((resolve) => localOAuthServer.close(() => resolve()));
  }
  await runtime.supervisor.stop();
  await Promise.allSettled([redisClient.quit(), sqlClient.end({ timeout: 5 })]);
  console.log('Server closed');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
