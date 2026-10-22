import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import dotenv from 'dotenv';

// Load .env explicitly if it hasn't been loaded
dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('FATAL ERROR: DATABASE_URL is not defined in the environment variables.');
}

let databaseUrl: URL;
try {
  databaseUrl = new URL(connectionString);
} catch {
  throw new Error('FATAL ERROR: DATABASE_URL is not a valid PostgreSQL connection URL.');
}

const placeholderPattern = /(^|[._-])(your|example|placeholder)([._-]|$)/i;
if (
  !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
  placeholderPattern.test(databaseUrl.hostname) ||
  placeholderPattern.test(databaseUrl.username) ||
  placeholderPattern.test(databaseUrl.password)
) {
  throw new Error(
    'FATAL ERROR: DATABASE_URL still contains placeholder values. Copy the real connection string from Supabase Dashboard > Connect.',
  );
}

// Disable prefetch as it is not supported for pooled connections
export const sqlClient = postgres(connectionString, { prepare: false });
export const db = drizzle(sqlClient, { schema });

export const SEARCH_SQL_CONNECTIONS = 3;

/** Called only after search admission; ordinary API/worker imports open no search sockets. */
export function createSearchSqlClient() {
  // The pinned driver's failover path can suppress the pending query's rejection
  // while reconnecting. Do not silently choose a host or change the main pool.
  if (sqlClient.options.host.length !== 1 || sqlClient.options.target_session_attrs) {
    throw new Error('Search SQL requires one database endpoint without target-session failover.');
  }
  return postgres(connectionString!, {
    prepare: false, max: SEARCH_SQL_CONNECTIONS,
    connect_timeout: 2, backoff: false, idle_timeout: 20,
  });
}
