import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';

export interface WorkerStatus {
  running: boolean;
  runs: number;
  failures: number;
  last_started_at: string | null;
  last_completed_at: string | null;
  last_error: string | null;
}

interface Task {
  name: string;
  intervalMs: number;
  activeIntervalMs?: number;
  idleIntervalMs?: number;
  run: () => Promise<unknown>;
  timer?: NodeJS.Timeout;
  wakeRequested?: boolean;
  status: WorkerStatus;
}

export class WorkerSupervisor {
  private readonly tasks: Task[] = [];
  private started = false;

  register(name: string, intervalMs: number, run: () => Promise<unknown>): void {
    this.tasks.push({
      name,
      intervalMs,
      run,
      status: {
        running: false,
        runs: 0,
        failures: 0,
        last_started_at: null,
        last_completed_at: null,
        last_error: null,
      },
    });
  }

  registerAdaptive(
    name: string,
    activeIntervalMs: number,
    idleIntervalMs: number,
    run: () => Promise<number>,
  ): void {
    if (activeIntervalMs <= 0 || idleIntervalMs < activeIntervalMs) {
      throw new Error('Adaptive worker intervals must be positive and idle must be at least active.');
    }
    this.tasks.push({
      name,
      intervalMs: idleIntervalMs,
      activeIntervalMs,
      idleIntervalMs,
      run,
      status: {
        running: false,
        runs: 0,
        failures: 0,
        last_started_at: null,
        last_completed_at: null,
        last_error: null,
      },
    });
  }

  private async execute(task: Task): Promise<unknown> {
    if (task.status.running) return undefined;
    task.status.running = true;
    task.status.last_started_at = new Date().toISOString();
    try {
      const result = await task.run();
      task.status.runs++;
      task.status.last_error = null;
      return result;
    } catch (error) {
      task.status.failures++;
      task.status.last_error = error instanceof Error ? error.message : String(error);
      console.error(`[Worker:${task.name}] run failed:`, error);
      return undefined;
    } finally {
      task.status.running = false;
      task.status.last_completed_at = new Date().toISOString();
    }
  }

  private scheduleAdaptive(task: Task, delay: number): void {
    if (task.timer) clearTimeout(task.timer);
    const timer = setTimeout(
      () => void this.runAdaptive(task), delay,
    ) as unknown as NodeJS.Timeout;
    timer.unref();
    task.timer = timer;
  }

  private async runAdaptive(task: Task): Promise<void> {
    if (!this.started) return;
    if (task.status.running) { task.wakeRequested = true; return; }
    task.timer = undefined;
    task.wakeRequested = false;
    const result = await this.execute(task);
    if (!this.started) return;
    this.scheduleAdaptive(task, task.wakeRequested ? 0
      : typeof result === 'number' && result > 0 ? task.activeIntervalMs! : task.idleIntervalMs!);
  }

  /** Coalesce hints, including those arriving while a run is in progress. */
  wake(name: string): void {
    if (!this.started) return;
    const task = this.tasks.find((candidate) => candidate.name === name);
    if (!task || task.activeIntervalMs === undefined) return;
    if (task.wakeRequested) return;
    task.wakeRequested = true;
    if (!task.status.running) this.scheduleAdaptive(task, 0);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const task of this.tasks) {
      if (task.activeIntervalMs !== undefined) {
        void this.runAdaptive(task);
        continue;
      }
      void this.execute(task);
      // The backend runs on Node, but transitive React Native DOM globals make
      // TypeScript select the browser numeric overload for setInterval.
      const timer = setInterval(
        () => void this.execute(task),
        task.intervalMs,
      ) as unknown as NodeJS.Timeout;
      timer.unref();
      task.timer = timer;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const task of this.tasks) {
      task.wakeRequested = false;
      if (!task.timer) continue;
      if (task.activeIntervalMs === undefined) clearInterval(task.timer);
      else clearTimeout(task.timer);
      task.timer = undefined;
    }
    while (this.tasks.some((task) => task.status.running)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  snapshot(): Record<string, WorkerStatus> {
    return Object.fromEntries(this.tasks.map((task) => [task.name, { ...task.status }]));
  }
}
