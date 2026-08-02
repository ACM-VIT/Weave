import { PostgresRepositoryPersistence } from '../adapters/postgresRepositoryPersistence.js';
import { sqlClient } from '../db/index.js';
import { TrendingIngestionWorker } from '../workers/trendingIngestionWorker.js';

try {
  const result = await new TrendingIngestionWorker(new PostgresRepositoryPersistence()).runOnce();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await sqlClient.end({ timeout: 5 });
}
