import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { countEvents, type Db, databaseSizeBytes } from '../db/index.ts';
import type { FlushSummary } from '../pipeline/batcher.ts';

/**
 * Hand-rolled Prometheus exposition (docs/01 R15) — the text format is four
 * line shapes; a client library would be the only dependency it replaced.
 *
 * `GET /metrics` is bearer-token gated: without METRICS_TOKEN configured it is
 * a 404, never silently public (docs/02 § Security posture).
 */

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Running count/sum/max — enough for rate and average panels without quantile math. */
class DurationSummary {
  count = 0;
  sum = 0;
  max = 0;

  observe(ms: number): void {
    this.count += 1;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }
}

export class Metrics {
  private hits = 0;
  private botDrops = 0;
  private sseClients = 0;
  private rollupRepairs = 0;
  readonly flush = new DurationSummary();
  readonly query = new DurationSummary();

  /** Feed from `pipeline.onFlush` — the stored-hit and bot-drop counters. */
  recordFlush(summary: FlushSummary): void {
    this.hits += summary.events;
    this.botDrops += summary.botDrops;
  }

  /** Feed from the nightly reconcile job: nonzero means a delta-logic bug fired. */
  recordRollupRepairs(days: number): void {
    this.rollupRepairs += days;
  }

  sseOpened(): void {
    this.sseClients += 1;
  }

  sseClosed(): void {
    this.sseClients -= 1;
  }

  /** The whole exposition; DB gauges are read at scrape time. */
  render(db: Db | undefined): string {
    const lines = [
      ...counter('analytics_ingest_hits_total', 'Hits stored since process start.', this.hits),
      ...counter(
        'analytics_ingest_bot_drops_total',
        'Hits dropped as bot traffic since process start.',
        this.botDrops,
      ),
      ...summary('analytics_flush_duration_ms', 'Write-batch flush transaction time.', this.flush),
      ...summary('analytics_query_duration_ms', 'POST /api/query handling time.', this.query),
      ...counter(
        'analytics_rollup_repairs_total',
        'Rollup site-days the nightly reconcile found drifted and rebuilt.',
        this.rollupRepairs,
      ),
      ...gauge('analytics_sse_clients', 'Open realtime SSE connections.', this.sseClients),
    ];
    if (db !== undefined) {
      lines.push(
        ...gauge('analytics_events_rows', 'Rows in the events table.', countEvents(db)),
        ...gauge(
          'analytics_db_size_bytes',
          'SQLite database size in bytes.',
          databaseSizeBytes(db),
        ),
      );
    }
    return `${lines.join('\n')}\n`;
  }
}

export interface MetricsRoutesOptions {
  metrics: Metrics;
  db?: Db;
  /** Unset disables the endpoint entirely (404). */
  token?: string;
}

export function createMetricsRoutes({ metrics, db, token }: MetricsRoutesOptions): Hono {
  const app = new Hono();
  app.get('/metrics', (c) => {
    if (token === undefined || token === '') {
      return c.text('metrics are disabled — set METRICS_TOKEN', 404);
    }
    if (!bearerMatches(c.req.header('authorization'), token)) {
      return c.text('unauthorized', 401, { 'WWW-Authenticate': 'Bearer' });
    }
    return c.text(metrics.render(db), 200, { 'Content-Type': METRICS_CONTENT_TYPE });
  });
  return app;
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function counter(name: string, help: string, value: number): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name} ${value}`];
}

function gauge(name: string, help: string, value: number): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`];
}

function summary(name: string, help: string, durations: DurationSummary): string[] {
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} summary`,
    `${name}_sum ${durations.sum}`,
    `${name}_count ${durations.count}`,
    ...gauge(`${name}_max`, `${help} (max since start)`, durations.max),
  ];
}
