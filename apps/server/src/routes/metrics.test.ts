import { describe, expect, it } from 'vitest';
import { event, openTestDb } from '../../test/rows.ts';
import { insertEvents, withWriteTransaction } from '../db/index.ts';
import { createMetricsRoutes, METRICS_CONTENT_TYPE, Metrics } from './metrics.ts';

const flush = { events: 3, sessions: 1, botDrops: 2, excludedDrops: 0, missing: 0, siteIds: [1] };

describe('Metrics registry', () => {
  it('accumulates ingest counters from flush summaries', () => {
    const metrics = new Metrics();
    metrics.recordFlush(flush);
    metrics.recordFlush({ ...flush, events: 1, botDrops: 0, missing: 5 });
    const text = metrics.render(undefined);
    expect(text).toContain('analytics_ingest_hits_total 4');
    expect(text).toContain('analytics_ingest_bot_drops_total 2');
    expect(text).toContain('analytics_ingest_missing_total 5');
  });

  it('tracks duration summaries as sum/count/max', () => {
    const metrics = new Metrics();
    for (const ms of [2, 10, 4]) metrics.query.observe(ms);
    const text = metrics.render(undefined);
    expect(text).toContain('analytics_query_duration_ms_sum 16');
    expect(text).toContain('analytics_query_duration_ms_count 3');
    expect(text).toContain('analytics_query_duration_ms_max 10');
  });

  it('gauges SSE clients up and down', () => {
    const metrics = new Metrics();
    metrics.sseOpened();
    metrics.sseOpened();
    metrics.sseClosed();
    expect(metrics.render(undefined)).toContain('analytics_sse_clients 1');
  });

  it('reads DB gauges at scrape time', () => {
    const db = openTestDb();
    withWriteTransaction(db, () => insertEvents(db, [event(), event({ seq: 2 })]));
    const metrics = new Metrics();
    const text = metrics.render(db);
    expect(text).toContain('analytics_events_rows 2');
    expect(text).toMatch(/analytics_db_size_bytes [1-9]\d*\n/);
    db.close();
  });

  it('renders well-formed exposition: HELP/TYPE per family, trailing newline', () => {
    const text = new Metrics().render(undefined);
    expect(text.endsWith('\n')).toBe(true);
    for (const family of [
      ['analytics_ingest_hits_total', 'counter'],
      ['analytics_flush_duration_ms', 'summary'],
      ['analytics_sse_clients', 'gauge'],
    ]) {
      expect(text).toContain(`# HELP ${family[0]} `);
      expect(text).toContain(`# TYPE ${family[0]} ${family[1]}`);
    }
  });
});

describe('GET /metrics', () => {
  it('is a 404 when no token is configured — never silently public', async () => {
    for (const token of [undefined, '']) {
      const app = createMetricsRoutes({ metrics: new Metrics(), token });
      expect((await app.request('/metrics')).status).toBe(404);
      const withHeader = await app.request('/metrics', {
        headers: { authorization: 'Bearer anything' },
      });
      expect(withHeader.status).toBe(404);
    }
  });

  it('rejects missing, malformed and wrong bearer tokens', async () => {
    const app = createMetricsRoutes({ metrics: new Metrics(), token: 'sekrit' });
    const attempts: Record<string, string>[] = [
      {},
      { authorization: 'sekrit' },
      { authorization: 'Bearer wrong' },
      { authorization: 'Bearer sekrit-but-longer' },
      { authorization: 'Basic sekrit' },
      // The scheme folds; the credential does not (RFC 7235).
      { authorization: 'bearer SEKRIT' },
    ];
    for (const headers of attempts) {
      const res = await app.request('/metrics', { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  // The auth-scheme is a case-insensitive token (RFC 7235), so every spelling of
  // `Bearer` is the same scheme — a lowercase one is not unauthorized.
  it.each(['Bearer', 'bearer', 'BEARER', 'BeArEr'])(
    'serves the exposition to the right bearer, spelled %s',
    async (scheme) => {
      const app = createMetricsRoutes({ metrics: new Metrics(), token: 'sekrit' });
      const res = await app.request('/metrics', {
        headers: { authorization: `${scheme} sekrit` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(METRICS_CONTENT_TYPE);
      expect(await res.text()).toContain('analytics_ingest_hits_total 0');
    },
  );
});
