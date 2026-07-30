import type { QueryRequest, ResultRow } from '@featherstat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/index.ts';
import { executeQueryRequest } from '../../src/query/executor.ts';
import { resultOf } from '../rows.ts';
import { generateCorpus, type PlaceTotals } from './generate.ts';
import { openReplayDb } from './harness.ts';

/**
 * WP7 acceptance (docs/08): the 90-day replay corpus answers the docs/04
 * example widget batch, every metric agrees with the generator's independent
 * bookkeeping, and the full batch lands inside the docs/02 budget (< 50 ms).
 */

const corpus = generateCorpus();

/** The docs/04 § 3 example batch — the full dashboard in one request. */
const EXAMPLE_BATCH: QueryRequest = {
  site: 4,
  range: { preset: '30d' },
  queries: [
    { id: 'kpis', metrics: ['visitors', 'pageviews', 'engaged_ms', 'bounce_rate'] },
    { id: 'series', metrics: ['visitors', 'pageviews'], bucket: 'day' },
    { id: 'pages', metrics: ['pageviews', 'visitors'], dim: 'path', limit: 10 },
    { id: 'refs', metrics: ['visitors'], dim: 'ref_domain', limit: 10 },
    { id: 'geo', metrics: ['visitors'], dim: 'country' },
    { id: 'heatmap', metrics: ['pageviews'], dim: 'local_hour', dim2: 'weekday' },
  ],
};

/** Wide enough to hold every local date the corpus can produce, in any site timezone. */
const FULL_RANGE = { from: '2026-02-14', to: '2026-05-17' } as const;

let db: Db;

beforeAll(() => {
  db = openReplayDb(corpus);
}, 120_000);

afterAll(() => {
  db.close();
});

function byDate(rows: ResultRow[]): Map<string, ResultRow> {
  return new Map(rows.map((row) => [String(row.bucket), row]));
}

/** One order for both sides, so the comparison is about counts and not ranking. */
function sortPlaces(places: readonly PlaceTotals[]): PlaceTotals[] {
  return [...places].sort((a, b) => (a.country ?? '').localeCompare(b.country ?? ''));
}

