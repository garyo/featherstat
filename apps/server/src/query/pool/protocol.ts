import type { QueryRequest, QueryResponse } from '@featherstat/shared';

/**
 * The wire between the pool and its workers. Everything here must survive
 * structured clone: requests are zod-validated JSON and responses carry only
 * strings/numbers/nulls/string[] rows, so nothing needs serializing by hand.
 */

export interface WorkerInit {
  /** File-backed only: a worker cannot share a `:memory:` database. */
  dbPath: string;
}

export type PoolJob =
  | {
      id: number;
      kind: 'query';
      request: QueryRequest;
      now: number;
      /** The principal's readable sites — resolved on main, enforced in execution. */
      allowedSites?: readonly number[];
    }
  /** Test/diagnostic aid: proves execution happens off the main thread. */
  | { id: number; kind: 'ping' };

export type PoolReply =
  | { id: number; ok: true; result: QueryResponse | { threadId: number } }
  | { id: number; ok: false; error: string };
