import type { HitType, QueryRequest } from '@featherstat/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { binId, event, resultOf, session } from '../../test/rows.ts';
import {
  createSite,
  type Db,
  type EventRow,
  insertEvents,
  openDb,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { executeQueryRequest } from './executor.ts';

/**
 * Handcrafted journeys with known step sequences (docs/03 § Journeys). Sessions
 * carry interleaved pings (stored rows that are not steps), an event step, an
 * outlink step, a page announced three times in a row, and one session that
 * crosses midnight — every rule the sequence compiler implements has a session
 * here that would catch its loss.
 */

const DAY = '2026-07-27';
let db: Db;

interface JourneyHit {
  type?: HitType;
  path?: string;
  category?: string;
  action?: string;
  /** Local date of this one row — a session can cross midnight (docs/03). */
  date?: string;
}

interface Journey {
  sess: number;
  site?: number;
  date?: string;
  engaged?: number;
  country?: string;
  hits: JourneyHit[];
}

function seedJourney(journey: Journey): void {
  const date = journey.date ?? DAY;
  const rows: EventRow[] = journey.hits.map((hit, index) =>
    event({
      site_id: journey.site ?? 1,
      visitor_id: binId(journey.sess),
      session_id: binId(journey.sess),
      local_date: hit.date ?? date,
      local_hour: 10,
      type: hit.type ?? 'pageview',
      seq: index + 1,
      path: hit.path ?? null,
      event_category: hit.category ?? null,
      event_action: hit.action ?? null,
    }),
  );
  insertEvents(db, rows);
  upsertSessions(db, [
    session({
      id: binId(journey.sess),
      site_id: journey.site ?? 1,
      visitor_id: binId(journey.sess),
      local_date: date,
      pageviews: rows.filter((row) => row.type === 'pageview').length,
      events: rows.filter((row) => row.type === 'event').length,
      engaged_ms: journey.engaged ?? 0,
      country: journey.country ?? null,
    }),
  ]);
}

beforeAll(() => {
  db = openDb(':memory:');
  withWriteTransaction(db, () => {
    createSite(db, { id: 1, name: 'one', domains: ['one.test'], timezone: 'America/New_York' });
    createSite(db, { id: 2, name: 'two', domains: ['two.test'], timezone: 'UTC' });

    // A: 4 steps — pages, an event step, pages — with a ping between them.
    seedJourney({
      sess: 1,
      country: 'US',
      engaged: 60_000,
      hits: [
        { path: '/' },
        { type: 'ping', path: '/' },
        { path: '/docs' },
        { type: 'event', path: '/docs', category: 'cta', action: 'click' },
        { path: '/pricing' },
      ],
    });
    // B: shares A's first two steps, then stops — flows must group them at steps=2.
    seedJourney({
      sess: 2,
      country: 'US',
      engaged: 30_000,
      hits: [{ path: '/' }, { type: 'ping', path: '/' }, { path: '/docs' }],
    });
    // C: a different second step.
    seedJourney({
      sess: 3,
      country: 'DE',
      engaged: 5_000,
      hits: [{ path: '/' }, { path: '/pricing' }],
    });
    // D: single step — appears in flows, contributes no transition edge.
    seedJourney({ sess: 4, country: 'DE', engaged: 12_000, hits: [{ path: '/docs' }] });
    // E: an outlink step labels as the page it left from.
    seedJourney({
      sess: 5,
      country: 'US',
      engaged: 45_000,
      hits: [{ path: '/' }, { type: 'outlink', path: '/' }],
    });
    // F: the day before — outside the single-day range.
    seedJourney({
      sess: 6,
      date: '2026-07-26',
      engaged: 9_000,
      hits: [{ path: '/old' }, { path: '/' }],
    });
    // G: crosses midnight — the session's local_date is in range, its last row's is not.
    seedJourney({
      sess: 7,
      engaged: 8_000,
      hits: [{ path: '/late' }, { path: '/after', date: '2026-07-28' }],
    });
    // H: the SPA shape — /app announced twice for one navigation, then reloaded
    // after a real visit to /app/route. Three rows, two steps (docs/06).
    seedJourney({
      sess: 8,
      country: 'US',
      engaged: 20_000,
      hits: [
        { path: '/app' },
        { path: '/app' },
        { path: '/app/route' },
        { type: 'ping', path: '/app/route' },
        { path: '/app/route' },
      ],
    });
    // Site 2: must never leak into site 1 answers.
    seedJourney({ sess: 9, site: 2, engaged: 1_000, hits: [{ path: '/x' }, { path: '/y' }] });
  });
});

const RANGE = { range: { from: DAY, to: DAY } } as const;

function run(partial: Omit<QueryRequest, 'site' | 'range'> & Partial<QueryRequest>) {
  const request: QueryRequest = { site: 1, ...RANGE, ...partial };
  return executeQueryRequest(db, request);
}

describe('transitions', () => {
  it('builds step-bucketed edges: pings skipped, events labelled, midnight crossed', () => {
    const response = run({ queries: [{ id: 'q', kind: 'transitions', steps: 4, limit: 20 }] });
    expect(resultOf(response, 'q').rows).toEqual([
      { step: 1, from: '/', to: '/docs', sessions: 2 },
      { step: 1, from: '/', to: '/pricing', sessions: 1 },
      { step: 1, from: '/app', to: '/app/route', sessions: 1 },
      { step: 1, from: '/late', to: '/after', sessions: 1 },
      { step: 2, from: '/docs', to: 'event: cta · click', sessions: 1 },
      { step: 3, from: 'event: cta · click', to: '/pricing', sessions: 1 },
    ]);
  });

  it('never steps from a label to itself: a repeat is one step, not an edge', () => {
    // E's outlink leaves from the page it labels and H announced /app twice
    // before reloading /app/route — neither is movement, so neither is an edge.
    const rows = run({ queries: [{ id: 'q', kind: 'transitions', steps: 4, limit: 20 }] });
    expect(resultOf(rows, 'q').rows.filter((row) => row.from === row.to)).toEqual([]);
  });

  it("caps edge depth at 'steps'", () => {
    const response = run({ queries: [{ id: 'q', kind: 'transitions', steps: 2, limit: 20 }] });
    const steps = resultOf(response, 'q').rows.map((row) => row.step);
    expect(Math.max(...(steps as number[]))).toBe(2);
    expect(steps).toHaveLength(5);
  });

  it("keeps the top 'limit' edges of every step, not just of the first", () => {
    const response = run({ queries: [{ id: 'q', kind: 'transitions', steps: 4, limit: 1 }] });
    expect(resultOf(response, 'q').rows).toEqual([
      { step: 1, from: '/', to: '/docs', sessions: 2 },
      { step: 2, from: '/docs', to: 'event: cta · click', sessions: 1 },
      { step: 3, from: 'event: cta · click', to: '/pricing', sessions: 1 },
    ]);
  });

  it('scopes by the session local_date range', () => {
    const response = run({
      range: { from: '2026-07-26', to: DAY },
      queries: [{ id: 'q', kind: 'transitions', steps: 4, limit: 20 }],
    });
    expect(resultOf(response, 'q').rows).toContainEqual({
      step: 1,
      from: '/old',
      to: '/',
      sessions: 1,
    });
  });

  it("scopes by site, and site 'all' merges every site's journeys", () => {
    const two = run({ site: 2, queries: [{ id: 'q', kind: 'transitions', steps: 4, limit: 20 }] });
    expect(resultOf(two, 'q').rows).toEqual([{ step: 1, from: '/x', to: '/y', sessions: 1 }]);

    const all = run({
      site: 'all',
      queries: [{ id: 'q', kind: 'transitions', steps: 4, limit: 20 }],
    });
    const rows = resultOf(all, 'q').rows;
    expect(rows).toContainEqual({ step: 1, from: '/x', to: '/y', sessions: 1 });
    expect(rows).toContainEqual({ step: 1, from: '/', to: '/docs', sessions: 2 });
  });
});

describe('flows', () => {
  it('groups signatures with avg engaged time and exit rate', () => {
    const response = run({ queries: [{ id: 'q', kind: 'flows', steps: 2, limit: 20 }] });
    expect(resultOf(response, 'q').rows).toEqual([
      // A went on beyond the 2-step signature, B stopped inside it: exit_rate 0.5.
      { steps: ['/', '/docs'], sessions: 2, avg_engaged_ms: 45_000, exit_rate: 0.5 },
      { steps: ['/', '/pricing'], sessions: 1, avg_engaged_ms: 5_000, exit_rate: 1 },
      // E: one page and an outlink taken from it — one step, and a completed journey.
      { steps: ['/'], sessions: 1, avg_engaged_ms: 45_000, exit_rate: 1 },
      // H: five rows, two steps.
      { steps: ['/app', '/app/route'], sessions: 1, avg_engaged_ms: 20_000, exit_rate: 1 },
      { steps: ['/docs'], sessions: 1, avg_engaged_ms: 12_000, exit_rate: 1 },
      { steps: ['/late', '/after'], sessions: 1, avg_engaged_ms: 8_000, exit_rate: 1 },
    ]);
  });

  it('orders deterministically (sessions desc, then signature) at full depth', () => {
    const response = run({ queries: [{ id: 'q', kind: 'flows', steps: 4, limit: 20 }] });
    expect(resultOf(response, 'q').rows).toEqual([
      {
        steps: ['/', '/docs', 'event: cta · click', '/pricing'],
        sessions: 1,
        avg_engaged_ms: 60_000,
        exit_rate: 1,
      },
      { steps: ['/', '/docs'], sessions: 1, avg_engaged_ms: 30_000, exit_rate: 1 },
      { steps: ['/', '/pricing'], sessions: 1, avg_engaged_ms: 5_000, exit_rate: 1 },
      { steps: ['/'], sessions: 1, avg_engaged_ms: 45_000, exit_rate: 1 },
      { steps: ['/app', '/app/route'], sessions: 1, avg_engaged_ms: 20_000, exit_rate: 1 },
      { steps: ['/docs'], sessions: 1, avg_engaged_ms: 12_000, exit_rate: 1 },
      { steps: ['/late', '/after'], sessions: 1, avg_engaged_ms: 8_000, exit_rate: 1 },
    ]);
  });

  it('no signature repeats a label back to back, at any depth', () => {
    for (const steps of [2, 3, 4]) {
      const response = run({ queries: [{ id: 'q', kind: 'flows', steps, limit: 20 }] });
      for (const row of resultOf(response, 'q').rows) {
        const signature = row.steps as string[];
        expect(signature.filter((step, i) => i > 0 && step === signature[i - 1])).toEqual([]);
      }
    }
  });

  it("guards the long tail with 'limit'", () => {
    const response = run({ queries: [{ id: 'q', kind: 'flows', steps: 2, limit: 2 }] });
    expect(resultOf(response, 'q').rows).toEqual([
      { steps: ['/', '/docs'], sessions: 2, avg_engaged_ms: 45_000, exit_rate: 0.5 },
      { steps: ['/', '/pricing'], sessions: 1, avg_engaged_ms: 5_000, exit_rate: 1 },
    ]);
  });
});

describe('envelope filters', () => {
  const QUERIES: QueryRequest['queries'] = [
    { id: 'sankey', kind: 'transitions', steps: 4, limit: 20 },
    { id: 'journeys', kind: 'flows', steps: 2, limit: 20 },
  ];

  it('applies session-scoped filters to both kinds', () => {
    const response = run({
      filters: [{ dim: 'country', op: 'eq', value: 'US' }],
      queries: QUERIES,
    });
    expect(resultOf(response, 'sankey').rows).toEqual([
      { step: 1, from: '/', to: '/docs', sessions: 2 },
      { step: 1, from: '/app', to: '/app/route', sessions: 1 },
      { step: 2, from: '/docs', to: 'event: cta · click', sessions: 1 },
      { step: 3, from: 'event: cta · click', to: '/pricing', sessions: 1 },
    ]);
    expect(resultOf(response, 'journeys').rows).toEqual([
      { steps: ['/', '/docs'], sessions: 2, avg_engaged_ms: 45_000, exit_rate: 0.5 },
      { steps: ['/'], sessions: 1, avg_engaged_ms: 45_000, exit_rate: 1 },
      { steps: ['/app', '/app/route'], sessions: 1, avg_engaged_ms: 20_000, exit_rate: 1 },
    ]);
  });

  it("'is_null' picks the NULL group, like the metric path", () => {
    const response = run({ filters: [{ dim: 'country', op: 'is_null' }], queries: QUERIES });
    expect(resultOf(response, 'sankey').rows).toEqual([
      { step: 1, from: '/late', to: '/after', sessions: 1 },
    ]);
  });

  it('rejects event-only filters honestly while the batch still succeeds', () => {
    const response = run({
      filters: [{ dim: 'path', op: 'starts', value: '/docs' }],
      queries: [...QUERIES, { id: 'ok', metrics: ['pageviews'] }],
    });
    for (const id of ['sankey', 'journeys']) {
      expect(response.results[id]).toEqual({
        error: { code: 'unsupported', message: expect.stringContaining('session-scoped') },
      });
    }
    // The event-level filter is fine for a metric query: /docs pageviews of A, B, D.
    expect(resultOf(response, 'ok').rows).toEqual([{ pageviews: 3 }]);
  });

  it('treats injection attempts as literal values', () => {
    const response = run({
      filters: [{ dim: 'country', op: 'eq', value: "' OR '1'='1" }],
      queries: QUERIES,
    });
    expect(resultOf(response, 'sankey').rows).toEqual([]);
    expect(resultOf(response, 'journeys').rows).toEqual([]);
  });
});

describe('edges of the envelope', () => {
  it('answers an empty range with empty rows, not an error', () => {
    const response = run({
      range: { from: '2026-01-01', to: '2026-01-02' },
      queries: [
        { id: 'sankey', kind: 'transitions', steps: 4, limit: 20 },
        { id: 'journeys', kind: 'flows', steps: 4, limit: 20 },
      ],
    });
    expect(resultOf(response, 'sankey').rows).toEqual([]);
    expect(resultOf(response, 'journeys').rows).toEqual([]);
  });

  it('pins the docs/04 § 3 example shapes', () => {
    const response = run({
      queries: [
        { id: 'sankey', kind: 'transitions', steps: 3, limit: 20 },
        { id: 'journeys', kind: 'flows', steps: 4, limit: 20 },
      ],
    });
    const sankey = resultOf(response, 'sankey');
    expect(sankey.rows.length).toBeGreaterThan(0);
    for (const row of sankey.rows) {
      expect(Object.keys(row).sort()).toEqual(['from', 'sessions', 'step', 'to']);
      expect(typeof row.from).toBe('string');
      expect(typeof row.to).toBe('string');
    }
    const journeys = resultOf(response, 'journeys');
    expect(journeys.ms).toBeGreaterThanOrEqual(0);
    for (const row of journeys.rows) {
      expect(Object.keys(row).sort()).toEqual(['avg_engaged_ms', 'exit_rate', 'sessions', 'steps']);
      expect(Array.isArray(row.steps)).toBe(true);
      for (const step of row.steps as string[]) expect(typeof step).toBe('string');
    }
  });
});
