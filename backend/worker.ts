import 'dotenv/config';
import redisClient from './config/redis.js';
import { validateWorkerRoleDependencies } from './config/features.js';
import { sqlClient } from './db/index.js';
import { ApplicationRuntime } from './runtime/applicationRuntime.js';

const cliRole = process.argv.find((argument) => argument.startsWith('--role='))?.slice('--role='.length);
if (process.env.WORKER_ROLE && cliRole && process.env.WORKER_ROLE !== cliRole) {
  throw new Error('WORKER_ROLE conflicts with the --role command-line argument.');
}
const role = process.env.WORKER_ROLE || cliRole;
if (!role || !['outbox', 'feed', 'maintenance', 'all'].includes(role)) {
  throw new Error('WORKER_ROLE must be outbox, feed, maintenance, or all. Use separate roles in production.');
}

const runtime = new ApplicationRuntime(role as 'outbox' | 'feed' | 'maintenance' | 'all');
const roleErrors = validateWorkerRoleDependencies(role as 'outbox' | 'feed' | 'maintenance' | 'all', runtime.flags);
if (roleErrors.length > 0) throw new Error(`Invalid worker configuration: ${roleErrors.join(' ')}`);
runtime.start();
console.log(`Backend worker running with role=${role}`);

async function shutdown(): Promise<void> {
  await runtime.stop();
  await Promise.allSettled([redisClient.quit(), sqlClient.end({ timeout: 5 })]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