describe('query engine on the replay corpus', () => {
  it('answers every query of the docs/04 example batch', () => {
    const response = executeQueryRequest(db, EXAMPLE_BATCH, { now: corpus.endMs });
    expect(Object.keys(response.results).sort()).toEqual(
      ['geo', 'heatmap', 'kpis', 'pages', 'refs', 'series'].sort(),
    );
    for (const query of EXAMPLE_BATCH.queries) {
      const entry = resultOf(response, query.id);
      expect(entry.rows.length, query.id).toBeGreaterThan(0);
    }
    const kpis = resultOf(response, 'kpis').rows[0];
    expect(kpis?.visitors).toBeGreaterThan(0);
    expect(kpis?.bounce_rate).toBeGreaterThan(0);
    expect(kpis?.bounce_rate).toBeLessThan(1);
    expect(resultOf(response, 'pages').rows.length).toBeLessThanOrEqual(10);
    expect(response.meta.dataVersion).toBe(corpus.storedHits);
  });

  it('matches the generator bookkeeping for every site and every local day', () => {
    for (const site of corpus.sites) {
      const response = executeQueryRequest(db, {
        site: site.id,
        range: FULL_RANGE,
        queries: [
          { id: 'events', metrics: ['visitors', 'pageviews'], bucket: 'day' },
          { id: 'sessions', metrics: ['visits', 'bounce_rate'], bucket: 'day' },
        ],
      });
      const eventDays = byDate(resultOf(response, 'events').rows);
      const sessionDays = byDate(resultOf(response, 'sessions').rows);
      const expected = corpus.totals.filter((day) => day.siteId === site.id);
      expect(expected.length).toBeGreaterThan(0);

      let checkedDays = 0;
      for (const day of expected) {
        const label = `site ${site.id} ${day.localDate}`;
        const events = eventDays.get(day.localDate);
        if (day.visitors > 0 || events !== undefined) {
          expect(events?.visitors ?? 0, label).toBe(day.visitors);
          expect(events?.pageviews ?? 0, label).toBe(day.pageviews);
        }
        const sessions = sessionDays.get(day.localDate);
        expect(Number(sessions?.visits ?? 0), label).toBe(day.sessions);
        if (sessions !== undefined) {
          const bounces = Math.round(Number(sessions.bounce_rate) * Number(sessions.visits));
          expect(bounces, label).toBe(day.bounces);
        }
        checkedDays += 1;
      }
      // Every day the query reports must exist in the oracle too.
      for (const date of eventDays.keys()) {
        expect(
          expected.some((day) => day.localDate === date),
          `site ${site.id} ${date} in query but not oracle`,
        ).toBe(true);
      }
      expect(checkedDays).toBeGreaterThanOrEqual(90);
    }
  });

  it('breaks down by country against the generator, unlocated group included', () => {
    // Until the replay path had a geo provider, `country` was NULL for all 137k
    // stored rows, so every geo breakdown in this suite — this one included —
    // agreed with the oracle about a single null row and asserted nothing.
    for (const site of corpus.sites) {
      const response = executeQueryRequest(db, {
        site: site.id,
        range: FULL_RANGE,
        queries: [{ id: 'geo', metrics: ['pageviews'], dim: 'country' }],
      });
      const expected = corpus.places.filter((place) => place.siteId === site.id);
      const actual = resultOf(response, 'geo').rows.map((row) => ({
        siteId: site.id,
        country: row.country === null ? null : String(row.country),
        pageviews: Number(row.pageviews),
      }));
      expect(sortPlaces(actual), site.name).toEqual(sortPlaces(expected));
      // The slack that keeps the equality from passing vacuously: several
      // countries AND an unlocated group, on every site.
      expect(expected.length, site.name).toBeGreaterThan(5);
      expect(
        expected.some((place) => place.country === null),
        `${site.name} has an unlocated group`,
      ).toBe(true);
    }
  });

  it('answers region and city, so the whole geo triple is real and not just the code', () => {
    const response = executeQueryRequest(db, {
      site: 'all',
      range: FULL_RANGE,
      queries: [
        { id: 'region', metrics: ['pageviews'], dim: 'region', limit: 20 },
        { id: 'city', metrics: ['pageviews'], dim: 'city', limit: 20 },
      ],
    });
    const named = (id: string): string[] =>
      resultOf(response, id)
        .rows.map((row) => row[id])
        .filter((value): value is string => typeof value === 'string');
    expect(named('city')).toContain('Boston');
    expect(named('region')).toContain('Massachusetts');
    // Non-ASCII place names survive ingest, storage and the compiler intact.
    expect(named('city')).toContain('São Paulo');
  });

  it("groups site 'all' per site with each site's own totals", () => {
    const response = executeQueryRequest(db, {
      site: 'all',
      range: FULL_RANGE,
      queries: [{ id: 'q', metrics: ['pageviews'], dim: 'site' }],
    });
    const rows = resultOf(response, 'q').rows;
    expect(rows).toHaveLength(corpus.sites.length);
    for (const site of corpus.sites) {
      const expected = corpus.totals
        .filter((day) => day.siteId === site.id)
        .reduce((sum, day) => sum + day.pageviews, 0);
      expect(rows.find((row) => row.site === site.id)?.pageviews, site.name).toBe(expected);
    }
  });

  it('answers the full example batch under the 50 ms budget (docs/02)', () => {
    executeQueryRequest(db, EXAMPLE_BATCH, { now: corpus.endMs }); // warm statement cache
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run += 1) {
      const response = executeQueryRequest(db, EXAMPLE_BATCH, { now: corpus.endMs });
      best = Math.min(best, response.meta.generatedInMs);
    }
    expect(best).toBeLessThan(50);
  });
});
