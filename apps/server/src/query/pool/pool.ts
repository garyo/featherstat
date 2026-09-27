import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { QueryRequest, QueryResponse } from '@featherstat/shared';
import type { GoalDefinitions } from '../goals.ts';
import type { PoolJob, PoolReply, WorkerInit } from './protocol.ts';

/**
 * The read pool (docs/02): query batches execute on worker threads with their
 * own read-only connections, so a slow 90-day scan never blocks the event loop
 * that answers beacons (invariant 4). WAL already permits concurrent readers;
 * this moves the reader, not the discipline — the main thread keeps the one
 * writer, workers cannot write at all.
 *
 * The main thread still does everything except execute: parse, validate,
 * window resolution, rate limiting, the ETag pre-check. What crosses the wire
 * is the validated request; what comes back is the finished response.
 */

/** A saturated pool answers like a rate limit, not like a crash. */
export class PoolSaturatedError extends Error {}

export interface QueryPoolOptions {
  /** Worker count; defaults to min(4, availableParallelism() - 1), floor 1. */
  size?: number;
  /** Per-job wall clock before the worker is presumed wedged and replaced. */
  timeoutMs?: number;
  /** Queued (not yet running) jobs beyond this are refused; the route 429s. */
  maxQueue?: number;
  /** Worker entry override; the bundled server points this at its own file. */
  workerUrl?: URL;
  /** Node CLI flags for workers; defaults to inheriting this process's. */
  execArgv?: string[];
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_QUEUE = 64;

interface Job {
  message: PoolJob;
  resolve: (reply: PoolReply) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  /** The job this worker is running, with its watchdog. */
  running?: { job: Job; timer: NodeJS.Timeout };
}

/** Resolves once `job` settles either way, without disturbing its own caller. */
function settled(job: Job): Promise<void> {
  return new Promise((resolve) => {
    const { resolve: reply, reject } = job;
    job.resolve = (value) => {
      reply(value);
      resolve();
    };
    job.reject = (error) => {
      reject(error);
      resolve();
    };
  });
}

export class QueryPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly dbPath: string;
  private readonly options: Required<Pick<QueryPoolOptions, 'timeoutMs' | 'maxQueue'>> &
    Pick<QueryPoolOptions, 'workerUrl' | 'execArgv'>;
  private nextId = 1;
  private closed = false;

  constructor(dbPath: string, options: QueryPoolOptions = {}) {
    this.dbPath = dbPath;
    this.options = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxQueue: options.maxQueue ?? DEFAULT_MAX_QUEUE,
      workerUrl: options.workerUrl,
      execArgv: options.execArgv,
    };
    const size = options.size ?? Math.max(1, Math.min(4, availableParallelism() - 1));
    for (let i = 0; i < size; i++) this.slots.push({ worker: this.spawn() });
  }

  get size(): number {
    return this.slots.length;
  }

  async execute(
    request: QueryRequest,
    now: number,
    allowedSites?: readonly number[],
    derived?: Readonly<Record<string, string>>,
    goals?: GoalDefinitions,
  ): Promise<QueryResponse> {
    const reply = await this.submit({
      id: this.nextId++,
      kind: 'query',
      request,
      now,
      ...(allowedSites === undefined ? {} : { allowedSites }),
      ...(derived === undefined ? {} : { derived }),
      ...(goals === undefined ? {} : { goals }),
    });
    if (!reply.ok) throw new Error(reply.error);
    return reply.result as QueryResponse;
  }

  /** Answers with the executing thread's id — the proof queries leave main. */
  async ping(): Promise<number> {
    const reply = await this.submit({ id: this.nextId++, kind: 'ping' });
    if (!reply.ok) throw new Error(reply.error);
    return (reply.result as { threadId: number }).threadId;
  }

  /**
   * Stops accepting work, gives in-flight jobs up to `graceMs` to settle — a
   * reply, a crash or their own watchdog, whichever comes first — then
   * terminates every worker, which rejects whatever is still running.
   * Queued-but-unstarted jobs are rejected at once: the client retries against
   * whatever replaces this process.
   */
  async close(graceMs: number = this.options.timeoutMs): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error('query pool is shutting down'));
    const inFlight = this.slots.flatMap((slot) =>
      slot.running === undefined ? [] : [settled(slot.running.job)],
    );
    if (inFlight.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      // Ref'd on purpose, unlike the watchdogs: a shutdown awaiting this must
      // not see the process exit from under it with nothing left holding it open.
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      });
      await Promise.race([Promise.all(inFlight), grace]);
      clearTimeout(timer);
    }
    await Promise.allSettled(this.slots.map((slot) => slot.worker.terminate()));
  }

  private submit(message: PoolJob): Promise<PoolReply> {
    if (this.closed) return Promise.reject(new Error('query pool is closed'));
    const idle = this.slots.some((slot) => slot.running === undefined);
    if (!idle && this.queue.length >= this.options.maxQueue) {
      return Promise.reject(new PoolSaturatedError('query pool queue is full'));
    }
    return new Promise<PoolReply>((resolve, reject) => {
      this.queue.push({ message, resolve, reject });
      this.dispatch();
    });
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (slot.running !== undefined) continue;
      const job = this.queue.shift();
      if (job === undefined) return;
      const timer = setTimeout(() => this.replaceWedged(slot), this.options.timeoutMs);
      timer.unref();
      slot.running = { job, timer };
      slot.worker.postMessage(job.message);
    }
  }

  private spawn(): Worker {
    const url = this.options.workerUrl ?? new URL('./worker.ts', import.meta.url);
    const workerData: WorkerInit = { dbPath: this.dbPath };
    const worker = new Worker(url, {
      workerData,
      ...(this.options.execArgv === undefined ? {} : { execArgv: this.options.execArgv }),
    });
    worker.unref(); // idle workers never hold the process open
    worker.on('message', (reply: PoolReply) => this.settle(worker, reply));
    worker.on('error', (error) =>
      this.replaceCrashed(worker, error instanceof Error ? error : new Error(String(error))),
    );
    worker.on('exit', (code) => {
      if (code !== 0) this.replaceCrashed(worker, new Error(`query worker exited with ${code}`));
    });
    return worker;
  }

  private settle(worker: Worker, reply: PoolReply): void {
    const slot = this.slots.find((s) => s.worker === worker);
    if (slot?.running === undefined) return;
    clearTimeout(slot.running.timer);
    const { job } = slot.running;
    slot.running = undefined;
    job.resolve(reply);
    this.dispatch();
  }

  private replaceCrashed(worker: Worker, error: Error): void {
    const slot = this.slots.find((s) => s.worker === worker);
    if (slot === undefined) return;
    const running = slot.running;
    slot.running = undefined;
    if (running !== undefined) {
      clearTimeout(running.timer);
      running.job.reject(error);
    }
    if (!this.closed) {
      slot.worker = this.spawn();
      this.dispatch();
    }
  }

  private replaceWedged(slot: Slot): void {
    const running = slot.running;
    if (running === undefined) return;
    slot.running = undefined;
    running.job.reject(new Error(`query timed out after ${this.options.timeoutMs} ms`));
    // Its listeners stay: a late reply or its exit finds no job to settle, and
    // an 'error' with no listener would throw on the main thread.
    void slot.worker.terminate();
    if (!this.closed) {
      slot.worker = this.spawn();
      this.dispatch();
    }
  }
}
