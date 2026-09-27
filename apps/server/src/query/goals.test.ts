import { isQueryError, type QueryRequest } from '@featherstat/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { binId, event, openTestDb, resultOf, session } from '../../test/rows.ts';
import {
  createGoal,
  type Db,
  insertEvents,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { executeQueryRequest } from './executor.ts';
import { resolveGoals } from './stored.ts';

/**
 * Goal metrics end to end (docs/04 § 3): definitions resolved on main
 * (query/stored.ts) exactly as the route does, executed through the goal
 * statements the executor appends and merges. The corpus is tiny and
 * hand-countable.
 */

const DAY = '2026-07-27';
const DAY2 = '2026-07-28';
const NOW = Date.UTC(2026, 6, 28, 14);

let db: Db;
let signupGoal: number;
let purchaseGoal: number;
let fixedGoal: number;
let otherSiteGoal: number;

interface Seed {
  sess: number;
  date?: string;
  pages: readonly string[];
  purchases?: readonly number[];
}

function seedVisit({ sess, date = DAY, pages, purchases = [] }: Seed): void {
  withWriteTransaction(db, () => {
    const base = {
      session_id: binId(sess),
      visitor_id: binId(sess),
      local_date: date,
      ts: Date.parse(`${date}T12:00:00Z`),
    };
    insertEvents(db, [
      ...pages.map((path, i) => event({ ...base, ts: base.ts + i, path, seq: i + 1 })),
      ...purchases.map((value, i) =>
        event({
          ...base,
          ts: base.ts + 100 + i,
          type: 'event',
          event_category: 'shop',
          event_action: 'purchase',
          event_value: value,
          seq: pages.length + i + 1,
        }),
      ),
    ]);
    upsertSessions(db, [
      session({
        id: binId(sess),
        visitor_id: binId(sess),
        local_date: date,
        started_at: base.ts,
        last_seen_at: base.ts,
        pageviews: pages.length,
        events: purchases.length,
      }),
    ]);
  });
}

beforeAll(() => {
  db = openTestDb(2);
  withWriteTransaction(db, () => {
    signupGoal = createGoal(
      db,
      {
        site_id: 1,
        name: 'Signed up',
        filters: JSON.stringify([{ dim: 'path', op: 'eq', value: '/signup' }]),
        value_expr: null,
        target: null,
      },
      NOW,
    ).id;
    purchaseGoal = createGoal(
      db,
      {
        site_id: 1,
        name: 'Purchased',
        filters: JSON.stringify([{ dim: 'event_action', op: 'eq', value: 'purchase' }]),
        value_expr: 'event_value',
        target: null,
      },
      NOW,
    ).id;
    fixedGoal = createGoal(
      db,
      {
        site_id: 1,
        name: 'Signup worth 5',
        filters: JSON.stringify([{ dim: 'path', op: 'eq', value: '/signup' }]),
        value_expr: 'fixed:5',
        target: null,
      },
      NOW,
    ).id;
    otherSiteGoal = createGoal(
      db,
      {
        site_id: 2,
        name: 'Elsewhere',
        filters: JSON.stringify([{ dim: 'path', op: 'eq', value: '/x' }]),
        value_expr: null,
        target: null,
      },
      NOW,
    ).id;
  });
  seedVisit({ sess: 1, pages: ['/a', '/signup'] });
  seedVisit({ sess: 2, pages: ['/a'] });
  seedVisit({ sess: 3, pages: ['/signup', '/signup'] }); // completes ONCE per session
  seedVisit({ sess: 4, date: DAY2, pages: ['/signup'], purchases: [10, 2.5] });
});

function ask(query: Record<string, unknown>, range = { from: DAY, to: DAY2 }) {
  const request: QueryRequest = {
    site: 1,
    range,
    queries: [{ id: 'q', ...query } as QueryRequest['queries'][number]],
  };
  return executeQueryRequest(db, request, { now: NOW, goals: resolveGoals(db, request) });
}

const resultOfQ = (response: ReturnType<typeof ask>) => resultOf(response, 'q');

describe('goal metrics', () => {
  it('counts conversions once per session and computes cr against visits', () => {
    const { rows, measures } = resultOfQ(
      ask({ metrics: [`goal:${signupGoal}:conversions`, `goal:${signupGoal}:cr`] }),
    );
    const row = rows[0];
    expect(row?.[`goal:${signupGoal}:conversions`]).toBe(3); // sessions 1, 3 and 4
    expect(row?.visits).toBe(4); // the denominator rides in the row
    expect(row?.[`goal:${signupGoal}:cr`]).toBe(3 / 4);
    expect(measures?.[`goal:${signupGoal}:conversions`]).toEqual({
      unit: 'count',
      population: 'actions',
      aggregate: 'distinct',
    });
    expect(measures?.[`goal:${signupGoal}:cr`]).toEqual({
      unit: 'rate',
      population: 'sessions',
      aggregate: 'ratio',
      of: { numerator: `goal:${signupGoal}:conversions`, denominator: 'visits' },
    });
  });

  it('sums event_value for a value goal, and multiplies for a fixed one', () => {
    const { rows, measures } = resultOfQ(
      ask({ metrics: [`goal:${purchaseGoal}:value`, `goal:${fixedGoal}:value`] }),
    );
    const row = rows[0];
    expect(row?.[`goal:${purchaseGoal}:value`]).toBe(12.5);
    expect(row?.[`goal:${fixedGoal}:value`]).toBe(15); // 3 conversions × 5
    expect(measures?.[`goal:${purchaseGoal}:value`]?.aggregate).toBe('sum');
    expect(measures?.[`goal:${fixedGoal}:value`]?.aggregate).toBe('computed');
  });

  it('buckets conversions by the completing EVENT’s local date (docs/04 § 3)', () => {
    const { rows } = resultOfQ(
      ask({ metrics: ['visits', `goal:${signupGoal}:conversions`], bucket: 'day' }),
    );
    const byDay = new Map(rows.map((row) => [row.bucket, row]));
    expect(byDay.get(DAY)).toMatchObject({ visits: 3, [`goal:${signupGoal}:conversions`]: 2 });
    expect(byDay.get(DAY2)).toMatchObject({ visits: 1, [`goal:${signupGoal}:conversions`]: 1 });
  });

  it('merges with a dimension breakdown, empty groups reading 0', () => {
    const { rows } = resultOfQ(
      ask({ metrics: ['pageviews', `goal:${purchaseGoal}:conversions`], dim: 'path' }),
    );
    const byPath = new Map(rows.map((row) => [row.path, row]));
    // The purchase events carry no path; the pageview groups still answer 0.
    expect(byPath.get('/a')).toMatchObject({
      pageviews: 2,
      [`goal:${purchaseGoal}:conversions`]: 0,
    });
    expect(byPath.get('/signup')).toMatchObject({ pageviews: 4 });
  });

  it('respects request filters inside the goal statement', () => {
    const { rows } = resultOfQ(
      ask({
        metrics: [`goal:${signupGoal}:conversions`],
        filters: [{ dim: 'path', op: 'eq', value: '/signup', scope: 'session' }],
      }),
    );
    expect(rows[0]?.[`goal:${signupGoal}:conversions`]).toBe(3);
  });

  it("applies the query's own filters to conversions, as to its visits", () => {
    // Sessions 1 and 2 visited /a; only session 1 went on to /signup.
    const { rows } = resultOfQ(
      ask({
        metrics: [`goal:${signupGoal}:conversions`, `goal:${signupGoal}:cr`],
        filters: [{ dim: 'path', op: 'eq', value: '/a', scope: 'session' }],
      }),
    );
    expect(rows[0]).toMatchObject({
      visits: 2,
      [`goal:${signupGoal}:conversions`]: 1,
      [`goal:${signupGoal}:cr`]: 1 / 2,
    });
  });

  it('refuses hour shapes honestly', () => {
    for (const shape of [{ bucket: 'hour' }, { dim: 'local_hour' }]) {
      const entry = ask({ metrics: [`goal:${signupGoal}:conversions`], ...shape }).results.q;
      expect(entry !== undefined && isQueryError(entry)).toBe(true);
      if (entry !== undefined && isQueryError(entry)) {
        expect(entry.error.message).toContain('distinct sessions');
      }
    }
  });

  it('refuses a session-only grouping', () => {
    const entry = ask({ metrics: [`goal:${signupGoal}:conversions`], dim: 'entry_path' }).results.q;
    expect(entry !== undefined && isQueryError(entry)).toBe(true);
  });

  it('answers an unknown goal id with a per-query error, never a 500', () => {
    const entry = ask({ metrics: ['goal:999:conversions'] }).results.q;
    expect(entry !== undefined && isQueryError(entry)).toBe(true);
    if (entry !== undefined && isQueryError(entry)) {
      expect(entry.error.message).toBe('unknown goal 999');
    }
  });

  it("refuses a goal from outside the query's site scope", () => {
    const entry = ask({ metrics: [`goal:${otherSiteGoal}:conversions`] }).results.q;
    expect(entry !== undefined && isQueryError(entry)).toBe(true);
    if (entry !== undefined && isQueryError(entry)) {
      expect(entry.error.message).toContain('another site');
    }
  });

  it("scopes a goal to its own site under site:'all'", () => {
    // A look-alike /x pageview on site 1 must not convert site 2's goal.
    seedVisit({ sess: 30, pages: ['/x'] });
    const request: QueryRequest = {
      site: 'all',
      range: { from: DAY, to: DAY2 },
      queries: [{ id: 'q', metrics: [`goal:${otherSiteGoal}:conversions`] }],
    };
    const { rows } = resultOfQ(
      executeQueryRequest(db, request, { now: NOW, goals: resolveGoals(db, request) }),
    );
    expect(rows[0]?.[`goal:${otherSiteGoal}:conversions`]).toBe(0);
  });
});
