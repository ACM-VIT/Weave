import { sqlClient } from '../db/index.js';

/** Best-effort acceleration. SQL polling must continue even if LISTEN is unavailable. */
export class PostgresWorkerWakeup {
  private active = false;
  private subscription?: Awaited<ReturnType<typeof sqlClient.listen>>;

  constructor(private readonly channel: string, private readonly wake: () => void) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    const wake = () => { if (this.active) this.wake(); };
    // postgres-js reconnects its dedicated listening connection and invokes
    // onlisten again. Catch up immediately, including work committed while it
    // was disconnected or before the initial subscription became ready.
    void sqlClient.listen(this.channel, wake, wake).then((subscription) => {
      if (this.active) this.subscription = subscription;
      else void subscription.unlisten().catch(() => {});
    }).catch((error: unknown) => {
      console.error(`[WorkerWakeup:${this.channel}] LISTEN unavailable; polling remains active:`, error);
    });
  }

  stop(): void {
    this.active = false;
    // Do not make shutdown wait for a disconnected listener to reconnect.
    // sqlClient.end() also closes the underlying listening connection.
    if (this.subscription) void this.subscription.unlisten().catch(() => {});
    this.subscription = undefined;
  }
}
