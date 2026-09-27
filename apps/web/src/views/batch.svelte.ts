import type { QueryRequest, QueryResponse } from '@featherstat/shared';
import { canonicalJson, type QueryClient } from '../lib/api.ts';

/**
 * One in-flight batch per view: a newer run aborts the older, the last response
 * wins, and the previous response is held while refetching so the view dims
 * instead of blanking (docs/05: no skeletons, no layout shift). A run of the
 * request already in flight is folded into it rather than re-sent.
 */
export interface BatchRunner {
  readonly response: QueryResponse | undefined;
  /** Latest batch-level failure; cleared by the next success. */
  readonly error: string | undefined;
  /** The request `response` answers — what is actually on screen after a failure. */
  readonly held: QueryRequest | undefined;
  /**
   * True when the latest failure was for a different view state than the held
   * response shows — a user-initiated change that never landed, not a live
   * revalidation of what is already visible.
   */
  readonly stale: boolean;
  /** True while a re-issue is in flight over a held previous response. */
  readonly refetching: boolean;
  /** Issues `request` — unless the same request (by value) is already in flight. */
  run(request: QueryRequest): void;
  /**
   * Re-issues the last request unconditionally. The recovery path after a
   * failure (re-selecting the same state re-derives nothing, so would never
   * retry), and the revalidation after a data tick — which must not fold into an
   * identical request in flight, because that one may predate the tick.
   */
  refresh(): void;
}

export function createBatchRunner(client: QueryClient): BatchRunner {
  let response = $state<QueryResponse | undefined>(undefined);
  let held = $state<QueryRequest | undefined>(undefined);
  let error = $state<string | undefined>(undefined);
  let stale = $state(false);
  let busy = $state(false);
  // Plain counters: `run` executes inside view $effects, so its synchronous path
  // must only ever WRITE reactive state — reading any would make the effect
  // depend on it and re-issue the batch forever.
  let pending = 0;
  let controller: AbortController | undefined;
  let seq = 0;
  let last: QueryRequest | undefined;
  /** Canonical body of the request in flight; undefined when none is. */
  let inFlight: string | undefined;

  const execute = (request: QueryRequest, body: string): void => {
    controller?.abort();
    const mine = ++seq;
    const own = new AbortController();
    controller = own;
    inFlight = body;
    pending += 1;
    busy = true;
    client
      .query(request, { signal: own.signal })
      .then((result) => {
        if (seq !== mine) return;
        response = result;
        held = request;
        error = undefined;
        stale = false;
      })
      .catch((cause: unknown) => {
        if (seq !== mine || own.signal.aborted) return;
        error = cause instanceof Error ? cause.message : String(cause);
        // By value, not reference: switching away and back yields a fresh object
        // for the same state, which is not stale.
        stale = held === undefined || canonicalJson(request) !== canonicalJson(held);
      })
      .finally(() => {
        if (seq === mine) inFlight = undefined;
        pending -= 1;
        if (pending === 0) busy = false;
      });
  };

  return {
    get response() {
      return response;
    },
    get error() {
      return error;
    },
    get held() {
      return held;
    },
    get stale() {
      return stale;
    },
    get refetching() {
      return busy && response !== undefined;
    },
    run(request) {
      const body = canonicalJson(request);
      if (body === inFlight) return;
      last = request;
      execute(request, body);
    },
    refresh() {
      if (last !== undefined) execute(last, canonicalJson(last));
    },
  };
}
