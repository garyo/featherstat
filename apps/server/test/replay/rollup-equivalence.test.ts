import type { Hit } from '@featherstat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSite, type Db, openDb, stmt, withWriteTransaction } from '../../src/db/index.ts';
import { WriteBatcher } from '../../src/pipeline/batcher.ts';
import type { DeviceInfo } from '../../src/pipeline/enrich.ts';
import { priorSessionLookup, Sessionizer } from '../../src/pipeline/sessionizer.ts';
import { rebuildRollupDay } from '../../src/rollup/rebuild.ts';
import { verifyRollupDay } from '../../src/rollup/verify.ts';
import { generateCorpus } from './generate.ts';
import { openReplayDb } from './harness.ts';

/**
 * The rollup equivalence ratchet (docs/03 § Rollups, CLAUDE.md invariant 6):
 * after driving REAL ingest — parser → pipeline → batcher, with `applyRollups`
 * riding every flush transaction exactly as in production — every (site, day)'s
 * incrementally-maintained rollup rows must equal a from-scratch recompute over
 * the raw rows, cell for cell.
 *
 * The 90-day corpus is the adversarial input on purpose: six sites in four
 * timezones (every hour boundary disagrees), two DST switches, campaign/NULL
 * dimension values, heartbeats (never actions), revived sessions crossing the
 * idle window, engaged sessions that un-bounce mid-flight, and stable Matomo
 * `_id` identities. What the corpus cannot produce — a mid-transaction flush
 * failure, a visitor whose id survives local midnight — the randomized drift
 * suite below adds.
 */

const corpus = generateCorpus();

function rollupDays(db: Db): Array<{ site_id: number; local_date: string }> {
  return stmt<{ site_id: number; local_date: string }>(
    db,
    `SELECT site_id, local_date FROM (
       SELECT DISTINCT site_id, local_date FROM events
       UNION SELECT DISTINCT site_id, local_date FROM sessions
     ) ORDER BY site_id, local_date`,
  ).all() as Array<{ site_id: number; local_date: string }>;
}

function verifyEveryDay(db: Db): void {
  const days = rollupDays(db);
  expect(days.length).toBeGreaterThan(0);
  for (const { site_id, local_date } of days) {
    const drift = verifyRollupDay(db, site_id, local_date);
    expect(drift, `site ${site_id} @ ${local_date}`).toEqual([]);
  }
}

