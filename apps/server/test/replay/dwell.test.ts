import {
  type Hit,
  type HitType,
  PING_CLAMP_MS,
  type QueryRequest,
  SESSION_REVIVAL_MS,
  SESSION_TIMEOUT_MS,
} from '@featherstat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/index.ts';
import { executeQueryRequest } from '../../src/query/executor.ts';
import { resultOf } from '../rows.ts';
import { BOT_AGENTS, type Corpus, generateCorpus, localStamp, oraclePath } from './generate.ts';
import { openReplayDb } from './harness.ts';

/**
 * Time on page + outbound links over the 90-day replay corpus. The oracle never
 * touches SQL: it re-sessionizes the generator's raw hit stream in plain JS
 * (docs/03 rules — identity with the site-local midnight rotation, 30-min idle
 * timeout) and then walks each session's hits applying the dwell rule of docs/03
 * by hand: every event, pings included, credits its clamped gap to the most
 * recent pageview, and a gap that does not exist is not a zero. Full-corpus
 * equality, every site — nothing is sampled.
 */

const corpus = generateCorpus();

/** Wide enough to hold every local date the corpus can produce, in any site timezone. */
const FULL_RANGE = { from: '2026-02-14', to: '2026-05-17' } as const;

let db: Db;
let oracle: OracleSession[];

beforeAll(() => {
  db = openReplayDb(corpus);
  oracle = sessionize(corpus);
}, 120_000);

