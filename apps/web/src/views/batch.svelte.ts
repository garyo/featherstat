import type { QueryRequest, QueryResponse } from '@analytics/shared';
import { canonicalJson, type QueryClient } from '../lib/api.ts';

/**
 * One in-flight batch per view: a newer run aborts the older, the last response
 * wins, and the previous response is held while refetching so the view dims
 * instead of blanking (docs/05: no skeletons, no layout shift).
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
  run(request: QueryRequest): void;
  /**
   * Re-runs the last request. The recovery path after a failure: the view's
   * $effect only re-issues when its derived request changes, so re-selecting the
   * same state would otherwise never retry.
   */
  retry(): void;
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

  const execute = (request: QueryRequest): void => {
    controller?.abort();
    const mine = ++seq;
    const own = new AbortController();
    controller = own;
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
      last = request;
      execute(request);
    },
    retry() {
      if (last !== undefined) execute(last);
    },
  };
}
