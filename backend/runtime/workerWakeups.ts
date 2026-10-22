import postgres from 'postgres';
import { WorkerSupervisor } from './workerSupervisor.js';

/** LISTEN requires a direct/session PostgreSQL connection, never transaction pooling. */
export class WorkerWakeups {
  private client?: ReturnType<typeof postgres>;
  private stopped = false;
  private ready = false;
  private starting?: Promise<void>;

  constructor(
    private readonly supervisor: WorkerSupervisor,
    private readonly databaseUrl = process.env.OUTBOX_LISTEN_DATABASE_URL ?? process.env.DATABASE_URL!,
  ) {}

  async start(): Promise<void> {
    if (this.ready || this.stopped) return;
    if (this.starting) return this.starting;
    const previous = this.client;
    this.client = undefined;
    // Use one session and explicit LISTEN rather than sql.listen's hidden
    // auto-reconnecting pool. Owning reconnection here makes shutdown bounded.
    // onnotify is supported by postgres.js parseOptions/connection handling;
    // it is absent from its Options declaration, so retain the structural type.
    const options = {
      max: 1, prepare: false, connect_timeout: 3, idle_timeout: 0, max_lifetime: null,
      connection: { application_name: 'weave-worker-wakeups',statement_timeout: 3000 },
      onnotify: (channel: string) => {
        if (!this.stopped && this.client === client) {
          if (channel === 'weave_ml_outbox') this.supervisor.wake('ml-outbox');
          if (channel === 'weave_feed_prewarm') this.supervisor.wake('feed-prewarm');
        }
      },
      onclose: () => {
        if (!this.stopped && this.client === client) {
          const wasReady = this.ready;
          this.ready = false;
          if (wasReady) this.supervisor.wake('outbox-notification-listener');
        }
      },
    };
    const client = postgres(this.databaseUrl, options);
    this.client = client;
    this.starting = (async () => {
      await previous?.end({ timeout: 1 });
      await client`LISTEN weave_ml_outbox`;
      await client`LISTEN weave_feed_prewarm`;
      this.ready = true;
      // Drain durable work whose notification was lost before subscription.
      if (!this.stopped) {
        this.supervisor.wake('ml-outbox');
        this.supervisor.wake('feed-prewarm');
      }
    })().catch(async error => {
      await client.end({ timeout: 1 });
      if (this.client === client) this.client = undefined;
      throw error;
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.starting?.catch(() => {});
    await this.client?.end({ timeout: 1 });
  }
}
