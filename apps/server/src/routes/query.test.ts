import type { QueryResponse } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { event, openTestDb, session } from '../../test/rows.ts';
import {
  createDerivedMetric,
  createSegment,
  type Db,
  insertEvents,
  updateSegment,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { createApp } from '../index.ts';
import { QUERY_BATCHES_GLOBAL, QUERY_BATCHES_PER_SESSION, QUERY_WINDOW_MS } from './query.ts';

const BODY = {
  site: 1,
  range: { from: '2023-11-14', to: '2023-11-14' },
  queries: [{ id: 'kpis', metrics: ['visitors', 'pageviews'] }],
};

let db: Db;
let app: ReturnType<typeof createApp>;

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return await app.request('/api/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  db = openTestDb();
  withWriteTransaction(db, () => {
    insertEvents(db, [event()]);
    upsertSessions(db, [session()]);
  });
  app = createApp({ db });
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('POST /api/query', () => {
  it('answers a valid batch with results and a strong ETag', async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toMatch(/^"[A-Za-z0-9_-]+"$/);
    const body = (await res.json()) as QueryResponse;
    expect(body.results.kpis).toEqual({
      rows: [{ visitors: 1, pageviews: 1 }],
      // Every metric result states what its columns count and how they compose
      // (docs/04 § 3) — once per result, never per row.
      measures: {
        visitors: { unit: 'count', population: 'actions', aggregate: 'distinct' },
        pageviews: { unit: 'count', population: 'pageviews', aggregate: 'sum' },
      },
      ms: expect.any(Number),
    });
    expect(body.meta.dataVersion).toBe(1);
  });

  /**
   * The window and the axis are pure functions of what the ETag already hashes,
   * so the body a client replays on a 304 states the same window as the 200 that
   * seeded it — which is what lets the browser stop deriving windows without
   * making a revalidation show a stale one. The clock-dependent part is `clip`,
   * and the reader's own clock overrides it (apps/web widgets/axis.ts).
   */
  it('states the window and axis it resolved, and holds them across a 304', async () => {
    const body = { ...BODY, queries: [{ ...BODY.queries[0], bucket: 'day' }] };
    const first = await post(body);
    const seeded = (await first.json()) as QueryResponse;
    expect(seeded.meta.windows).toEqual([
      { siteId: 1, timezone: 'America/New_York', from: '2023-11-14', to: '2023-11-14' },
    ]);

    const etag = first.headers.get('etag') as string;
    const revalidated = await post(body, { 'if-none-match': etag });
    expect(revalidated.status).toBe(304);
    // A 304 has no body, so what the client keeps is the seeded one — the same
    // window, and an axis it can still move to its own clock.
    const again = await post(body);
    const fresh = (await again.json()) as QueryResponse;
    expect(fresh.meta.windows).toEqual(seeded.meta.windows);
    expect(fresh.results.kpis).toMatchObject({
      bucket: 'day',
      axis: [{ siteId: 1, keys: ['2023-11-14'], clip: '2023-11-14' }],
    });
  });

  it("changes the ETag when a site's timezone changes under an explicit range", async () => {
    // The resolved window is unchanged (from/to are literal), but the axis and
    // the clip are not: they are read in the site's zone.
    const first = await post(BODY);
    const etag = first.headers.get('etag') as string;
    withWriteTransaction(db, () => {
      db.prepare("UPDATE sites SET timezone = 'Asia/Tokyo' WHERE id = 1").run();
    });
    const res = await post(BODY, { 'if-none-match': etag });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).not.toBe(etag);
  });

  it('revalidates with 304 and executes no queries', async () => {
    const first = await post(BODY);
    const etag = first.headers.get('etag');
    expect(etag).not.toBeNull();

    // Every execution enters exactly one read-snapshot transaction, so this spy
    // sees query work even when the statement cache makes `prepare` silent.
    const transaction = vi.spyOn(db, 'transaction');
    const revalidated = await post(BODY, { 'if-none-match': etag as string });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('etag')).toBe(etag);
    expect(await revalidated.text()).toBe('');
    expect(transaction).not.toHaveBeenCalled();

    // The spy has teeth: a full re-execution of the same body does register.
    const full = await post(BODY);
    expect(full.status).toBe(200);
    expect(transaction).toHaveBeenCalledTimes(1);
    transaction.mockRestore();
  });

  it('expires a preset ETag at site-local midnight even when no data changed', async () => {
    vi.useFakeTimers();
    try {
      // 12:00 in New York on the seeded day.
      vi.setSystemTime(Date.UTC(2023, 10, 14, 17));
      const body = { ...BODY, range: { preset: 'today' } };
      const first = await post(body);
      const etag = first.headers.get('etag') as string;
      const day1 = (await first.json()) as QueryResponse;
      expect(day1.results.kpis).toMatchObject({ rows: [{ visitors: 1, pageviews: 1 }] });

      // One local day later, still no new events: "today" now means an empty window.
      vi.setSystemTime(Date.UTC(2023, 10, 15, 17));
      const next = await post(body, { 'if-none-match': etag });
      expect(next.status).toBe(200);
      expect(next.headers.get('etag')).not.toBe(etag);
      const day2 = (await next.json()) as QueryResponse;
      expect(day2.results.kpis).toMatchObject({ rows: [{ visitors: 0, pageviews: 0 }] });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The rolling preset is quantized to the hour precisely so this holds: a
   * window with a moving edge would hash differently on every request and
   * revalidate nothing, which is the caching cost that pays for the feature.
   */
  it("holds the rolling '24h' ETag within the hour and expires it when the hour turns", async () => {
    vi.useFakeTimers();
    try {
      // 18:05 in New York, an hour after the seeded hit at 17:13 local.
      vi.setSystemTime(Date.UTC(2023, 10, 14, 23, 5));
      const body = { ...BODY, range: { preset: '24h' } };
      const first = await post(body);
      const etag = first.headers.get('etag') as string;
      const seeded = (await first.json()) as QueryResponse;
      expect(seeded.results.kpis).toMatchObject({ rows: [{ visitors: 1, pageviews: 1 }] });
      // The window states its own sub-day edges, so no client re-derives them.
      expect(seeded.meta.windows).toEqual([
        {
          siteId: 1,
          timezone: 'America/New_York',
          from: '2023-11-13',
          to: '2023-11-14',
          fromTs: Date.UTC(2023, 10, 14),
          toTs: Date.UTC(2023, 10, 15),
        },
      ]);

      // Later in the same local hour: same window, same tag, no query work.
      vi.setSystemTime(Date.UTC(2023, 10, 14, 23, 59, 59));
      expect((await post(body, { 'if-none-match': etag })).status).toBe(304);

      // The hour turns and the window rolls with it, even though no data moved.
      vi.setSystemTime(Date.UTC(2023, 10, 15, 0, 0, 1));
      const rolled = await post(body, { 'if-none-match': etag });
      expect(rolled.status).toBe(200);
      expect(rolled.headers.get('etag')).not.toBe(etag);

      // And a day on, the hit has rolled out of the window entirely.
      vi.setSystemTime(Date.UTC(2023, 10, 16, 0, 0, 1));
      const later = (await post(body)).json() as Promise<QueryResponse>;
      expect((await later).results.kpis).toMatchObject({ rows: [{ visitors: 0, pageviews: 0 }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('mints a new ETag when data changes, so a stale tag re-executes', async () => {
    const first = await post(BODY);
    const etag = first.headers.get('etag') as string;

    withWriteTransaction(db, () => {
      insertEvents(db, [event({ visitor_id: Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9), seq: 2 })]);
    });
    const res = await post(BODY, { 'if-none-match': etag });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).not.toBe(etag);
    const body = (await res.json()) as QueryResponse;
    expect(body.meta.dataVersion).toBe(2);
  });

  it('hashes the canonicalized body: key order does not change the ETag, content does', async () => {
    const reordered = {
      queries: BODY.queries,
      range: { to: '2023-11-14', from: '2023-11-14' },
      site: 1,
    };
    const [a, b] = await Promise.all([post(BODY), post(reordered)]);
    expect(b.headers.get('etag')).toBe(a.headers.get('etag'));

    const different = await post({ ...BODY, range: { from: '2023-11-01', to: '2023-11-14' } });
    expect(different.headers.get('etag')).not.toBe(a.headers.get('etag'));
  });

  it('rejects an invalid body with 400 and zod issues (this is not a beacon)', async () => {
    const res = await post({ ...BODY, queries: [{ id: 'x', metrics: ['drop table'] }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe('invalid query request');
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('rejects impossible calendar dates with 400, not a 500', async () => {
    const badMonth = await post({
      ...BODY,
      range: { from: '2026-13-01', to: '2026-13-02' },
      compare: 'previous',
    });
    expect(badMonth.status).toBe(400);

    // V8 would silently read Feb 30 as Mar 2 and shift the compare window.
    const badDay = await post({ ...BODY, range: { from: '2026-02-30', to: '2026-03-02' } });
    expect(badDay.status).toBe(400);
  });

  it("rejects a filter whose value does not fit its op ('is_null' vs the rest)", async () => {
    const missing = await post({ ...BODY, filters: [{ dim: 'country', op: 'eq' }] });
    expect(missing.status).toBe(400);
    const extra = await post({
      ...BODY,
      filters: [{ dim: 'country', op: 'is_null', value: 'US' }],
    });
    expect(extra.status).toBe(400);
  });

  it('rejects a non-JSON body with 400', async () => {
    const res = await post('not json');
    expect(res.status).toBe(400);
  });

  it('answers 404 for an unknown site id', async () => {
    const res = await post({ ...BODY, site: 42 });
    expect(res.status).toBe(404);
  });

  /**
   * A batch is the most expensive thing an authenticated caller can ask for, and
   * better-sqlite3 is synchronous — while one runs it owns the loop that also
   * answers beacons (invariant 4). The budget is metered on the principal the
   * gate already established; the address is only the fallback for a
   * tracking-only app mounted without that gate, exercised here because it is
   * the cheap way to drive the mechanism.
   *
   * The clock is frozen rather than read, so every charge in a loop lands at one
   * instant and the sliding window moves only where a test moves it.
   */
  describe('rate limit', () => {
    const IP = '203.0.113.7';
    const FROZEN = Date.UTC(2023, 10, 14, 17);
    /**
     * The client's revalidation debounce (`REVALIDATE_DEBOUNCE_MS`, apps/web
     * lib/live.ts) — the fastest a live view re-queries. Repeated as a number
     * here rather than imported across packages; `test/contract/rate-limit.test.ts`
     * is where the two are bound together.
     */
    const POLL_MS = 3_000;

    const from = (ip: string): Promise<Response> => post(BODY, { 'x-forwarded-for': ip });

    /** Spends the whole instance budget across as many callers as it takes. */
    async function spendTheInstance(): Promise<void> {
      const callers = QUERY_BATCHES_GLOBAL / QUERY_BATCHES_PER_SESSION;
      expect(Number.isInteger(callers)).toBe(true);
      for (let caller = 0; caller < callers; caller += 1) {
        for (let i = 0; i < QUERY_BATCHES_PER_SESSION; i += 1) {
          expect((await from(`198.51.100.${caller}`)).status).toBe(200);
        }
      }
    }

    beforeEach(() => {
      vi.useFakeTimers({ now: FROZEN, toFake: ['Date'] });
    });

    it('answers 429 with a Retry-After once a caller has spent its budget', async () => {
      for (let i = 0; i < QUERY_BATCHES_PER_SESSION; i += 1) {
        expect((await from(IP)).status).toBe(200);
      }
      const refused = await from(IP);
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBe('60');
      expect((await refused.json()) as { error: string }).toEqual({
        error: 'too many query batches — try again in a minute',
      });

      // Someone else's budget is untouched — a limiter that blocked the instance
      // on one caller's burst would be the outage it was meant to prevent.
      expect((await from('198.51.100.4')).status).toBe(200);
    });

    it('never charges a 304 — a dashboard revalidating on an unchanged view is free', async () => {
      const seed = await from(IP);
      const etag = seed.headers.get('etag') as string;

      // Far past the budget, all of it conditional: the response is served from
      // the ETag before the limiter is consulted at all.
      for (let i = 0; i < QUERY_BATCHES_PER_SESSION * 2; i += 1) {
        const res = await post(BODY, { 'x-forwarded-for': IP, 'if-none-match': etag });
        expect(res.status).toBe(304);
      }
      expect((await from(IP)).status).toBe(200);
    });

    it('lets a live client back in one window after its last executed batch', async () => {
      for (let i = 0; i < QUERY_BATCHES_PER_SESSION; i += 1) {
        expect((await from(IP)).status).toBe(200);
      }
      for (let elapsed = POLL_MS; elapsed < QUERY_WINDOW_MS; elapsed += POLL_MS) {
        vi.setSystemTime(FROZEN + elapsed);
        expect((await from(IP)).status).toBe(429);
      }
      vi.setSystemTime(FROZEN + QUERY_WINDOW_MS);
      expect((await from(IP)).status).toBe(200);
    });

    it('bounds the whole instance too, so many callers cannot add up to an outage', async () => {
      await spendTheInstance();
      // A caller who has spent nothing of its own budget still waits.
      expect((await from(IP)).status).toBe(429);
    });

    /**
     * The false positive that would actually hurt, and the reason `/api/query`
     * charges the WORK rather than the attempt (auth/ratelimit.ts).
     *
     * Once the instance budget is spent, every open dashboard keeps polling —
     * that is what a live view does, and it cannot know why it was refused. A
     * limiter that charged the attempt would let that ordinary polling hold the
     * door shut on itself indefinitely: the refusals alone outnumber the budget,
     * so the window would never drain and nobody would get back in.
     */
    it('does not let refusals hold the budget shut: a polling fleet still recovers', async () => {
      await spendTheInstance();
      const pollers = Math.ceil((QUERY_BATCHES_GLOBAL * POLL_MS) / (QUERY_WINDOW_MS - POLL_MS) + 1);
      for (let elapsed = POLL_MS; elapsed < QUERY_WINDOW_MS; elapsed += POLL_MS) {
        vi.setSystemTime(FROZEN + elapsed);
        for (let poller = 0; poller < pollers; poller += 1) {
          expect((await from(`192.0.2.${poller}`)).status).toBe(429);
        }
      }
      vi.setSystemTime(FROZEN + QUERY_WINDOW_MS);
      expect((await from('192.0.2.0')).status).toBe(200);
    });
  });

  it('keeps hostile filter values inert end to end', async () => {
    const res = await post({
      ...BODY,
      queries: [
        {
          id: 'q',
          metrics: ['pageviews'],
          filters: [{ dim: 'path', op: 'eq', value: "'; DELETE FROM events; --" }],
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as QueryResponse;
    expect(body.results.q).toMatchObject({ rows: [{ pageviews: 0 }] });
    // The table survived and still answers.
    const recheck = await post(BODY);
    const rechecked = (await recheck.json()) as QueryResponse;
    expect(rechecked.results.kpis).toMatchObject({ rows: [{ visitors: 1, pageviews: 1 }] });
  });

  describe('saved segments in requests', () => {
    let usSegment: number;

    beforeEach(() => {
      withWriteTransaction(db, () => {
        // A second visitor from the US beside the seeded (country-less) one.
        insertEvents(db, [
          event({
            visitor_id: Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9),
            session_id: Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9),
            country: 'US',
          }),
        ]);
        upsertSessions(db, [
          session({
            id: Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9),
            visitor_id: Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9),
            country: 'US',
          }),
        ]);
        usSegment = createSegment(
          db,
          'US traffic',
          JSON.stringify({ dim: 'country', op: 'eq', value: 'US' }),
          1,
        ).id;
      });
    });

    it('expands a {segment} ref to the same answer as the inline filter', async () => {
      const viaSegment = await post({ ...BODY, filters: [{ segment: usSegment }] });
      const inline = await post({
        ...BODY,
        filters: [{ dim: 'country', op: 'eq', value: 'US' }],
      });
      expect(viaSegment.status).toBe(200);
      const a = (await viaSegment.json()) as QueryResponse;
      const b = (await inline.json()) as QueryResponse;
      expect(a.results.kpis).toMatchObject({ rows: [{ visitors: 1, pageviews: 1 }] });
      const rowsOf = (r: QueryResponse) =>
        r.results.kpis !== undefined && 'rows' in r.results.kpis ? r.results.kpis.rows : undefined;
      expect(rowsOf(a)).toEqual(rowsOf(b));
      // The tag hashes the EXPANDED request, so the two spellings of one
      // question collapse to one canonical body — and one cache entry.
      expect(viaSegment.headers.get('etag')).toBe(inline.headers.get('etag'));
    });

    it('400s an unknown segment with a clear message', async () => {
      const res = await post({ ...BODY, filters: [{ segment: 99 }] });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toEqual({ error: 'unknown segment 99' });
      // In a compare position too — the same operator named it, the same answer.
      const compare = await post({ ...BODY, compare: { segment: 99 } });
      expect(compare.status).toBe(400);
    });

    it('expires the ETag when the segment is edited — the tag hashes the expanded tree', async () => {
      const body = { ...BODY, filters: [{ segment: 0 /* patched below */ }] };
      (body.filters[0] as { segment: number }).segment = usSegment;
      const first = await post(body);
      const etag = first.headers.get('etag') as string;
      expect((await post(body, { 'if-none-match': etag })).status).toBe(304);

      withWriteTransaction(db, () => {
        updateSegment(
          db,
          usSegment,
          'US traffic',
          JSON.stringify({ dim: 'country', op: 'is_null' }),
          2,
        );
      });
      const edited = await post(body, { 'if-none-match': etag });
      expect(edited.status).toBe(200);
      expect(edited.headers.get('etag')).not.toBe(etag);
      // The edit is live in the answer: the NULL-country visitor now matches.
      const answered = (await edited.json()) as QueryResponse;
      expect(answered.results.kpis).toMatchObject({ rows: [{ visitors: 1, pageviews: 1 }] });
    });

    it('answers segment compare and folds the tree into the tag', async () => {
      const body = { ...BODY, compare: { segment: 0 } };
      body.compare.segment = usSegment;
      const first = await post(body);
      expect(first.status).toBe(200);
      const answered = (await first.json()) as QueryResponse;
      expect(answered.results.kpis).toMatchObject({
        rows: [{ visitors: 2, pageviews: 2 }],
        compare: [{ visitors: 1, pageviews: 1 }],
      });
      const etag = first.headers.get('etag') as string;
      withWriteTransaction(db, () => {
        updateSegment(
          db,
          usSegment,
          'US traffic',
          JSON.stringify({ dim: 'country', op: 'is_null' }),
          2,
        );
      });
      const edited = await post(body, { 'if-none-match': etag });
      expect(edited.status).toBe(200);
      expect(edited.headers.get('etag')).not.toBe(etag);
    });
  });

  describe('derived metrics in requests', () => {
    const body = { ...BODY, queries: [{ id: 'q', metrics: ['d:views_each'] }] };

    it('errors per query while the name is unknown, then answers once it exists — new tag', async () => {
      const first = await post(body);
      expect(first.status).toBe(200);
      const missing = (await first.json()) as QueryResponse;
      expect(missing.results.q).toEqual({
        error: { code: 'unsupported', message: "unknown derived metric 'd:views_each'" },
      });
      const etag = first.headers.get('etag') as string;
      expect((await post(body, { 'if-none-match': etag })).status).toBe(304);

      withWriteTransaction(db, () => {
        createDerivedMetric(db, 'views_each', 'pageviews / visitors', 1);
      });
      // dataVersion never moved, but the definitions are hashed too.
      const res = await post(body, { 'if-none-match': etag });
      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).not.toBe(etag);
      const answered = (await res.json()) as QueryResponse;
      expect(answered.results.q).toMatchObject({
        rows: [{ pageviews: 1, visitors: 1, 'd:views_each': 1 }],
      });
    });
  });

  describe('ETag at site-local midnight for explicit ranges (docs/04 § 3)', () => {
    it('expires a range touching today when the local day turns, without any data change', async () => {
      vi.useFakeTimers();
      try {
        // 12:00 in New York on the seeded day; the range runs past today.
        vi.setSystemTime(Date.UTC(2023, 10, 14, 17));
        const body = { ...BODY, range: { from: '2023-11-14', to: '2023-11-20' } };
        const first = await post(body);
        const etag = first.headers.get('etag') as string;
        expect((await post(body, { 'if-none-match': etag })).status).toBe(304);

        // One local day later: same window, same data — but where elapsed time
        // stops inside it has moved, and a cached clip must not survive it.
        vi.setSystemTime(Date.UTC(2023, 10, 15, 17));
        const next = await post(body, { 'if-none-match': etag });
        expect(next.status).toBe(200);
        expect(next.headers.get('etag')).not.toBe(etag);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps a fully past range stable across the same midnight — those tags may cache', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.UTC(2023, 10, 16, 17));
        const body = { ...BODY, range: { from: '2023-11-13', to: '2023-11-14' } };
        const first = await post(body);
        const etag = first.headers.get('etag') as string;
        vi.setSystemTime(Date.UTC(2023, 10, 17, 17));
        expect((await post(body, { 'if-none-match': etag })).status).toBe(304);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('keeps hostile values inert from every nested tree position (any/not/glob)', async () => {
    const hostile = "'; DELETE FROM events; --";
    const res = await post({
      ...BODY,
      queries: [
        {
          id: 'q',
          metrics: ['pageviews'],
          filters: [
            {
              any: [
                { not: { dim: 'path', op: 'glob', value: hostile } },
                { all: [{ dim: 'title', op: 'contains', value: hostile }] },
              ],
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as QueryResponse;
    // not(glob hostile) matches every real path — the value stayed a pattern, not SQL.
    expect(body.results.q).toMatchObject({ rows: [{ pageviews: 1 }] });
    // The table survived and still answers.
    const recheck = await post(BODY);
    const rechecked = (await recheck.json()) as QueryResponse;
    expect(rechecked.results.kpis).toMatchObject({ rows: [{ visitors: 1, pageviews: 1 }] });
  });
});
