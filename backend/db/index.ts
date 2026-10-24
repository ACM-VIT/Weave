import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import dotenv from 'dotenv';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';

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

/** TLS setup removes raw listeners; record native close without a removable hook. */
class SearchSocket extends Socket {
  private finishClose!: () => void;
  readonly transportClosed = new Promise<void>(resolve => { this.finishClose = resolve; });

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'close') this.finishClose?.();
    return super.emit(event, ...args);
  }
}

/** Called only after search admission; ordinary API/worker imports open no search sockets. */
export function createSearchSqlClient() {
  // The pinned driver's failover path can suppress the pending query's rejection
  // while reconnecting. Do not silently choose a host or change the main pool.
  if (sqlClient.options.host.length !== 1 || sqlClient.options.target_session_attrs) {
    throw new Error('Search SQL requires one database endpoint without target-session failover.');
  }
  // One client belongs to one admission slot. The documented socket hook lets
  // cancellation close its real transport, including a BEGIN waiting at a proxy.
  const sockets = new Set<SearchSocket>();
  let retired = false;
  let disposal: Promise<void> | undefined;
  const options = {
    prepare: false, max: 1, fetch_types: false,
    connect_timeout: 2, backoff: false, idle_timeout: 20,
    socket: (parsed: postgres.ParsedOptions) => {
      // end() does not cancel the driver's scheduled reconnect callback.
      if (retired) return Promise.reject(new Error('Search SQL slot is retired.'));
      const socket = Object.assign(new SearchSocket(), {
        host: parsed.host[0], port: parsed.port[0], ssl: parsed.ssl,
      });
      sockets.add(socket); // Own even sockets whose connect has not completed.
      void socket.transportClosed.then(() => sockets.delete(socket));
      return new Promise<Duplex>((resolve, reject) => {
        const timer = setTimeout(() => socket.destroy(new Error('Search SQL connect timed out.')), 2_000);
        const closedBeforeConnect = () => {
          clearTimeout(timer);
          reject(new Error('Search SQL connection closed before connecting.'));
        };
        socket.once('close', closedBeforeConnect);
        socket.once('error', error => { clearTimeout(timer); reject(error); });
        socket.once('connect', () => {
          clearTimeout(timer);
          socket.removeListener('close', closedBeforeConnect);
          if (retired) {
            const error = new Error('Search SQL slot is retired.');
            socket.destroy(error);
            reject(error);
          } else {
            // Keep the driver's TLS wrapper on a duplex transport rather than
            // transferring the raw fd. Cancellation then closes the owned TCP
            // stream without leaving TLS with an invalid native descriptor.
            resolve(Object.assign(Duplex.from({ readable: socket, writable: socket }), {
              host: parsed.host[0], port: parsed.port[0], ssl: parsed.ssl,
            }));
          }
        });
        // The driver still performs its normal TLS negotiation/authentication.
        // host is retained for SNI, and parsed.path retains Unix-socket semantics.
        try {
          if (parsed.path) socket.connect(parsed.path);
          else socket.connect(parsed.port[0], parsed.host[0]);
        } catch (error) {
          clearTimeout(timer);
          socket.destroy();
          reject(error);
        }
      });
    },
  };
  const sql = postgres(connectionString!, options);
  // The driver's implicit array-catalog query has an uncaught rejection path on
  // disconnect. Search uses only explicitly cast text[]/uuid[] inputs and returns
  // collections as JSON/JSONB; register their serializers without startup SQL.
  const serializeArray = (values: readonly string[]) => '{' + values.map(value =>
    '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"',
  ).join(',') + '}';
  sql.options.serializers[1009] = serializeArray; // text[]
  sql.options.serializers[2951] = serializeArray; // uuid[]
  return {
    sql,
    get disposal() { return disposal; },
    destroy(): Promise<void> {
      if (disposal) return disposal;
      retired = true;
      return disposal = (async () => {
        // The driver owns the TLS wrapper. Let it terminate that wrapper before
        // closing its underlying transport, otherwise TLS can write to a dead fd.
        try { await sql.end({ timeout: 0 }); }
        finally {
          await Promise.all([...sockets].map(socket => {
            socket.destroy();
            return socket.transportClosed;
          }));
        }
      })();
    },
  };
}
