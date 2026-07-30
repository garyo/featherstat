import {
  BATCH_INTERVAL_MS,
  ENGAGEMENT_THRESHOLD_MS,
  SESSION_TIMEOUT_MS,
} from '@featherstat/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/index.ts';
import { parseMatomoRequest } from '../../src/ingest/matomo.ts';
import { isBotUserAgent } from '../../src/pipeline/enrich.ts';
import { BOT_AGENTS, type DayTotals, generateCorpus, toMatomoQuery } from './generate.ts';
import { openReplayDb } from './harness.ts';

/**
 * The M0 acceptance instrument (docs/08 WP6): 90 days of synthetic traffic for six
 * sites, encoded as matomo.php requests and pushed through the real parser,
 * pipeline and batcher into an in-memory database. Every per-site, per-day total
 * is then compared against the generator's own bookkeeping — two independent
 * implementations of docs/03 have to agree exactly, for all ~540 site-days.
 */

const corpus = generateCorpus();

let db: Db;

beforeAll(() => {
  // Ingest time comes from `ctx.receivedAt`, so session expiry is driven by the
  // corpus. The fake clock is what makes the 200 ms batch timer deterministic.
  vi.useFakeTimers();
  vi.setSystemTime(corpus.startMs);
  // The one suite that lets the REAL 200 ms batch timer do the flushing — the
  // batcher's own scheduling is part of what it asserts, so it advances the
  // clock where its siblings just call flush().
  db = openReplayDb(corpus, {
    batchIntervalMs: BATCH_INTERVAL_MS,
    onBatch: () => vi.advanceTimersByTime(BATCH_INTERVAL_MS),
  });
}, 120_000);

afterAll(() => {
  db.close();
  vi.useRealTimers();
});

/** Rebuilds the generator's DayTotals shape from SQL alone. */
function totalsFromDb(target: Db): DayTotals[] {
  const merged = new Map<string, DayTotals>();
  const bucket = (siteId: number, localDate: string): DayTotals => {
    const key = `${siteId}|${localDate}`;
    let row = merged.get(key);
    if (row === undefined) {
      row = { siteId, localDate, visitors: 0, sessions: 0, pageviews: 0, bounces: 0, botDrops: 0 };
      merged.set(key, row);
    }
    return row;
  };

  const events = target
    .prepare(
      `SELECT site_id, local_date,
         -- Heartbeats are not visits (docs/03): a session beating past local
         -- midnight must not book its visitor into a day it never acted in.
         COUNT(DISTINCT CASE WHEN type != 'ping' THEN visitor_id END) AS visitors,
         SUM(type = 'pageview') AS pageviews
       FROM events GROUP BY site_id, local_date`,
    )
    .all() as Array<{ site_id: number; local_date: string; visitors: number; pageviews: number }>;
  for (const row of events) {
    const totals = bucket(row.site_id, row.local_date);
    totals.visitors = row.visitors;
    totals.pageviews = row.pageviews;
  }

  const sessions = target
    .prepare(
      `SELECT site_id, local_date, COUNT(*) AS sessions,
         SUM(pageviews = 1 AND events = 0 AND engaged_ms < ?) AS bounces
       FROM sessions GROUP BY site_id, local_date`,
    )
    .all(ENGAGEMENT_THRESHOLD_MS) as Array<{
    site_id: number;
    local_date: string;
    sessions: number;
    bounces: number;
  }>;
  for (const row of sessions) {
    const totals = bucket(row.site_id, row.local_date);
    totals.sessions = row.sessions;
    totals.bounces = row.bounces;
  }

  const bots = target.prepare('SELECT site_id, local_date, count FROM bot_drops').all() as Array<{
    site_id: number;
    local_date: string;
    count: number;
  }>;
  for (const row of bots) bucket(row.site_id, row.local_date).botDrops = row.count;

  return [...merged.values()].sort(
    (a, b) => a.siteId - b.siteId || a.localDate.localeCompare(b.localDate),
  );
}

function count(target: Db, sql: string, ...params: number[]): number {
  return target
    .prepare(sql)
    .pluck()
    .get(...params) as number;
}

