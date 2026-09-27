import type { QueryRequest, QueryResponse } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import type { QueryClient } from '../lib/api.ts';
import { createBatchRunner } from './batch.svelte.ts';

/** The runner's own half of invariant 1: an identical run never re-sends. */

const RESPONSE: QueryResponse = {
  results: {},
  meta: { generatedInMs: 1, dataVersion: 1, windows: [] },
};

const request = (preset: '7d' | '30d'): QueryRequest => ({
  site: 1,
  range: { preset },
  queries: [{ id: 'kpis', metrics: ['visitors'] }],
});

function recordingClient(): {
  client: QueryClient;
  sent: QueryRequest[];
  aborted: () => number;
  settle: () => Promise<void>;
} {
  const sent: QueryRequest[] = [];
  const signals: AbortSignal[] = [];
  const waiting: Array<() => void> = [];
  return {
    sent,
    aborted: () => signals.filter((signal) => signal.aborted).length,
    settle: async () => {
      for (const resolve of waiting.splice(0)) resolve();
      await new Promise((done) => setTimeout(done, 0));
    },
    client: {
      query: (body, options) => {
        sent.push(body);
        if (options?.signal !== undefined) signals.push(options.signal);
        return new Promise((resolve) => waiting.push(() => resolve(RESPONSE)));
      },
    },
  };
}

describe('BatchRunner', () => {
  it('folds a run of the request already in flight into it, compared by value', () => {
    const { client, sent, aborted } = recordingClient();
    const runner = createBatchRunner(client);
    runner.run(request('30d'));
    runner.run(request('30d'));
    runner.run(structuredClone(request('30d')));
    expect(sent).toHaveLength(1);
    expect(aborted()).toBe(0);
  });

  it('still aborts the older batch for a different state', () => {
    const { client, sent, aborted } = recordingClient();
    const runner = createBatchRunner(client);
    runner.run(request('30d'));
    runner.run(request('7d'));
    expect(sent).toHaveLength(2);
    expect(aborted()).toBe(1);
  });

  it('re-sends once the identical request has landed — a rollover re-run is a new batch', async () => {
    const { client, sent, settle } = recordingClient();
    const runner = createBatchRunner(client);
    runner.run(request('30d'));
    await settle();
    runner.run(request('30d'));
    expect(sent).toHaveLength(2);
  });

  it('refreshes unconditionally: a revalidation may not ride a batch that predates its tick', () => {
    const { client, sent, aborted } = recordingClient();
    const runner = createBatchRunner(client);
    runner.run(request('30d'));
    runner.refresh();
    expect(sent).toHaveLength(2);
    expect(aborted()).toBe(1);
  });
});