describe('rollups over the replay corpus', () => {
  let db: Db;

  beforeAll(() => {
    db = openReplayDb(corpus);
  }, 180_000);

  afterAll(() => {
    db.close();
  });

  it('every (site, day): flush-incremental == rebuild-from-raw', () => {
    expect(rollupDays(db).length).toBeGreaterThan(500); // 6 sites × ≥90 days
    verifyEveryDay(db);
  }, 120_000);

  it('meta-test: a corrupted rollup cell is reported, and a rebuild repairs it', () => {
    // The ratchet is only as good as its ability to object (repo rule: prove
    // the guard fires). Corrupt one additive counter and one distinct count.
    const day = rollupDays(db)[0];
    if (day === undefined) throw new Error('corpus produced no days');
    withWriteTransaction(db, () => {
      stmt(
        db,
        `UPDATE rollup_dim_day SET pageviews = pageviews + 1, visitors = visitors + 1
         WHERE site_id = ? AND local_date = ? AND dim_id = 0`,
      ).run(day.site_id, day.local_date);
      stmt(
        db,
        `UPDATE rollup_sessions_day SET bounced = bounced - 1
         WHERE site_id = ? AND local_date = ? AND dim_id = 0`,
      ).run(day.site_id, day.local_date);
    });

    const drift = verifyRollupDay(db, day.site_id, day.local_date);
    const columns = drift.map((entry) => entry.column).sort();
    expect(columns).toEqual(['bounced', 'pageviews', 'visitors']);

    withWriteTransaction(db, () => rebuildRollupDay(db, day.site_id, day.local_date));
    expect(verifyRollupDay(db, day.site_id, day.local_date)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Property-style drift suite: randomized flush boundaries, an injected failing
// flush, and uid-stable visitors whose sessions cross local midnight — the
// shapes the deterministic corpus cannot produce.
// ---------------------------------------------------------------------------

/** mulberry32 (same PRNG discipline as generate.ts): seeded, never Math.random. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const DEVICE: DeviceInfo = {
  browser: 'Chrome',
  browser_version: '126',
  os: 'Linux',
  device_type: 'desktop',
};

const DRIFT_SITES = [
  { id: 1, name: 'utc', domains: ['utc.test'], timezone: 'UTC' },
  { id: 2, name: 'tokyo', domains: ['tokyo.test'], timezone: 'Asia/Tokyo' },
];
const PATHS = ['/', '/a', '/b', '/pricing', null];
const DAY_MS = 86_400_000;

describe('rollup drift under randomized flushes', () => {
  it('random flush points + one failing flush: retry double-counts nothing', () => {
    const rng = mulberry32(0xd41f7);
    const db = openDb(':memory:');
    withWriteTransaction(db, () => {
      for (const site of DRIFT_SITES) createSite(db, site);
    });

    // The real batcher and sessionizer, wired the way createPipeline wires
    // them (including the revival snapshot seeding) but with the visitor ids
    // supplied directly — which is what lets a visitor stay STABLE across
    // local midnight here, the uid shape the corpus has no opted-in site for.
    const batcher = new WriteBatcher(db, 3_600_000);
    const lookup = priorSessionLookup(db);
    const sessionizer = new Sessionizer((siteId, visitorId, notBefore) => {
      const prior = lookup(siteId, visitorId, notBefore);
      if (prior !== undefined) batcher.seedSnapshot(prior.row);
      return prior;
    });

    interface Planned {
      siteId: number;
      ts: number;
      hit: Hit;
      visitor: Uint8Array;
    }
    const planned: Planned[] = [];
    const start = Date.UTC(2026, 2, 1); // spans Tokyo's midnight repeatedly
    for (let visitor = 0; visitor < 60; visitor += 1) {
      const site = DRIFT_SITES[visitor % 2];
      if (site === undefined) continue;
      const stable = rng() < 0.5; // uid-style: one id across all three days
      for (let day = 0; day < 3; day += 1) {
        if (rng() < 0.3) continue;
        // Biased late into the day so some sessions straddle local midnight.
        const sessionStart = start + day * DAY_MS + Math.floor(rng() ** 2 * DAY_MS * 1.2);
        const id = new Uint8Array(8);
        id[0] = visitor;
        id[1] = site.id;
        id[2] = stable ? 0xff : day;
        let ts = sessionStart;
        const steps = 1 + Math.floor(rng() * 4);
        for (let step = 0; step < steps; step += 1) {
          const roll = rng();
          const path = PATHS[Math.floor(rng() * PATHS.length)] ?? null;
          const url = path === null ? undefined : `https://${site.domains[0]}${path}`;
          const hit: Hit =
            roll < 0.6 || step === 0
              ? { siteId: site.id, type: 'pageview', url }
              : roll < 0.75
                ? { siteId: site.id, type: 'ping', url }
                : roll < 0.9
                  ? {
                      siteId: site.id,
                      type: 'event',
                      url,
                      event: { category: 'cta', action: 'click', value: 1 },
                    }
                  : { siteId: site.id, type: 'outlink', url, targetUrl: 'https://ext.test/x' };
          planned.push({ siteId: site.id, ts, hit, visitor: id });
          ts += 1_000 + Math.floor(rng() * 25_000);
        }
      }
    }
    // Deliberate midnight-straddlers: a stable visitor reading through their
    // site's LOCAL midnight (15:00 UTC in Tokyo), so the session's later hits
    // land on the next local_date while the visit stays on its start date.
    for (const [index, site] of DRIFT_SITES.entries()) {
      const offsetMs = site.timezone === 'Asia/Tokyo' ? 9 * 3_600_000 : 0;
      for (const day of [1, 2]) {
        const boundary = start + day * DAY_MS - offsetMs;
        const id = new Uint8Array(8);
        id[0] = 200 + index;
        id[1] = site.id;
        id[2] = day;
        for (let step = 0; step < 5; step += 1) {
          const path = PATHS[step % PATHS.length] ?? '/';
          planned.push({
            siteId: site.id,
            ts: boundary - 45_000 + step * 20_000,
            hit: {
              siteId: site.id,
              type: step % 2 === 0 ? 'pageview' : 'ping',
              url: `https://${site.domains[0]}${path ?? '/'}`,
            },
            visitor: id,
          });
        }
      }
    }
    planned.sort((a, b) => a.ts - b.ts);

    const failAt = Math.floor(planned.length * 0.4);
    let failed = 0;
    let flushes = 0;
    for (const [index, entry] of planned.entries()) {
      const site = DRIFT_SITES[entry.siteId - 1];
      if (site === undefined) throw new Error('unknown drift site');
      const sessionized = sessionizer.process({
        site: { ...site, created_at: 0, domains: [...site.domains] },
        hit: entry.hit,
        visitorId: entry.visitor,
        now: entry.ts,
        device: DEVICE,
        geo: null,
        lang: 'en-us',
      });
      if (sessionized === undefined) continue; // an orphan heartbeat
      batcher.addEvent(sessionized.event);
      batcher.addSession(sessionized.session);

      if (index === failAt) {
        // One flush dies mid-transaction; everything must stay queued and the
        // retried flush must land the SAME deltas it failed to.
        batcher.beforeCommit = () => {
          batcher.beforeCommit = undefined;
          failed += 1;
          throw new Error('injected flush failure');
        };
        expect(batcher.flush()).toBeUndefined();
        expect(batcher.pending).toBeGreaterThan(0);
      } else if (rng() < 0.04) {
        if (batcher.flush() !== undefined) {
          flushes += 1;
          sessionizer.noteFlush();
        }
      }
    }
    if (batcher.flush() !== undefined) flushes += 1;

    expect(failed).toBe(1);
    expect(flushes).toBeGreaterThan(5); // the randomized boundaries actually happened
    verifyEveryDay(db);

    // The uid shape really is in the input: some session's hits span two local
    // dates, which only a stable visitor id survives.
    const spanning = stmt<number>(
      db,
      'SELECT COUNT(*) FROM (SELECT session_id FROM events GROUP BY session_id HAVING COUNT(DISTINCT local_date) > 1)',
    )
      .pluck()
      .get() as number;
    expect(spanning).toBeGreaterThan(0);

    db.close();
  }, 60_000);
});