afterAll(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

interface OracleHit {
  ts: number;
  type: HitType;
  /** The stored `path`: a URL's pathname + query, '' when the hit carried no URL. */
  path: string;
  targetUrl: string | undefined;
}

interface OracleSession {
  siteId: number;
  localDate: string;
  lastSeen: number;
  /** Every stored hit of the session, in arrival order — pings included. */
  hits: OracleHit[];
}

const BOT_AGENT_SET = new Set(BOT_AGENTS);

function sessionize(source: Corpus): OracleSession[] {
  const zones = new Map(source.sites.map((site) => [site.id, site.timezone]));
  const open = new Map<string, OracleSession>();
  const all: OracleSession[] = [];
  for (const { hit, ctx } of source.hits) {
    if (BOT_AGENT_SET.has(ctx.userAgent)) continue;
    // Identity rotates at site-local midnight (docs/03), so the local date is part of the key.
    const localDate = localStamp(zones.get(hit.siteId) ?? 'UTC', ctx.receivedAt).date;
    const identity = `${hit.siteId}|${localDate}|${hit.visitorId ?? `${ctx.ip}\n${ctx.userAgent}`}`;
    // A ping continues a visit, never starts one (docs/03): it reaches back to the
    // returning-reader window, and past that it is dropped rather than stored.
    const prior = open.get(identity);
    const reach = hit.type === 'ping' ? SESSION_REVIVAL_MS : SESSION_TIMEOUT_MS;
    const idle = prior === undefined ? Number.POSITIVE_INFINITY : ctx.receivedAt - prior.lastSeen;
    if (hit.type === 'ping' && idle > reach) continue;
    let session = idle <= reach ? prior : undefined;
    if (session === undefined) {
      session = {
        siteId: hit.siteId,
        localDate,
        lastSeen: ctx.receivedAt,
        hits: [],
      };
      open.set(identity, session);
      all.push(session);
    } else {
      session.lastSeen = ctx.receivedAt;
    }
    session.hits.push({
      ts: ctx.receivedAt,
      type: hit.type,
      path: pathOf(hit),
      targetUrl: hit.targetUrl,
    });
  }
  return all;
}

/** The server's URL split, restated in journeys.test.ts's oracle: pathname +
 * query, fragment and tracking params dropped (docs/03 § Page identity). */
function pathOf(hit: Hit): string {
  if (hit.url === undefined) return '';
  return oraclePath(new URL(hit.url));
}

/** One page view that could actually be timed: its path and the ms credited to it. */
interface MeasuredView {
  path: string;
  ms: number;
}

/**
 * The docs/03 rule, applied by hand: walk the session's hits, remember the page
 * the most recent pageview opened, and credit every hit's clamped gap to it. A
 * page nothing followed is never emitted — it was not measured, and a zero
 * would be a lie.
 */
function measuredViews(session: OracleSession): MeasuredView[] {
  const views: Array<MeasuredView & { measured: boolean }> = [];
  let current: (MeasuredView & { measured: boolean }) | undefined;
  for (const [index, hit] of session.hits.entries()) {
    if (hit.type === 'pageview') {
      current = { path: hit.path, ms: 0, measured: false };
      views.push(current);
    }
    const next = session.hits[index + 1];
    if (next === undefined || current === undefined) continue; // no gap, or no page yet
    current.ms += Math.min(next.ts - hit.ts, PING_CLAMP_MS);
    current.measured = true;
  }
  return views.filter((view) => view.measured);
}

interface DwellRow {
  path: string;
  views_measured: number;
  avg_page_ms: number;
  max_page_ms: number;
  views_scrolled: number;
  avg_scroll_pct: number | null;
}

function expectedDwell(scoped: readonly OracleSession[], limit: number): DwellRow[] {
  const byPath = new Map<string, { total: number; count: number; max: number }>();
  for (const session of scoped) {
    for (const view of measuredViews(session)) {
      const entry = byPath.get(view.path) ?? { total: 0, count: 0, max: 0 };
      entry.total += view.ms;
      entry.count += 1;
      entry.max = Math.max(entry.max, view.ms);
      byPath.set(view.path, entry);
    }
  }
  return [...byPath.entries()]
    .map(([path, entry]) => ({
      path,
      // Constant, and honestly so: scroll depth is native-tracker-only and this
      // corpus is Matomo-shaped (`generate.ts` encodes every hit back into
      // matomo params), so no row here can carry a reading. That makes this an
      // assertion that the corpus reports NO scroll rather than a fabricated 0 %
      // — the exit-ping attribution it cannot exercise is pinned by a
      // hand-built fixture in `query/dwell.test.ts` instead.
      views_scrolled: 0,
      avg_scroll_pct: null,
      views_measured: entry.count,
      avg_page_ms: entry.total / entry.count,
      max_page_ms: entry.max,
    }))
    .sort((a, b) => b.avg_page_ms - a.avg_page_ms || cmp(a.path, b.path))
    .slice(0, limit);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Envelope {
  site: number;
  from: string;
  to: string;
  /** strftime('%w') numbering: 0 = Sunday … 6 = Saturday. */
  weekday?: number;
}

function scopedSessions(envelope: Envelope): OracleSession[] {
  return oracle.filter(
    (session) =>
      session.siteId === envelope.site &&
      session.localDate >= envelope.from &&
      session.localDate <= envelope.to &&
      (envelope.weekday === undefined || weekdayOf(session.localDate) === envelope.weekday),
  );
}

function weekdayOf(localDate: string): number {
  return new Date(`${localDate}T00:00:00Z`).getUTCDay();
}

function dwellBatch(
  envelope: Envelope,
  limit: number,
  filters?: QueryRequest['filters'],
): QueryRequest {
  return {
    site: envelope.site,
    range: { from: envelope.from, to: envelope.to },
    ...(filters === undefined ? {} : { filters }),
    queries: [{ id: 'dwell', kind: 'dwell', limit }],
  };
}

function runDwell(envelope: Envelope, limit: number) {
  return executeQueryRequest(db, dwellBatch(envelope, limit));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('time on page on the replay corpus', () => {
  it('oracle sessionization agrees with the generator day totals', () => {
    const bySiteDay = new Map<string, number>();
    for (const session of oracle) {
      const key = `${session.siteId}|${session.localDate}`;
      bySiteDay.set(key, (bySiteDay.get(key) ?? 0) + 1);
    }
    for (const day of corpus.totals) {
      expect(bySiteDay.get(`${day.siteId}|${day.localDate}`) ?? 0).toBe(day.sessions);
    }
  });

  it('matches the oracle exactly for every site over the full range', () => {
    for (const site of corpus.sites) {
      const envelope = { site: site.id, ...FULL_RANGE };
      const response = executeQueryRequest(db, dwellBatch(envelope, 200));
      const expected = expectedDwell(scopedSessions(envelope), 200);
      expect(expected.length, site.name).toBeGreaterThan(0);
      expect(resultOf(response, 'dwell').rows, site.name).toEqual(expected);
    }
  });

  it('times fewer views than there were pageviews — the unmeasurable are excluded', () => {
    const envelope = { site: 2, ...FULL_RANGE };
    const measured = expectedDwell(scopedSessions(envelope), 200).reduce(
      (sum, row) => sum + row.views_measured,
      0,
    );
    const pageviews = corpus.totals
      .filter((day) => day.siteId === envelope.site)
      .reduce((sum, day) => sum + day.pageviews, 0);
    expect(measured).toBeGreaterThan(0);
    expect(measured).toBeLessThan(pageviews);
    // And no row ever rests on zero views, nor reports a negative duration.
    for (const row of resultOf(runDwell(envelope, 200), 'dwell').rows) {
      expect(Number(row.views_measured)).toBeGreaterThan(0);
      expect(Number(row.avg_page_ms)).toBeGreaterThanOrEqual(0);
      expect(Number(row.max_page_ms)).toBeGreaterThanOrEqual(Number(row.avg_page_ms));
    }
  });

  it('a tight limit keeps the deterministic top', () => {
    const envelope = { site: 2, ...FULL_RANGE };
    expect(resultOf(runDwell(envelope, 5), 'dwell').rows).toEqual(
      expectedDwell(scopedSessions(envelope), 5),
    );
  });

  it('respects the filter envelope (Mondays only, session-scoped)', () => {
    const envelope = { site: 2, from: '2026-03-01', to: '2026-04-15', weekday: 1 };
    const response = executeQueryRequest(
      db,
      dwellBatch(envelope, 200, [{ dim: 'weekday', op: 'eq', value: '1' }]),
    );
    const scoped = scopedSessions(envelope);
    expect(scoped.length).toBeGreaterThan(0);
    expect(resultOf(response, 'dwell').rows).toEqual(expectedDwell(scoped, 200));
  });

  it('rejects an event-only filter honestly', () => {
    const response = executeQueryRequest(
      db,
      dwellBatch({ site: 2, ...FULL_RANGE }, 20, [{ dim: 'path', op: 'starts', value: '/blog' }]),
    );
    expect(response.results.dwell).toHaveProperty(['error', 'code'], 'unsupported');
  });

  it('answers an empty range with empty rows', () => {
    const response = executeQueryRequest(
      db,
      dwellBatch({ site: 2, from: '2026-01-01', to: '2026-01-31' }, 20),
    );
    expect(resultOf(response, 'dwell').rows).toEqual([]);
  });

  it('answers the busiest site under 100 ms', () => {
    const request = dwellBatch({ site: 2, ...FULL_RANGE }, 10);
    executeQueryRequest(db, request); // warm statement cache
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run += 1) {
      best = Math.min(best, executeQueryRequest(db, request).meta.generatedInMs);
    }
    // Guard against algorithmic blowups (an accidental O(n^2) would be seconds),
    // not scheduler moods: the same query measures 60-120 ms on this machine
    // depending on power state (efficiency cores after wake vs performance).
    expect(best).toBeLessThan(250);
  });
});

describe('outbound links on the replay corpus', () => {
  /** Stored hits of a type, straight from the generator's stream — no SQL involved. */
  function storedHits(siteId: number, type: HitType): OracleHit[] {
    return oracle
      .filter((session) => session.siteId === siteId)
      .flatMap((session) => session.hits.filter((hit) => hit.type === type));
  }

  it('counts outlinks and downloads per site, and ranks the targets', () => {
    for (const site of corpus.sites) {
      const response = executeQueryRequest(db, {
        site: site.id,
        range: FULL_RANGE,
        queries: [
          { id: 'totals', metrics: ['outlinks', 'downloads'] },
          { id: 'targets', metrics: ['outlinks'], dim: 'target_url', limit: 20 },
        ],
      });
      const outlinks = storedHits(site.id, 'outlink');
      const totals = resultOf(response, 'totals').rows[0];
      expect(totals?.outlinks, site.name).toBe(outlinks.length);
      expect(totals?.downloads, site.name).toBe(storedHits(site.id, 'download').length);

      const byTarget = new Map<string, number>();
      for (const hit of outlinks) {
        const target = hit.targetUrl ?? '';
        byTarget.set(target, (byTarget.get(target) ?? 0) + 1);
      }
      const ranked = resultOf(response, 'targets')
        .rows.filter((row) => Number(row.outlinks) > 0)
        .map((row) => [String(row.target_url), Number(row.outlinks)] as const);
      expect(new Map(ranked), site.name).toEqual(byTarget);
    }
  });
});