describe('replay harness', () => {
  it('generates 90 days of shaped traffic for the six sites of docs/01', () => {
    expect(corpus.sites).toHaveLength(6);
    expect(corpus.endMs - corpus.startMs).toBe(90 * 86_400_000);
    expect(corpus.hits.length).toBeGreaterThan(50_000);
    expect(corpus.totals.filter((day) => day.siteId === 1).length).toBeGreaterThanOrEqual(90);
    const types = new Set(corpus.hits.map((entry) => entry.hit.type));
    expect([...types].sort()).toEqual(['download', 'event', 'outlink', 'pageview', 'ping']);
    const outOfOrder = corpus.hits.findIndex(
      (entry, i) => i > 0 && entry.ctx.receivedAt < (corpus.hits[i - 1]?.ctx.receivedAt ?? 0),
    );
    expect(outOfOrder).toBe(-1);
  });

  it('is reproducible: one seed, one corpus', () => {
    const a = generateCorpus({ days: 3, seed: 7 });
    const b = generateCorpus({ days: 3, seed: 7 });
    expect(a.hits.length).toBe(b.hits.length);
    expect(a.hits.slice(0, 500)).toEqual(b.hits.slice(0, 500));
    expect(a.totals).toEqual(b.totals);
    expect(generateCorpus({ days: 3, seed: 8 }).totals).not.toEqual(a.totals);
  });

  it('round-trips its hits through the matomo.php parser', () => {
    const stride = Math.floor(corpus.hits.length / 2_000) || 1;
    for (let i = 0; i < corpus.hits.length; i += stride) {
      const entry = corpus.hits[i];
      if (entry === undefined) continue;
      const { hits, sendImage } = parseMatomoRequest({ query: toMatomoQuery(entry) });
      expect(hits).toEqual([entry.hit]);
      expect(sendImage).toBe(false);
    }
  });

  it('agrees with isbot about which corpus agents are bots', () => {
    const agents = new Set(corpus.hits.map((entry) => entry.ctx.userAgent));
    expect(agents.size).toBeGreaterThan(BOT_AGENTS.length);
    for (const agent of agents) {
      expect(isBotUserAgent(agent), agent).toBe(BOT_AGENTS.includes(agent));
    }
  });

  it('stores one event row per accepted hit; bots and orphan heartbeats are all it drops', () => {
    expect(count(db, 'SELECT COUNT(*) FROM events')).toBe(corpus.storedHits);
    const botDrops = corpus.totals.reduce((sum, day) => sum + day.botDrops, 0);
    expect(botDrops).toBeGreaterThan(0);
    expect(count(db, 'SELECT COALESCE(SUM(count), 0) FROM bot_drops')).toBe(botDrops);
    expect(corpus.hits.length - corpus.storedHits).toBe(botDrops + corpus.droppedPings);
  });

  it('exercises both sides of the returning-reader window (docs/03)', () => {
    // Revived and dropped heartbeats both occur, so neither branch of the rule is
    // asserted vacuously — and no session anywhere begins with a heartbeat.
    expect(corpus.revivedPings).toBeGreaterThan(0);
    expect(corpus.droppedPings).toBeGreaterThan(0);
    expect(
      count(
        db,
        `SELECT COUNT(*) FROM sessions s
         WHERE (SELECT type FROM events e WHERE e.session_id = s.id AND e.seq = 1) = 'ping'`,
      ),
    ).toBe(0);
    // A revived visit outlives the idle window, which is exactly the point.
    const outlived = 'SELECT COUNT(*) FROM sessions WHERE last_seen_at - started_at > ?';
    expect(count(db, outlived, SESSION_TIMEOUT_MS)).toBeGreaterThan(0);
  });

  it('carries the SPA double-fire, on the SPA sites and nowhere else', () => {
    // History holds these rows — the tracker guard stops new ones, it does not
    // rewrite what is already stored — so the journey collapse has something to
    // fold away (docs/06). Sub-second and same URL: no dwell in the generator is
    // under a second, so nothing else can produce this shape.
    const seen = new Map<string, { url: string; at: number }>();
    const repeats = new Map<number, number>();
    for (const { hit, ctx } of corpus.hits) {
      if (hit.type !== 'pageview' || hit.url === undefined) continue;
      const key = `${hit.siteId}|${hit.visitorId ?? `${ctx.ip}\n${ctx.userAgent}`}`;
      const prior = seen.get(key);
      if (prior?.url === hit.url && ctx.receivedAt - prior.at < 1_000) {
        repeats.set(hit.siteId, (repeats.get(hit.siteId) ?? 0) + 1);
      }
      seen.set(key, { url: hit.url, at: ctx.receivedAt });
    }
    expect([...repeats.keys()].sort()).toEqual([3, 5]);
    for (const [siteId, count] of repeats) expect(count, `site ${siteId}`).toBeGreaterThan(20);
  });

  it('matches the expected totals for every site and every local day', () => {
    const actual = totalsFromDb(db);
    expect(actual).toHaveLength(corpus.totals.length);
    expect(actual).toEqual(corpus.totals);
  });

  it('exercises both engagement escapes from the bounce definition', () => {
    const single = 'SELECT COUNT(*) FROM sessions WHERE pageviews = 1';
    const threshold = ENGAGEMENT_THRESHOLD_MS;
    expect(count(db, `${single} AND events = 0 AND engaged_ms < ?`, threshold)).toBeGreaterThan(0);
    expect(count(db, `${single} AND events = 0 AND engaged_ms >= ?`, threshold)).toBeGreaterThan(0);
    expect(count(db, `${single} AND events > 0 AND engaged_ms < ?`, threshold)).toBeGreaterThan(0);
    const bounces = corpus.totals.reduce((sum, day) => sum + day.bounces, 0);
    const sessions = corpus.totals.reduce((sum, day) => sum + day.sessions, 0);
    expect(bounces).toBeGreaterThan(0);
    expect(bounces).toBeLessThan(sessions);
  });

  it('keeps sessions, engagement and journeys consistent inside the database', () => {
    expect(count(db, 'SELECT COUNT(*) FROM events WHERE seq < 1')).toBe(0);
    expect(
      count(
        db,
        `SELECT COUNT(*) FROM (
           SELECT session_id FROM events GROUP BY session_id
           HAVING COUNT(DISTINCT seq) <> COUNT(*) OR MAX(seq) <> COUNT(*)
         )`,
      ),
    ).toBe(0);
    expect(
      count(db, 'SELECT COUNT(*) FROM sessions WHERE last_seen_at < started_at OR engaged_ms < 0'),
    ).toBe(0);
    expect(
      count(
        db,
        `SELECT COUNT(*) FROM sessions s WHERE s.pageviews <>
           (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'pageview')`,
      ),
    ).toBe(0);
  });
});
