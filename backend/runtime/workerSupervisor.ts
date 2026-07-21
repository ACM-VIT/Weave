import { clearInterval, setInterval, setTimeout } from 'node:timers';

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
  run: () => Promise<unknown>;
  timer?: NodeJS.Timeout;
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

  private async execute(task: Task): Promise<void> {
    if (task.status.running) return;
    task.status.running = true;
    task.status.last_started_at = new Date().toISOString();
    try {
      await task.run();
      task.status.runs++;
      task.status.last_error = null;
    } catch (error) {
      task.status.failures++;
      task.status.last_error = error instanceof Error ? error.message : String(error);
      console.error(`[Worker:${task.name}] run failed:`, error);
    } finally {
      task.status.running = false;
      task.status.last_completed_at = new Date().toISOString();
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const task of this.tasks) {
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
    for (const task of this.tasks) if (task.timer) clearInterval(task.timer);
    while (this.tasks.some((task) => task.status.running)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  snapshot(): Record<string, WorkerStatus> {
    return Object.fromEntries(this.tasks.map((task) => [task.name, { ...task.status }]));
  }
}
