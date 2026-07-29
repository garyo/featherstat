import type { QueryResponse } from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { event, openTestDb, session } from '../../test/rows.ts';
import { type Db, insertEvents, upsertSessions, withWriteTransaction } from '../db/index.ts';
import { createApp } from '../index.ts';

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
});
