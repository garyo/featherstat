import { parentPort, threadId } from 'node:worker_threads';

/**
 * Test rigging for pool.test.ts ONLY — a worker that misbehaves on command.
 * The real worker (worker.ts) has no sleep/crash surface; the failure paths
 * (timeout, crash, saturation) are properties of the POOL, so they are
 * exercised through a worker whose failures are deterministic.
 */

type FixtureJob =
  | { id: number; kind: 'ping' }
  | { id: number; kind: 'sleep'; ms: number }
  | { id: number; kind: 'crash' };

const port = parentPort;
if (port === null) throw new Error('fixture worker must be started as a worker thread');

port.on('message', (job: FixtureJob) => {
  if (job.kind === 'crash') process.exit(1);
  if (job.kind === 'sleep') {
    // A synchronous stall — exactly what a wedged query looks like to the pool.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, job.ms);
    port.postMessage({ id: job.id, ok: true, result: { slept: job.ms } });
    return;
  }
  port.postMessage({ id: job.id, ok: true, result: { threadId } });
});
