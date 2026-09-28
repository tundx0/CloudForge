export type Execute = (id: string, signal: AbortSignal) => Promise<void>;

export type SchedulerOptions = {
  /** Most tasks running at once. */
  concurrency: number;
  /** Most tasks waiting to start. Reservations beyond this are refused. */
  maxQueued: number;
  execute: Execute;
  /** Called when `execute` rejects. It should record the failure; it must not throw. */
  onError: (id: string, err: unknown) => void | Promise<void>;
};

export type SchedulerStats = {
  running: number;
  queued: number;
  concurrency: number;
  maxQueued: number;
  accepting: boolean;
};

/**
 * A claim on one queue slot, taken before any async work so that two
 * concurrent requests cannot both pass a "queue has room" check.
 */
export type Reservation = {
  /** Consumes the slot and queues `id`. */
  enqueue(id: string): void;
  /** Gives the slot back, e.g. when creating the job failed. */
  release(): void;
};

type Running = { promise: Promise<void>; controller: AbortController };

/**
 * Runs at most `concurrency` tasks at once, in FIFO order, with a bounded
 * waiting line. In-process only: see docs/adr/0002-in-process-scheduler.md.
 */
export class BuildScheduler {
  private readonly waiting: string[] = [];
  private readonly running = new Map<string, Running>();
  private reserved = 0;
  private accepting = true;

  constructor(private readonly options: SchedulerOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error("concurrency must be a positive integer");
    }
    if (!Number.isInteger(options.maxQueued) || options.maxQueued < 0) {
      throw new Error("maxQueued must be a non-negative integer");
    }
  }

  /** Returns undefined when the queue is full or the scheduler is shutting down. */
  reserve(): Reservation | undefined {
    if (!this.accepting || this.waiting.length + this.reserved >= this.options.maxQueued) {
      return undefined;
    }
    this.reserved += 1;
    let used = false;
    const consume = () => {
      if (used) {
        return false;
      }
      used = true;
      this.reserved -= 1;
      return true;
    };
    return {
      enqueue: (id) => {
        if (consume()) {
          this.push(id);
        }
      },
      release: () => {
        consume();
      },
    };
  }

  /**
   * Queues without checking capacity. For startup recovery, where the work was
   * already accepted before a restart and must not be dropped.
   */
  enqueueRecovered(id: string): void {
    this.push(id);
  }

  stats(): SchedulerStats {
    return {
      running: this.running.size,
      queued: this.waiting.length,
      concurrency: this.options.concurrency,
      maxQueued: this.options.maxQueued,
      accepting: this.accepting,
    };
  }

  /**
   * Stops accepting and starting work, waits up to `graceMs` for running tasks,
   * then aborts the rest and waits for them to wind down. Queued tasks are left
   * where they are; with a durable store they are picked up on the next start.
   */
  async shutdown(graceMs: number): Promise<{ aborted: string[] }> {
    this.accepting = false;
    const all = () => Promise.allSettled([...this.running.values()].map((r) => r.promise));

    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      all().then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), graceMs);
      }),
    ]);
    clearTimeout(timer);

    const aborted = timedOut ? [...this.running.keys()] : [];
    for (const id of aborted) {
      this.running.get(id)?.controller.abort(new Error("interrupted by shutdown"));
    }
    await all();
    return { aborted };
  }

  private push(id: string): void {
    if (this.waiting.includes(id) || this.running.has(id)) {
      return;
    }
    this.waiting.push(id);
    this.pump();
  }

  private pump(): void {
    while (
      this.accepting &&
      this.running.size < this.options.concurrency &&
      this.waiting.length > 0
    ) {
      const id = this.waiting.shift()!;
      const controller = new AbortController();
      const promise = this.run(id, controller.signal).finally(() => {
        this.running.delete(id);
        this.pump();
      });
      this.running.set(id, { promise, controller });
    }
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    try {
      await this.options.execute(id, signal);
    } catch (err) {
      try {
        await this.options.onError(id, err);
      } catch {
        // onError is the last line of defence; nothing useful is left to do.
      }
    }
  }
}
