import { parentPort, threadId, workerData } from 'node:worker_threads';
import BetterSqlite3 from 'better-sqlite3';
import { executeQueryRequest } from '../executor.ts';
import type { PoolJob, PoolReply, WorkerInit } from './protocol.ts';

/**
 * Pool worker entry: one read-only connection, jobs in, responses out.
 *
 * The whole batch executes here, inside the executor's own read snapshot, so
 * "one batch = one instant" survives the move off the main thread unchanged —
 * and `meta.dataVersion` is read inside that snapshot, naming the executed
 * instant for the route's ETag re-derivation. A read-only connection cannot
 * take the write lock, so the single-writer discipline (invariant 2) is
 * enforced by SQLite itself on this thread, not just by convention.
 */

const port = parentPort;
if (port === null) throw new Error('query pool worker must be started as a worker thread');

const { dbPath } = workerData as WorkerInit;
const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });

port.on('message', (job: PoolJob) => {
  let reply: PoolReply;
  try {
    reply =
      job.kind === 'ping'
        ? { id: job.id, ok: true, result: { threadId } }
        : {
            id: job.id,
            ok: true,
            result: executeQueryRequest(db, job.request, {
              now: job.now,
              allowedSites: job.allowedSites,
              derived: job.derived,
            }),
          };
  } catch (error) {
    reply = {
      id: job.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  port.postMessage(reply);
});
